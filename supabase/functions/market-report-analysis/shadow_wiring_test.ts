// 市況レポートの handler と、G6 の Claude 比較処理（shadow、既定 OFF）のつなぎ目の確認（Phase 2c、G2）。
// 本物の handleRequest・openAiRequester・generateSharedAnalysis を、手元の模型の通信（OpenAI・Anthropic・台帳・DB）で動かす。
// 本物の API・鍵・DB には一切つながない。ほかの宛先へ出たらテストは失敗する。
import assert from "node:assert/strict";
import test from "node:test";
import { type Deps, handleRequest, SHADOW_WALL_CLOCK_MS, shadowLogRecord } from "./handler.ts";
import { buildAnalysisInput } from "./analysis_input.ts";
import { rich0917 } from "./test_support.ts";
import { anthropicBody, anthropicError, FAKE_ANTHROPIC_KEY, jsonResponse } from "../_shared/ai_provider/test_support.ts";
import { MIN_SHADOW_WINDOW_MS, SHADOW_DEADLINE_MARGIN_MS } from "../_shared/ai_provider/market_report_wiring.ts";

const directory = new URL("./fixtures/", import.meta.url);
const dataFixture = JSON.parse(await Deno.readTextFile(new URL("close_2026-09-17_data_packet.json", directory)));
const newsRows = JSON.parse(await Deno.readTextFile(new URL("close_2026-09-17_news_rows.json", directory)));
const SUPABASE = "https://project-ref.supabase.co";
const SECRET = "cron-secret-for-tests";
const SERVICE_KEY = "service-secret-NOT-REAL";
const OPENAI_KEY = "openai-test-key-NOT-REAL";
const START = Date.parse("2026-09-17T07:20:00Z");

type Call = { seq: number; url: string; path: string; body: Record<string, unknown> | null };

function analysisPayload() {
  return rich0917(buildAnalysisInput({
    dataPacket: dataFixture.payload, dataPacketId: dataFixture.id, dataContentHash: dataFixture.content_hash, newsRows,
  }));
}

type Options = {
  mode?: string;
  model?: string | null;
  anthropicKey?: string | null;
  waitUntil?: "capture" | "absent" | "throws";
  claimOutcome?: string;
  dataQuality?: string;
  openAiStatus?: number;
  /** 生成は返るが、中身が使えない（generateSharedAnalysis が outcome.ok=false を返す）。 */
  badGeneration?: boolean;
  completeStatus?: number;
  anthropic?: "ok" | 429 | 529;
  ledgerDeny?: string;
  ledger?: FakeLedger;
  logThrows?: boolean;
  /** 完了の記録が呼ばれたときに、時計をこれだけ進める（生成に時間がかかった日を作る）。 */
  elapsedAtCompleteMs?: number;
  /** Anthropic への依頼を、この Promise が解けるまで止めておく（応答が比較処理を待たないことを見る）。 */
  holdAnthropic?: Promise<void>;
  /** trace を書いたあとは、時計を読むと例外（比較処理の中の例外を作る）。 */
  clockThrowsAfterTrace?: boolean;
};

class FakeLedger {
  byAttempt = new Map<string, { id: string; status: string }>();
  rpcs: string[] = [];
  #n = 0;
  handle(name: string, p: Record<string, unknown>, deny?: string): Response {
    this.rpcs.push(name);
    if (name === "ai_ledger_reserve") {
      if (deny) return jsonResponse(200, { allowed: false, reason: deny, policy_key: "anthropic.opus.kabumori.market_report.monthly" });
      const key = `${p.request_id}#${p.attempt}`;
      const existing = this.byAttempt.get(key);
      if (existing) {
        return jsonResponse(200, existing.status === "reserved"
          ? { allowed: true, reservation_id: existing.id, status: "reserved", reused: true }
          : { allowed: false, reservation_id: existing.id, status: existing.status, reason: "ATTEMPT_FINALIZED" });
      }
      const id = `00000000-0000-4000-8000-${String(++this.#n).padStart(12, "0")}`;
      this.byAttempt.set(key, { id, status: "reserved" });
      return jsonResponse(200, { allowed: true, reservation_id: id, status: "reserved", reused: false });
    }
    const entry = [...this.byAttempt.values()].find((value) => value.id === p.reservation_id);
    if (!entry) return jsonResponse(400, { code: "P0001", message: "AI_LEDGER_UNKNOWN_RESERVATION" });
    if (name === "ai_ledger_mark_sent") {
      if (entry.status !== "reserved") return jsonResponse(200, { status: entry.status, may_send: false });
      entry.status = "sent";
      return jsonResponse(200, { status: "sent", may_send: true });
    }
    if (name === "ai_ledger_settle") {
      entry.status = "settled";
      return jsonResponse(200, { status: "settled", duplicate: false });
    }
    if (name === "ai_ledger_release") {
      if (entry.status === "reserved") entry.status = "released";
      return jsonResponse(200, { status: entry.status });
    }
    return jsonResponse(404, { code: "PGRST202" });
  }
}

function harness(options: Options = {}) {
  const calls: Call[] = [];
  const envReads: string[] = [];
  const logs: string[] = [];
  const pending: Promise<unknown>[] = [];
  let seq = 0;
  let clockMs = START;
  let clockBroken = false;
  const ledger = options.ledger ?? new FakeLedger();
  const fetchMock: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const path = url.startsWith(`${SUPABASE}/rest/v1/`) ? url.slice(`${SUPABASE}/rest/v1/`.length) : url;
    calls.push({ seq: ++seq, url, path, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url === "https://api.openai.com/v1/responses") {
      if (options.openAiStatus) return json({ error: { message: "x" } }, options.openAiStatus);
      const isFact = String(body?.instructions).includes("Factチェッカー");
      const payload = isFact ? { passed: true, issues: [] } : options.badGeneration ? {} : analysisPayload();
      return json({ output: [{ content: [{ type: "output_text", text: JSON.stringify(payload) }] }], usage: { input_tokens: 900, output_tokens: 300 } });
    }
    if (url.startsWith("https://api.anthropic.com/")) {
      if (options.holdAnthropic) await options.holdAnthropic;
      if (options.anthropic === 429) return jsonResponse(429, anthropicError(429, "rate_limit_error", "slow down"));
      if (options.anthropic === 529) return jsonResponse(529, anthropicError(529, "overloaded_error", "overloaded"));
      return jsonResponse(200, anthropicBody(analysisPayload()));
    }
    if (!url.startsWith(`${SUPABASE}/rest/v1/`)) throw new Error(`UNEXPECTED_HOST:${url}`);
    if (path.startsWith("rpc/ai_ledger_")) {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("apikey"), SERVICE_KEY);
      // 台帳の RPC は引数を {"p": {...}} の形で受け取る。
      return ledger.handle(path.slice(4), (body?.p ?? {}) as Record<string, unknown>, options.ledgerDeny);
    }
    if (path.startsWith("market_holidays")) return json([{ holiday_date: "2026-09-21" }]);
    if (path === "rpc/claim_market_report_analysis") {
      const outcome = options.claimOutcome ?? "claimed";
      return json([{
        cycle_id: outcome === "data_not_ready" ? null : "11111111-1111-4111-8111-111111111111",
        claim_token: outcome === "claimed" ? "22222222-2222-4222-8222-222222222222" : null,
        attempt: 1, outcome, data_packet_id: outcome === "data_not_ready" ? null : dataFixture.id,
      }]);
    }
    if (path.startsWith("market_data_packets")) {
      return json([{ id: dataFixture.id, content_hash: dataFixture.content_hash, payload: dataFixture.payload, data_quality_status: options.dataQuality ?? "partial" }]);
    }
    if (path.startsWith("important_news_candidates")) return json(newsRows);
    if (path === "rpc/complete_market_report_analysis") {
      clockMs += options.elapsedAtCompleteMs ?? 0;
      if (options.completeStatus) return json({ message: "x" }, options.completeStatus);
      return json("33333333-3333-4333-8333-333333333333");
    }
    if (path === "rpc/fail_market_report_analysis") return json("failed");
    if (path === "market_report_generation_traces") {
      if (options.clockThrowsAfterTrace) clockBroken = true;
      return new Response(null, { status: 201 });
    }
    throw new Error(`UNEXPECTED_PATH:${path}`);
  };
  const env: Record<string, string> = {
    SUPABASE_URL: SUPABASE,
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }),
    SEND_PUSH_NOTIFICATIONS_CRON_SECRET: SECRET,
    OPENAI_API_KEY: OPENAI_KEY,
  };
  if (options.mode !== undefined) env.KABUMORI_MARKET_REPORT_AI_MODE = options.mode;
  if (options.model !== null) env.KABUMORI_MARKET_REPORT_SHADOW_MODEL = options.model ?? "claude-opus-5-5";
  if (options.anthropicKey !== null) env.ANTHROPIC_API_KEY = options.anthropicKey ?? FAKE_ANTHROPIC_KEY;
  const deps: Deps = {
    env: (name) => {
      envReads.push(name);
      return env[name];
    },
    fetch: fetchMock,
    now: () => {
      if (clockBroken) throw new Error("clock down");
      return new Date(clockMs);
    },
    log: (line) => {
      if (options.logThrows) throw new Error("log down");
      logs.push(line);
    },
  };
  const waitUntilMode = options.waitUntil ?? "capture";
  if (waitUntilMode === "capture") deps.waitUntil = (promise) => { pending.push(promise); };
  if (waitUntilMode === "throws") deps.waitUntil = () => { throw new Error("waitUntil unavailable"); };
  return {
    calls, envReads, logs, pending, deps, ledger,
    advance: (ms: number) => { clockMs += ms; },
    shadowCalls: () => calls.filter((call) => call.url.startsWith("https://api.anthropic.com/") || call.path.startsWith("rpc/ai_ledger_")),
    complete: () => calls.find((call) => call.path === "rpc/complete_market_report_analysis"),
  };
}

const request = (body: unknown, secret = SECRET) =>
  new Request("https://functions.local/market-report-analysis", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Cron-Secret": secret }, body: JSON.stringify(body),
  });

async function settle(promises: Promise<unknown>[]) {
  await Promise.all(promises);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 既定（OFF、waitUntil なし）の結果。これと一致することを確かめる。 */
async function baseline() {
  const h = harness({ waitUntil: "absent" });
  const body = await (await handleRequest(request({ mode: "close" }), h.deps)).json();
  return {
    body,
    complete: h.complete()!.body,
    openai: h.calls.filter((call) => call.url.includes("openai")).map((call) => call.body),
  };
}

// ---------------------------------------------------------------------------
// (a) OFF・不正な設定・waitUntil なし: 応答・保存・費用・OpenAI への依頼がまったく同じ。台帳・Anthropic へは0
// ---------------------------------------------------------------------------

for (const [label, options] of [
  ["mode 未設定", {}],
  ["mode=off", { mode: "off" }],
  ["mode が不明な値", { mode: "SHADOW!" }],
  ["shadow だがモデル未設定", { mode: "shadow", model: null }],
  ["shadow だが Anthropic の鍵なし", { mode: "shadow", anthropicKey: null }],
  ["shadow だがカタログに無いモデル", { mode: "shadow", model: "gpt-6-luna" }],
  ["shadow だが waitUntil が無い", { mode: "shadow", waitUntil: "absent" }],
] as const) {
  test(`(a) ${label}: 今の OpenAI の生成と公開がそのまま。比較処理の通信・台帳は0`, async () => {
    const before = await baseline();
    const h = harness(options as Options);
    const body = await (await handleRequest(request({ mode: "close" }), h.deps)).json();
    await settle(h.pending);
    assert.deepEqual(body, before.body, "応答の本文が同じ");
    assert.deepEqual(h.complete()!.body, before.complete, "保存する packet・診断・費用（OpenAI だけ）が同じ");
    assert.deepEqual(h.calls.filter((call) => call.url.includes("openai")).map((call) => call.body), before.openai, "OpenAI への依頼が同じ");
    assert.deepEqual(h.shadowCalls(), [], "Anthropic・台帳へは0");
    assert.equal(h.pending.length, 0, "waitUntil に何も渡さない");
    assert.ok(!h.calls.some((call) => call.path === "rpc/fail_market_report_analysis"));
  });
}

test("(a) OFF では、比較処理のための設定（モデル・Anthropic の鍵）を読まない", async () => {
  const h = harness({});
  await handleRequest(request({ mode: "close" }), h.deps);
  assert.ok(!h.envReads.includes("ANTHROPIC_API_KEY"));
  assert.ok(!h.envReads.includes("KABUMORI_MARKET_REPORT_SHADOW_MODEL"));
  assert.deepEqual([...new Set(h.envReads)].sort(), [
    "KABUMORI_MARKET_REPORT_AI_MODE", "OPENAI_API_KEY", "SEND_PUSH_NOTIFICATIONS_CRON_SECRET", "SUPABASE_SECRET_KEYS", "SUPABASE_URL",
  ]);
});

// ---------------------------------------------------------------------------
// (b) shadow: 完了の記録と trace のあとでだけ比較処理。応答は比較処理を待たない。公開・費用は OpenAI だけ
// ---------------------------------------------------------------------------

test("(b) shadow: 応答は比較処理を待たずに返り、完了の記録と trace のあとで Anthropic へ1回だけ送る", async () => {
  const before = await baseline();
  let releaseAnthropic!: () => void;
  const hold = new Promise<void>((resolve) => { releaseAnthropic = resolve; });
  const h = harness({ mode: "shadow", holdAnthropic: hold });
  const response = await handleRequest(request({ mode: "close" }), h.deps);
  const body = await response.json();
  // Anthropic への依頼が止まっていても、応答はもう返っている（比較処理は waitUntil の中）。
  assert.equal(h.pending.length, 1);
  let flushed = false;
  void h.pending[0].then(() => { flushed = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(flushed, false, "比較処理は終わっていない");
  assert.deepEqual(body, before.body, "応答の本文は OFF と同じ");
  assert.deepEqual(h.complete()!.body, before.complete, "保存する packet・診断・費用は OFF と同じ（Claude の費用は入らない）");
  releaseAnthropic();
  await settle(h.pending);
  assert.equal(flushed, true);
  const anthropic = h.calls.filter((call) => call.url.startsWith("https://api.anthropic.com/"));
  assert.equal(anthropic.length, 1, "生成の最後の1回だけ");
  const completeSeq = h.complete()!.seq;
  const traceSeq = h.calls.find((call) => call.path === "market_report_generation_traces")!.seq;
  const firstShadow = Math.min(...h.shadowCalls().map((call) => call.seq));
  assert.ok(completeSeq < firstShadow && traceSeq < firstShadow, "完了の記録と trace が先");
  assert.deepEqual(h.ledger.rpcs, ["ai_ledger_reserve", "ai_ledger_mark_sent", "ai_ledger_settle"]);
  assert.equal(h.calls.filter((call) => call.url.includes("openai")).length, 2, "OpenAI への追加の依頼は無い");
  assert.ok(!h.calls.some((call) => call.path === "rpc/fail_market_report_analysis"));
});

test("(b) ログ: 比較処理の記録は識別子と数値だけ（プロンプト・本文・ニュース・鍵を出さない）", async () => {
  const h = harness({ mode: "shadow" });
  await handleRequest(request({ mode: "close" }), h.deps);
  await settle(h.pending);
  const events = h.logs.map((line) => JSON.parse(line)).filter((event) => event.event === "market_report_shadow");
  assert.deepEqual(events.map((event) => event.phase), ["call", "flush"]);
  assert.equal(events[0].ok, true, JSON.stringify(events[0]));
  assert.equal(events[1].attempted, 1);
  const text = h.logs.join("\n");
  const headline = String((analysisPayload() as { headline_ja?: string }).headline_ja ?? "");
  for (const secret of [OPENAI_KEY, SERVICE_KEY, FAKE_ANTHROPIC_KEY, "instructions", "Factチェッカー", headline]) {
    if (secret) assert.ok(!text.includes(secret), `ログに ${secret.slice(0, 12)} が出ない`);
  }
  // 送信先から返った文字（識別子でないもの）は REDACTED に置き換える。
  const redacted = shadowLogRecord({
    step: "generate", sequence: 1, callId: "mr:x", model: "m", ok: false, errorCode: "PROVIDER_ERROR", detail: "slow down please, key sk-abc",
    providerRequests: 1, actualModel: null, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, costBasis: "x", latencyMs: 1, structure: null,
  } as never);
  assert.equal(redacted.detail, "REDACTED");
});

// ---------------------------------------------------------------------------
// (c) 失敗・skip・認証なし・例外: 比較処理を準備しても送らない。失敗の扱いは今のまま
// ---------------------------------------------------------------------------

for (const [label, options, expected] of [
  ["認証なし", { mode: "shadow" }, 401],
  ["データが使えない", { mode: "shadow", dataQuality: "blocked" }, 500],
  ["回が未完成（skip）", { mode: "shadow", claimOutcome: "data_not_ready" }, 200],
  ["もう完成済み（skip）", { mode: "shadow", claimOutcome: "already_completed" }, 200],
  ["OpenAI の通信が失敗（例外）", { mode: "shadow", openAiStatus: 400 }, 500],
  ["生成の中身が使えない（outcome.ok=false）", { mode: "shadow", badGeneration: true }, 200],
  ["完了の記録が失敗", { mode: "shadow", completeStatus: 500 }, 500],
] as const) {
  test(`(c) ${label}: 比較処理は送らない（waitUntil に渡さない）`, async () => {
    const h = harness(options as Options);
    const response = await handleRequest(request({ mode: "close" }, label === "認証なし" ? "wrong" : SECRET), h.deps);
    assert.equal(response.status, expected);
    await settle(h.pending);
    assert.equal(h.pending.length, 0);
    assert.deepEqual(h.shadowCalls(), []);
    if (label.startsWith("生成の中身")) {
      assert.equal((await response.clone().json().catch(() => ({}))).status ?? "failed", "failed");
      assert.ok(h.calls.some((call) => call.path === "rpc/fail_market_report_analysis"), "今の失敗の扱いのまま");
    }
  });
}

// ---------------------------------------------------------------------------
// (d) waitUntil が無い: 準備しない・送らない・後ろで勝手に動く処理も残さない
// ---------------------------------------------------------------------------

test("(d) waitUntil が無いとき: 比較処理を準備せず、時間がたっても何も送らない。設定の誤りはログで分かる", async () => {
  const h = harness({ mode: "shadow", waitUntil: "absent" });
  const body = await (await handleRequest(request({ mode: "close" }), h.deps)).json();
  assert.equal(body.status, "completed");
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.shadowCalls(), []);
  assert.ok(!h.envReads.includes("ANTHROPIC_API_KEY"), "鍵も読まない");
  assert.ok(h.logs.some((line) => line.includes('"reason":"NO_WAIT_UNTIL"')));
});

// ---------------------------------------------------------------------------
// (e) 締め切り: 処理の開始から 150 秒。残りが 20 秒未満なら送らない（費用もかからない）
// ---------------------------------------------------------------------------

const noTimeAfter = SHADOW_WALL_CLOCK_MS - SHADOW_DEADLINE_MARGIN_MS - MIN_SHADOW_WINDOW_MS; // 120 秒

// 比較処理は、完了の記録と trace の直後に動き出す。その時点の「処理の開始からの経過」で決まる
// （ここでは、完了の記録の時点で時計を進めて、生成にかかった時間を作る）。
for (const [label, elapsed, sends] of [
  ["開始から119秒（残り21秒）", noTimeAfter - 1_000, true],
  ["開始から120秒ちょうど（残り20秒）", noTimeAfter, true],
  ["開始から121秒（残り19秒）", noTimeAfter + 1_000, false],
  ["締め切りの1秒前", SHADOW_WALL_CLOCK_MS - 1_000, false],
] as const) {
  test(`(e) ${label}: ${sends ? "送る" : "送らない（NO_TIME、台帳も0）"}`, async () => {
    const h = harness({ mode: "shadow", elapsedAtCompleteMs: elapsed });
    const body = await (await handleRequest(request({ mode: "close" }), h.deps)).json();
    assert.equal(body.status, "completed");
    await settle(h.pending);
    assert.equal(h.shadowCalls().length > 0, sends);
    if (!sends) assert.ok(h.logs.some((line) => line.includes('"reason":"NO_TIME"')));
  });
}

test("(e) 締め切りは完了の時刻ではなく、処理の開始から数える（生成に125秒かかった日は送らない）", async () => {
  const h = harness({ mode: "shadow", elapsedAtCompleteMs: 125_000 });
  const body = await (await handleRequest(request({ mode: "close" }), h.deps)).json();
  assert.equal(body.status, "completed");
  await settle(h.pending);
  assert.deepEqual(h.shadowCalls(), [], "開始から125秒 → 残り15秒 → 送らない");
});

// ---------------------------------------------------------------------------
// (f) 比較処理・登録・ログの例外: 完成したレポートを失敗にしない、失敗の記録も呼ばない
// ---------------------------------------------------------------------------

test("(f) waitUntil への登録が例外: completed のまま。比較処理は動き出さない（残らない）", async () => {
  const h = harness({ mode: "shadow", waitUntil: "throws" });
  const body = await (await handleRequest(request({ mode: "close" }), h.deps)).json();
  assert.equal(body.status, "completed");
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.shadowCalls(), []);
  assert.ok(!h.calls.some((call) => call.path === "rpc/fail_market_report_analysis"));
  assert.ok(h.logs.some((line) => line.includes('"reason":"WAIT_UNTIL_FAILED"')));
});

test("(f) ログが例外: completed のまま、比較処理も最後まで動く", async () => {
  const h = harness({ mode: "shadow", logThrows: true });
  const body = await (await handleRequest(request({ mode: "close" }), h.deps)).json();
  assert.equal(body.status, "completed");
  await settle(h.pending);
  assert.equal(h.calls.filter((call) => call.url.startsWith("https://api.anthropic.com/")).length, 1);
  assert.ok(!h.calls.some((call) => call.path === "rpc/fail_market_report_analysis"));
});

test("(f) 比較処理（flush）が例外: completed のまま、失敗の記録は呼ばない", async () => {
  // trace を書いたあとは時計を読むと例外 → 比較処理の中（締め切りの計算）で例外になる。
  const h = harness({ mode: "shadow", clockThrowsAfterTrace: true });
  const body = await (await handleRequest(request({ mode: "close" }), h.deps)).json();
  assert.equal(body.status, "completed");
  await settle(h.pending);
  assert.deepEqual(h.shadowCalls(), []);
  assert.ok(!h.calls.some((call) => call.path === "rpc/fail_market_report_analysis"));
  assert.ok(h.logs.some((line) => line.includes('"reason":"FLUSH_EXCEPTION"')));
});

// ---------------------------------------------------------------------------
// (g) 同じ試行の再実行・Anthropic の 429 / 529・予算の拒否: 公開は変わらない
// ---------------------------------------------------------------------------

test("(g) 同じ claim の試行を2回動かしても、台帳が2回目を断り、Anthropic へは1回だけ", async () => {
  const ledger = new FakeLedger();
  const first = harness({ mode: "shadow", ledger });
  await handleRequest(request({ mode: "close" }), first.deps);
  await settle(first.pending);
  const second = harness({ mode: "shadow", ledger });
  const body = await (await handleRequest(request({ mode: "close" }), second.deps)).json();
  await settle(second.pending);
  assert.equal(body.status, "completed");
  assert.equal(first.calls.filter((call) => call.url.startsWith("https://api.anthropic.com/")).length, 1);
  assert.equal(second.calls.filter((call) => call.url.startsWith("https://api.anthropic.com/")).length, 0, "ATTEMPT_FINALIZED");
});

for (const [label, options] of [
  ["Anthropic 429", { mode: "shadow", anthropic: 429 }],
  ["Anthropic 529", { mode: "shadow", anthropic: 529 }],
  ["予算の拒否（COST_LIMIT）", { mode: "shadow", ledgerDeny: "COST_LIMIT" }],
] as const) {
  test(`(g) ${label}: 公開（応答・保存・費用）は OFF と同じで、失敗にならない`, async () => {
    const before = await baseline();
    const h = harness(options as Options);
    const body = await (await handleRequest(request({ mode: "close" }), h.deps)).json();
    await settle(h.pending);
    assert.deepEqual(body, before.body);
    assert.deepEqual(h.complete()!.body, before.complete);
    assert.ok(!h.calls.some((call) => call.path === "rpc/fail_market_report_analysis"));
    const call = h.logs.map((line) => JSON.parse(line)).find((event) => event.phase === "call");
    if (label.startsWith("予算")) {
      assert.equal(h.calls.filter((c) => c.url.startsWith("https://api.anthropic.com/")).length, 0, "予算が断れば送らない");
    }
    assert.equal(call?.ok, false);
  });
}
