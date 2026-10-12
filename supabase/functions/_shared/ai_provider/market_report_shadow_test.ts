// Phase 2a: the market report -> shared provider connection candidate, offline only. Every Claude response is a
// synthetic fake (recordingFetch); the ledger is an in-test fake that keeps the real ledger's one-send-per-attempt
// rule. The legacy request bodies are the real ones the report builds, from an offline repository fixture.
//   deno test --no-config --allow-env --allow-read supabase/functions/_shared/ai_provider/market_report_shadow_test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { factRequestBody, generateSharedAnalysis, generationRequestBody } from "../../market-report-analysis/analysis_logic.ts";
import { inputOf, loadFixture, rich0917 } from "../../market-report-analysis/test_support.ts";
import type { BudgetCallContext, BudgetDecision, BudgetDenyReason, BudgetGuard, BudgetReservation, BudgetSettlement } from "./budget.ts";
import { attemptCostUsd, upperBoundAttemptCostUsd } from "./cost.ts";
import {
  compareStructure,
  createMarketReportRequester,
  ledgerGuardFromEdgeEnv,
  MARKET_REPORT_AI_MODE_ENV,
  type MarketReportRequester,
  type MarketReportRequesterOptions,
  type MarketReportShadowRecord,
  marketReportShadowCallId,
  parseMarketReportAiMode,
  shadowRequestFromResponsesBody,
} from "./market_report_shadow.ts";
import { findModelSpec } from "./model_catalog.ts";
import { DEFAULT_RETRY_TIMING } from "./retry.ts";
import { anthropicBody, anthropicError, FAKE_ANTHROPIC_KEY, fakeEnv, hangUntilAborted, jsonResponse, recordingFetch, type Responder } from "./test_support.ts";

const MODEL = "claude-opus-5-5";
const CYCLE = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const CONTEXT = { cycleId: CYCLE, claimAttempt: 1 };
const NOW = () => new Date("2026-09-17T07:20:05Z");

const fixture = await loadFixture("close_2026-09-17");
const INPUT = inputOf(fixture);
const LEGACY_ANALYSIS = rich0917(INPUT);
const GENERATE_BODY = generationRequestBody(INPUT, []);
const FACT_BODY = factRequestBody(INPUT, LEGACY_ANALYSIS);
const FACT_PASS = { passed: true, issues: [], objective_issues: [] };

/** The legacy (OpenAI) requester stand-in: fixed results, every call recorded. */
function legacyRequester(log: string[] = []): MarketReportRequester {
  return (step) => {
    log.push(step);
    return Promise.resolve({ payload: step === "generate" ? LEGACY_ANALYSIS : FACT_PASS, inputTokens: 1000, outputTokens: 200 });
  };
}

/** A ledger stand-in with the real ledger's rule: one send per (callId, attempt); a finalised attempt never again. */
class FakeLedger implements BudgetGuard {
  readonly state = new Map<string, "reserved" | "sent" | "released" | "settled">();
  readonly byReservation = new Map<string, string>();
  readonly contexts: BudgetCallContext[] = [];
  readonly settled: Array<{ costUsd: number; settlement: BudgetSettlement | undefined }> = [];
  deny: BudgetDenyReason | null = null;
  settleThrows = false;
  #n = 0;

  reserve(context: BudgetCallContext, upperBoundUsd: number): Promise<BudgetDecision> {
    if (this.deny) return Promise.resolve({ allowed: false, reason: this.deny, limitId: "fake" });
    const key = `${context.callId}#${context.attempt}`;
    const current = this.state.get(key);
    if (current === "settled") return Promise.resolve({ allowed: false, reason: "ATTEMPT_FINALIZED", limitId: null });
    if (current === "sent") return Promise.resolve({ allowed: false, reason: "SEND_NOT_CONFIRMED", limitId: null });
    this.contexts.push(context);
    this.state.set(key, "reserved");
    const id = `r${++this.#n}`;
    this.byReservation.set(id, key);
    return Promise.resolve({ allowed: true, reservation: { id, limitIds: ["fake"], reservedUsd: upperBoundUsd } });
  }
  markSent(reservation: BudgetReservation): Promise<void> {
    const key = this.byReservation.get(reservation.id)!;
    if (this.state.get(key) !== "reserved") return Promise.reject(new Error("not sendable"));
    this.state.set(key, "sent");
    return Promise.resolve();
  }
  release(reservation: BudgetReservation): Promise<void> {
    const key = this.byReservation.get(reservation.id)!;
    if (this.state.get(key) === "reserved") this.state.set(key, "released");
    return Promise.resolve();
  }
  settle(reservation: BudgetReservation, costUsd: number, settlement?: BudgetSettlement): Promise<void> {
    if (this.settleThrows) return Promise.reject(new Error("ledger down"));
    this.state.set(this.byReservation.get(reservation.id)!, "settled");
    this.settled.push({ costUsd, settlement });
    return Promise.resolve();
  }
}

const env = (mode: string | undefined, extra: Record<string, string | undefined> = {}) =>
  fakeEnv({ [MARKET_REPORT_AI_MODE_ENV]: mode, ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY, ...extra });

function shadow(responder: Responder, overrides: Partial<MarketReportRequesterOptions> = {}) {
  const provider = recordingFetch(responder);
  const records: MarketReportShadowRecord[] = [];
  const ledger = (overrides.budget as FakeLedger | undefined) ?? new FakeLedger();
  const legacyLog: string[] = [];
  const decision = createMarketReportRequester({
    legacy: legacyRequester(legacyLog),
    shadowModel: MODEL,
    readEnv: env("shadow").readEnv,
    context: CONTEXT,
    budget: ledger,
    sink: (record) => records.push(record),
    fetch: provider.fetch,
    ...overrides,
  });
  return { decision, provider, records, ledger, legacyLog };
}

const claudeOk: Responder = () => jsonResponse(200, anthropicBody(LEGACY_ANALYSIS), { "request-id": "req_shadow_1" });

// ---- mode and fail-safe defaults -----------------------------------------------------------------------------------

test("mode: only the exact value 'shadow' turns it on; unset, off, typos, 'primary' and 'on' are off", () => {
  assert.deepEqual(parseMarketReportAiMode(undefined), { mode: "off", reason: "UNSET" });
  assert.deepEqual(parseMarketReportAiMode(""), { mode: "off", reason: "UNSET" });
  assert.deepEqual(parseMarketReportAiMode("off"), { mode: "off", reason: "OFF" });
  assert.deepEqual(parseMarketReportAiMode("shadow"), { mode: "shadow", reason: "SHADOW" });
  for (const value of ["Shadow", "SHADOW", " shadow", "shadow ", "on", "primary", "claude", "true", "1"]) {
    assert.deepEqual(parseMarketReportAiMode(value), { mode: "off", reason: "UNSUPPORTED_VALUE" }, value);
  }
});

test("off (the default) returns the legacy requester itself and reads nothing else", () => {
  const legacy = legacyRequester();
  for (const mode of [undefined, "off", "primary"]) {
    const reader = env(mode);
    const decision = createMarketReportRequester({
      legacy, shadowModel: MODEL, readEnv: reader.readEnv, context: CONTEXT, budget: new FakeLedger(), sink: () => assert.fail("no record"),
    });
    assert.equal(decision.mode, "off");
    assert.equal(decision.requester, legacy, "the very same function: behaviour cannot differ");
    assert.deepEqual(reader.reads, [MARKET_REPORT_AI_MODE_ENV], "the Anthropic key is not even read when off");
  }
});

test("shadow without a usable key, ledger, context or Anthropic catalog model stays off (legacy unchanged)", () => {
  const legacy = legacyRequester();
  const cases: Array<[string, Partial<MarketReportRequesterOptions>]> = [
    ["KEY_MISSING", { readEnv: fakeEnv({ [MARKET_REPORT_AI_MODE_ENV]: "shadow" }).readEnv }],
    ["KEY_INVALID", { readEnv: env("shadow", { ANTHROPIC_API_KEY: "sk-ant-admin01-NOT-REAL-00000000000000" }).readEnv }],
    ["NO_LEDGER", { budget: null }],
    ["BAD_CONTEXT", { context: undefined }],
    ["BAD_CONTEXT", { context: { cycleId: "not-a-uuid", claimAttempt: 1 } }],
    ["BAD_CONTEXT", { context: { cycleId: CYCLE, claimAttempt: 0 } }],
    ["SHADOW_MODEL_INVALID", { shadowModel: "gpt-6.1-sol" }],
    ["SHADOW_MODEL_INVALID", { shadowModel: "claude-unknown-9" }],
  ];
  for (const [reason, override] of cases) {
    const decision = createMarketReportRequester({
      legacy, shadowModel: MODEL, readEnv: env("shadow").readEnv, context: CONTEXT, budget: new FakeLedger(), sink: () => {}, ...override,
    });
    assert.deepEqual([decision.mode, decision.reason], ["off", reason]);
    assert.equal(decision.requester, legacy);
  }
});

// ---- translation of the real report bodies -------------------------------------------------------------------------

test("the real generate and fact bodies translate to a system market-report request with the same prompt and schema", () => {
  for (const [step, body] of [["generate", GENERATE_BODY], ["fact", FACT_BODY]] as const) {
    const callId = marketReportShadowCallId(CONTEXT, step, 1);
    const translated = shadowRequestFromResponsesBody(step, body, { callId, timeoutMs: 90_000, model: MODEL });
    assert.ok(translated.ok, step);
    if (!translated.ok) continue;
    const request = translated.request;
    const legacyFormat = (body.text as { format: { name: string; schema: unknown } }).format;
    assert.equal(request.provider, "anthropic");
    assert.equal(request.model, MODEL, "the legacy model id in the body is ignored");
    assert.equal(request.systemInstructions, body.instructions);
    assert.equal(request.userContent, body.input);
    assert.deepEqual(request.jsonSchema, { name: legacyFormat.name, schema: legacyFormat.schema });
    assert.equal(request.maxOutputTokens, body.max_output_tokens);
    assert.equal(request.reasoningEffort, (body.reasoning as { effort: string }).effort);
    assert.deepEqual(request.transport, { maxAttempts: 1, retryOnTimeout: false });
    assert.deepEqual(request.usageContext, { application: "kabumori", feature: "market_report", subject: { kind: "system" } });
    assert.equal(request.callId, `mr:${CYCLE}:a1:${step}:1`);
    // The ledger's trial policy allows at most $1.00 per attempt.
    const upper = upperBoundAttemptCostUsd(findModelSpec(MODEL)!, request);
    assert.ok(upper > 0 && upper <= 1, `${step} upper bound ${upper}`);
  }
});

test("a body that is not the report's shape is refused before anything is sent", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["BODY_INSTRUCTIONS", { ...GENERATE_BODY, instructions: "" }],
    ["BODY_INPUT", { ...GENERATE_BODY, input: { not: "a string" } }],
    ["BODY_SCHEMA", { ...GENERATE_BODY, text: { format: { type: "text" } } }],
    ["BODY_MAX_OUTPUT", { ...GENERATE_BODY, max_output_tokens: 0 }],
    ["BODY_EFFORT", { ...GENERATE_BODY, reasoning: { effort: "turbo" } }],
  ];
  for (const [code, body] of bad) {
    assert.deepEqual(shadowRequestFromResponsesBody("generate", body, { callId: "mr:x", timeoutMs: 1000, model: MODEL }), { ok: false, code });
  }
});

// ---- shadow behaviour ----------------------------------------------------------------------------------------------

test("shadow: the legacy result is returned unchanged; one Claude call; ledger reserve -> sent -> settled at the same cost", async () => {
  const { decision, provider, records, ledger, legacyLog } = shadow(claudeOk);
  assert.equal(decision.mode, "shadow");
  const legacyResult = await legacyRequester()("generate", GENERATE_BODY);
  const result = await decision.requester("generate", GENERATE_BODY);
  assert.deepEqual(result, legacyResult);
  assert.deepEqual(legacyLog, ["generate"]);
  assert.equal(provider.calls.length, 1);
  assert.equal(new URL(provider.calls[0].url).hostname, "api.anthropic.com");
  assert.equal(records.length, 1);
  const record = records[0];
  const expectedCost = attemptCostUsd(findModelSpec(MODEL)!, {
    inputTokens: 800, cacheReadInputTokens: 0, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 150,
  });
  assert.deepEqual(
    [record.ok, record.errorCode, record.providerRequests, record.actualModel, record.inputTokens, record.outputTokens, record.costBasis],
    [true, null, 1, MODEL, 800, 400, "measured"],
  );
  assert.equal(record.estimatedCostUsd, expectedCost);
  assert.equal(record.estimatedCostUsd, 0.0112, "800 x $4/M + 400 x $20/M");
  // The ledger was settled with exactly the figure the record reports, as a succeeded, measured attempt.
  assert.equal(ledger.settled.length, 1);
  assert.equal(ledger.settled[0].costUsd, record.estimatedCostUsd);
  assert.deepEqual([ledger.settled[0].settlement?.outcome, ledger.settled[0].settlement?.costBasis], ["succeeded", "measured"]);
  const context = ledger.contexts[0];
  assert.deepEqual(
    [context.provider, context.model, context.application, context.feature, context.logicalRole, context.subject, context.callId],
    ["anthropic", MODEL, "kabumori", "market_report", "kabumori.market_report.generate.shadow", { kind: "system" }, `mr:${CYCLE}:a1:generate:1`],
  );
  assert.equal(record.structure?.sameTopLevelKeys, true);
});

test("shadow runs only after a successful legacy step, only for the listed steps, and at most maxShadowCalls times", async () => {
  const run = shadow(claudeOk);
  await run.decision.requester("fact", FACT_BODY);
  assert.equal(run.provider.calls.length, 0, "fact is not shadowed by default");
  await run.decision.requester("generate", GENERATE_BODY);
  await run.decision.requester("generate", GENERATE_BODY);
  await run.decision.requester("generate", GENERATE_BODY);
  assert.equal(run.provider.calls.length, 2, "default cap: two shadow calls per invocation");
  assert.deepEqual(run.records.map((r) => r.callId), [`mr:${CYCLE}:a1:generate:1`, `mr:${CYCLE}:a1:generate:2`]);

  const both = shadow(() => jsonResponse(200, anthropicBody(FACT_PASS)), { steps: ["fact"], maxShadowCalls: 1 });
  await both.decision.requester("fact", FACT_BODY);
  await both.decision.requester("fact", FACT_BODY);
  assert.equal(both.provider.calls.length, 1);
  assert.equal(both.records[0].ok, true);

  const failing = shadow(claudeOk, { legacy: () => Promise.reject(new Error("ANALYSIS_OPENAI_GENERATE_FAILED:500")) });
  await assert.rejects(failing.decision.requester("generate", GENERATE_BODY), /ANALYSIS_OPENAI_GENERATE_FAILED:500/u);
  assert.equal(failing.provider.calls.length, 0, "no shadow after a legacy failure");
  assert.equal(failing.ledger.contexts.length, 0);
});

test("provider errors: exactly one request, no retry, no fallback, recorded; the legacy result still returned", async () => {
  const errors: Array<[number, string, string, string]> = [
    [429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit", "RATE_LIMITED"],
    [529, "overloaded_error", "Overloaded", "OVERLOADED"],
    [500, "api_error", "Internal server error", "SERVER_ERROR"],
    [400, "invalid_request_error", "You have reached your specified workspace API usage limits", "SPEND_LIMIT"],
    [400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.", "CREDIT_EXHAUSTED"],
    [401, "authentication_error", "invalid x-api-key", "AUTH"],
  ];
  for (const [status, type, message, code] of errors) {
    const run = shadow(() => jsonResponse(status, anthropicError(status, type, message)));
    const result = await run.decision.requester("generate", GENERATE_BODY);
    assert.equal(result.payload, LEGACY_ANALYSIS, code);
    assert.equal(run.provider.calls.length, 1, `${code}: one request`);
    assert.deepEqual([run.records[0].ok, run.records[0].errorCode], [false, code]);
    assert.equal(run.records[0].structure, null);
  }
});

test("schema violation and cut-off output are recorded as failures; nothing reaches the report", async () => {
  const violation = shadow(() => jsonResponse(200, anthropicBody({ headline_ja: "only one field" })));
  assert.equal((await violation.decision.requester("generate", GENERATE_BODY)).payload, LEGACY_ANALYSIS);
  assert.deepEqual([violation.records[0].ok, violation.records[0].errorCode], [false, "SCHEMA_VIOLATION"]);

  const long = shadow(() => jsonResponse(200, anthropicBody(LEGACY_ANALYSIS, { stopReason: "max_tokens" })));
  assert.equal((await long.decision.requester("generate", GENERATE_BODY)).payload, LEGACY_ANALYSIS);
  assert.deepEqual([long.records[0].ok, long.records[0].errorCode], [false, "INCOMPLETE"]);
  assert.equal(long.ledger.settled[0].settlement?.outcome, "failed", "a cut-off answer is still billed and recorded");
});

test("budget denial: nothing is sent and the report is unaffected", async () => {
  for (const reason of ["NO_MATCHING_LIMIT", "CALL_LIMIT", "COST_LIMIT", "PER_CALL_LIMIT"] as const) {
    const ledger = new FakeLedger();
    ledger.deny = reason;
    const run = shadow(claudeOk, { budget: ledger });
    assert.equal((await run.decision.requester("generate", GENERATE_BODY)).payload, LEGACY_ANALYSIS);
    assert.equal(run.provider.calls.length, 0, reason);
    assert.deepEqual([run.records[0].ok, run.records[0].errorCode, run.records[0].detail], [false, "BUDGET_DENIED", reason]);
  }
});

test("a re-run of the same claim attempt is refused by the ledger: no second paid call (idempotent callIds)", async () => {
  const ledger = new FakeLedger();
  const first = shadow(claudeOk, { budget: ledger });
  await first.decision.requester("generate", GENERATE_BODY);
  const rerun = shadow(claudeOk, { budget: ledger });
  await rerun.decision.requester("generate", GENERATE_BODY);
  assert.equal(first.provider.calls.length + rerun.provider.calls.length, 1);
  assert.deepEqual([rerun.records[0].errorCode, rerun.records[0].detail], ["BUDGET_DENIED", "ATTEMPT_FINALIZED"]);
  // The next claim attempt is a different call.
  const next = shadow(claudeOk, { budget: ledger, context: { cycleId: CYCLE, claimAttempt: 2 } });
  await next.decision.requester("generate", GENERATE_BODY);
  assert.equal(next.provider.calls.length, 1);
  assert.equal(next.records[0].callId, `mr:${CYCLE}:a2:generate:1`);
});

test("ledger settle failure after the send: recorded as sent and successful; the hold stays for the ledger's recovery", async () => {
  const ledger = new FakeLedger();
  ledger.settleThrows = true;
  const run = shadow(claudeOk, { budget: ledger });
  assert.equal((await run.decision.requester("generate", GENERATE_BODY)).payload, LEGACY_ANALYSIS);
  assert.equal(run.records[0].ok, true);
  assert.deepEqual([...ledger.state.values()], ["sent"], "not released: recovery finalises it at its upper bound");
});

test("timeout and cancellation: bounded, recorded, never in the way of the report", async () => {
  // The shadow's deadline is start + timeoutMs, and execute.ts sends an attempt only while at least
  // min(DEFAULT_RETRY_TIMING.minAttemptMs, timeoutMs) is left. A timeout at or below that window is refused before
  // sending (DEADLINE_EXCEEDED) as soon as 1 ms has passed, so this case needs a timeout clearly above it.
  const slowTimeoutMs = 6_000;
  assert.ok(slowTimeoutMs >= DEFAULT_RETRY_TIMING.minAttemptMs + 1_000, "the slow case must wait for a real transport timeout");
  const slow = shadow((_call, _i, init) => hangUntilAborted(init), { timeoutMs: slowTimeoutMs });
  const started = Date.now();
  assert.equal((await slow.decision.requester("generate", GENERATE_BODY)).payload, LEGACY_ANALYSIS);
  // Ended by its own 6 s timeout: far below the 90 s default, with slack for a loaded machine.
  assert.ok(Date.now() - started < 10_000);
  assert.deepEqual([slow.records[0].ok, slow.records[0].errorCode, slow.records[0].costBasis], [false, "TIMEOUT", "includes_upper_bound"]);

  const before = new AbortController();
  before.abort();
  const cancelledBefore = shadow(claudeOk, { signal: before.signal });
  assert.equal((await cancelledBefore.decision.requester("generate", GENERATE_BODY)).payload, LEGACY_ANALYSIS);
  assert.equal(cancelledBefore.provider.calls.length, 0);
  assert.equal(cancelledBefore.records.length, 0);

  const during = new AbortController();
  const cancelledDuring = shadow((_call, _i, init) => hangUntilAborted(init), { signal: during.signal, timeoutMs: 60_000 });
  setTimeout(() => during.abort(), 50);
  const t0 = Date.now();
  assert.equal((await cancelledDuring.decision.requester("generate", GENERATE_BODY)).payload, LEGACY_ANALYSIS);
  assert.ok(Date.now() - t0 < 5_000, "cancellation ends the shadow promptly");
  assert.equal(cancelledDuring.records[0].ok, false);
  assert.ok(["NETWORK", "TIMEOUT", "PROTOCOL"].includes(String(cancelledDuring.records[0].errorCode)), String(cancelledDuring.records[0].errorCode));
});

test("a sink that throws never reaches the report", async () => {
  const run = shadow(claudeOk, { sink: () => { throw new Error("sink down"); } });
  assert.equal((await run.decision.requester("generate", GENERATE_BODY)).payload, LEGACY_ANALYSIS);
});

test("records carry no key, prompt, input or output text — only identifiers, counts, codes and shapes", async () => {
  const runs = [
    shadow(claudeOk),
    shadow(() => jsonResponse(401, anthropicError(401, "authentication_error", `bad key ${FAKE_ANTHROPIC_KEY}`))),
    shadow(() => jsonResponse(200, anthropicBody({ headline_ja: LEGACY_ANALYSIS.headline_ja }))),
  ];
  const sentinels = [
    FAKE_ANTHROPIC_KEY,
    "あなたは日本株の市場レポート編集者です",
    String(GENERATE_BODY.input).slice(0, 40),
    LEGACY_ANALYSIS.headline_ja,
    LEGACY_ANALYSIS.market_summary_ja.slice(0, 20),
  ];
  for (const run of runs) {
    await run.decision.requester("generate", GENERATE_BODY);
    const rendered = JSON.stringify(run.records);
    for (const sentinel of sentinels) assert.ok(!rendered.includes(sentinel), `leaked: ${sentinel.slice(0, 12)}`);
    assert.deepEqual(Object.keys(run.records[0]).sort(), [
      "actualModel", "callId", "costBasis", "detail", "errorCode", "estimatedCostUsd", "inputTokens", "latencyMs", "model", "ok",
      "outputTokens", "providerRequests", "sequence", "step", "structure",
    ]);
  }
});

test("structure comparison is content-free: schema key names, kinds and sizes only", () => {
  const comparison = compareStructure(LEGACY_ANALYSIS, { ...LEGACY_ANALYSIS, claims: LEGACY_ANALYSIS.claims.slice(0, 1), x_post: undefined, extra: 1 });
  assert.equal(comparison.sameTopLevelKeys, false);
  assert.deepEqual(comparison.extraInShadow, ["extra"]);
  assert.deepEqual(comparison.fields.claims, { legacy: { kind: "array", size: LEGACY_ANALYSIS.claims.length }, shadow: { kind: "array", size: 1 } });
  assert.deepEqual(comparison.fields.x_post.shadow, { kind: "absent", size: null });
  assert.equal(comparison.fields.headline_ja.legacy.size, [...LEGACY_ANALYSIS.headline_ja].length);
  assert.ok(!JSON.stringify(comparison).includes(LEGACY_ANALYSIS.headline_ja));
  assert.deepEqual(compareStructure("text", null).fields, {});
});

test("the real report pipeline gives the identical outcome with the shadow on (shadow ran once, no effect)", async () => {
  const plain = await generateSharedAnalysis(INPUT, legacyRequester(), NOW);
  const run = shadow(claudeOk);
  const shadowed = await generateSharedAnalysis(INPUT, run.decision.requester, NOW);
  assert.equal(plain.ok, true);
  assert.equal(shadowed.ok, plain.ok);
  if (!plain.ok || !shadowed.ok) return;
  assert.deepEqual(shadowed.packet, plain.packet);
  assert.deepEqual([shadowed.calls, shadowed.inputTokens, shadowed.outputTokens, shadowed.costUsd], [plain.calls, plain.inputTokens, plain.outputTokens, plain.costUsd]);
  assert.equal(run.provider.calls.length, 1);
  assert.equal(run.records[0].ok, true);
});

test("ledgerGuardFromEdgeEnv: needs SUPABASE_URL and SUPABASE_SECRET_KEYS.default; never touches the network", () => {
  const network = recordingFetch(() => assert.fail("no request"));
  const read = (values: Record<string, string | undefined>) => (name: string) => values[name];
  assert.equal(ledgerGuardFromEdgeEnv(read({}), network.fetch), null);
  assert.equal(ledgerGuardFromEdgeEnv(read({ SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" }), network.fetch), null);
  assert.equal(ledgerGuardFromEdgeEnv(read({ SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SUPABASE_SECRET_KEYS: "not json" }), network.fetch), null);
  assert.equal(ledgerGuardFromEdgeEnv(read({ SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SUPABASE_SECRET_KEYS: '{"other":"x"}' }), network.fetch), null);
  assert.equal(ledgerGuardFromEdgeEnv(read({ SUPABASE_URL: "http://example.com", SUPABASE_SECRET_KEYS: '{"default":"sb_secret_NOT_REAL"}' }), network.fetch), null);
  const guard = ledgerGuardFromEdgeEnv(read({ SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SUPABASE_SECRET_KEYS: '{"default":"sb_secret_NOT_REAL_000"}' }), network.fetch);
  assert.ok(guard);
  assert.ok(!JSON.stringify(guard).includes("sb_secret_NOT_REAL_000"));
  assert.equal(network.calls.length, 0);
});
