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
}) {
  const calls: MockCall[] = [];
  let usageEventId = opts.usageEventIdStart ?? 100;

  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, method, body });

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
    if (u.includes("/rest/v1/market_state_current") && method === "GET") {
      return new Response(JSON.stringify([{ domain: "rates", narrative: null, as_of: null }]), { status: 200 });
    }
    if (u.includes("/rest/v1/market_state_current") && method === "PATCH") {
      return new Response(null, { status: 204 });
    }
    if (u.includes("/rest/v1/market_state_history") && method === "POST") {
      return new Response(null, { status: 201 });
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

  const runComplete = calls.find((c) => c.url.includes("/rest/v1/mic_state_evaluation_runs") && c.method === "PATCH");
  assert.equal(runComplete?.body.ai_usage_event_id, 100, "run should reference the Luna usage event id (the only one)");
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

  const runComplete = calls.find((c) => c.url.includes("/rest/v1/mic_state_evaluation_runs") && c.method === "PATCH");
  // Luna's event gets id 200, Sol's gets id 201 -- the run must reference Sol's (201), not Luna's.
  assert.equal(runComplete?.body.ai_usage_event_id, 201);
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

  const materialUpdate = calls.find((c) => c.url.includes("/rest/v1/market_state_current") && c.method === "PATCH");
  assert.equal(materialUpdate?.body.narrative, "stale narrative", "Luna's low-confidence result is still saved as-is");
  // [H] confidence clamp still applies: stored ai_confidence never exceeds data_confidence.
  assert.equal(materialUpdate?.body.ai_confidence, Math.min(0.55, 0.6));
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
});
