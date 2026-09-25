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
  // Run ids handed out by successive claims (defaults to "run-1").
  runIds?: string[];
}) {
  const calls: MockCall[] = [];
  let usageEventId = opts.usageEventIdStart ?? 100;
  const runIds = [...(opts.runIds ?? [])];

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
      return new Response(JSON.stringify([{ id: runIds.shift() ?? "run-1" }]), { status: 201 });
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
      // event, so resolveFedStatementDiffEvidence never actually
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
  assert.equal(usageInserts[0].body.related_table, "mic_state_evaluation_runs", "usage is linked to the run, not the domain");
  assert.equal(usageInserts[0].body.related_id, "run-1");
  assert.equal(usageInserts[0].body.feature, "mic_state_evaluation_rates", "domain kept as metadata");

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
  assert.deepEqual(
    usageInserts.map((u) => [u.body.related_table, u.body.related_id]),
    [["mic_state_evaluation_runs", "run-1"], ["mic_state_evaluation_runs", "run-1"]],
    "both Luna and Sol usage rows belong to the same run",
  );
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

// A complete mic_fed_statement_diffs row as PostgREST returns it for the
// evaluator's select list.
function fedDiffRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    current_event_id: "39ec45a4-77b5-4869-a011-2f4aa98c228d",
    previous_event_id: "50e3601d-2de6-483c-bed3-86892cff3cd3",
    current_document_hash: "f".repeat(64),
    previous_document_hash: "e".repeat(64),
    diff_hash: "1".repeat(64),
    meeting_date: "2026-09-16",
    previous_meeting_date: "2026-07-29",
    changed_paragraph_count: 3,
    material_change_count: 4,
    deterministic_diff: { comparisonStatus: "compared" },
    semantic_buckets: ["policy stance", "risks"],
    ai_interpretation: { overall_bias_change: "hawkish" },
    model: "gpt-6-luna",
    prompt_version: "fed-statement-diff-v2",
    generated_at: "2026-09-16T19:00:00+00:00",
    ai_usage_receipt: { feature: "mic_fed_statement_diff" },
    ai_usage_recorded_at: "2026-09-16T19:00:01+00:00",
    updated_at: "2026-09-16T19:00:01+00:00",
    ...overrides,
  };
}

test("[J] a rates evaluation with a central_bank_decision event but NO matching fed diff row calls the RPC with no Fed diff snapshots (0 diffs -> no diff evidence, not an error)", async () => {
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
  assert.deepEqual(rpcCall?.body.p_fed_statement_diff_snapshots, []);
  assert.equal(rpcCall?.body.p_run_id, "run-1");
});

test("[K] a rates evaluation with a central_bank_decision event AND exactly one matching fed diff row passes that diff's snapshot, as read before AI, in the RPC call", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({ lunaOutput: LUNA_CONFIDENT_OUTPUT });
  const diff = fedDiffRow("4c6f1ad7-255e-4ac7-8eab-b44904bf94b0");
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/rest/v1/mic_fed_statement_diffs") && (init?.method ?? "GET") === "GET") {
      calls.push({ url: u, method: "GET", body: undefined });
      return new Response(JSON.stringify([diff]), { status: 200 });
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
  assert.deepEqual(rpcCall?.body.p_fed_statement_diff_snapshots, [diff]);

  // Exactly 1 diff is not ambiguous -- Luna still runs normally, and the
  // diff was read before the AI call (fail-before-AI ordering).
  const openAiIndex = calls.findIndex((c) => c.url === "https://api.openai.com/v1/responses");
  const diffIndex = calls.findIndex((c) => c.url.includes("/rest/v1/mic_fed_statement_diffs"));
  assert.ok(openAiIndex > diffIndex && diffIndex >= 0, "Fed diff is read before Luna");
  assert.equal(calls.filter((c) => c.url === "https://api.openai.com/v1/responses").length, 1);
});

test("[L] a central_bank_decision event with 2+ matching fed diff rows fails closed BEFORE any AI call: the whole run fails, Luna is never called, no ai_usage_events row is recorded, and the RPC is never called (no State/history/evidence write)", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({ lunaOutput: LUNA_CONFIDENT_OUTPUT });
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/rest/v1/mic_fed_statement_diffs") && (init?.method ?? "GET") === "GET") {
      return new Response(
        JSON.stringify([
          fedDiffRow("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
          fedDiffRow("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", { prompt_version: "fed-statement-diff-v3" }),
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
  assert.deepEqual(rpcCall?.body.p_fed_statement_diff_snapshots, []);
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

// --- P1/P2: Fed diff snapshot guard, run-linked AI usage ---

const isUsageInsert = (c: MockCall) => c.url.includes("/rest/v1/ai_usage_events") && c.method === "POST";
const rpcError = (message: string) => () =>
  Promise.resolve(new Response(JSON.stringify({ code: "P0001", message }), { status: 400 }));
const withFedDiff = (baseFetch: FetchFn, diff: Record<string, unknown>) =>
  withOverride(baseFetch, (u) => u.includes("/rest/v1/mic_fed_statement_diffs"), () =>
    Promise.resolve(new Response(JSON.stringify([diff]), { status: 200 })));

test("[V] a Fed diff PATCHed while AI ran: the RPC fails closed, the run fails, and the Luna usage stays attributed to that failed run", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({ runIds: ["run-V"] });
  const fetchImpl = withOverride(
    withFedDiff(baseFetch, fedDiffRow("4c6f1ad7-255e-4ac7-8eab-b44904bf94b0")),
    isMaterialRpc,
    rpcError("MIC_STATE_FED_DIFF_CHANGED_DURING_EVALUATION"),
  );
  const result = await runWith(fetchImpl, decisionResult({ recentEvents: [centralBankEvent()] }));
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /MIC_STATE_FED_DIFF_CHANGED_DURING_EVALUATION/);
  const usage = calls.filter(isUsageInsert);
  assert.deepEqual(usage.map((u) => u.body.related_id), ["run-V"]);
  assert.ok(calls.some((c) => c.method === "PATCH" && c.url.includes("id=eq.run-V&status=eq.running") && c.body.status === "failed"));
});

test("[W] State RPC failure after AI: the run is failed and its usage row (real cost) remains linked to that failed run", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({ runIds: ["run-W"], runStatusAfterError: "failed" });
  const fetchImpl = withOverride(baseFetch, isMaterialRpc, rpcError("MIC_STATE_STALE_DECISION"));
  const result = await runWith(fetchImpl, decisionResult());
  assert.equal(result.status, "failed");
  const usage = calls.filter(isUsageInsert);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].body.related_table, "mic_state_evaluation_runs");
  assert.equal(usage[0].body.related_id, "run-W");
});

test("[X] retry: failed run A and new run B each own their own AI usage rows -- nothing is shared or mixed", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({ runIds: ["run-A", "run-B"], usageEventIdStart: 300 });
  const rpcBodies: Array<{ p_run_id: string; p_ai_usage_event_id: number }> = [];
  const fetchImpl: FetchFn = (url, init) => {
    if (!isMaterialRpc(String(url))) return baseFetch(url, init);
    rpcBodies.push(JSON.parse(String(init?.body)));
    return rpcBodies.length === 1
      ? rpcError("MIC_STATE_EVENT_CHANGED_DURING_EVALUATION")()
      : Promise.resolve(new Response(JSON.stringify([{ result_status: "applied" }]), { status: 200 }));
  };
  const first = await runWith(fetchImpl, decisionResult());
  const second = await runWith(fetchImpl, decisionResult());
  assert.equal(first.status, "failed");
  assert.equal(second.status, "evaluated");

  const usage = calls.filter(isUsageInsert);
  assert.deepEqual(usage.map((u) => u.body.related_id), ["run-A", "run-B"], "each AI call is linked to the run that made it");
  assert.deepEqual(rpcBodies.map((b) => [b.p_run_id, b.p_ai_usage_event_id]), [["run-A", 300], ["run-B", 301]]);
});

test("[Y] response loss after commit: reconciled as evaluated, and the run's usage row relation is unchanged", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({ runIds: ["run-Y"], runStatusAfterError: "evaluated" });
  const fetchImpl = withOverride(baseFetch, isMaterialRpc, () => Promise.reject(new TypeError("connection reset")));
  const result = await runWith(fetchImpl, decisionResult());
  assert.equal(result.status, "evaluated");
  assert.equal(result.reason, "reconciled_after_error");
  assert.deepEqual(calls.filter(isUsageInsert).map((u) => u.body.related_id), ["run-Y"]);
  assert.equal(calls.filter(isUsageInsert).length, 1, "no extra usage row is written by the reconcile path");
});

// --- Phase 2C-2: Fed statement interpretation context in the State AI input ---

const OPENAI_URL = "https://api.openai.com/v1/responses";
const VALID_FED_INTERPRETATION = {
  summary: "政策金利を25bp引き上げ、インフレ警戒を維持しました。",
  changes: [
    {
      bucket: "policy stance", direction: "more_hawkish", previous: "据え置き", current: "25bp引き上げ",
      interpretation: "より引き締め的な姿勢です。", confidence: 0.8,
    },
  ],
  overall_bias_change: "more_hawkish",
  confidence: 0.75,
};
const interpretedFedDiff = (overrides: Record<string, unknown> = {}) =>
  fedDiffRow("4c6f1ad7-255e-4ac7-8eab-b44904bf94b0", { ai_interpretation: VALID_FED_INTERPRETATION, ...overrides });

// deno-lint-ignore no-explicit-any
function aiFacts(call: MockCall): any {
  return JSON.parse(call.body.input.find((m: { role: string }) => m.role === "user").content);
}
function aiSystem(call: MockCall): string {
  return call.body.input.find((m: { role: string }) => m.role === "system").content;
}

test("[A] rates + Fed diff with ai_interpretation: the Luna request carries it as fed_statement_interpretations", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({});
  const result = await runWith(withFedDiff(baseFetch, interpretedFedDiff()), decisionResult({ recentEvents: [centralBankEvent()] }));
  assert.equal(result.status, "evaluated");
  const ai = calls.filter((c) => c.url === OPENAI_URL);
  assert.equal(ai.length, 1);
  const fed = aiFacts(ai[0]).fed_statement_interpretations;
  assert.equal(fed.length, 1);
  assert.equal(fed[0].meeting_date, "2026-09-16");
  assert.equal(fed[0].previous_meeting_date, "2026-07-29");
  assert.equal(fed[0].interpretation.summary, VALID_FED_INTERPRETATION.summary);
  assert.equal(fed[0].interpretation.overall_bias_change, "more_hawkish");
  assert.equal(fed[0].interpretation_model, "gpt-6-luna");
  assert.equal(fed[0].interpretation_prompt_version, "fed-statement-diff-v2");
  assert.match(aiSystem(ai[0]), /二次的な解釈であり、Factではありません/);
});

test("[A/G] evidence consistency: the interpretation the AI saw comes from the very snapshot sent to the RPC (the diff is read once)", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({});
  let diffLookups = 0;
  const fetchImpl = withOverride(baseFetch, (u) => u.includes("/rest/v1/mic_fed_statement_diffs"), () => {
    diffLookups += 1;
    return Promise.resolve(new Response(JSON.stringify([interpretedFedDiff()]), { status: 200 }));
  });
  await runWith(fetchImpl, decisionResult({ recentEvents: [centralBankEvent()] }));
  assert.equal(diffLookups, 1, "no second Fed diff query");
  const rpcSnapshot = calls.find((c) => isMaterialRpc(c.url))!.body.p_fed_statement_diff_snapshots[0];
  const aiEntry = aiFacts(calls.find((c) => c.url === OPENAI_URL)!).fed_statement_interpretations[0];
  assert.equal(aiEntry.interpretation.summary, rpcSnapshot.ai_interpretation.summary);
  assert.equal(aiEntry.interpretation_generated_at, rpcSnapshot.generated_at);
  assert.equal(aiEntry.meeting_date, rpcSnapshot.meeting_date);
});

test("[G] a Fed diff changed during evaluation still fails closed even when its interpretation was used as AI context", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({ runIds: ["run-G"] });
  const fetchImpl = withOverride(
    withFedDiff(baseFetch, interpretedFedDiff()),
    isMaterialRpc,
    rpcError("MIC_STATE_FED_DIFF_CHANGED_DURING_EVALUATION"),
  );
  const result = await runWith(fetchImpl, decisionResult({ recentEvents: [centralBankEvent()] }));
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /MIC_STATE_FED_DIFF_CHANGED_DURING_EVALUATION/);
  assert.ok(calls.some((c) => c.method === "PATCH" && c.url.includes("id=eq.run-G&status=eq.running") && c.body.status === "failed"));
});

test("[C] ai_interpretation null: no Fed context in the AI request, and the rates run still evaluates normally", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({});
  const result = await runWith(
    withFedDiff(baseFetch, interpretedFedDiff({ ai_interpretation: null, model: null, generated_at: null })),
    decisionResult({ recentEvents: [centralBankEvent()] }),
  );
  assert.equal(result.status, "evaluated");
  const ai = calls.find((c) => c.url === OPENAI_URL)!;
  assert.equal("fed_statement_interpretations" in aiFacts(ai), false);
  assert.equal(aiSystem(ai).includes("fed_statement_interpretations"), false);
  assert.equal(calls.find((c) => isMaterialRpc(c.url))!.body.p_fed_statement_diff_snapshots.length, 1, "diff evidence unchanged");
});

test("[C/L] a malformed interpretation is skipped: the AI request is identical to the no-diff request; evidence is unchanged", async () => {
  const withMalformed = makeMockFetch({});
  await runWith(
    withFedDiff(withMalformed.fetchImpl, interpretedFedDiff({ ai_interpretation: { summary: "x", changes: "bad" } })),
    decisionResult({ recentEvents: [centralBankEvent()] }),
  );
  const noDiff = makeMockFetch({});
  await runWith(noDiff.fetchImpl, decisionResult({ recentEvents: [centralBankEvent()] }));
  assert.deepEqual(
    withMalformed.calls.find((c) => c.url === OPENAI_URL)!.body,
    noDiff.calls.find((c) => c.url === OPENAI_URL)!.body,
  );
  assert.equal(withMalformed.calls.find((c) => isMaterialRpc(c.url))!.body.p_fed_statement_diff_snapshots.length, 1);
});

test("[D] a non-rates domain never gets Fed context, even if a Fed diff snapshot were resolved for it", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = withFedDiff(baseFetch, interpretedFedDiff()) as typeof fetch;
  try {
    const result = await evaluateDomain(
      ctx, "fx", decisionResult({ domain: "fx", recentEvents: [centralBankEvent()] }), new Date("2026-09-16T18:20:00Z"), 1,
    );
    assert.equal(result.status, "evaluated");
  } finally {
    globalThis.fetch = originalFetch;
  }
  const ai = calls.find((c) => c.url === OPENAI_URL)!;
  assert.equal("fed_statement_interpretations" in aiFacts(ai), false);
  assert.equal(aiSystem(ai).includes("fed_statement_interpretations"), false);
});

test("[E] Fed ambiguity (2+ diffs, both interpreted) still fails before any AI call", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({});
  const fetchImpl = withOverride(baseFetch, (u) => u.includes("/rest/v1/mic_fed_statement_diffs"), () =>
    Promise.resolve(new Response(JSON.stringify([
      interpretedFedDiff(),
      fedDiffRow("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", { ai_interpretation: VALID_FED_INTERPRETATION, prompt_version: "fed-statement-diff-v3" }),
    ]), { status: 200 })));
  const result = await runWith(fetchImpl, decisionResult({ recentEvents: [centralBankEvent()] }));
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /FED_STATEMENT_DIFF_AMBIGUOUS/);
  assert.equal(calls.filter((c) => c.url === OPENAI_URL).length, 0);
  assert.equal(calls.filter(isUsageInsert).length, 0);
});

test("[F] Fed diff lookup failure still fails before any AI call", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({});
  const fetchImpl = withOverride(baseFetch, (u) => u.includes("/rest/v1/mic_fed_statement_diffs"), () =>
    Promise.resolve(new Response("upstream error", { status: 503 })));
  const result = await runWith(fetchImpl, decisionResult({ recentEvents: [centralBankEvent()] }));
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /FED_STATEMENT_DIFF_LOOKUP_FAILED/);
  assert.equal(calls.filter((c) => c.url === OPENAI_URL).length, 0);
});

test("[H/I] Luna -> Sol: both requests carry the identical Fed context; usage stays one row per real call, both on the same run", async () => {
  const { fetchImpl: baseFetch, calls } = makeMockFetch({
    runIds: ["run-H"],
    lunaOutput: { narrative: "n", bullish_factors: [], bearish_factors: [], key_risks: [], confidence: 0.5, needs_sol: false },
    solOutput: { narrative: "n2", bullish_factors: [], bearish_factors: [], key_risks: [], confidence: 0.6, needs_sol: false },
  });
  const result = await runWith(
    withFedDiff(baseFetch, interpretedFedDiff()),
    decisionResult({ dataConfidence: 0.9, recentEvents: [centralBankEvent()] }),
  );
  assert.equal(result.status, "evaluated");
  const ai = calls.filter((c) => c.url === OPENAI_URL);
  assert.deepEqual(ai.map((c) => c.body.model), ["gpt-5.6-luna", "gpt-5.6-sol"]);
  assert.equal(aiFacts(ai[1]).fed_statement_interpretations.length, 1);
  assert.deepEqual(aiFacts(ai[0]).fed_statement_interpretations, aiFacts(ai[1]).fed_statement_interpretations);
  assert.deepEqual(calls.filter(isUsageInsert).map((u) => [u.body.related_table, u.body.related_id, u.body.feature, u.body.model]), [
    ["mic_state_evaluation_runs", "run-H", "mic_state_evaluation_rates", "gpt-5.6-luna"],
    ["mic_state_evaluation_runs", "run-H", "mic_state_evaluation_rates", "gpt-5.6-sol"],
  ]);
});

test("no additional OpenAI call: with Fed context the run makes exactly the calls it makes without it", async () => {
  const withFed = makeMockFetch({});
  await runWith(withFedDiff(withFed.fetchImpl, interpretedFedDiff()), decisionResult({ recentEvents: [centralBankEvent()] }));
  const without = makeMockFetch({});
  await runWith(without.fetchImpl, decisionResult({ recentEvents: [centralBankEvent()] }));
  assert.equal(withFed.calls.filter((c) => c.url === OPENAI_URL).length, 1);
  assert.equal(without.calls.filter((c) => c.url === OPENAI_URL).length, 1);
  assert.equal(withFed.calls.filter(isUsageInsert).length, without.calls.filter(isUsageInsert).length);
});
