// 個別レポートの配信安定化 P1（2026-10-11）: 20人の上限で21人目以降が届かない問題（P1-4）、通知の予約の失敗で
// 完成したレポートが failed に戻る問題（P1-5）、止まった「生成中」の行が残り続ける問題（P1-6）。
// DB の一意キーと条件付き更新を再現した手元のストアで、index.ts と同じ手順を何回も実行して確かめる。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  claimReport,
  type ExistingRow,
  finalizeReport,
  MAX_USERS_PER_RUN,
  NOTIFICATION_PENDING_MARK,
  type ReportStore,
  restReportStore,
  selectRunUsers,
  STALE_GENERATING_MINUTES,
  sweepNotifications,
} from "./delivery_lifecycle.ts";

type Row = ExistingRow & { report_type: string; trading_date: string; error: string | null; notified_at: string | null; fact_status: string };

/** personalized_reports と通知の一意キー・条件付き更新を、そのまま再現する手元のストア。 */
class MemoryStore implements ReportStore {
  rows: Row[] = [];
  notifications = new Set<string>();
  enqueueFails = 0;
  pushDisabled = new Set<string>();
  private seq = 0;
  constructor(public clock: () => Date) {}
  listRows(reportType: string, tradingDate: string, onlyUser: string | null) {
    return Promise.resolve(this.rows.filter((row) => row.report_type === reportType && row.trading_date === tradingDate && (!onlyUser || row.user_id === onlyUser)).map((row) => ({ ...row })));
  }
  insertGenerating(userId: string, reportType: string, tradingDate: string) {
    if (this.rows.some((row) => row.user_id === userId && row.report_type === reportType && row.trading_date === tradingDate)) return Promise.resolve(null);
    const id = `r${++this.seq}`;
    this.rows.push({ id, user_id: userId, report_type: reportType, trading_date: tradingDate, status: "generating", updated_at: this.clock().toISOString(), error: null, notified_at: null, fact_status: "pending" });
    return Promise.resolve(id);
  }
  takeOverStale(reportId: string, cutoffIso: string, nowIso: string) {
    const row = this.rows.find((item) => item.id === reportId && item.status === "generating" && item.updated_at < cutoffIso);
    if (!row) return Promise.resolve(false);
    row.updated_at = nowIso;
    row.error = null;
    return Promise.resolve(true);
  }
  finalize(reportId: string, update: Record<string, unknown>) {
    const row = this.rows.find((item) => item.id === reportId && item.status === "generating");
    if (!row) return Promise.resolve(false);
    Object.assign(row, update);
    return Promise.resolve(true);
  }
  markFailed(reportId: string, error: string, nowIso: string) {
    const row = this.rows.find((item) => item.id === reportId && item.status === "generating");
    if (!row) return Promise.resolve(false);
    Object.assign(row, { status: "failed", fact_status: "pending", error, updated_at: nowIso });
    return Promise.resolve(true);
  }
  enqueue(reportId: string) {
    if (this.enqueueFails > 0) {
      this.enqueueFails -= 1;
      return Promise.reject(new Error("REST_POST_FAILED:rpc/enqueue_personalized_report_notification:503"));
    }
    const row = this.rows.find((item) => item.id === reportId)!;
    if (row.status !== "completed" || row.fact_status !== "passed" || this.pushDisabled.has(row.user_id)) return Promise.resolve(false);
    if (this.notifications.has(reportId)) return Promise.resolve(false); // 部分ユニーク索引
    this.notifications.add(reportId);
    row.notified_at = this.clock().toISOString();
    return Promise.resolve(true);
  }
  markNotificationPending(reportId: string, code: string) {
    const row = this.rows.find((item) => item.id === reportId && item.status === "completed" && item.notified_at === null);
    if (row) row.error = `${NOTIFICATION_PENDING_MARK}:${code}`;
    return Promise.resolve();
  }
  clearNotificationPending(reportId: string) {
    const row = this.rows.find((item) => item.id === reportId && item.status === "completed" && item.error?.startsWith(NOTIFICATION_PENDING_MARK));
    if (row) row.error = null;
    return Promise.resolve();
  }
  listNotificationPending(reportType: string, tradingDate: string, limit: number) {
    return Promise.resolve(this.rows
      .filter((row) => row.report_type === reportType && row.trading_date === tradingDate && row.status === "completed" && row.fact_status === "passed" && row.notified_at === null && row.error?.startsWith(NOTIFICATION_PENDING_MARK))
      .map((row) => row.id).sort().slice(0, limit));
  }
}

const TYPE = "close";
const DATE = "2026-10-12";
const users = (n: number) => Array.from({ length: n }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
const COMPLETED = { status: "completed", fact_status: "passed", title_ja: "t", body: { ok: true } };
const FAILED = { status: "failed", fact_status: "failed", error: "REPORT_FACT_FAILED" };
const code = (error: unknown) => error instanceof Error ? error.message : "UNEXPECTED";

type Outcome = "completed" | "failed" | "throw" | "die";
/** index.ts の1回の実行と同じ手順（選定 → 引き受け → 生成 → 保存と通知、または失敗の記録）。 */
async function run(store: MemoryStore, candidates: string[], options: { outcome?: (userId: string) => Outcome; budget?: number } = {}) {
  await sweepNotifications(store, TYPE, DATE, code);
  const selection = selectRunUsers(candidates, await store.listRows(TYPE, DATE, null), store.clock());
  const picks = [
    ...selection.fresh.map((userId) => ({ userId, staleReportId: undefined as string | undefined })),
    ...selection.stale.map((item) => ({ userId: item.userId, staleReportId: item.reportId as string | undefined })),
  ].sort((a, b) => a.userId.localeCompare(b.userId)).slice(0, MAX_USERS_PER_RUN);
  const processed: string[] = [];
  for (const [index, pick] of picks.entries()) {
    if (options.budget !== undefined && index >= options.budget) break; // 時間の予算切れ（行を作らない）
    const claim = await claimReport(store, pick, TYPE, DATE, store.clock());
    if (!claim.reportId) continue;
    const outcome = options.outcome?.(pick.userId) ?? "completed";
    if (outcome === "die") continue; // 関数が止まった: 行は「生成中」のまま
    let finalized = false;
    try {
      if (outcome === "throw") throw new Error("REST_POST_FAILED:rpc/personalized_report_news_inputs:500");
      const result = await finalizeReport(store, claim.reportId, outcome === "completed" ? COMPLETED : FAILED, code);
      finalized = result.saved;
    } catch (error) {
      if (!finalized) await store.markFailed(claim.reportId, code(error), store.clock().toISOString());
    }
    processed.push(pick.userId);
  }
  return { selection, processed };
}

// ---------------------------------------------------------------------------------------------
// P1-4: 21人目以降も、実行を重ねれば必ず届く
// ---------------------------------------------------------------------------------------------

test("P1-4: 1・20・21・45人とも、必要な回数の実行で全員にちょうど1行ずつ届き、その後の再実行は何もしない", async () => {
  for (const n of [1, 20, 21, 45]) {
    const store = new MemoryStore(() => new Date("2026-10-12T08:15:00Z"));
    const all = users(n);
    let runs = 0;
    while (true) {
      const { selection } = await run(store, all);
      runs += 1;
      if (selection.remaining === 0) break;
      assert.ok(runs < 10, `${n}人: 終わらない`);
    }
    assert.equal(runs, Math.max(1, Math.ceil(n / MAX_USERS_PER_RUN)), `${n}人の実行回数`);
    assert.equal(store.rows.length, n, `${n}人: 行の数`);
    assert.equal(new Set(store.rows.map((row) => row.user_id)).size, n, `${n}人: 重複なし`);
    assert.ok(store.rows.every((row) => row.status === "completed"));
    const again = await run(store, all);
    assert.deepEqual([again.selection.fresh, again.selection.stale, again.processed], [[], [], []], `${n}人: 再実行で何もしない`);
  }
});

test("P1-4: 修正前の選び方（全員の先頭20人）では、21人目以降は何回実行しても届かない（再現）", () => {
  const all = users(45);
  const oldPick = (existing: ExistingRow[]) => all.slice(0, MAX_USERS_PER_RUN).filter((userId) => !existing.some((row) => row.user_id === userId));
  const existing: ExistingRow[] = all.slice(0, 20).map((user_id, index) => ({ id: `r${index}`, user_id, status: "completed", updated_at: "2026-10-12T08:15:00Z" }));
  assert.deepEqual(oldPick(existing), [], "修正前: 2回目以降は誰も選ばれない");
  const next = selectRunUsers(all, existing, new Date("2026-10-12T08:20:00Z"));
  assert.deepEqual([next.fresh.length, next.fresh[0], next.remaining], [20, all[20], 5], "修正後: 21人目から選ぶ");
});

test("P1-4: 時間の予算切れで後回しになった利用者は、次の実行で処理される", async () => {
  const store = new MemoryStore(() => new Date("2026-10-12T08:15:00Z"));
  const all = users(25);
  await run(store, all, { budget: 7 });
  assert.equal(store.rows.length, 7);
  await run(store, all);
  await run(store, all);
  assert.equal(store.rows.length, 25);
});

test("P1-4: 失敗した利用者は他を止めず、作り直されない（既存の扱い）。ウォッチだけ・保有ゼロでも候補の扱いは同じ", async () => {
  const store = new MemoryStore(() => new Date("2026-10-12T08:15:00Z"));
  const all = users(22);
  const outcome = (userId: string): Outcome => userId === all[3] ? "failed" : userId === all[5] ? "throw" : "completed";
  await run(store, all, { outcome });
  await run(store, all, { outcome });
  assert.equal(store.rows.length, 22);
  assert.deepEqual(store.rows.filter((row) => row.status === "failed").map((row) => row.user_id).sort(), [all[3], all[5]].sort());
  assert.equal(store.rows.filter((row) => row.status === "completed").length, 20);
  const third = await run(store, all, { outcome: () => "completed" });
  assert.deepEqual(third.processed, [], "failed の行は作り直さない");
});

test("P1-4: 同時に2つの実行が走っても、同じ利用者の行は1つだけ", async () => {
  const store = new MemoryStore(() => new Date("2026-10-12T08:15:00Z"));
  const all = users(30);
  await Promise.all([run(store, all), run(store, all)]);
  await Promise.all([run(store, all), run(store, all)]);
  assert.equal(store.rows.length, 30);
  assert.equal(new Set(store.rows.map((row) => row.user_id)).size, 30);
});

// ---------------------------------------------------------------------------------------------
// P1-5: 完成したレポートは、通知の予約に失敗しても failed に戻らない
// ---------------------------------------------------------------------------------------------

test("P1-5: 保存のあとに通知の予約が失敗しても、レポートは completed・Fact passed のまま。印を付け、次の実行で1回だけ予約する", async () => {
  const store = new MemoryStore(() => new Date("2026-10-12T08:15:00Z"));
  const [user] = users(1);
  store.enqueueFails = 1;
  await run(store, [user]);
  const row = store.rows[0];
  assert.deepEqual([row.status, row.fact_status, row.notified_at], ["completed", "passed", null]);
  assert.ok(row.error?.startsWith(NOTIFICATION_PENDING_MARK), "予約し直す印が付く");
  assert.equal(store.notifications.size, 0);
  await run(store, [user]);
  assert.deepEqual([store.notifications.size, row.status, row.error], [1, "completed", null], "次の実行で予約し、印を消す");
  await run(store, [user]);
  assert.equal(store.notifications.size, 1, "重複して予約しない");
});

test("P1-5: 修正前の処理（例外で failed に上書き）では、完成した本文が見えなくなる（再現）", async () => {
  const store = new MemoryStore(() => new Date("2026-10-12T08:15:00Z"));
  const id = (await store.insertGenerating("u", TYPE, DATE))!;
  await store.finalize(id, COMPLETED);
  // 修正前の index.ts: 予約の例外 → catch で無条件に failed へ PATCH していた
  Object.assign(store.rows[0], { status: "failed", fact_status: "pending" });
  assert.equal(store.rows[0].status, "failed", "修正前は completed が failed に戻っていた");
  // 修正後の markFailed は「生成中」の行にしか効かない
  const fresh = new MemoryStore(() => new Date("2026-10-12T08:15:00Z"));
  const id2 = (await fresh.insertGenerating("u", TYPE, DATE))!;
  await fresh.finalize(id2, COMPLETED);
  assert.equal(await fresh.markFailed(id2, "X", "2026-10-12T08:16:00Z"), false);
  assert.equal(fresh.rows[0].status, "completed");
});

test("P1-5: 利用者の設定で通知しない場合は、印を消して予約し直しをやめる。予約の失敗が続けば印は残る", async () => {
  const store = new MemoryStore(() => new Date("2026-10-12T08:15:00Z"));
  const [a, b] = users(2);
  store.pushDisabled.add(a);
  store.enqueueFails = 2; // a と b の最初の予約が失敗
  await run(store, [a, b]);
  assert.equal(store.rows.filter((row) => row.error?.startsWith(NOTIFICATION_PENDING_MARK)).length, 2);
  store.enqueueFails = 1; // 次の実行の最初の予約（a）も失敗
  const sweep = await sweepNotifications(store, TYPE, DATE, code);
  assert.deepEqual([sweep.queued, sweep.cleared, sweep.failed.length], [1, 1, 1]);
  const again = await sweepNotifications(store, TYPE, DATE, code);
  assert.deepEqual([again.queued, again.cleared], [0, 1], "a は設定で通知しないので印を消して終わり");
  assert.equal(store.notifications.size, 1);
  assert.ok(store.rows.every((row) => row.status === "completed"));
});

// ---------------------------------------------------------------------------------------------
// P1-6: 止まった「生成中」の行
// ---------------------------------------------------------------------------------------------

test(`P1-6: ${STALE_GENERATING_MINUTES}分より古い「生成中」の行だけを引き取り、新しいものは触らない`, async () => {
  let now = new Date("2026-10-12T08:15:00Z");
  const store = new MemoryStore(() => now);
  const all = users(3);
  await run(store, all, { outcome: (userId) => userId === all[1] ? "die" : "completed" });
  assert.equal(store.rows.find((row) => row.user_id === all[1])!.status, "generating");
  now = new Date("2026-10-12T08:25:00Z");
  const early = await run(store, all);
  assert.deepEqual([early.selection.stale, early.processed], [[], []], "10分後: まだ引き取らない");
  now = new Date("2026-10-12T08:46:00Z");
  const late = await run(store, all);
  assert.deepEqual(late.selection.stale.map((item) => item.userId), [all[1]]);
  assert.equal(store.rows.find((row) => row.user_id === all[1])!.status, "completed");
  assert.equal(store.rows.length, 3, "行は増えない（同じ行を引き取る）");
});

test("P1-6: 2つの実行が同時に同じ古い行を引き取ろうとしても、引き取れるのは1つだけ", async () => {
  const store = new MemoryStore(() => new Date("2026-10-12T09:00:00Z"));
  store.rows.push({ id: "old", user_id: "u", report_type: TYPE, trading_date: DATE, status: "generating", updated_at: "2026-10-12T08:15:00Z", error: null, notified_at: null, fact_status: "pending" });
  const now = new Date("2026-10-12T09:00:00Z");
  const [first, second] = await Promise.all([
    claimReport(store, { userId: "u", staleReportId: "old" }, TYPE, DATE, now),
    claimReport(store, { userId: "u", staleReportId: "old" }, TYPE, DATE, now),
  ]);
  assert.deepEqual([first.reason, second.reason].sort(), ["lost_takeover", "taken_over"]);
});

test("P1-6: 元の実行が遅れて終わっても、先に完成した結果を上書きせず、通知も1件だけ", async () => {
  const store = new MemoryStore(() => new Date("2026-10-12T09:00:00Z"));
  const id = (await store.insertGenerating("u", TYPE, DATE))!;
  const first = await finalizeReport(store, id, COMPLETED, code);
  const late = await finalizeReport(store, id, FAILED, code);
  assert.deepEqual([first.saved, late.saved, late.notification], [true, false, "skipped_not_saved"]);
  assert.equal(store.rows[0].status, "completed");
  assert.equal(store.notifications.size, 1);
});

// ---------------------------------------------------------------------------------------------
// PostgREST での実装と index.ts の配線
// ---------------------------------------------------------------------------------------------

test("REST 実装: 保存・失敗の記録・引き取りは、必ず条件（生成中・古さ）付きの1つの更新で行う", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown; prefer?: string }> = [];
  const store = restReportStore({
    get: (path) => { calls.push({ method: "GET", path }); return Promise.resolve([] as never); },
    post: (path, body, prefer) => { calls.push({ method: "POST", path, body, prefer }); return Promise.resolve([] as never); },
    patchReturning: (path, body) => { calls.push({ method: "PATCH", path, body }); return Promise.resolve([{ id: "r1" }] as never); },
  });
  await store.finalize("r1", COMPLETED);
  await store.markFailed("r1", "E", "2026-10-12T09:00:00.000Z");
  await store.takeOverStale("r1", "2026-10-12T08:30:00.000Z", "2026-10-12T09:00:00.000Z");
  await store.insertGenerating("u", TYPE, DATE);
  await store.markNotificationPending("r1", "E");
  await store.listNotificationPending(TYPE, DATE, 20);
  const paths = calls.map((call) => `${call.method} ${call.path}`);
  assert.ok(paths[0].startsWith("PATCH personalized_reports?id=eq.r1&status=eq.generating"), paths[0]);
  assert.ok(paths[1].startsWith("PATCH personalized_reports?id=eq.r1&status=eq.generating"), paths[1]);
  assert.ok(paths[2].includes("status=eq.generating") && paths[2].includes("updated_at=lt.2026-10-12T08%3A30%3A00.000Z"), paths[2]);
  assert.equal(calls[3].prefer, "resolution=ignore-duplicates,return=representation");
  assert.ok(paths[4].includes("status=eq.completed") && paths[4].includes("notified_at=is.null"), paths[4]);
  assert.ok(paths[5].includes("notified_at=is.null") && paths[5].includes(`error=like.${encodeURIComponent(`${NOTIFICATION_PENDING_MARK}*`)}`), paths[5]);
});

test("index.ts の配線: 全員から未処理の人を選び、保存と通知は finalizeReport、失敗の記録は「生成中」の行だけ", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.ok(!source.includes("[...byUser.keys()].slice(0, MAX_USERS_PER_RUN)"), "全員の先頭20人に固定しない");
  assert.ok(source.includes("selectRunUsers(candidates, dryRun ? [] : await store.listRows(reportType, tradingDate, onlyUser), now)"));
  assert.ok(source.includes("claimReport(store, pick, reportType, tradingDate, new Date())"));
  assert.ok(source.includes("finalizeReport(store, reportId, update, safeError)"));
  assert.ok(source.includes("if (reportId && !finalized) await store.markFailed(reportId, code, new Date().toISOString())"));
  assert.ok(source.includes("sweepNotifications(store, reportType, tradingDate, safeError)"));
  assert.ok(!/db\.patch\(`personalized_reports\?id=eq\.\$\{reportId\}`/.test(source), "条件の無い PATCH は残っていない");
  assert.ok(source.includes("remaining_users: selection.remaining"), "残りの人数を返す（次の実行の判断に使える）");
  assert.ok(source.includes("const notificationSweep = dryRun\n      ? null"), "dry run では予約し直さない");
});
