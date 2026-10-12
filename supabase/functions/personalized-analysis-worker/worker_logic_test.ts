// worker の1回の実行を、DB の RPC と同じ規則の手元の模型（MemStore）で確かめる。
// 模型の規則は migration の claim / complete / fail / enqueue / mark と同じ:
//   先着順、同時に動かせる数の上限、引き取りごとに新しい token と版、期限切れは版を進めて待ち行列へ戻す
//   （回数を使い切れば failed）、完了は token・版・期限がすべて一致するときだけ、通知は1ジョブ1件。
// SQL そのものの同じ性質は supabase/tests/personalized_ondemand_analysis_run.sh（手元の PostgreSQL）で確かめている。
import assert from "node:assert/strict";
import test from "node:test";
import {
  runWorker,
  MIN_LEASE_REMAINING_MS,
  type AnalysisResult,
  type AnalyzeOutcome,
  type ClaimedJob,
  type WorkerStore,
} from "./worker_logic.ts";
import { rpcStore } from "./store.ts";

type Job = {
  id: string;
  user: string;
  status: "queued" | "processing" | "completed" | "failed";
  attempt: number;
  max: number;
  token: string | null;
  version: number;
  expiresAt: number | null;
  availableAt: number;
  requestedAt: number;
  completedAt: number | null;
  error: string | null;
  notify: "not_required" | "pending" | "queued" | "skipped" | "failed";
  notifyAttempts: number;
  push: boolean;
};

class MemStore implements WorkerStore {
  jobs = new Map<string, Job>();
  results = new Map<string, AnalysisResult>();
  notifications = new Map<string, number>();
  enqueueFailures = 0;
  private seq = 0;
  constructor(public clock: { now: number }, public capacity = 4, public leaseMs = 300_000) {}

  add(user: string, push = true, max = 2): string {
    const id = `job-${String(++this.seq).padStart(6, "0")}-0000-0000-000000000000`.slice(0, 36);
    this.jobs.set(id, {
      id, user, status: "queued", attempt: 0, max, token: null, version: 0, expiresAt: null,
      availableAt: this.clock.now, requestedAt: this.clock.now + this.seq / 1000, completedAt: null, error: null,
      notify: "not_required", notifyAttempts: 0, push,
    });
    return id;
  }

  claim(limit: number): Promise<ClaimedJob[]> {
    const now = this.clock.now;
    for (const job of this.jobs.values()) {
      if (job.status === "processing" && job.expiresAt! < now) {
        const exhausted = job.attempt >= job.max;
        Object.assign(job, {
          status: exhausted ? "failed" : "queued", error: exhausted ? "LEASE_EXPIRED_ATTEMPTS_EXHAUSTED" : "LEASE_EXPIRED",
          token: null, expiresAt: null, version: job.version + 1, availableAt: now,
        });
      }
    }
    const running = [...this.jobs.values()].filter((job) => job.status === "processing").length;
    const slots = Math.min(Math.max(limit, 0), 20, Math.max(this.capacity - running, 0));
    const picked = [...this.jobs.values()]
      .filter((job) => job.status === "queued" && job.availableAt <= now)
      .sort((a, b) => a.requestedAt - b.requestedAt)
      .slice(0, slots);
    return Promise.resolve(picked.map((job) => {
      Object.assign(job, {
        status: "processing", attempt: job.attempt + 1, token: crypto.randomUUID(), version: job.version + 1,
        expiresAt: now + this.leaseMs, error: null,
      });
      return {
        job_id: job.id, user_id: job.user, scope: "latest", request_date: "2026-10-09", model_tier: "standard",
        attempt_count: job.attempt, max_attempts: job.max, lease_token: job.token!, lease_version: job.version,
        lease_expires_at: new Date(job.expiresAt!).toISOString(),
      } satisfies ClaimedJob;
    }));
  }

  complete(claimed: ClaimedJob, result: AnalysisResult): Promise<string> {
    const job = this.jobs.get(claimed.job_id)!;
    if (job.status !== "processing" || job.token !== claimed.lease_token || job.version !== claimed.lease_version ||
      job.expiresAt! < this.clock.now) return Promise.resolve("lease_lost");
    assert.ok(!this.results.has(job.id), "a job never gets a second result");
    this.results.set(job.id, result);
    Object.assign(job, {
      status: "completed", completedAt: this.clock.now, token: null, expiresAt: null, version: job.version + 1, notify: "pending",
    });
    return Promise.resolve("completed");
  }

  fail(claimed: ClaimedJob, code: string, retryable: boolean): Promise<string> {
    const job = this.jobs.get(claimed.job_id)!;
    if (job.status !== "processing" || job.token !== claimed.lease_token || job.version !== claimed.lease_version ||
      job.expiresAt! < this.clock.now) {
      return Promise.resolve("lease_lost");
    }
    const final = !retryable || job.attempt >= job.max;
    Object.assign(job, {
      status: final ? "failed" : "queued", error: code, token: null, expiresAt: null, version: job.version + 1,
      availableAt: this.clock.now + 60_000 * job.attempt,
    });
    return Promise.resolve(final ? "failed" : "requeued");
  }

  pendingNotifications(limit: number): Promise<string[]> {
    return Promise.resolve([...this.jobs.values()]
      .filter((job) => job.status === "completed" && (job.notify === "pending" || job.notify === "failed") && job.notifyAttempts < 3)
      .sort((a, b) => a.completedAt! - b.completedAt!)
      .slice(0, limit)
      .map((job) => job.id));
  }

  enqueueNotification(id: string): Promise<string> {
    if (this.enqueueFailures > 0) {
      this.enqueueFailures -= 1;
      return Promise.reject(new Error("REST_RPC_FAILED:enqueue_personalized_analysis_notification:503"));
    }
    const job = this.jobs.get(id)!;
    if (job.status !== "completed") return Promise.resolve("not_completed");
    if (job.notify === "queued" || job.notify === "skipped") return Promise.resolve(job.notify);
    job.notifyAttempts += 1;
    if (!job.push) {
      job.notify = "skipped";
      return Promise.resolve("skipped");
    }
    const fresh = !this.notifications.has(id);
    if (fresh) this.notifications.set(id, 1);
    job.notify = "queued";
    return Promise.resolve(fresh ? "queued" : "already_queued");
  }

  markNotificationFailed(id: string): Promise<void> {
    const job = this.jobs.get(id)!;
    if (job.status === "completed" && (job.notify === "pending" || job.notify === "failed")) {
      job.notify = "failed";
      job.notifyAttempts += 1;
    }
    return Promise.resolve();
  }
}

function result(job: ClaimedJob): AnalysisResult {
  return {
    title_ja: `分析 ${job.user_id}`, summary_ja: "", body: {}, portfolio_snapshot: {}, source_basis: { job: job.job_id },
    fact_status: "passed", model_used: "m", input_tokens: 1, output_tokens: 1, api_cost_usd: 0,
    reference_report_packet_id: "p", reference_data_packet_id: null, report_type: "close", trading_date: "2026-10-09",
  };
}

const ok = (job: ClaimedJob): Promise<AnalyzeOutcome> => Promise.resolve({ kind: "completed", result: result(job), calls: 2 });

function setup(capacity = 4) {
  const clock = { now: Date.parse("2026-10-09T07:00:00Z") };
  return { clock, store: new MemStore(clock, capacity) };
}

test("引き取った token と版で完了し、完成した結果ごとに通知を1件だけ予約する", async () => {
  const { clock, store } = setup();
  const a = store.add("user-a");
  const b = store.add("user-b", false);
  const seen: ClaimedJob[] = [];
  const report = await runWorker(store, (job) => { seen.push(job); return ok(job); }, { now: () => clock.now });
  assert.equal(report.claimed, 2);
  assert.deepEqual(seen.map((job) => [job.job_id, job.lease_version, job.attempt_count]), [[a, 1, 1], [b, 1, 1]]);
  assert.deepEqual(report.jobs.map((job) => job.outcome), ["completed", "completed"]);
  assert.deepEqual(report.notifications, { queued: 1, skipped: 1, already: 0, failed: 0 });
  assert.deepEqual([...store.notifications.keys()], [a], "通知 OFF の人には予約しない");
  // 次の実行は何もしない（二重の通知なし）。
  const again = await runWorker(store, ok, { now: () => clock.now });
  assert.equal(again.claimed, 0);
  assert.deepEqual(again.notifications, { queued: 0, skipped: 0, already: 0, failed: 0 });
});

test("遅れて終わった worker: 期限が切れて別の worker が引き取り直して完成させたら、元の結果は捨てられる", async () => {
  const { clock, store } = setup();
  const id = store.add("user-a");
  let release!: (value: AnalyzeOutcome) => void;
  let slowJob!: ClaimedJob;
  const slow = runWorker(store, (job) => {
    slowJob = job;
    return new Promise<AnalyzeOutcome>((resolve) => { release = resolve; });
  }, { now: () => clock.now });
  await new Promise((resolve) => setTimeout(resolve, 0));
  clock.now += 301_000; // 貸し出しの期限切れ
  const second = await runWorker(store, ok, { now: () => clock.now });
  assert.deepEqual(second.jobs.map((job) => job.outcome), ["completed"]);
  assert.equal(store.jobs.get(id)!.attempt, 2);
  release({ kind: "completed", result: { ...result(slowJob), title_ja: "古い結果" }, calls: 2 });
  const first = await slow;
  assert.deepEqual(first.jobs.map((job) => job.outcome), ["lease_lost"]);
  assert.equal(store.results.size, 1);
  assert.notEqual(store.results.get(id)!.title_ja, "古い結果");
  assert.equal(store.notifications.get(id), 1, "通知は1件だけ");
});

test("遅れて終わった worker の失敗の記録も、引き取り直された行には効かない", async () => {
  const { clock, store } = setup();
  const id = store.add("user-a");
  let release!: (value: AnalyzeOutcome) => void;
  const slow = runWorker(store, () => new Promise<AnalyzeOutcome>((resolve) => { release = resolve; }), { now: () => clock.now });
  await new Promise((resolve) => setTimeout(resolve, 0));
  clock.now += 301_000;
  await runWorker(store, ok, { now: () => clock.now });
  release({ kind: "failed", code: "REPORT_FACT_FAILED", retryable: false, calls: 2 });
  assert.deepEqual((await slow).jobs.map((job) => job.outcome), ["lease_lost"]);
  assert.equal(store.jobs.get(id)!.status, "completed");
});

for (const late of [
  { name: "再試行できる失敗", outcome: (): Promise<AnalyzeOutcome> => Promise.resolve({ kind: "failed", code: "REPORT_FACT_FAILED", retryable: true, calls: 2 }) },
  { name: "再試行しない失敗", outcome: (): Promise<AnalyzeOutcome> => Promise.resolve({ kind: "failed", code: "NO_TRACKED_STOCKS", retryable: false, calls: 0 }) },
  { name: "例外", outcome: (): Promise<AnalyzeOutcome> => Promise.reject(new Error("REST_GET_FAILED:tracked_stocks:503")) },
]) {
  test(`期限切れのあと、引き取り直す前の失敗の記録（${late.name}）は効かず、行は変わらない。次の引き取りで1回だけ取り直す`, async () => {
    const { clock, store } = setup();
    const id = store.add("user-a");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = runWorker(store, () => gate.then(late.outcome), { now: () => clock.now });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = { ...store.jobs.get(id)! };
    clock.now += 301_000; // 期限切れ（まだ誰も引き取り直していない）
    release();
    const first = await slow;
    assert.deepEqual(first.jobs.map((job) => job.outcome), ["lease_lost"]);
    assert.deepEqual(store.jobs.get(id), before, "状態・回数・token・版・期限・失敗のコードは変わらない");
    const second = await runWorker(store, ok, { now: () => clock.now });
    assert.deepEqual(second.jobs.map((job) => job.outcome), ["completed"]);
    assert.equal(store.jobs.get(id)!.attempt, 2);
    assert.equal(store.results.size, 1);
    assert.equal(store.notifications.get(id), 1);
    assert.equal((await runWorker(store, ok, { now: () => clock.now })).claimed, 0, "取り直しは1回だけ");
  });
}

test("途中で止まった worker（何も書かずに消えた）: 期限切れのあと次の実行が引き取り直して完成させる", async () => {
  const { clock, store } = setup();
  const id = store.add("user-a");
  await store.claim(4); // 引き取ったまま worker が落ちた
  assert.equal((await runWorker(store, ok, { now: () => clock.now })).claimed, 0, "期限内は誰も引き取らない");
  clock.now += 301_000;
  const report = await runWorker(store, ok, { now: () => clock.now });
  assert.deepEqual(report.jobs.map((job) => job.outcome), ["completed"]);
  assert.equal(store.jobs.get(id)!.attempt, 2);
  assert.equal(store.notifications.get(id), 1);
});

test("処理中の例外は再試行（待ち時間つき）、回数を使い切ったら failed。失敗は通知しない", async () => {
  const { clock, store } = setup();
  const id = store.add("user-a");
  const boom = () => Promise.reject(new Error("REST_GET_FAILED:tracked_stocks:503"));
  const first = await runWorker(store, boom, { now: () => clock.now });
  assert.deepEqual(first.jobs.map((job) => [job.outcome, job.code]), [["requeued", "REST_GET_FAILED:tracked_stocks:503"]]);
  assert.equal((await runWorker(store, boom, { now: () => clock.now })).claimed, 0, "待ち時間の間は引き取らない");
  clock.now += 61_000;
  const second = await runWorker(store, boom, { now: () => clock.now });
  assert.deepEqual(second.jobs.map((job) => job.outcome), ["failed"]);
  assert.equal(store.jobs.get(id)!.status, "failed");
  assert.equal(store.notifications.size, 0);
});

test("例外の文章（秘密情報を含みうる）は記録せず、固定のコードにする", async () => {
  const { clock, store } = setup();
  const id = store.add("user-a");
  await runWorker(store, () => Promise.reject(new Error("Authorization: Bearer sk-secret failed")), { now: () => clock.now });
  assert.equal(store.jobs.get(id)!.error, "ANALYSIS_UNEXPECTED_ERROR");
});

test("再試行しない失敗は1回目で failed。再試行できる失敗の返り値も、分類で上書きされる", async () => {
  const { clock, store } = setup();
  const a = store.add("user-a");
  const b = store.add("user-b");
  await runWorker(store, (job) => Promise.resolve(job.job_id === a
    ? { kind: "failed", code: "NO_TRACKED_STOCKS", retryable: true, calls: 0 }
    : { kind: "failed", code: "MARKET_REPORT_NOT_READY", retryable: true, calls: 0 }), { now: () => clock.now });
  assert.equal(store.jobs.get(a)!.status, "failed");
  assert.equal(store.jobs.get(b)!.status, "queued");
});

test("貸し出しの残りが短いジョブは、AI を呼ばずに待ち行列へ戻す", async () => {
  const clock = { now: Date.parse("2026-10-09T07:00:00Z") };
  const store = new MemStore(clock, 4, MIN_LEASE_REMAINING_MS - 1_000);
  store.add("user-a");
  let called = 0;
  const report = await runWorker(store, (job) => { called += 1; return ok(job); }, { now: () => clock.now });
  assert.equal(called, 0);
  assert.deepEqual(report.jobs.map((job) => job.outcome), ["skipped_short_lease"]);
});

test("通知の予約の失敗: 完成した結果はそのまま。印を付け、次の実行で1回だけ予約する", async () => {
  const { clock, store } = setup();
  const id = store.add("user-a");
  store.enqueueFailures = 1;
  const first = await runWorker(store, ok, { now: () => clock.now });
  assert.deepEqual(first.notifications, { queued: 0, skipped: 0, already: 0, failed: 1 });
  assert.equal(store.jobs.get(id)!.status, "completed");
  assert.ok(store.results.has(id));
  assert.equal(store.jobs.get(id)!.notify, "failed");
  const second = await runWorker(store, ok, { now: () => clock.now });
  assert.deepEqual(second.notifications, { queued: 1, skipped: 0, already: 0, failed: 0 });
  assert.equal(store.notifications.get(id), 1);
  const third = await runWorker(store, ok, { now: () => clock.now });
  assert.deepEqual(third.notifications, { queued: 0, skipped: 0, already: 0, failed: 0 });
});

test("通知の予約がずっと失敗しても、3回で予約をやめる（無限に繰り返さない）", async () => {
  const { clock, store } = setup();
  const id = store.add("user-a");
  store.enqueueFailures = 100;
  for (let run = 0; run < 6; run += 1) await runWorker(store, ok, { now: () => clock.now });
  assert.equal(store.jobs.get(id)!.notifyAttempts, 3);
  assert.equal(store.jobs.get(id)!.status, "completed");
  assert.equal(store.enqueueFailures, 97);
});

test("引き取りの失敗はそのまま例外（Edge は 500 を返す）。ジョブには触れない", async () => {
  const { clock, store } = setup();
  const id = store.add("user-a");
  const broken: WorkerStore = {
    claim: () => Promise.reject(new Error("REST_RPC_FAILED:claim:503")),
    complete: store.complete.bind(store),
    fail: store.fail.bind(store),
    pendingNotifications: store.pendingNotifications.bind(store),
    enqueueNotification: store.enqueueNotification.bind(store),
    markNotificationFailed: store.markNotificationFailed.bind(store),
  };
  await assert.rejects(runWorker(broken, ok, { now: () => clock.now }), /REST_RPC_FAILED/);
  assert.equal(store.jobs.get(id)!.status, "queued");
});

for (const users of [100, 1000]) {
  test(`公平さ（${users}人）: 依頼の順に、全員がちょうど1回ずつ完成し、同時に動くのは上限まで`, async () => {
    const { clock, store } = setup(4);
    const ids = Array.from({ length: users }, (_, index) => store.add(`user-${index}`, index % 3 !== 0));
    const order: string[] = [];
    let running = 0;
    let peak = 0;
    const analyze = async (job: ClaimedJob): Promise<AnalyzeOutcome> => {
      running += 1;
      peak = Math.max(peak, running);
      order.push(job.job_id);
      await new Promise((resolve) => setTimeout(resolve, 0));
      running -= 1;
      return { kind: "completed", result: result(job), calls: 2 };
    };
    let runs = 0;
    while ([...store.jobs.values()].some((job) => job.status !== "completed")) {
      // 2つの worker が同時に動いても（Cron の重なり）、上限と先着順は崩れない。
      await Promise.all([
        runWorker(store, analyze, { batch: 4, now: () => clock.now }),
        runWorker(store, analyze, { batch: 4, now: () => clock.now }),
      ]);
      runs += 1;
      assert.ok(runs <= users, "必ず終わる");
    }
    assert.deepEqual(order, ids, "依頼の順（先着順）");
    assert.ok(peak <= 4, `同時に動いた数 ${peak}`);
    assert.equal(store.results.size, users);
    assert.equal(new Set([...store.results.values()].map((value) => value.title_ja)).size, users, "1人1件");
    assert.equal(store.notifications.size, ids.filter((_, index) => index % 3 !== 0).length);
    assert.ok([...store.notifications.values()].every((count) => count === 1));
  });
}

test("DB との境界: 状態の変更はすべて RPC に token と版を添えて渡し、通知の一覧は回数の上限つき", async () => {
  const calls: Array<[string, unknown]> = [];
  const db = {
    get<T>(path: string) { calls.push(["get", path]); return Promise.resolve([{ id: "j1" }] as T); },
    rpc<T>(name: string, args: Record<string, unknown>) {
      calls.push([name, args]);
      return Promise.resolve((name === "claim_personalized_analysis_jobs" ? [] : { status: "completed" }) as T);
    },
  };
  const store = rpcStore(db);
  const job: ClaimedJob = {
    job_id: "j1", user_id: "u1", scope: "latest", request_date: "2026-10-09", model_tier: "standard", attempt_count: 1,
    max_attempts: 2, lease_token: "tok", lease_version: 7, lease_expires_at: "2026-10-09T07:05:00Z",
  };
  assert.deepEqual(await store.claim(3), []);
  assert.equal(await store.complete(job, result(job)), "completed");
  await store.fail(job, "X", true);
  assert.deepEqual(await store.pendingNotifications(50), ["j1"]);
  await store.enqueueNotification("j1");
  await store.markNotificationFailed("j1");
  assert.deepEqual(calls.map(([name]) => name), [
    "claim_personalized_analysis_jobs", "complete_personalized_analysis_job", "fail_personalized_analysis_job", "get",
    "enqueue_personalized_analysis_notification", "mark_personalized_analysis_notification_failed",
  ]);
  assert.deepEqual(calls[0][1], { p_limit: 3 });
  assert.equal((calls[1][1] as Record<string, unknown>).p_lease_token, "tok");
  assert.equal((calls[1][1] as Record<string, unknown>).p_lease_version, 7);
  assert.deepEqual(calls[2][1], { p_job_id: "j1", p_lease_token: "tok", p_lease_version: 7, p_error_code: "X", p_retryable: true });
  assert.match(String(calls[3][1]), /notify_status=in\.\(pending,failed\)&notify_attempt_count=lt\.3/);
});
