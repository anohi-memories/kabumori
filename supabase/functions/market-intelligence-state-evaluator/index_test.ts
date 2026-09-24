// Orchestration-level tests for evaluateDomain -- specifically the AI
// usage accounting (Phase 1B hardening: one ai_usage_events row per actual
// OpenAI call, not per evaluation). Everything upstream of evaluateDomain
// (Facts reads, material-change decision) is constructed directly as a
// DomainDecisionOrError, so these tests never touch mic_state_query_logic.ts
// -- only the claim/AI/write/complete REST calls evaluateDomain itself
// makes need mocking here, via a temporary globalThis.fetch replacement
// (none of these calls take an injectable fetchImpl from evaluateDomain's
// own signature, so a global patch is the only way to intercept them).
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDomain } from "./index.ts";
import type { DomainDecision, DomainDecisionOrError } from "./index.ts";
import type { RestContext } from "./mic_state_run_logic.ts";

const ctx: RestContext = { supabaseUrl: "https://example.supabase.co", secretKey: "secret-key" };

// evaluateDomain reads OPENAI_API_KEY directly from the environment (not
// via ctx); every fetch it triggers is mocked below, so this value is
// never actually sent anywhere -- it only needs to be non-empty so the
// SECRET_MISSING guard doesn't short-circuit before any mocked call happens.
Deno.env.set("OPENAI_API_KEY", "test-key-never-sent-fetch-is-mocked");

function baseDecision(overrides: Partial<DomainDecision> = {}): DomainDecision {
  return {
    domain: "rates",
    metrics: [
      {
        metricKey: "US10Y",
        domain: "rates",
        currentValue: 4.5,
        previousValue: null,
        pctChange: null,
        absChange: null,
        unit: "percent",
        observedDate: "2026-09-10",
        observedAt: null,
        timePrecision: "date",
        fetchedAt: "2026-09-12T00:00:00.000Z",
        sourceKey: "fred",
        provider: "FRED",
        isOfficial: true,
        expectedLagMinutes: 4320,
        observationAgeMinutes: 4600,
        observationStatus: "delayed_expected",
      },
    ],
    recentEvents: [],
    metricDecision: { isMaterial: true, materialMetricKeys: ["US10Y"], reason: "US10Y: first_observation" },
    eventDecision: { isMaterial: false, materialMetricKeys: [], reason: "no high/critical event" },
    isMaterial: true,
    coverageStatus: "full",
    fetchStatus: "fresh",
    observationStatus: "delayed_expected",
    dataConfidence: 0.9,
    latestAsOf: "2026-09-12T00:00:00.000Z",
    priorUpdatedAt: "2026-09-12T00:00:00.000Z",
    ...overrides,
  };
}

function decisionResult(overrides: Partial<DomainDecision> = {}): DomainDecisionOrError {
  return { ok: true, decision: baseDecision(overrides) };
}

function openAiPayload(structured: Record<string, unknown>, usage = { input_tokens: 100, output_tokens: 50 }) {
  return {
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(structured) }] }],
    usage,
  };
}

const LUNA_CONFIDENT_OUTPUT = {
  narrative: "n", bullish_factors: [], bearish_factors: [], key_risks: [], confidence: 0.95, needs_sol: false,
};

// deno-lint-ignore no-explicit-any
type MockCall = { url: string; method: string; body: any };

// Routes every REST/OpenAI call evaluateDomain can make. `lunaOutput` and
// `solOutput` control what each model "returns" so a test can force (or
// rule out) escalation.
function makeMockFetch(opts: {
  lunaOutput?: Record<string, unknown>;
  solOutput?: Record<string, unknown>;
  usageEventIdStart?: number;
  // What the post-error read-back of the run reports as committed.
  runStatusAfterError?: string;
}) {
  const calls: MockCall[] = [];
  let usageEventId = opts.usageEventIdStart ?? 100;

  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, method, body });

    if (u.includes("/rest/v1/mic_state_evaluation_runs") && method === "GET" && u.includes("select=status")) {
      return new Response(JSON.stringify([{ status: opts.runStatusAfterError ?? "failed" }]), { status: 200 });
    }
    if (u.includes("/rest/v1/mic_state_evaluation_runs") && method === "GET") {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("/rest/v1/mic_state_evaluation_runs") && method === "POST") {
      return new Response(JSON.stringify([{ id: "run-1" }]), { status: 201 });
    }
    if (u.includes("/rest/v1/mic_state_evaluation_runs") && method === "PATCH") {
      return new Response(null, { status: 204 });
    }
    if (u === "https://api.openai.com/v1/responses") {
      const isSol = (body?.model as string)?.includes("sol");
      const structured = isSol ? (opts.solOutput ?? LUNA_CONFIDENT_OUTPUT) : (opts.lunaOutput ?? LUNA_CONFIDENT_OUTPUT);
      return new Response(JSON.stringify(openAiPayload(structured)), { status: 200 });
    }
    if (u.includes("/rest/v1/ai_usage_events") && method === "POST") {
      const id = usageEventId++;
      return new Response(JSON.stringify([{ id }]), { status: 201 });
    }
    // No direct market_state_current PATCH route: every State write goes
    // through one of the two transactional RPCs below, so a direct PATCH
    // would hit the "unexpected mock fetch call" error.
    if (u.includes("/rest/v1/rpc/apply_mic_state_no_change_update") && method === "POST") {
      return new Response(JSON.stringify([{ result_status: "applied" }]), { status: 200 });
    }
    if (u.includes("/rest/v1/mic_fed_statement_diffs") && method === "GET") {
      // Most tests in this file never exercise a central_bank_decision
      // event, so resolveFedStatementDiffEvidenceIds never actually
      // reaches this route for them (it returns [] before fetching for an
      // empty event-id list) -- kept as a safe default for those tests,
      // overridden per-test (via a wrapping fetchImpl) where the fed diff
      // resolution result itself is what's being asserted on.
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("/rest/v1/rpc/apply_mic_state_material_update") && method === "POST") {
      return new Response(JSON.stringify([{ result_status: "applied" }]), { status: 200 });
    }
    throw new Error(`unexpected mock fetch call: ${method} ${u}`);
  };

  return { fetchImpl, calls };
}

test("[E] Luna-only evaluation records exactly one ai_usage_events row, referenced by the run", async () => {
  const { fetchImpl, calls } = makeMockFetch({ lunaOutput: LUNA_CONFIDENT_OUTPUT });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    const result = await evaluateDomain(ctx, "rates", decisionResult(), new Date("2026-09-13T05:00:00Z"), 1);
    assert.equal(result.status, "evaluated");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const openAiCalls = calls.filter((c) => c.url === "https://api.openai.com/v1/responses");
  assert.equal(openAiCalls.length, 1, "expected exactly one OpenAI call (Luna only)");
  assert.equal(openAiCalls[0].body.model, "gpt-5.6-luna");

  const usageInserts = calls.filter((c) => c.url.includes("/rest/v1/ai_usage_events") && c.method === "POST");
  assert.equal(usageInserts.length, 1, "expected exactly one ai_usage_events row for a Luna-only evaluation");
  assert.equal(usageInserts[0].body.model, "gpt-5.6-luna");

  // The run is completed inside the material RPC's transaction, so the usage
  // id travels in the RPC payload and there is no separate run PATCH.
  const rpcCall = calls.find((c) => c.url.includes("/rest/v1/rpc/apply_mic_state_material_update"));
  assert.equal(rpcCall?.body.p_ai_usage_event_id, 100, "run should reference the Luna usage event id (the only one)");
  assert.equal(calls.some((c) => c.url.includes("/rest/v1/mic_state_evaluation_runs") && c.method === "PATCH"), false);
});

test("[F] Luna -> Sol escalation records two ai_usage_events rows (one per actual API call)", async () => {
  const { fetchImpl, calls } = makeMockFetch({
    lunaOutput: { narrative: "n", bullish_factors: [], bearish_factors: [], key_risks: [], confidence: 0.5, needs_sol: false },
    solOutput: { narrative: "n2", bullish_factors: [], bearish_factors: [], key_risks: [], confidence: 0.6, needs_sol: false },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    // dataConfidence=0.9 (sufficient) + low Luna confidence(0.5) -> escalates
    const result = await evaluateDomain(ctx, "rates", decisionResult({ dataConfidence: 0.9 }), new Date("2026-09-13T05:00:00Z"), 1);
    assert.equal(result.status, "evaluated");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const openAiCalls = calls.filter((c) => c.url === "https://api.openai.com/v1/responses");
  assert.equal(openAiCalls.length, 2, "expected two OpenAI calls (Luna then Sol)");
  assert.equal(openAiCalls[0].body.model, "gpt-5.6-luna");
  assert.equal(openAiCalls[1].body.model, "gpt-5.6-sol");

  const usageInserts = calls.filter((c) => c.url.includes("/rest/v1/ai_usage_events") && c.method === "POST");
  assert.equal(usageInserts.length, 2, "expected two ai_usage_events rows: one for Luna, one for Sol");
  assert.equal(usageInserts[0].body.model, "gpt-5.6-luna");
  assert.equal(usageInserts[1].body.model, "gpt-5.6-sol");
});

test("[G] the evaluation run's ai_usage_event_id references the FINAL model's event (Sol, when escalated)", async () => {
  const { fetchImpl, calls } = makeMockFetch({
    lunaOutput: { narrative: "n", bullish_factors: [], bearish_factors: [], key_risks: [], confidence: 0.5, needs_sol: false },
    solOutput: { narrative: "n2", bullish_factors: [], bearish_factors: [], key_risks: [], confidence: 0.6, needs_sol: false },
    usageEventIdStart: 200,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    await evaluateDomain(ctx, "rates", decisionResult({ dataConfidence: 0.9 }), new Date("2026-09-13T05:00:00Z"), 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const rpcCall = calls.find((c) => c.url.includes("/rest/v1/rpc/apply_mic_state_material_update"));
  // Luna's event gets id 200, Sol's gets id 201 -- the run must reference Sol's (201), not Luna's.
  assert.equal(rpcCall?.body.p_ai_usage_event_id, 201);
});

test("[A] low data_confidence caused by stale/partial Facts does NOT escalate to Sol, even with needs_sol + low Luna confidence (the production rates case)", async () => {
  const { fetchImpl, calls } = makeMockFetch({
    lunaOutput: { narrative: "stale narrative", bullish_factors: [], bearish_factors: [], key_risks: [], confidence: 0.55, needs_sol: true },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    const result = await evaluateDomain(ctx, "rates", decisionResult({ dataConfidence: 0.6 }), new Date("2026-09-13T05:00:00Z"), 1);
    assert.equal(result.status, "evaluated");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const openAiCalls = calls.filter((c) => c.url === "https://api.openai.com/v1/responses");
  assert.equal(openAiCalls.length, 1, "must not escalate to Sol when low confidence is a data-quality problem");
  assert.equal(openAiCalls[0].body.model, "gpt-5.6-luna");

  const usageInserts = calls.filter((c) => c.url.includes("/rest/v1/ai_usage_events") && c.method === "POST");
  assert.equal(usageInserts.length, 1);

  const materialUpdate = calls.find((c) => c.url.includes("/rest/v1/rpc/apply_mic_state_material_update") && c.method === "POST");
  assert.equal(materialUpdate?.body.p_narrative, "stale narrative", "Luna's low-confidence result is still saved as-is");
  // [H] confidence clamp still applies: stored ai_confidence never exceeds data_confidence.
  assert.equal(materialUpdate?.body.p_ai_confidence, Math.min(0.55, 0.6));
});

test("[I] all-stale guard still short-circuits before any AI call", async () => {
  const { fetchImpl, calls } = makeMockFetch({});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    const staleDecision = decisionResult({
      metrics: [
        {
          metricKey: "JGB10Y",
          domain: "rates",
          currentValue: 2.9,
          previousValue: null,
          pctChange: null,
          absChange: null,
          unit: "percent",
          observedDate: "2026-08-31",
          observedAt: null,
          timePrecision: "date",
          fetchedAt: "2026-09-12T00:00:00.000Z",
          sourceKey: "mof_jgb",
          provider: "MOF",
          isOfficial: true,
          expectedLagMinutes: 1440,
          observationAgeMinutes: 19000,
          observationStatus: "stale",
        },
      ],
      dataConfidence: 0.2,
    });
    const result = await evaluateDomain(ctx, "rates", staleDecision, new Date("2026-09-13T05:00:00Z"), 1);
    assert.equal(result.status, "no_change");
    assert.equal(result.reason, "all_metrics_stale_or_unknown");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const openAiCalls = calls.filter((c) => c.url === "https://api.openai.com/v1/responses");
  assert.equal(openAiCalls.length, 0, "all-stale guard must prevent any AI call");
  const usageInserts = calls.filter((c) => c.url.includes("/rest/v1/ai_usage_events") && c.method === "POST");
  assert.equal(usageInserts.length, 0);
  // Status refresh + run no_change are one transactional RPC.
  const noChangeRpc = calls.filter((c) => c.url.includes("/rest/v1/rpc/apply_mic_state_no_change_update"));
  assert.equal(noChangeRpc.length, 1);
  assert.equal(noChangeRpc[0].body.p_run_id, "run-1");
  assert.equal(noChangeRpc[0].body.p_decision_detail.ai_skipped, true);
  assert.equal(noChangeRpc[0].body.p_decision_detail.skip_reason, "all_metrics_stale_or_unknown");
  assert.equal(calls.some((c) => c.url.includes("/rest/v1/mic_state_evaluation_runs") && c.method === "PATCH"), false);
});

// --- State Evidence Phase 2C1: evidence resolution + the transactional RPC ---

function centralBankEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "39ec45a4-77b5-4869-a011-2f4aa98c228d",
    title: "Fed raises target range by 25bp",
    summary: "s",
    importance: "high" as const,
    eventType: "central_bank_decision",
    publishedAt: "2026-09-16T18:00:00.000Z",
    updatedAt: "2026-09-16T18:00:00.000Z",
    ...overrides,
  };
}

test("[J] a rates evaluation with a central_bank_decision event but NO matching fed diff row calls the RPC with an empty fed_statement_diff_evidence_ids array (0 diffs -> no diff evidence, not an error)", async () => {
  const { fetchImpl, calls } = makeMockFetch({ lunaOutput: LUNA_CONFIDENT_OUTPUT });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    const result = await evaluateDomain(
      ctx,
      "rates",
      decisionResult({ recentEvents: [centralBankEvent()] }),
      new Date("2026-09-16T18:20:00Z"),
      1,
    );
    assert.equal(result.status, "evaluated");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const diffLookup = calls.find((c) => c.url.includes("/rest/v1/mic_fed_statement_diffs") && c.method === "GET");
  assert.ok(diffLookup, "must query mic_fed_statement_diffs for the central_bank_decision event id");
  assert.match(diffLookup!.url, /current_event_id=in\.\(39ec45a4-77b5-4869-a011-2f4aa98c228d\)/);

  // 0 diffs is not ambiguous -- Luna still runs normally.
  const openAiCalls = calls.filter((c) => c.url === "https://api.openai.com/v1/responses");
  assert.equal(openAiCalls.length, 1, "0 matching diffs is not ambiguous -- Luna must still run");

  const rpcCall = calls.find((c) => c.url.includes("/rest/v1/rpc/apply_mic_state_material_update"));
  assert.deepEqual(rpcCall?.body.p_source_event_ids, ["39ec45a4-77b5-4869-a011-2f4aa98c228d"]);
  assert.deepEqual(rpcCall?.body.p_market_event_snapshots, [{
    id: "39ec45a4-77b5-4869-a011-2f4aa98c228d",
    title: "Fed raises target range by 25bp",
    summary: "s",
    importance: "high",
    event_type: "central_bank_decision",
    published_at: "2026-09-16T18:00:00.000Z",
    updated_at: "2026-09-16T18:00:00.000Z",
  }]);
  assert.deepEqual(rpcCall?.body.p_fed_statement_diff_evidence_ids, []);
  assert.equal(rpcCall?.body.p_run_id, "run-1");
});

test("[K] a rates evaluation with a central_bank_decision event AND exactly one matching fed diff row includes that diff id in the RPC call", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({ lunaOutput: LUNA_CONFIDENT_OUTPUT });
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/rest/v1/mic_fed_statement_diffs") && (init?.method ?? "GET") === "GET") {
      return new Response(
        JSON.stringify([{ id: "4c6f1ad7-255e-4ac7-8eab-b44904bf94b0", current_event_id: "39ec45a4-77b5-4869-a011-2f4aa98c228d" }]),
        { status: 200 },
      );
    }
    return baseFetch(url, init);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    const result = await evaluateDomain(
      ctx,
      "rates",
      decisionResult({ recentEvents: [centralBankEvent()] }),
      new Date("2026-09-16T18:20:00Z"),
      1,
    );
    assert.equal(result.status, "evaluated");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const rpcCall = calls.find((c) => c.url.includes("/rest/v1/rpc/apply_mic_state_material_update"));
  assert.deepEqual(rpcCall?.body.p_fed_statement_diff_evidence_ids, ["4c6f1ad7-255e-4ac7-8eab-b44904bf94b0"]);

  // Exactly 1 diff is not ambiguous -- Luna still runs normally.
  const openAiCalls = calls.filter((c) => c.url === "https://api.openai.com/v1/responses");
  assert.equal(openAiCalls.length, 1, "exactly 1 matching diff is not ambiguous -- Luna must still run");
});

test("[L] a central_bank_decision event with 2+ matching fed diff rows fails closed BEFORE any AI call: the whole run fails, Luna is never called, no ai_usage_events row is recorded, and the RPC is never called (no State/history/evidence write)", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({ lunaOutput: LUNA_CONFIDENT_OUTPUT });
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/rest/v1/mic_fed_statement_diffs") && (init?.method ?? "GET") === "GET") {
      return new Response(
        JSON.stringify([
          { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", current_event_id: "39ec45a4-77b5-4869-a011-2f4aa98c228d" },
          { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", current_event_id: "39ec45a4-77b5-4869-a011-2f4aa98c228d" },
        ]),
        { status: 200 },
      );
    }
    if (u.includes("/rest/v1/mic_state_evaluation_runs") && (init?.method ?? "GET") === "PATCH") {
      // failStateEvaluationRun's PATCH -- allow it through so evaluateDomain can return cleanly.
      return new Response(null, { status: 204 });
    }
    return baseFetch(url, init);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    const result = await evaluateDomain(
      ctx,
      "rates",
      decisionResult({ recentEvents: [centralBankEvent()] }),
      new Date("2026-09-16T18:20:00Z"),
      1,
    );
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /FED_STATEMENT_DIFF_AMBIGUOUS/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const rpcCall = calls.find((c) => c.url.includes("/rest/v1/rpc/apply_mic_state_material_update"));
  assert.equal(rpcCall, undefined, "the transactional RPC must never be called when diff resolution is ambiguous");
  // Fail-before-AI ordering: Fed diff evidence is resolved BEFORE Luna is
  // called, so an ambiguous diff set must short-circuit the whole run
  // before any OpenAI call happens -- no Luna call, no ai_usage_events
  // row, no billing for a run that is guaranteed to fail closed.
  const openAiCalls = calls.filter((c) => c.url === "https://api.openai.com/v1/responses");
  assert.equal(openAiCalls.length, 0, "Luna must NOT be called when Fed diff evidence resolution is ambiguous");
  const usageInserts = calls.filter((c) => c.url.includes("/rest/v1/ai_usage_events") && c.method === "POST");
  assert.equal(usageInserts.length, 0, "no ai_usage_events row must be recorded when Fed diff evidence resolution is ambiguous");
});

test("[M] no_change (not material) never calls mic_fed_statement_diffs or the material-update RPC", async () => {
  const { fetchImpl, calls } = makeMockFetch({});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    const result = await evaluateDomain(
      ctx,
      "rates",
      decisionResult({
        isMaterial: false,
        metricDecision: { isMaterial: false, materialMetricKeys: [], reason: "no change" },
        recentEvents: [centralBankEvent()],
      }),
      new Date("2026-09-16T18:20:00Z"),
      1,
    );
    assert.equal(result.status, "no_change");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.some((c) => c.url.includes("/rest/v1/mic_fed_statement_diffs")), false);
  assert.equal(calls.some((c) => c.url.includes("/rest/v1/rpc/apply_mic_state_material_update")), false);
  // Status refresh + run no_change: one RPC, no separate run PATCH.
  const noChangeRpc = calls.filter((c) => c.url.includes("/rest/v1/rpc/apply_mic_state_no_change_update"));
  assert.equal(noChangeRpc.length, 1);
  assert.equal(noChangeRpc[0].body.p_run_id, "run-1");
  assert.equal(noChangeRpc[0].body.p_expected_current_updated_at, "2026-09-12T00:00:00.000Z");
  assert.deepEqual(noChangeRpc[0].body.p_decision_detail, { material: false, reason: "no change" });
  assert.equal(calls.some((c) => c.url.includes("/rest/v1/mic_state_evaluation_runs") && c.method === "PATCH"), false);
});

test("a no-change decision with a stale State CAS cannot overwrite newer status or complete as no_change", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({});
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("/rest/v1/rpc/apply_mic_state_no_change_update")) {
      return new Response(JSON.stringify({ code: "P0001", message: "MIC_STATE_STALE_DECISION" }), { status: 400 });
    }
    return baseFetch(url, init);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    const result = await evaluateDomain(ctx, "rates", decisionResult({
      isMaterial: false,
      metricDecision: { isMaterial: false, materialMetricKeys: [], reason: "no change" },
    }), new Date("2026-09-16T18:20:00Z"), 0);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /MIC_STATE_STALE_DECISION/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.some((call) => call.url === "https://api.openai.com/v1/responses"), false);
  assert.equal(calls.some((call) => call.url.includes("/rest/v1/rpc/apply_mic_state_material_update")), false);
});

// --- Blocker A/B: event snapshots, atomic run completion, response-loss ---

type FetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>;

function withOverride(baseFetch: FetchFn, match: (url: string, method: string) => boolean, respond: () => Promise<Response>): FetchFn {
  return (url, init) => match(String(url), init?.method ?? "GET") ? respond() : baseFetch(url, init);
}

async function runWith(fetchImpl: FetchFn, decision: DomainDecisionOrError) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    return await evaluateDomain(ctx, "rates", decision, new Date("2026-09-16T18:20:00Z"), 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const isMaterialRpc = (u: string) => u.includes("/rest/v1/rpc/apply_mic_state_material_update");
const isNoChangeRpc = (u: string) => u.includes("/rest/v1/rpc/apply_mic_state_no_change_update");

test("[N] material RPC committed but its HTTP response was lost: the run is read back as evaluated and reported as evaluated, never overwritten to failed", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({ runStatusAfterError: "evaluated" });
  const fetchImpl = withOverride(baseFetch, isMaterialRpc, () => Promise.reject(new TypeError("connection reset")));
  const result = await runWith(fetchImpl, decisionResult({ recentEvents: [centralBankEvent()] }));
  assert.equal(result.status, "evaluated");
  assert.equal(result.reason, "reconciled_after_error");
  assert.match(result.error ?? "", /connection reset/);

  // The fail attempt can only ever touch a still-running run.
  const failPatches = calls.filter((c) => c.url.includes("/rest/v1/mic_state_evaluation_runs") && c.method === "PATCH");
  assert.equal(failPatches.length, 1);
  assert.match(failPatches[0].url, /status=eq\.running/);
  assert.ok(calls.some((c) => c.url.includes("select=status")), "must read back the committed run status");
});

test("[O] material RPC transport failure where nothing committed: reported as failed", async () => {
  const { fetchImpl: baseFetch } = makeMockFetch({ runStatusAfterError: "failed" });
  const fetchImpl = withOverride(baseFetch, isMaterialRpc, () => Promise.reject(new TypeError("connection refused")));
  const result = await runWith(fetchImpl, decisionResult());
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /connection refused/);
});

test("[P] an event changed by ingest while AI ran: the RPC fails closed and the run is failed (never evaluated)", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({ runStatusAfterError: "failed" });
  const fetchImpl = withOverride(baseFetch, isMaterialRpc, () =>
    Promise.resolve(
      new Response(JSON.stringify({ code: "P0001", message: "MIC_STATE_EVENT_CHANGED_DURING_EVALUATION" }), { status: 400 }),
    ));
  const result = await runWith(fetchImpl, decisionResult({ recentEvents: [centralBankEvent()] }));
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /MIC_STATE_EVENT_CHANGED_DURING_EVALUATION/);
  assert.ok(calls.some((c) => c.url.includes("/rest/v1/mic_state_evaluation_runs") && c.method === "PATCH" && c.body.status === "failed"));
});

test("[Q] no-change RPC committed but its HTTP response was lost: reported as no_change after read-back", async () => {
  const { fetchImpl: baseFetch } = makeMockFetch({ runStatusAfterError: "no_change" });
  const fetchImpl = withOverride(baseFetch, isNoChangeRpc, () => Promise.reject(new TypeError("connection reset")));
  const result = await runWith(fetchImpl, decisionResult({
    isMaterial: false,
    metricDecision: { isMaterial: false, materialMetricKeys: [], reason: "no change" },
  }));
  assert.equal(result.status, "no_change");
  assert.equal(result.reason, "reconciled_after_error");
});

test("[R] a missing ai_usage_events id fails before the material RPC (an evaluated run must reference its usage event)", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({});
  const fetchImpl = withOverride(
    baseFetch,
    (u, m) => u.includes("/rest/v1/ai_usage_events") && m === "POST",
    () => Promise.resolve(new Response(JSON.stringify([{}]), { status: 201 })),
  );
  const result = await runWith(fetchImpl, decisionResult());
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /AI_USAGE_EVENT_ID_MISSING/);
  assert.equal(calls.some((c) => isMaterialRpc(c.url)), false);
});

test("[S] a rate_decision event is snapshotted as evidence without any Fed diff lookup", async () => {
  const { fetchImpl, calls } = makeMockFetch({});
  const rateEvent = centralBankEvent({
    id: "11111111-2222-3333-4444-555555555555",
    eventType: "rate_decision",
    title: "BOJ holds",
    importance: "critical",
  });
  const result = await runWith(fetchImpl, decisionResult({ recentEvents: [rateEvent] }));
  assert.equal(result.status, "evaluated");
  assert.equal(calls.some((c) => c.url.includes("/rest/v1/mic_fed_statement_diffs")), false);
  const rpcCall = calls.find((c) => isMaterialRpc(c.url));
  const snapshots = rpcCall?.body.p_market_event_snapshots as Array<{ id: string; event_type: string; importance: string }>;
  assert.deepEqual(snapshots.map((s) => [s.id, s.event_type, s.importance]), [
    ["11111111-2222-3333-4444-555555555555", "rate_decision", "critical"],
  ]);
  assert.deepEqual(rpcCall?.body.p_fed_statement_diff_evidence_ids, []);
});

test("[T] a network error during Fed diff lookup is never treated as 0 diffs: the run fails before any AI call", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({});
  const fetchImpl = withOverride(
    baseFetch,
    (u) => u.includes("/rest/v1/mic_fed_statement_diffs"),
    () => Promise.reject(new TypeError("network down")),
  );
  const result = await runWith(fetchImpl, decisionResult({ recentEvents: [centralBankEvent()] }));
  assert.equal(result.status, "failed");
  assert.equal(calls.some((c) => c.url === "https://api.openai.com/v1/responses"), false);
  assert.equal(calls.some((c) => isMaterialRpc(c.url)), false);
});

test("[U] the event snapshot sent as evidence carries exactly the event content given to the AI", async () => {
  const { fetchImpl, calls } = makeMockFetch({});
  const event = centralBankEvent({ title: "FOMC: 25bp hike", summary: "3.75-4.00%" });
  await runWith(fetchImpl, decisionResult({ recentEvents: [event] }));
  const aiPayloadText = JSON.stringify(calls.find((c) => c.url === "https://api.openai.com/v1/responses")?.body);
  const snapshot = calls.find((c) => isMaterialRpc(c.url))?.body.p_market_event_snapshots[0];
  for (const field of ["title", "summary", "importance", "event_type", "published_at"]) {
    assert.ok(aiPayloadText.includes(JSON.stringify(snapshot[field]).slice(1, -1)), `AI input must contain snapshot.${field}`);
  }
});
