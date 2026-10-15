// F6 J1 R2 (2026-10-16): an attempt that may have been processed and billed is never sent again by this layer.
// Only a rate limit / overload the provider reported as not processed is retried, within maxAttempts and the budget.
// Fake fetch, fake clock, fake keys and a fake ledger with the database ledger's (callId, attempt) rules. No network.
import assert from "node:assert/strict";
import test from "node:test";
import type { BudgetCallContext, BudgetDecision, BudgetGuard, BudgetReservation, BudgetSettlement } from "./budget.ts";
import { upperBoundAttemptCostUsd } from "./cost.ts";
import { executeAiRequest } from "./execute.ts";
import { findModelSpec } from "./model_catalog.ts";
import {
  anthropicBody,
  anthropicError,
  hangUntilAborted,
  jsonResponse,
  openAiBody,
  recordingFetch,
  type Responder,
  sampleRequest,
  testDeps,
  VALID_PAYLOAD,
} from "./test_support.ts";
import type { AiFailure, AiProvider, AiRequest, AiResult, AiTransportPolicy } from "./types.ts";

type Row = {
  readonly key: string;
  state: "held" | "sent" | "settled" | "released";
  readonly upperUsd: number;
  costUsd: number | null;
  settlement: BudgetSettlement | null;
};

/**
 * The database ledger's rules, in memory: one row per (callId, attempt); a settled attempt is final
 * (ATTEMPT_FINALIZED); an attempt marked sent but not settled has no second permit (ATTEMPT_IN_FLIGHT, reported to
 * the executor as SEND_NOT_CONFIRMED); a row marked sent is never released; held rows count at their upper bound.
 */
class ContractLedger implements BudgetGuard {
  readonly rows = new Map<string, Row>();
  readonly events: string[] = [];
  /** mark_sent commits, then its response is lost (the RPC throws after the row is already sent). */
  loseMarkSentResponse = false;
  constructor(private readonly maxEstimatedUsd = 100, private readonly maxCalls = Number.POSITIVE_INFINITY) {}

  totalUsd(): number {
    let total = 0;
    for (const row of this.rows.values()) {
      if (row.state === "released") continue;
      total += row.state === "settled" ? row.costUsd ?? row.upperUsd : row.upperUsd;
    }
    return total;
  }

  reserve(context: BudgetCallContext, upperBoundUsd: number): Promise<BudgetDecision> {
    const key = `${context.callId}#${context.attempt}`;
    const existing = this.rows.get(key);
    if (existing && existing.state === "settled") return Promise.resolve({ allowed: false, reason: "ATTEMPT_FINALIZED", limitId: null });
    if (existing && existing.state !== "released") return Promise.resolve({ allowed: false, reason: "SEND_NOT_CONFIRMED", limitId: null });
    const counted = [...this.rows.values()].filter((row) => row.state !== "released").length;
    if (counted + 1 > this.maxCalls) return Promise.resolve({ allowed: false, reason: "CALL_LIMIT", limitId: "contract" });
    if (this.totalUsd() + upperBoundUsd > this.maxEstimatedUsd) return Promise.resolve({ allowed: false, reason: "COST_LIMIT", limitId: "contract" });
    this.rows.set(key, { key, state: "held", upperUsd: upperBoundUsd, costUsd: null, settlement: null });
    this.events.push(`reserve ${key}`);
    return Promise.resolve({ allowed: true, reservation: { id: key, limitIds: ["contract"], reservedUsd: upperBoundUsd } });
  }

  markSent(reservation: BudgetReservation): Promise<void> {
    const row = this.rows.get(reservation.id);
    if (!row || row.state !== "held") return Promise.reject(new Error("not_held"));
    row.state = "sent";
    this.events.push(`markSent ${row.key}`);
    if (this.loseMarkSentResponse) return Promise.reject(new Error("response_lost_after_commit"));
    return Promise.resolve();
  }

  settle(reservation: BudgetReservation, costUsd: number, settlement?: BudgetSettlement): Promise<void> {
    const row = this.rows.get(reservation.id);
    if (!row || row.state !== "sent") return Promise.reject(new Error("not_sent"));
    row.state = "settled";
    row.costUsd = costUsd;
    row.settlement = settlement ?? null;
    this.events.push(`settle ${row.key} ${settlement?.outcome}/${settlement?.costBasis}`);
    return Promise.resolve();
  }

  release(reservation: BudgetReservation): Promise<void> {
    const row = this.rows.get(reservation.id);
    if (!row || row.state !== "held") return Promise.reject(new Error("marked_sent_never_released"));
    row.state = "released";
    this.events.push(`release ${row.key}`);
    return Promise.resolve();
  }
}

function failure(result: AiResult): AiFailure {
  assert.equal(result.ok, false);
  return result as AiFailure;
}

function sequence(...responders: Responder[]): Responder {
  return (call, index, init) => responders[Math.min(index, responders.length - 1)](call, index, init);
}
const ok = (provider: AiProvider): Responder => () =>
  jsonResponse(200, provider === "anthropic" ? anthropicBody(VALID_PAYLOAD) : openAiBody(VALID_PAYLOAD));
const status = (code: number, body: unknown, headers: Record<string, string> = {}): Responder => () => jsonResponse(code, body, headers);
const lostAfterSend: Responder = () => Promise.reject(new TypeError("connection reset by peer"));

async function run(request: AiRequest, responder: Responder, ledger = new ContractLedger()) {
  const net = recordingFetch(responder);
  const harness = testDeps(net.fetch, { budget: ledger });
  const result = await executeAiRequest(request, harness.deps);
  return { result, calls: net.calls, sleeps: harness.sleeps, envReads: harness.envReads, ledger };
}

function upper(request: AiRequest): number {
  return upperBoundAttemptCostUsd(findModelSpec(request.model)!, request);
}

/** One request to the request's own provider and model; only that provider's key was read. */
function assertNoFallback(request: AiRequest, calls: Array<{ url: string; body: unknown }>, envReads: string[]) {
  const url = request.provider === "anthropic" ? "https://api.anthropic.com/v1/messages" : "https://api.openai.com/v1/responses";
  for (const call of calls) {
    assert.equal(call.url, url);
    assert.equal((call.body as { model: string }).model, request.model);
  }
  assert.deepEqual(envReads, [request.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"]);
}

const AMBIGUOUS: Array<[string, AiProvider, Responder, string]> = [
  ["Anthropic 504 timeout_error", "anthropic", status(504, anthropicError(504, "timeout_error", "Request timed out")), "SERVER_ERROR"],
  ["Anthropic timeout_error on another status", "anthropic", status(500, anthropicError(500, "timeout_error", "Request timed out")), "SERVER_ERROR"],
  ["OpenAI 504", "openai", status(504, { error: { type: "server_error", code: null, message: "timeout" } }), "SERVER_ERROR"],
  ["Anthropic connection lost after send", "anthropic", lostAfterSend, "NETWORK"],
  ["OpenAI connection lost after send", "openai", lostAfterSend, "NETWORK"],
];

test("R2: a 504 / timeout_error or a connection lost after send is sent once, even with maxAttempts 3; settled unknown at the upper bound", async () => {
  for (const [label, provider, responder, code] of AMBIGUOUS) {
    const request = sampleRequest(provider, { callId: "r2-ambiguous", transport: { maxAttempts: 3 } });
    // The second response would succeed: it must never be asked for.
    const { result, calls, sleeps, envReads, ledger } = await run(request, sequence(responder, ok(provider)));
    const value = failure(result);
    assert.equal(calls.length, 1, label);
    assert.deepEqual(sleeps, [], label);
    assert.deepEqual([value.errorCode, value.transportAttempts, value.costBasis], [code, 1, "includes_upper_bound"], label);
    assert.equal(value.estimatedCostUsd, upper(request), label);
    assert.deepEqual(ledger.events, ["reserve r2-ambiguous#1", "markSent r2-ambiguous#1", "settle r2-ambiguous#1 unknown/upper_bound"], label);
    assert.equal(ledger.totalUsd(), upper(request), `${label}: the ledger keeps the upper bound`);
    assertNoFallback(request, calls, envReads);
  }
});

test("R2: other server errors (500 api_error, 502, Anthropic 503) are not known to be unsent and are not retried", async () => {
  const rows: Array<[AiProvider, number, unknown]> = [
    ["anthropic", 500, anthropicError(500, "api_error", "internal")],
    ["anthropic", 503, null],
    ["openai", 500, { error: { type: "server_error", code: null, message: "x" } }],
    ["openai", 502, { error: { message: "bad gateway" } }],
  ];
  for (const [provider, code, body] of rows) {
    const request = sampleRequest(provider, { transport: { maxAttempts: 3 } });
    const { result, calls, envReads } = await run(request, sequence(status(code, body), ok(provider)));
    assert.deepEqual([failure(result).errorCode, calls.length], ["SERVER_ERROR", 1], `${provider} ${code}`);
    assertNoFallback(request, calls, envReads);
  }
});

test("R2: a client timeout is sent once; asking to retry after a timeout is refused before any key read, reservation or request", async () => {
  const request = sampleRequest("anthropic", { callId: "r2-timeout", timeoutMs: 1_000, transport: { maxAttempts: 3 } });
  const timedOut = await run(request, sequence((_c, _i, init) => hangUntilAborted(init), ok("anthropic")));
  assert.deepEqual([failure(timedOut.result).errorCode, timedOut.calls.length], ["TIMEOUT", 1]);
  assert.deepEqual(timedOut.ledger.events, ["reserve r2-timeout#1", "markSent r2-timeout#1", "settle r2-timeout#1 unknown/upper_bound"]);

  const optIn = { maxAttempts: 3, retryOnTimeout: true } as unknown as AiTransportPolicy;
  for (const provider of ["anthropic", "openai"] as const) {
    const refused = await run(sampleRequest(provider, { timeoutMs: 1_000, transport: optIn }), ok(provider));
    assert.deepEqual([failure(refused.result).errorCode, failure(refused.result).detail], ["REQUEST_INVALID", "transport"]);
    assert.deepEqual([refused.calls.length, refused.envReads.length, refused.ledger.events.length], [0, 0, 0]);
  }
});

test("R2: known-unsent 429 / 529 / OpenAI 503 are retried only within maxAttempts; each attempt is reserved, sent once and settled at zero", async () => {
  const request = sampleRequest("anthropic", { callId: "r2-unsent", transport: { maxAttempts: 3 } });
  const retried = await run(
    request,
    sequence(status(429, anthropicError(429, "rate_limit_error", "slow"), { "retry-after": "2" }), status(529, anthropicError(529, "overloaded_error", "busy")), ok("anthropic")),
  );
  assert.equal(retried.result.ok, true);
  assert.equal(retried.calls.length, 3);
  assert.deepEqual(retried.sleeps, [2_000, 2_000]);
  assert.deepEqual(retried.ledger.events, [
    "reserve r2-unsent#1", "markSent r2-unsent#1", "settle r2-unsent#1 failed/measured",
    "reserve r2-unsent#2", "markSent r2-unsent#2", "settle r2-unsent#2 failed/measured",
    "reserve r2-unsent#3", "markSent r2-unsent#3", "settle r2-unsent#3 succeeded/measured",
  ]);
  assert.equal(retried.ledger.rows.get("r2-unsent#1")!.costUsd, 0, "a refused request is not billed");
  assert.equal(retried.result.ok && retried.result.costBasis, "measured");
  assertNoFallback(request, retried.calls, retried.envReads);

  const openai = await run(sampleRequest("openai", { transport: { maxAttempts: 2 } }), sequence(status(503, { error: { message: "slow down" } }), ok("openai")));
  assert.deepEqual([openai.result.ok, openai.calls.length], [true, 2]);

  const capped = await run(sampleRequest("anthropic", { transport: { maxAttempts: 2 } }), status(429, anthropicError(429, "rate_limit_error", "slow")));
  assert.deepEqual([failure(capped.result).errorCode, capped.calls.length], ["RATE_LIMITED", 2], "maxAttempts is the cap");

  const single = await run(sampleRequest("anthropic", { transport: { maxAttempts: 1 } }), status(529, anthropicError(529, "overloaded_error", "busy"), { "retry-after": "0" }));
  assert.deepEqual([failure(single.result).errorCode, single.calls.length, single.sleeps.length], ["OVERLOADED", 1, 0], "maxAttempts 1 = one request");
});

test("R2: after a known-unsent retry, an ambiguous attempt still ends the call (at most one possibly billed attempt)", async () => {
  const request = sampleRequest("anthropic", { callId: "r2-mixed", transport: { maxAttempts: 3 } });
  const { result, calls, ledger } = await run(
    request,
    sequence(status(529, anthropicError(529, "overloaded_error", "busy")), status(504, anthropicError(504, "timeout_error", "late")), ok("anthropic")),
  );
  const value = failure(result);
  assert.deepEqual([value.errorCode, value.transportAttempts, calls.length], ["SERVER_ERROR", 2, 2]);
  assert.deepEqual(ledger.events.filter((event) => event.startsWith("settle")), ["settle r2-mixed#1 failed/measured", "settle r2-mixed#2 unknown/upper_bound"]);
  assert.equal(value.usage.unknownUsageAttempts, 1);
  assert.equal(ledger.totalUsd(), upper(request));
});

test("R2: mark_sent committed but its response was lost: nothing is sent, the sent row is kept, and a replay gets no second permit", async () => {
  const request = sampleRequest("anthropic", { callId: "r2-marksent", transport: { maxAttempts: 3 } });
  const ledger = new ContractLedger();
  ledger.loseMarkSentResponse = true;
  const lost = await run(request, ok("anthropic"), ledger);
  assert.deepEqual([failure(lost.result).errorCode, failure(lost.result).detail, lost.calls.length], ["BUDGET_DENIED", "SEND_NOT_CONFIRMED", 0]);
  assert.equal(ledger.rows.get("r2-marksent#1")!.state, "sent", "a row marked sent is never released");
  assert.equal(ledger.totalUsd(), upper(request), "and stays counted at its upper bound");

  ledger.loseMarkSentResponse = false;
  const replay = await run(request, ok("anthropic"), ledger);
  assert.deepEqual([failure(replay.result).errorCode, failure(replay.result).detail, replay.calls.length], ["BUDGET_DENIED", "SEND_NOT_CONFIRMED", 0]);
});

test("R2: replaying a call whose attempt settled unknown sends nothing (ATTEMPT_FINALIZED)", async () => {
  const request = sampleRequest("anthropic", { callId: "r2-replay", transport: { maxAttempts: 3 } });
  const ledger = new ContractLedger();
  const first = await run(request, status(504, anthropicError(504, "timeout_error", "late")), ledger);
  assert.equal(first.calls.length, 1);
  assert.equal(ledger.rows.get("r2-replay#1")!.settlement?.outcome, "unknown");
  const replay = await run(request, ok("anthropic"), ledger);
  assert.deepEqual([failure(replay.result).errorCode, failure(replay.result).detail, replay.calls.length], ["BUDGET_DENIED", "ATTEMPT_FINALIZED", 0]);
  assert.equal(ledger.totalUsd(), upper(request), "one possibly billed attempt, counted once");
});

test("R2: aggregate: every attempt is reserved first; a shared cap stops further calls before anything is sent", async () => {
  const request = sampleRequest("anthropic", { transport: { maxAttempts: 3 } });
  const cap = upper(request) * 2.5;
  const ledger = new ContractLedger(cap);
  const net = recordingFetch(status(504, anthropicError(504, "timeout_error", "late")));
  const results = await Promise.all(["a", "b", "c", "d"].map((id) =>
    executeAiRequest({ ...request, callId: `r2-aggregate-${id}` }, testDeps(net.fetch, { budget: ledger }).deps)
  ));
  const codes = results.map((result) => failure(result).errorCode).sort();
  assert.deepEqual(codes, ["BUDGET_DENIED", "BUDGET_DENIED", "SERVER_ERROR", "SERVER_ERROR"]);
  assert.equal(net.calls.length, 2, "one possibly billed attempt per admitted call, none for the refused ones");
  assert.ok(ledger.totalUsd() <= cap);
  assert.equal(ledger.totalUsd(), upper(request) * 2);

  // Known-unsent retries are attempts too: when the next one does not fit the call cap, it is not sent.
  const tight = new ContractLedger(100, 1);
  const stopped = await run({ ...request, callId: "r2-tight" }, sequence(status(429, anthropicError(429, "rate_limit_error", "slow")), ok("anthropic")), tight);
  assert.deepEqual([failure(stopped.result).errorCode, failure(stopped.result).detail, stopped.calls.length], ["BUDGET_DENIED", "CALL_LIMIT", 1]);
});
