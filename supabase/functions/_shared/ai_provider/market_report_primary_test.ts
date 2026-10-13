// F6 V0 offline E2E: the shared CLOSE market report generated with Claude as the PRIMARY model, through the REAL
// generateSharedAnalysis and the repository close fixtures; the morning report and every non-"primary_close" setting
// stay on the REAL OpenAI requester. All traffic goes to an in-test router: a fake OpenAI Responses API, a fake
// Anthropic API and a fake PostgREST ledger with the production trial policies (system Opus market report only;
// $1 per attempt; $2 / 6 per JST day; $5 / 40 per JST month) and the one-send-per-attempt rule. Any other host fails.
//   deno test --no-config --allow-env --allow-read supabase/functions/_shared/ai_provider/market_report_primary_test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { generateSharedAnalysis, reportContentHash } from "../../market-report-analysis/analysis_logic.ts";
import type { AnalysisInput } from "../../market-report-analysis/analysis_input.ts";
import { openAiRequester } from "../../market-report-analysis/handler.ts";
import { inputOf, loadFixture, rich0917, richClose0930, richMorning1001 } from "../../market-report-analysis/test_support.ts";
import { newTransportStats } from "../../market-report-analysis/transport_retry.ts";
import type { FetchLike } from "./adapter.ts";
import {
  MARKET_REPORT_AI_MODE_ENV,
  MARKET_REPORT_PRIMARY_MODEL_ENV,
  type MarketReportPrimaryRecord,
  PRIMARY_MIN_CALL_MS,
  prepareMarketReportPrimary,
  type PrepareMarketReportPrimaryOptions,
} from "./market_report_primary.ts";
import { anthropicBody, anthropicError, FAKE_ANTHROPIC_KEY, hangUntilAborted, jsonResponse } from "./test_support.ts";

const OPENAI_KEY = "sk-test-openai-NOT-REAL-0000000000";
const LEDGER_KEY = "sb_secret_FAKE_TEST_ONLY_000000000";
const PROJECT = "abcdefghijklmnopqrst";
const MODEL = "claude-opus-5-5";
const CYCLE = "5d7e2b1a-1c3f-4a5b-8c9d-0e1f2a3b4c5d";
const FACT_PREFIX = "あなたは市場レポートの厳格なFactチェッカーです";

const ENV: Record<string, string | undefined> = {
  [MARKET_REPORT_AI_MODE_ENV]: "primary_close",
  [MARKET_REPORT_PRIMARY_MODEL_ENV]: MODEL,
  ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
  SUPABASE_URL: `https://${PROJECT}.supabase.co`,
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: LEDGER_KEY }),
};

type Case = { label: string; fixture: string; make: (input: AnalysisInput) => unknown; now: () => Date };
const CLOSE_0930: Case = { label: "close 9/30", fixture: "close_2026-09-30", make: richClose0930, now: () => new Date("2026-10-01T22:55:20Z") };
const CLOSE_0917: Case = { label: "close 9/17", fixture: "close_2026-09-17", make: rich0917, now: () => new Date("2026-09-17T07:20:05Z") };
const MORNING_1001: Case = { label: "morning 10/1", fixture: "morning_2026-10-01", make: richMorning1001, now: () => new Date("2026-10-01T22:55:20Z") };
const PASS = { passed: true, issues: [], objective_issues: [] };

// ---- fake ledger (PostgREST RPCs of migration 20261010050613 with the Phase 1f trial policies) ----------------------

type Reservation = { status: "reserved" | "sent" | "released" | "settled"; amount: number };

class FakeLedger {
  readonly reservations = new Map<string, Reservation>();
  readonly byAttempt = new Map<string, string>();
  readonly calls: string[] = [];
  readonly reserves: Array<Record<string, unknown>> = [];
  readonly settlements: Array<{ outcome: string; cost: number }> = [];
  day = { calls: 0, usd: 0 };
  month = { calls: 0, usd: 0 };
  #n = 0;

  handle(name: string, headers: Headers, p: Record<string, unknown>): Response {
    this.calls.push(name);
    if (headers.get("apikey") !== LEDGER_KEY || headers.get("authorization") !== `Bearer ${LEDGER_KEY}`) {
      return jsonResponse(401, { code: "PGRST301", message: "JWSError" });
    }
    if (name === "ai_ledger_reserve") return jsonResponse(200, this.reserve(p));
    const r = this.reservations.get(String(p.reservation_id));
    if (!r) return jsonResponse(400, { code: "P0001", message: "AI_LEDGER_UNKNOWN_RESERVATION" });
    if (name === "ai_ledger_mark_sent") {
      if (r.status !== "reserved") return jsonResponse(200, { status: r.status, may_send: false });
      r.status = "sent";
      return jsonResponse(200, { status: "sent", may_send: true });
    }
    if (name === "ai_ledger_release") {
      if (r.status === "reserved") {
        r.status = "released";
        this.day.calls -= 1; this.month.calls -= 1; this.day.usd -= r.amount; this.month.usd -= r.amount;
      }
      return jsonResponse(200, { status: r.status });
    }
    if (name === "ai_ledger_settle") {
      const cost = Number(p.estimated_cost_usd);
      this.day.usd += cost - r.amount;
      this.month.usd += cost - r.amount;
      r.status = "settled";
      this.settlements.push({ outcome: String(p.outcome), cost });
      return jsonResponse(200, { status: "settled", duplicate: false });
    }
    return jsonResponse(404, { code: "PGRST202" });
  }

  reserve(p: Record<string, unknown>) {
    this.reserves.push(p);
    const key = `${p.request_id}#${p.attempt}`;
    const existing = this.byAttempt.get(key);
    if (existing) {
      const status = this.reservations.get(existing)!.status;
      if (status === "reserved") return { allowed: true, reservation_id: existing, status, reused: true };
      return { allowed: false, reservation_id: existing, status, reason: status === "sent" ? "ATTEMPT_IN_FLIGHT" : "ATTEMPT_FINALIZED" };
    }
    const scoped = p.provider === "anthropic" && p.model === MODEL && p.application === "kabumori" && p.feature === "market_report" &&
      p.subject_kind === "system" && p.user_id === undefined && p.brand_id === undefined;
    if (!scoped) return { allowed: false, reason: "NO_MATCHING_POLICY" };
    const amount = Number(p.amount_usd);
    if (amount > 1) return { allowed: false, reason: "PER_CALL_LIMIT" };
    if (this.day.calls + 1 > 6) return { allowed: false, reason: "CALL_LIMIT" };
    if (this.day.usd + amount > 2) return { allowed: false, reason: "COST_LIMIT" };
    if (this.month.calls + 1 > 40) return { allowed: false, reason: "CALL_LIMIT" };
    if (this.month.usd + amount > 5) return { allowed: false, reason: "COST_LIMIT" };
    this.day.calls += 1; this.month.calls += 1; this.day.usd += amount; this.month.usd += amount;
    const id = `00000000-0000-4000-8000-${String(++this.#n).padStart(12, "0")}`;
    this.reservations.set(id, { status: "reserved", amount });
    this.byAttempt.set(key, id);
    return { allowed: true, reservation_id: id, status: "reserved", reused: false };
  }
}

// ---- network: OpenAI (legacy), Anthropic (primary), the ledger; nothing else ----------------------------------------

type ClaudeCall = { step: "generate" | "fact"; system: string; body: Record<string, unknown>; init: RequestInit | undefined };
type Net = { fetch: FetchLike; openai: Array<Record<string, unknown>>; claude: ClaudeCall[]; ledger: FakeLedger };

function network(options: {
  openai?: Array<{ payload?: unknown; status?: number }>;
  claude?: (call: ClaudeCall, index: number) => Response | Promise<Response>;
  ledger?: FakeLedger;
}): Net {
  const openai = [...(options.openai ?? [])];
  const net: Net = { fetch: undefined as unknown as FetchLike, openai: [], claude: [], ledger: options.ledger ?? new FakeLedger() };
  net.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    const raw = input instanceof Request ? await input.clone().text() : typeof init?.body === "string" ? init.body : "";
    if (url.hostname === "api.openai.com") {
      net.openai.push(JSON.parse(raw));
      assert.equal(headers.get("authorization"), `Bearer ${OPENAI_KEY}`);
      const next = openai.shift();
      assert.ok(next, "unexpected OpenAI request");
      if (next.status) return jsonResponse(next.status, { error: { message: "fake" } });
      return jsonResponse(200, {
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(next.payload) }] }],
        usage: { input_tokens: 12_000, output_tokens: 3_000 },
      });
    }
    if (url.hostname === "api.anthropic.com") {
      assert.equal(headers.get("x-api-key"), FAKE_ANTHROPIC_KEY);
      const body = JSON.parse(raw) as Record<string, unknown> & { system?: Array<{ text: string }> | string };
      const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((part) => part.text).join("");
      const call: ClaudeCall = { step: system.startsWith(FACT_PREFIX) ? "fact" : "generate", system, body, init };
      net.claude.push(call);
      assert.ok(options.claude, "this case must not call Anthropic");
      return await options.claude!(call, net.claude.length - 1);
    }
    if (url.hostname === `${PROJECT}.supabase.co` && url.pathname.startsWith("/rest/v1/rpc/ai_ledger_")) {
      const { p } = JSON.parse(raw) as { p: Record<string, unknown> };
      return net.ledger.handle(url.pathname.slice("/rest/v1/rpc/".length), headers, p);
    }
    throw new Error(`unexpected host ${url.host}${url.pathname}`);
  };
  return net;
}

const USAGE = {
  generate: { input_tokens: 20_000, output_tokens: 9_000, thinking: 2_500 },
  fact: { input_tokens: 22_000, output_tokens: 1_500, thinking: 600 },
};

function claudeOk(payload: unknown, step: "generate" | "fact"): Response {
  const u = USAGE[step];
  return jsonResponse(200, anthropicBody(payload, { usage: {
    input_tokens: u.input_tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null,
    output_tokens: u.output_tokens, output_tokens_details: { thinking_tokens: u.thinking }, server_tool_use: null, service_tier: "standard", inference_geo: null,
  } }), { "request-id": "req_primary_harness" });
}

/** Claude answers like the legacy fixture: the rich analysis for generate, `fact` (default pass) for fact. */
const claudeReport = (analysis: unknown, fact: (index: number) => unknown = () => PASS) => {
  let facts = 0;
  return (call: ClaudeCall) => call.step === "generate" ? claudeOk(analysis, "generate") : claudeOk(fact(facts++), "fact");
};

// ---- one generation run: what handler.ts does between the claim and complete_market_report_analysis ----------------

async function run(options: {
  case: Case;
  net: Net;
  env?: Record<string, string | undefined>;
  claim?: { cycle_id: string | null; attempt: number } | null;
  deadlineInMs?: number;
  prepare?: Partial<PrepareMarketReportPrimaryOptions>;
}) {
  const input = inputOf(await loadFixture(options.case.fixture));
  const reportType = input.reportType;
  const values = options.env ?? ENV;
  const reads: string[] = [];
  const readEnv = (name: string) => {
    reads.push(name);
    return values[name];
  };
  const legacy = openAiRequester(OPENAI_KEY, options.net.fetch as typeof fetch, { stats: newTransportStats(), sleep: () => Promise.resolve() });
  const records: MarketReportPrimaryRecord[] = [];
  const prepared = prepareMarketReportPrimary({
    readEnv,
    reportType,
    claim: options.claim === undefined ? { cycle_id: CYCLE, attempt: 1 } : options.claim,
    deadlineAtMs: Date.now() + (options.deadlineInMs ?? 130_000),
    sink: (record) => records.push(record),
    fetch: options.net.fetch,
    ...options.prepare,
  });
  if (prepared.mode === "invalid") return { prepared, reads, records, input, outcome: null, error: null, hash: null };
  const requester = prepared.mode === "primary" ? prepared.requester : legacy;
  try {
    const outcome = await generateSharedAnalysis(input, requester, options.case.now, []);
    const hash = outcome.ok ? await reportContentHash(outcome.packet) : null;
    return { prepared, reads, records, input, outcome, error: null, hash };
  } catch (error) {
    return { prepared, reads, records, input, outcome: null, error: (error as Error).message, hash: null };
  }
}

async function legacyBaseline(c: Case, openaiScript: (input: AnalysisInput) => Array<{ payload?: unknown; status?: number }>) {
  const input = inputOf(await loadFixture(c.fixture));
  const net = network({ openai: openaiScript(input) });
  return { net, ...(await run({ case: c, net, env: { ...ENV, [MARKET_REPORT_AI_MODE_ENV]: undefined } })) };
}

// ---- tests ---------------------------------------------------------------------------------------------------------

for (const c of [CLOSE_0930, CLOSE_0917]) {
  test(`${c.label}: primary_close makes the canonical close report with Claude only (same packet as the OpenAI path)`, async () => {
    const legacy = await legacyBaseline(c, (input) => [{ payload: c.make(input) }, { payload: PASS }]);
    assert.equal(legacy.outcome?.ok, true);
    const input = inputOf(await loadFixture(c.fixture));
    const net = network({ claude: claudeReport(c.make(input)) });
    const r = await run({ case: c, net });
    assert.equal(r.prepared.mode, "primary");
    assert.equal(r.outcome?.ok, true, r.error ?? "");
    // The stored report is the canonical one: same packet, same content hash as the legacy path with the same answers.
    assert.deepEqual(r.outcome!.ok && r.outcome!.packet, legacy.outcome!.ok && legacy.outcome!.packet);
    assert.equal(r.hash, legacy.hash);
    // Every model call went to Claude: generate then fact, the legacy instructions / input / schema, no OpenAI at all.
    assert.equal(net.openai.length, 0);
    assert.deepEqual(net.claude.map((call) => call.step), ["generate", "fact"]);
    assert.deepEqual(net.claude.map((call) => call.system), legacy.net.openai.map((body) => body.instructions));
    assert.deepEqual(net.ledger.calls, ["ai_ledger_reserve", "ai_ledger_mark_sent", "ai_ledger_settle", "ai_ledger_reserve", "ai_ledger_mark_sent", "ai_ledger_settle"]);
    assert.deepEqual(net.ledger.reserves.map((p) => [p.request_id, p.logical_role, p.subject_kind]), [
      [`mrp:${CYCLE}:a1:generate:1`, "kabumori.market_report.generate.primary", "system"],
      [`mrp:${CYCLE}:a1:fact:1`, "kabumori.market_report.fact.primary", "system"],
    ]);
    assert.ok(net.ledger.reserves.every((p) => Number(p.amount_usd) <= 1), "every upper bound within the $1 per-attempt policy");
    // Usage and cost: the report sees Claude's tokens; the primary totals equal what the ledger settled.
    assert.equal(r.outcome!.inputTokens, 42_000);
    assert.equal(r.outcome!.outputTokens, 10_500);
    const prepared = r.prepared as Extract<typeof r.prepared, { mode: "primary" }>;
    const settled = net.ledger.settlements.reduce((sum, s) => sum + s.cost, 0);
    assert.deepEqual(prepared.totals(), { calls: 2, inputTokens: 42_000, outputTokens: 10_500, costUsd: Number(settled.toFixed(6)) });
    assert.equal(r.records[0].estimatedCostUsd, 0.26, "20,000 x $4/M + 9,000 x $20/M");
    assert.deepEqual(r.records.map((x) => [x.callId, x.ok, x.providerRequests]), [
      [`mrp:${CYCLE}:a1:generate:1`, true, 1],
      [`mrp:${CYCLE}:a1:fact:1`, true, 1],
    ]);
  });
}

test("the morning report, and every setting other than exactly primary_close, stays on OpenAI untouched", async () => {
  const morning = inputOf(await loadFixture(MORNING_1001.fixture));
  const net = network({ openai: [{ payload: richMorning1001(morning) }, { payload: PASS }] });
  const r = await run({ case: MORNING_1001, net });
  assert.deepEqual([r.prepared.mode, r.prepared.reason], ["legacy", "NOT_CLOSE"]);
  assert.equal(r.outcome?.ok, true);
  assert.deepEqual([net.openai.length, net.claude.length, net.ledger.calls.length], [2, 0, 0]);
  assert.deepEqual(r.reads, [MARKET_REPORT_AI_MODE_ENV], "morning reads only the mode");

  const close = inputOf(await loadFixture(CLOSE_0930.fixture));
  for (const mode of [undefined, "", "off", "shadow", "primary", "PRIMARY_CLOSE", " primary_close", "primary_close\n", "primary_morning"]) {
    const legacyNet = network({ openai: [{ payload: richClose0930(close) }, { payload: PASS }] });
    const off = await run({ case: CLOSE_0930, net: legacyNet, env: { ...ENV, [MARKET_REPORT_AI_MODE_ENV]: mode } });
    assert.deepEqual([off.prepared.mode, off.prepared.reason], ["legacy", "OFF"], String(mode));
    assert.equal(off.outcome?.ok, true);
    assert.deepEqual([legacyNet.openai.length, legacyNet.claude.length, legacyNet.ledger.calls.length], [2, 0, 0], String(mode));
    assert.deepEqual(off.reads, [MARKET_REPORT_AI_MODE_ENV], "off reads only the mode");
  }
});

test("on but incomplete is refused (fail closed, never a silent OpenAI fallback), with nothing sent", async () => {
  const cases: Array<[string, Record<string, string | undefined>, { cycle_id: string | null; attempt: number } | null | undefined]> = [
    ["MODEL_INVALID", { ...ENV, [MARKET_REPORT_PRIMARY_MODEL_ENV]: undefined }, undefined],
    ["MODEL_INVALID", { ...ENV, [MARKET_REPORT_PRIMARY_MODEL_ENV]: "gpt-6.1-sol" }, undefined],
    ["MODEL_INVALID", { ...ENV, [MARKET_REPORT_PRIMARY_MODEL_ENV]: "claude-unknown-9" }, undefined],
    ["KEY_MISSING", { ...ENV, ANTHROPIC_API_KEY: undefined }, undefined],
    ["NO_LEDGER", { ...ENV, SUPABASE_SECRET_KEYS: undefined }, undefined],
    ["NO_LEDGER", { ...ENV, SUPABASE_URL: "http://not-https.example" }, undefined],
    ["BAD_CONTEXT", ENV, { cycle_id: null, attempt: 1 }],
    ["BAD_CONTEXT", ENV, { cycle_id: "not-a-uuid", attempt: 1 }],
    ["BAD_CONTEXT", ENV, null],
  ];
  for (const [reason, env, claim] of cases) {
    const net = network({});
    const r = await run({ case: CLOSE_0930, net, env, claim });
    assert.deepEqual([r.prepared.mode, r.prepared.reason], ["invalid", reason]);
    assert.deepEqual([net.openai.length, net.claude.length, net.ledger.calls.length], [0, 0, 0], reason);
  }
});

test("a failed Claude generation fails the report: one request, no retry, no OpenAI fallback, settled in the ledger", async () => {
  for (const [status, type, code] of [[529, "overloaded_error", "OVERLOADED"], [429, "rate_limit_error", "RATE_LIMITED"], [500, "api_error", "SERVER_ERROR"]] as const) {
    const net = network({ claude: () => jsonResponse(status, anthropicError(status, type, "fake")) });
    const r = await run({ case: CLOSE_0930, net });
    assert.equal(r.error, `ANALYSIS_PRIMARY_GENERATE_FAILED:${code}`);
    assert.deepEqual([net.claude.length, net.openai.length], [1, 0], code);
    assert.deepEqual(net.ledger.settlements.map((s) => s.outcome), ["failed"], code);
    assert.deepEqual([r.records[0].ok, r.records[0].errorCode], [false, code]);
  }
});

test("budget refusals fail the report before anything is sent (day calls, month cost, a re-run of the same attempt)", async () => {
  const input = inputOf(await loadFixture(CLOSE_0930.fixture));
  const fullDay = new FakeLedger();
  fullDay.day = { calls: 6, usd: 1 };
  const dayNet = network({ claude: claudeReport(richClose0930(input)), ledger: fullDay });
  const day = await run({ case: CLOSE_0930, net: dayNet });
  assert.equal(day.error, "ANALYSIS_PRIMARY_GENERATE_FAILED:BUDGET_DENIED");
  assert.deepEqual([dayNet.claude.length, dayNet.openai.length, day.records[0].detail], [0, 0, "CALL_LIMIT"]);

  const spent = new FakeLedger();
  spent.month = { calls: 10, usd: 4.8 };
  const monthNet = network({ claude: claudeReport(richClose0930(input)), ledger: spent });
  const month = await run({ case: CLOSE_0930, net: monthNet });
  assert.equal(month.error, "ANALYSIS_PRIMARY_GENERATE_FAILED:BUDGET_DENIED");
  assert.deepEqual([monthNet.claude.length, month.records[0].detail], [0, "COST_LIMIT"]);

  // The same claim attempt run twice (a duplicate invocation): the ledger pays once and the duplicate fails.
  const ledger = new FakeLedger();
  const first = network({ claude: claudeReport(richClose0930(input)), ledger });
  assert.equal((await run({ case: CLOSE_0930, net: first })).outcome?.ok, true);
  const again = network({ claude: claudeReport(richClose0930(input)), ledger });
  const dup = await run({ case: CLOSE_0930, net: again });
  assert.equal(dup.error, "ANALYSIS_PRIMARY_GENERATE_FAILED:BUDGET_DENIED");
  assert.deepEqual([again.claude.length, dup.records[0].detail], [0, "ATTEMPT_FINALIZED"]);
  // The next claim attempt (the cron retry) is a new call and may run.
  const retry = network({ claude: claudeReport(richClose0930(input)), ledger });
  const next = await run({ case: CLOSE_0930, net: retry, claim: { cycle_id: CYCLE, attempt: 2 } });
  assert.equal(next.outcome?.ok, true);
  assert.equal(next.records[0].callId, `mrp:${CYCLE}:a2:generate:1`);
});

test("time: no call starts without the minimum window; a hanging call ends at the time left, settled at its upper bound", async () => {
  const input = inputOf(await loadFixture(CLOSE_0930.fixture));
  const lateNet = network({ claude: claudeReport(richClose0930(input)) });
  const late = await run({ case: CLOSE_0930, net: lateNet, deadlineInMs: PRIMARY_MIN_CALL_MS - 1_000 });
  assert.equal(late.error, "ANALYSIS_PRIMARY_GENERATE_FAILED:DEADLINE_EXCEEDED");
  assert.deepEqual([lateNet.claude.length, lateNet.ledger.calls.length, late.records[0].costBasis], [0, 0, "no_request"]);

  const slowNet = network({ claude: (call) => hangUntilAborted(call.init) });
  const t0 = Date.now();
  const slow = await run({ case: CLOSE_0930, net: slowNet, deadlineInMs: 6_500 });
  assert.ok(Date.now() - t0 < 10_000, "bounded by the run deadline, not the 90 s per-call cap");
  assert.equal(slow.error, "ANALYSIS_PRIMARY_GENERATE_FAILED:TIMEOUT");
  assert.deepEqual([slow.records[0].costBasis, slowNet.ledger.settlements[0].outcome], ["includes_upper_bound", "unknown"]);
  assert.equal(slowNet.openai.length, 0);
});

test("regeneration and a failed fact call keep the existing delivery contract, all on Claude", async () => {
  const input = inputOf(await loadFixture(CLOSE_0917.fixture));
  // Fact rejects the first generation -> regenerate -> Fact passes: four Claude calls, deterministic callIds.
  const regenNet = network({
    claude: claudeReport(rich0917(input), (i) => i === 0 ? { passed: false, issues: ["根拠の無い因果"], objective_issues: [] } : PASS),
  });
  const regen = await run({ case: CLOSE_0917, net: regenNet });
  assert.equal(regen.outcome?.ok, true, regen.error ?? "");
  assert.deepEqual(regenNet.claude.map((call) => call.step), ["generate", "fact", "generate", "fact"]);
  assert.deepEqual(regen.records.map((x) => x.callId), [
    `mrp:${CYCLE}:a1:generate:1`, `mrp:${CYCLE}:a1:fact:1`, `mrp:${CYCLE}:a1:generate:2`, `mrp:${CYCLE}:a1:fact:2`,
  ]);
  assert.ok(regenNet.claude[2].system.includes("前回の生成は次の理由で不合格でした"));

  // The Fact call itself fails: the report is still delivered as today's contract says (FACT_NOT_RUN), never OpenAI.
  const factNet = network({
    claude: (call) => call.step === "generate" ? claudeOk(rich0917(input), "generate") : jsonResponse(529, anthropicError(529, "overloaded_error", "fake")),
  });
  const factDown = await run({ case: CLOSE_0917, net: factNet });
  assert.equal(factDown.outcome?.ok, true, factDown.error ?? "");
  assert.ok(factDown.outcome!.ok && factDown.outcome!.packet.fact.ai_status === "not_run");
  assert.deepEqual([factNet.openai.length, factDown.records.map((x) => x.errorCode)], [0, [null, "OVERLOADED"]]);
});

test("records and errors carry no key, prompt or report text; the primary reads only its five settings", async () => {
  const input = inputOf(await loadFixture(CLOSE_0930.fixture));
  const net = network({ claude: claudeReport(richClose0930(input)) });
  const r = await run({ case: CLOSE_0930, net });
  assert.deepEqual(
    [...new Set(r.reads)].sort(),
    [MARKET_REPORT_AI_MODE_ENV, MARKET_REPORT_PRIMARY_MODEL_ENV, "ANTHROPIC_API_KEY", "SUPABASE_SECRET_KEYS", "SUPABASE_URL"].sort(),
  );
  const analysis = richClose0930(input) as { headline_ja: string };
  const rendered = JSON.stringify(r.records);
  for (const secret of [FAKE_ANTHROPIC_KEY, LEDGER_KEY, OPENAI_KEY, "あなたは日本株の市場レポート編集者です", FACT_PREFIX, analysis.headline_ja]) {
    assert.ok(!rendered.includes(secret), `leaked ${secret.slice(0, 12)}`);
  }
  assert.deepEqual(Object.keys(r.records[0]).sort(), [
    "actualModel", "callId", "costBasis", "detail", "errorCode", "estimatedCostUsd", "inputTokens", "latencyMs", "model", "ok",
    "outputTokens", "providerRequests", "sequence", "step",
  ]);
  // A sink that throws never reaches the report.
  const noisyNet = network({ claude: claudeReport(richClose0930(input)) });
  const noisy = await run({ case: CLOSE_0930, net: noisyNet, prepare: { sink: () => { throw new Error("recorder down"); } } });
  assert.equal(noisy.outcome?.ok, true);
});
