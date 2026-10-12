// Phase 2b offline handler-boundary harness: the shared market report's generation, exactly as handler.ts runs it
// (the REAL openAiRequester and generateSharedAnalysis, real morning / close fixtures from the repository), with the
// Phase 2b wiring in front of it. Every network call goes to an in-test router: a fake OpenAI Responses API (the
// legacy path), a fake Anthropic API (the shadow) and a fake PostgREST ledger that implements the production trial
// policies (system Opus 5.5 market report only; $1 per attempt; $2 / 6 per JST day; $5 / 40 per JST month) and the
// ledger's one-send-per-attempt rule. Any other host fails the test. No real key, network or database is used.
//   deno test --no-config --allow-env --allow-read supabase/functions/_shared/ai_provider/market_report_wiring_test.ts
// It also passes with the key variables unreadable and no network permission at all:
//   ... --no-prompt --allow-env --deny-env=ANTHROPIC_API_KEY,OPENAI_API_KEY,SUPABASE_SECRET_KEYS,SUPABASE_SERVICE_ROLE_KEY,
//   SUPABASE_URL,KABUMORI_MARKET_REPORT_AI_MODE,KABUMORI_MARKET_REPORT_SHADOW_MODEL --deny-net --allow-read=supabase/functions
import assert from "node:assert/strict";
import test from "node:test";
import { type GenerationRecord, generateSharedAnalysis, generationDiagnostics, reportContentHash } from "../../market-report-analysis/analysis_logic.ts";
import type { AnalysisInput } from "../../market-report-analysis/analysis_input.ts";
import { openAiRequester } from "../../market-report-analysis/handler.ts";
import { inputOf, loadFixture, rich0917, richClose0930, richMorning1001 } from "../../market-report-analysis/test_support.ts";
import { newTransportStats, transportDiagnostics } from "../../market-report-analysis/transport_retry.ts";
import type { FetchLike } from "./adapter.ts";
import { MARKET_REPORT_AI_MODE_ENV, type MarketReportRequester, type MarketReportShadowRecord } from "./market_report_shadow.ts";
import { MARKET_REPORT_SHADOW_MODEL_ENV, type MarketReportClaim, prepareMarketReportShadow, type PrepareOptions } from "./market_report_wiring.ts";
import { anthropicBody, anthropicError, FAKE_ANTHROPIC_KEY, hangUntilAborted, jsonResponse } from "./test_support.ts";

const OPENAI_KEY = "sk-test-openai-NOT-REAL-0000000000";
const LEDGER_KEY = "sb_secret_FAKE_TEST_ONLY_000000000";
const PROJECT = "abcdefghijklmnopqrst";
const MODEL = "claude-opus-5-5";
const CYCLE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const ENV: Record<string, string> = {
  [MARKET_REPORT_AI_MODE_ENV]: "shadow",
  [MARKET_REPORT_SHADOW_MODEL_ENV]: MODEL,
  ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
  SUPABASE_URL: `https://${PROJECT}.supabase.co`,
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: LEDGER_KEY }),
};

type Case = { label: string; fixture: string; make: (input: AnalysisInput) => unknown; now: () => Date };
const CASES: Case[] = [
  { label: "morning 10/1", fixture: "morning_2026-10-01", make: richMorning1001, now: () => new Date("2026-10-01T22:55:20Z") },
  { label: "close 9/30", fixture: "close_2026-09-30", make: richClose0930, now: () => new Date("2026-10-01T22:55:20Z") },
  { label: "close 9/17", fixture: "close_2026-09-17", make: rich0917, now: () => new Date("2026-09-17T07:20:05Z") },
];

// ---- fake ledger (PostgREST RPCs of migration 20261010050613, with the Phase 1d trial policies) ------------------

type Reservation = { key: string; status: "reserved" | "sent" | "released" | "settled"; amount: number };

class FakeLedgerRest {
  readonly reservations = new Map<string, Reservation>();
  readonly byAttempt = new Map<string, string>();
  readonly calls: string[] = [];
  readonly settlements: Array<{ outcome: string; cost: number; basis: string; input: unknown; output: unknown }> = [];
  readonly reserves: Array<Record<string, unknown>> = [];
  day = { calls: 0, usd: 0 };
  month = { calls: 0, usd: 0 };
  rejectAuth = false;
  #n = 0;

  handle(name: string, headers: Headers, p: Record<string, unknown>): Response {
    this.calls.push(name);
    if (this.rejectAuth || headers.get("apikey") !== LEDGER_KEY || headers.get("authorization") !== `Bearer ${LEDGER_KEY}`) {
      return jsonResponse(401, { code: "PGRST301", message: "JWSError" });
    }
    if (name === "ai_ledger_reserve") return jsonResponse(200, this.reserve(p));
    const reservation = this.reservations.get(String(p.reservation_id));
    if (!reservation) return jsonResponse(400, { code: "P0001", message: "AI_LEDGER_UNKNOWN_RESERVATION" });
    if (name === "ai_ledger_mark_sent") {
      if (reservation.status !== "reserved") return jsonResponse(200, { status: reservation.status, may_send: false });
      reservation.status = "sent";
      return jsonResponse(200, { status: "sent", may_send: true });
    }
    if (name === "ai_ledger_release") {
      if (reservation.status === "reserved") {
        reservation.status = "released";
        this.day.calls -= 1; this.month.calls -= 1; this.day.usd -= reservation.amount; this.month.usd -= reservation.amount;
      }
      return jsonResponse(200, { status: reservation.status });
    }
    if (name === "ai_ledger_settle") {
      const cost = Number(p.estimated_cost_usd);
      this.day.usd += cost - reservation.amount;
      this.month.usd += cost - reservation.amount;
      reservation.status = "settled";
      this.settlements.push({ outcome: String(p.outcome), cost, basis: String(p.cost_basis), input: p.input_tokens, output: p.output_tokens });
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
    if (amount > 1) return { allowed: false, reason: "PER_CALL_LIMIT", policy_key: "anthropic.opus.kabumori.market_report.monthly" };
    if (this.day.calls + 1 > 6) return { allowed: false, reason: "CALL_LIMIT", policy_key: "anthropic.opus.kabumori.market_report.daily" };
    if (this.day.usd + amount > 2) return { allowed: false, reason: "COST_LIMIT", policy_key: "anthropic.opus.kabumori.market_report.daily" };
    if (this.month.calls + 1 > 40) return { allowed: false, reason: "CALL_LIMIT", policy_key: "anthropic.opus.kabumori.market_report.monthly" };
    if (this.month.usd + amount > 5) return { allowed: false, reason: "COST_LIMIT", policy_key: "anthropic.opus.kabumori.market_report.monthly" };
    this.day.calls += 1; this.month.calls += 1; this.day.usd += amount; this.month.usd += amount;
    const id = `00000000-0000-4000-8000-${String(++this.#n).padStart(12, "0")}`;
    this.reservations.set(id, { key, status: "reserved", amount });
    this.byAttempt.set(key, id);
    return { allowed: true, reservation_id: id, status: "reserved", reused: false };
  }
}

// ---- the network: OpenAI (legacy), Anthropic (shadow), the ledger; nothing else -------------------------------------

type Net = {
  fetch: FetchLike;
  openai: Array<Record<string, unknown>>;
  anthropic: Array<{ system: string; headers: Headers }>;
  ledger: FakeLedgerRest;
};

function network(options: {
  legacy: Array<{ step: "generate" | "fact"; payload?: unknown; status?: number }>;
  anthropic?: (init: RequestInit | undefined) => Response | Promise<Response>;
  ledger?: FakeLedgerRest;
}): Net {
  const legacy = [...options.legacy];
  const ledger = options.ledger ?? new FakeLedgerRest();
  const net: Net = { fetch: undefined as unknown as FetchLike, openai: [], anthropic: [], ledger };
  net.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    const raw = input instanceof Request ? await input.clone().text() : typeof init?.body === "string" ? init.body : "";
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
      const body = JSON.parse(raw) as Record<string, unknown>;
      net.openai.push(body);
      assert.equal(headers.get("authorization"), `Bearer ${OPENAI_KEY}`);
      const next = legacy.shift();
      assert.ok(next, "unexpected OpenAI request");
      const text = body.instructions as string;
      assert.equal(next.step === "fact", text.startsWith("あなたは市場レポートの厳格なFactチェッカーです"), "legacy call order");
      if (next.status) return jsonResponse(next.status, { error: { message: "fake" } });
      return jsonResponse(200, {
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(next.payload) }] }],
        usage: { input_tokens: 12_000, output_tokens: 3_000 },
      });
    }
    if (url.hostname === "api.anthropic.com") {
      const body = JSON.parse(raw) as { system?: Array<{ text: string }> | string };
      const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((part) => part.text).join("");
      net.anthropic.push({ system, headers });
      assert.equal(headers.get("x-api-key"), FAKE_ANTHROPIC_KEY);
      assert.ok(options.anthropic, "the shadow must not call Anthropic in this case");
      return await options.anthropic!(init);
    }
    if (url.hostname === `${PROJECT}.supabase.co` && url.pathname.startsWith("/rest/v1/rpc/ai_ledger_")) {
      const { p } = JSON.parse(raw) as { p: Record<string, unknown> };
      return ledger.handle(url.pathname.slice("/rest/v1/rpc/".length), headers, p);
    }
    throw new Error(`unexpected host ${url.host}${url.pathname}`);
  };
  return net;
}

const claudeAnswer = (payload: unknown) => () =>
  jsonResponse(200, anthropicBody(payload, { usage: {
    input_tokens: 20_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null,
    output_tokens: 9_000, output_tokens_details: { thinking_tokens: 2_500 }, server_tool_use: null, service_tier: "standard", inference_geo: null,
  } }), { "request-id": "req_shadow_harness" });

// ---- one handler run: the same sequence as handler.ts after the claim ------------------------------------------------

type RunOptions = {
  case: Case;
  net: Net;
  env?: Record<string, string | undefined>;
  wiring?: boolean;
  claim?: MarketReportClaim | null;
  deadlineInMs?: number;
  /** Absolute deadline on the clock given in prepare.nowMs (instead of deadlineInMs from Date.now()). */
  deadlineAtMs?: number;
  signal?: AbortSignal;
  prepare?: Partial<PrepareOptions>;
};

async function run(options: RunOptions) {
  const fixture = await loadFixture(options.case.fixture);
  const input = inputOf(fixture);
  const reads: string[] = [];
  const values = options.env ?? ENV;
  const readEnv = (name: string) => {
    reads.push(name);
    return values[name];
  };
  const transport = newTransportStats();
  const legacy: MarketReportRequester = openAiRequester(OPENAI_KEY, options.net.fetch as typeof fetch, {
    stats: transport, sleep: () => Promise.resolve(),
  });
  const records: MarketReportShadowRecord[] = [];
  const prepared = options.wiring === false ? null : prepareMarketReportShadow({
    legacy,
    readEnv,
    claim: options.claim === undefined ? { cycle_id: CYCLE, attempt: 1 } : options.claim,
    sink: (record) => records.push(record),
    fetch: options.net.fetch,
    timing: { marginMs: 0, minWindowMs: 1_000 },
    ...options.prepare,
  });
  const generations: GenerationRecord[] = [];
  const anthropicBeforeDelivery = () => options.net.anthropic.length;
  const outcome = await generateSharedAnalysis(input, prepared ? prepared.requester : legacy, options.case.now, generations);
  const duringGeneration = anthropicBeforeDelivery();
  const diagnostics = { ...transportDiagnostics(transport), ...generationDiagnostics(outcome.trace) };
  const contentHash = outcome.ok ? await reportContentHash(outcome.packet) : null;
  // handler.ts would call complete_market_report_analysis here; the shadow runs only after that succeeded.
  const flush = prepared && outcome.ok
    ? await prepared.flush({ deadlineAtMs: options.deadlineAtMs ?? Date.now() + (options.deadlineInMs ?? 60_000), signal: options.signal })
    : null;
  return { prepared, legacy, outcome, diagnostics, contentHash, records, reads, flush, duringGeneration };
}

const deliver = (make: Case["make"], input: AnalysisInput) => [
  { step: "generate" as const, payload: make(input) },
  { step: "fact" as const, payload: { passed: true, issues: [], objective_issues: [] } },
];

async function legacyScript(c: Case) {
  return deliver(c.make, inputOf(await loadFixture(c.fixture)));
}

// ---- tests ---------------------------------------------------------------------------------------------------------

for (const c of CASES) {
  test(`${c.label}: off and shadow deliver exactly the legacy report (packet, hash, diagnostics, OpenAI requests)`, async () => {
    const baselineNet = network({ legacy: await legacyScript(c) });
    const baseline = await run({ case: c, net: baselineNet, wiring: false });
    assert.equal(baseline.outcome.ok, true, "the fixture delivers");

    const offNet = network({ legacy: await legacyScript(c) });
    const off = await run({ case: c, net: offNet, env: { ...ENV, [MARKET_REPORT_AI_MODE_ENV]: undefined } });
    assert.equal(off.prepared?.mode, "off");
    assert.equal(off.prepared?.requester, off.legacy, "off hands back the legacy requester itself");
    assert.deepEqual(off.reads, [MARKET_REPORT_AI_MODE_ENV], "off reads nothing but the mode");
    assert.deepEqual(off.flush, { attempted: 0, skipped: 0, reason: "OFF" });

    const input = inputOf(await loadFixture(c.fixture));
    const shadowNet = network({ legacy: await legacyScript(c), anthropic: claudeAnswer(c.make(input)) });
    const shadow = await run({ case: c, net: shadowNet });
    assert.equal(shadow.prepared?.mode, "shadow");

    for (const [name, other, net] of [["off", off, offNet], ["shadow", shadow, shadowNet]] as const) {
      assert.equal(other.contentHash, baseline.contentHash, `${name}: same content hash`);
      assert.deepEqual(other.outcome.ok && other.outcome.packet, baseline.outcome.ok && baseline.outcome.packet, `${name}: same packet`);
      assert.deepEqual(other.diagnostics, baseline.diagnostics, `${name}: same diagnostics`);
      assert.deepEqual(
        [other.outcome.calls, other.outcome.inputTokens, other.outcome.outputTokens, other.outcome.costUsd],
        [baseline.outcome.calls, baseline.outcome.inputTokens, baseline.outcome.outputTokens, baseline.outcome.costUsd],
        `${name}: same OpenAI usage and cost (Claude spend is not mixed in)`,
      );
      assert.deepEqual(net.openai, baselineNet.openai, `${name}: byte-identical OpenAI requests`);
    }
    assert.equal(offNet.anthropic.length + offNet.ledger.calls.length, 0, "off: no Claude, no ledger");
    // Deferred: nothing reaches Claude or the ledger while the report is generated; one call after delivery.
    assert.equal(shadow.duringGeneration, 0);
    assert.equal(shadowNet.anthropic.length, 1);
    assert.deepEqual(shadowNet.ledger.calls, ["ai_ledger_reserve", "ai_ledger_mark_sent", "ai_ledger_settle"]);
    assert.deepEqual(shadow.flush, { attempted: 1, skipped: 0, reason: null });
    const record = shadow.records[0];
    assert.deepEqual([record.ok, record.callId, record.inputTokens, record.outputTokens], [true, `mr:${CYCLE}:a1:generate:1`, 20_000, 9_000]);
    assert.equal(record.estimatedCostUsd, 0.26, "20,000 x $4/M + 9,000 x $20/M: about the measured Opus report cost");
    assert.deepEqual(shadowNet.ledger.settlements, [{ outcome: "succeeded", cost: 0.26, basis: "measured", input: 20_000, output: 9_000 }]);
    assert.ok(shadowNet.anthropic[0].system.startsWith("あなたは日本株の市場レポート編集者です"), "the legacy generation prompt");
    assert.ok(Number(shadowNet.ledger.reserves[0].amount_usd) <= 1, "upper bound within the $1 per-attempt policy");
  });
}

test("regeneration: 'last' shadows only the delivered generation, 'all' both, with distinct deterministic callIds", async () => {
  const c = CASES[2];
  const input = inputOf(await loadFixture(c.fixture));
  const script = () => [
    { step: "generate" as const, payload: c.make(input) },
    { step: "fact" as const, payload: { passed: false, issues: ["根拠の無い因果"], objective_issues: [] } },
    { step: "generate" as const, payload: c.make(input) },
    { step: "fact" as const, payload: { passed: true, issues: [], objective_issues: [] } },
  ];
  const lastNet = network({ legacy: script(), anthropic: claudeAnswer(c.make(input)) });
  const last = await run({ case: c, net: lastNet });
  assert.equal(last.outcome.ok && last.outcome.packet.fact.generation_attempts, 2);
  assert.equal(lastNet.anthropic.length, 1);
  assert.ok(lastNet.anthropic[0].system.includes("前回の生成は次の理由で不合格でした"), "the regenerated prompt was shadowed");
  assert.deepEqual(last.flush, { attempted: 1, skipped: 1, reason: null });

  const allNet = network({ legacy: script(), anthropic: claudeAnswer(c.make(input)) });
  const all = await run({ case: c, net: allNet, prepare: { selection: "all" } });
  assert.equal(allNet.anthropic.length, 2);
  assert.deepEqual(all.records.map((r) => r.callId), [`mr:${CYCLE}:a1:generate:1`, `mr:${CYCLE}:a1:generate:2`]);
  assert.equal(all.contentHash, last.contentHash, "the delivered report does not depend on the selection");
});

test("'all': the time left is checked again before the second shadow, which is skipped when the first used it up", async () => {
  const c = CASES[2];
  const input = inputOf(await loadFixture(c.fixture));
  let clock = 1_000_000;
  const net = network({
    legacy: [
      { step: "generate", payload: c.make(input) },
      { step: "fact", payload: { passed: false, issues: ["根拠の無い因果"], objective_issues: [] } },
      { step: "generate", payload: c.make(input) },
      { step: "fact", payload: { passed: true, issues: [], objective_issues: [] } },
    ],
    anthropic: () => {
      clock += 50_000; // the first shadow takes 50 s of the 60 s window
      return claudeAnswer(c.make(input))();
    },
  });
  const r = await run({
    case: c, net, deadlineAtMs: clock + 60_000,
    prepare: { selection: "all", nowMs: () => clock, timing: { marginMs: 0, minWindowMs: 20_000 } },
  });
  assert.deepEqual(r.flush, { attempted: 1, skipped: 1, reason: "NO_TIME" });
  assert.equal(net.anthropic.length, 1);
  assert.deepEqual(net.ledger.calls, ["ai_ledger_reserve", "ai_ledger_mark_sent", "ai_ledger_settle"], "no second reservation");
});

test("a duplicate run of the same claim attempt pays once; the next claim attempt is a new call", async () => {
  const c = CASES[0];
  const input = inputOf(await loadFixture(c.fixture));
  const ledger = new FakeLedgerRest();
  const first = network({ legacy: await legacyScript(c), anthropic: claudeAnswer(c.make(input)), ledger });
  const a = await run({ case: c, net: first });
  const second = network({ legacy: await legacyScript(c), anthropic: claudeAnswer(c.make(input)), ledger });
  const b = await run({ case: c, net: second });
  assert.equal(a.contentHash, b.contentHash);
  assert.equal(first.anthropic.length + second.anthropic.length, 1, "one paid call for one claim attempt");
  assert.deepEqual([b.records[0].errorCode, b.records[0].detail], ["BUDGET_DENIED", "ATTEMPT_FINALIZED"]);
  const third = network({ legacy: await legacyScript(c), anthropic: claudeAnswer(c.make(input)), ledger });
  const next = await run({ case: c, net: third, claim: { cycle_id: CYCLE, attempt: 2 } });
  assert.equal(third.anthropic.length, 1);
  assert.equal(next.records[0].callId, `mr:${CYCLE}:a2:generate:1`);
});

test("trial budget: the 7th shadow of a JST day and the month's caps are refused before sending; reports unaffected", async () => {
  const c = CASES[0];
  const input = inputOf(await loadFixture(c.fixture));
  const ledger = new FakeLedgerRest();
  const sent: number[] = [];
  for (let i = 1; i <= 7; i += 1) {
    const net = network({ legacy: await legacyScript(c), anthropic: claudeAnswer(c.make(input)), ledger });
    const r = await run({ case: c, net, claim: { cycle_id: `7c9e6679-7425-40de-944b-e07fc1f90a${String(i).padStart(2, "0")}`, attempt: 1 } });
    assert.equal(r.outcome.ok, true);
    sent.push(net.anthropic.length);
    if (i === 7) assert.deepEqual([r.records[0].errorCode, r.records[0].detail], ["BUDGET_DENIED", "CALL_LIMIT"]);
  }
  assert.deepEqual(sent, [1, 1, 1, 1, 1, 1, 0]);
  assert.ok(ledger.day.usd <= 2 && Math.abs(ledger.day.usd - 6 * 0.26) < 1e-9, `day spend ${ledger.day.usd}`);

  const monthCalls = new FakeLedgerRest();
  monthCalls.month = { calls: 40, usd: 1 };
  const netCalls = network({ legacy: await legacyScript(c), ledger: monthCalls });
  const capped = await run({ case: c, net: netCalls });
  assert.deepEqual([capped.records[0].detail, netCalls.anthropic.length], ["CALL_LIMIT", 0]);

  const monthUsd = new FakeLedgerRest();
  monthUsd.month = { calls: 10, usd: 4.8 };
  const netUsd = network({ legacy: await legacyScript(c), ledger: monthUsd });
  const spent = await run({ case: c, net: netUsd });
  assert.deepEqual([spent.records[0].detail, netUsd.anthropic.length], ["COST_LIMIT", 0], "4.80 + the reservation upper bound > $5");
});

test("failures after delivery stay in the shadow: ledger auth rejected, Claude errors, timeout, cancel, recorder failure", async () => {
  const c = CASES[1];
  const input = inputOf(await loadFixture(c.fixture));
  const baseline = await run({ case: c, net: network({ legacy: await legacyScript(c) }), wiring: false });

  const rejected = new FakeLedgerRest();
  rejected.rejectAuth = true;
  const authNet = network({ legacy: await legacyScript(c), ledger: rejected });
  const auth = await run({ case: c, net: authNet });
  assert.deepEqual([auth.records[0].errorCode, auth.records[0].detail, authNet.anthropic.length], ["BUDGET_DENIED", "GUARD_UNAVAILABLE", 0]);

  for (const [status, type, code] of [[529, "overloaded_error", "OVERLOADED"], [429, "rate_limit_error", "RATE_LIMITED"]] as const) {
    const net = network({ legacy: await legacyScript(c), anthropic: () => jsonResponse(status, anthropicError(status, type, "fake")) });
    const r = await run({ case: c, net });
    assert.deepEqual([r.records[0].errorCode, net.anthropic.length], [code, 1], code);
    assert.equal(r.contentHash, baseline.contentHash);
  }

  const slowNet = network({ legacy: await legacyScript(c), anthropic: (init) => hangUntilAborted(init) });
  const t0 = Date.now();
  const slow = await run({ case: c, net: slowNet, deadlineInMs: 1_500 });
  assert.ok(Date.now() - t0 < 10_000, "the shadow timeout is clipped to the time left before the deadline");
  assert.deepEqual([slow.records[0].errorCode, slow.records[0].costBasis], ["TIMEOUT", "includes_upper_bound"]);
  assert.equal(slowNet.ledger.settlements[0].outcome, "unknown", "a timed-out attempt is settled at its upper bound");

  const cancel = new AbortController();
  // Cancelled while the Claude request is in flight (the abort is triggered by the request itself, not by a timer race).
  const cancelNet = network({
    legacy: await legacyScript(c),
    anthropic: (init) => {
      setTimeout(() => cancel.abort(), 20);
      return hangUntilAborted(init);
    },
  });
  const t1 = Date.now();
  const cancelled = await run({ case: c, net: cancelNet, signal: cancel.signal, deadlineInMs: 60_000 });
  assert.ok(Date.now() - t1 < 5_000, "the handler's cancel signal ends a shadow in flight promptly");
  assert.equal(cancelled.records[0].ok, false);
  assert.ok(["NETWORK", "TIMEOUT", "PROTOCOL"].includes(String(cancelled.records[0].errorCode)), String(cancelled.records[0].errorCode));
  assert.equal(cancelled.contentHash, baseline.contentHash);

  const sinkNet = network({ legacy: await legacyScript(c), anthropic: claudeAnswer(c.make(input)) });
  const noisy = await run({ case: c, net: sinkNet, prepare: { sink: () => { throw new Error("recorder down"); } } });
  assert.deepEqual(noisy.flush, { attempted: 1, skipped: 0, reason: null });
  assert.equal(noisy.contentHash, baseline.contentHash);
});

test("no time left, cancelled before, legacy failure or retry, double flush: the shadow adds no call", async () => {
  const c = CASES[0];
  const input = inputOf(await loadFixture(c.fixture));
  const late = network({ legacy: await legacyScript(c) });
  const noTime = await run({ case: c, net: late, deadlineInMs: 500 });
  assert.deepEqual(noTime.flush, { attempted: 0, skipped: 1, reason: "NO_TIME" });
  assert.equal(late.ledger.calls.length, 0);

  const aborted = new AbortController();
  aborted.abort();
  const before = network({ legacy: await legacyScript(c) });
  const cancelled = await run({ case: c, net: before, signal: aborted.signal });
  assert.deepEqual(cancelled.flush, { attempted: 0, skipped: 1, reason: "CANCELLED" });
  assert.equal(before.ledger.calls.length, 0);

  // OpenAI fails (400: not retried): the report fails exactly as without the wiring, and nothing is remembered or sent.
  const failing = () => [{ step: "generate" as const, status: 400 }];
  const settle = (p: ReturnType<typeof run>) => p.then((r) => ({ outcome: r.outcome, flush: r.flush }), (error: Error) => error.message);
  const plainFail = await settle(run({ case: c, net: network({ legacy: failing() }), wiring: false }));
  const wiredNet = network({ legacy: failing() });
  const wiredFail = await settle(run({ case: c, net: wiredNet }));
  assert.match(JSON.stringify(plainFail), /ANALYSIS_OPENAI_GENERATE_FAILED:400/);
  assert.deepEqual(wiredFail, plainFail);
  assert.equal(wiredNet.anthropic.length + wiredNet.ledger.calls.length, 0);

  // OpenAI 503 then OK: the legacy transport retry is untouched (it lives inside the legacy requester) and the shadow
  // sees the one successful generation once.
  const retried = () => [{ step: "generate" as const, status: 503 }, ...deliver(c.make, input)];
  const plainRetry = await run({ case: c, net: network({ legacy: retried() }), wiring: false });
  const retryNet = network({ legacy: retried(), anthropic: claudeAnswer(c.make(input)) });
  const wiredRetry = await run({ case: c, net: retryNet });
  assert.equal(plainRetry.diagnostics.transport_retries, "1");
  assert.deepEqual(wiredRetry.diagnostics, plainRetry.diagnostics);
  assert.equal(wiredRetry.contentHash, plainRetry.contentHash);
  assert.deepEqual([retryNet.openai.length, retryNet.anthropic.length], [3, 1]);

  const once = network({ legacy: await legacyScript(c), anthropic: claudeAnswer(c.make(input)) });
  const twice = await run({ case: c, net: once });
  assert.deepEqual(await twice.prepared!.flush({ deadlineAtMs: Date.now() + 60_000 }), { attempted: 0, skipped: 0, reason: "ALREADY_FLUSHED" });
  assert.equal(once.anthropic.length, 1);
});

test("incomplete shadow configuration stays off and leaves the report identical", async () => {
  const c = CASES[0];
  const cases: Array<[string, Record<string, string | undefined>, MarketReportClaim | null | undefined]> = [
    ["SHADOW_MODEL_INVALID", { ...ENV, [MARKET_REPORT_SHADOW_MODEL_ENV]: undefined }, undefined],
    ["SHADOW_MODEL_INVALID", { ...ENV, [MARKET_REPORT_SHADOW_MODEL_ENV]: "gpt-6.1-sol" }, undefined],
    ["KEY_MISSING", { ...ENV, ANTHROPIC_API_KEY: undefined }, undefined],
    ["NO_LEDGER", { ...ENV, SUPABASE_SECRET_KEYS: undefined }, undefined],
    ["NO_LEDGER", { ...ENV, SUPABASE_URL: "http://not-https.example" }, undefined],
    ["BAD_CONTEXT", ENV, { cycle_id: null, attempt: 1 }],
    ["BAD_CONTEXT", ENV, null],
  ];
  for (const [reason, env, claim] of cases) {
    const net = network({ legacy: await legacyScript(c) });
    const r = await run({ case: c, net, env, claim });
    assert.deepEqual([r.prepared?.mode, r.prepared?.reason], ["off", reason]);
    assert.equal(r.prepared?.requester, r.legacy);
    assert.equal(net.anthropic.length + net.ledger.calls.length, 0);
  }
});

test("secrets and content never reach the records; the shadow reads only its five settings", async () => {
  const c = CASES[0];
  const input = inputOf(await loadFixture(c.fixture));
  const net = network({ legacy: await legacyScript(c), anthropic: claudeAnswer(c.make(input)) });
  const r = await run({ case: c, net });
  assert.deepEqual(
    [...new Set(r.reads)].sort(),
    [MARKET_REPORT_AI_MODE_ENV, MARKET_REPORT_SHADOW_MODEL_ENV, "ANTHROPIC_API_KEY", "SUPABASE_SECRET_KEYS", "SUPABASE_URL"].sort(),
  );
  const rendered = JSON.stringify({ records: r.records, flush: r.flush, diagnostics: r.diagnostics });
  for (const secret of [FAKE_ANTHROPIC_KEY, LEDGER_KEY, OPENAI_KEY, "あなたは日本株の市場レポート編集者です"]) {
    assert.ok(!rendered.includes(secret), `leaked ${secret.slice(0, 10)}`);
  }
  // The ledger is reached with the project's new-format secret key in apikey and Bearer (the report's own pattern).
  assert.deepEqual(net.ledger.calls, ["ai_ledger_reserve", "ai_ledger_mark_sent", "ai_ledger_settle"]);
});
