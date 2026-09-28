import assert from "node:assert/strict";
import test from "node:test";
import { evaluateScenario, handleRequest } from "./index.ts";
import { responsePayload, validOutput } from "./mic_scenario_test_fixtures.ts";
import type { StateRow } from "./mic_scenario_types.ts";

const ctx = { supabaseUrl: "https://example.supabase.co", secretKey: "sk_test" };
const NOW = new Date("2026-09-28T07:30:00Z");
const RUN = "33333333-3333-4333-8333-333333333333";
const RATES_RUN = "44444444-4444-4444-8444-444444444444";
const EQ_RUN = "55555555-5555-4555-8555-555555555555";

function state(domain: string, runId: string | null, overrides: Partial<StateRow> = {}): StateRow {
  return {
    domain, narrative: `${domain} narrative`, bullish_factors: ["b"], bearish_factors: ["r"], key_risks: ["k"],
    ai_confidence: 0.8, data_confidence: 0.9, coverage_status: "full", observation_status: "fresh",
    ai_evaluated_at: "2026-09-28T01:15:00Z", source_evaluation_run_id: runId, ...overrides,
  } as StateRow;
}

type Options = {
  states?: StateRow[];
  current?: Record<string, unknown>;
  claimStatus?: number;
  ai?: unknown[]; // OpenAI payloads in call order
  rpc?: Response | Error;
  noChangeRows?: number;
  readBackStatus?: string;
};

function backend(opts: Options = {}) {
  // deno-lint-ignore no-explicit-any
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const ai = [...(opts.ai ?? [])];
  let usageId = 100;
  const impl = ((url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }));
    if (url === "https://api.openai.com/v1/responses") {
      const next = ai.shift();
      if (!next) throw new Error("unexpected OpenAI call");
      return json(next);
    }
    const path = url.replace(ctx.supabaseUrl, "");
    if (path.startsWith("/rest/v1/mic_scenario_evaluation_runs")) {
      if (method === "PATCH" && path.includes("started_at=lt.")) return Promise.resolve(new Response(null, { status: 204 }));
      if (method === "GET" && path.includes("select=attempt_no")) return json([]);
      if (method === "POST") return opts.claimStatus === 409 ? json({ code: "23505" }, 409) : json([{ id: RUN }], 201);
      if (method === "PATCH" && body?.status === "no_change") return json(Array.from({ length: opts.noChangeRows ?? 1 }, () => ({ id: RUN })));
      if (method === "PATCH" && body?.status === "failed") return Promise.resolve(new Response(null, { status: 204 }));
      if (method === "GET" && path.includes("select=status")) return json([{ status: opts.readBackStatus ?? "failed" }]);
    }
    if (path.startsWith("/rest/v1/mic_scenario_current")) {
      return json([opts.current ?? { updated_at: "2026-09-27T00:00:00Z", source_state_run_ids: [], input_fingerprint: null, source_scenario_run_id: null }]);
    }
    if (path.startsWith("/rest/v1/market_state_current")) {
      return json(opts.states ?? [state("rates", RATES_RUN), state("equity_index", EQ_RUN), state("macro", null)]);
    }
    if (path === "/rest/v1/ai_usage_events" && method === "POST") return json([{ id: usageId++ }], 201);
    if (path === "/rest/v1/rpc/apply_mic_scenario_update") {
      const rpc = opts.rpc ?? new Response(JSON.stringify([{ result_status: "applied" }]), { status: 200 });
      return rpc instanceof Error ? Promise.reject(rpc) : Promise.resolve(rpc);
    }
    throw new Error(`unexpected endpoint ${method} ${url}`);
  }) as unknown as typeof fetch;
  const of = (fragment: string, method?: string) =>
    calls.filter((call) => call.url.includes(fragment) && (!method || call.method === method));
  return { calls, impl, of };
}

const lunaOk = responsePayload(validOutput());

test("[A][I] first Scenario: Luna once, one usage row linked to the run, one RPC with the final usage id", async () => {
  const b = backend({ ai: [lunaOk] });
  const result = await evaluateScenario(ctx, "sk-openai", NOW, b.impl);
  assert.deepEqual(result, { status: "evaluated", runId: RUN, reason: "initial_scenario" });
  assert.equal(b.of("api.openai.com").length, 1);
  assert.equal(b.of("api.openai.com")[0].body.model, "gpt-5.6-luna");
  const usage = b.of("ai_usage_events", "POST");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].body.related_id, RUN);
  const rpc = b.of("rpc/apply_mic_scenario_update");
  assert.equal(rpc.length, 1);
  const p = rpc[0].body;
  assert.equal(p.p_ai_usage_event_id, 100);
  assert.equal(p.p_run_id, RUN);
  assert.equal(p.p_expected_current_updated_at, "2026-09-27T00:00:00Z");
  // macro has no source run -> excluded; only rates + equity_index are snapshotted.
  assert.deepEqual(p.p_state_snapshots.map((s: StateRow) => s.domain), ["rates", "equity_index"]);
  assert.equal(p.p_input_fingerprint, `mic-scenario-v1|equity_index:${EQ_RUN}|rates:${RATES_RUN}`);
  assert.ok(p.p_confidence <= p.p_ai_confidence);
  assert.deepEqual(p.p_decision_detail.excluded, [{ domain: "macro", reason: "no_source_evaluation_run" }]);
  assert.equal(p.p_decision_detail.escalated_to_sol, false);
  // AI never sees State run ids.
  assert.equal(JSON.stringify(b.of("api.openai.com")[0].body).includes(RATES_RUN), false);
});

test("[B][D] same State set as the current Scenario: no AI, no usage, no RPC; run -> no_change", async () => {
  const b = backend({
    current: { updated_at: "2026-09-28T02:00:00Z", source_state_run_ids: [EQ_RUN, RATES_RUN], input_fingerprint: "x", source_scenario_run_id: "r" },
  });
  const result = await evaluateScenario(ctx, "sk-openai", NOW, b.impl);
  assert.deepEqual(result, { status: "no_change", runId: RUN, reason: "no_new_state_evaluation" });
  assert.equal(b.of("api.openai.com").length, 0);
  assert.equal(b.of("ai_usage_events").length, 0);
  assert.equal(b.of("rpc/").length, 0);
  const patch = b.of("mic_scenario_evaluation_runs", "PATCH").find((c) => c.body?.status === "no_change");
  assert.equal(patch?.body.decision_detail.fingerprint, `mic-scenario-v1|equity_index:${EQ_RUN}|rates:${RATES_RUN}`);
});

test("[C] fewer than two usable States: no AI, no_change insufficient_usable_states (even without an OpenAI key)", async () => {
  const b = backend({ states: [state("rates", RATES_RUN), state("equity_index", EQ_RUN, { data_confidence: 0.1 }), state("macro", null)] });
  const result = await evaluateScenario(ctx, null, NOW, b.impl);
  assert.deepEqual(result, { status: "no_change", runId: RUN, reason: "insufficient_usable_states" });
  assert.equal(b.of("api.openai.com").length, 0);
});

test("[E] a new State evaluation run on one domain triggers regeneration", async () => {
  const b = backend({
    ai: [lunaOk],
    current: { updated_at: "2026-09-28T02:00:00Z", source_state_run_ids: [EQ_RUN, "66666666-6666-4666-8666-666666666666"], input_fingerprint: "x", source_scenario_run_id: "r" },
  });
  const result = await evaluateScenario(ctx, "sk-openai", NOW, b.impl);
  assert.deepEqual(result, { status: "evaluated", runId: RUN, reason: "new_state_evaluation:rates" });
});

test("[H] claim conflict (another run in flight): no reads, no AI, no writes beyond the claim", async () => {
  const b = backend({ claimStatus: 409 });
  assert.deepEqual(await evaluateScenario(ctx, "sk-openai", NOW, b.impl), { status: "skipped_duplicate" });
  assert.equal(b.of("api.openai.com").length, 0);
  assert.equal(b.of("market_state_current").length, 0);
  assert.equal(b.of("rpc/").length, 0);
});

test("[J] Sol escalation: two usage rows, final RPC carries Sol's usage id and model", async () => {
  const b = backend({ ai: [responsePayload(validOutput({ needs_sol: true })), responsePayload(validOutput({ confidence: 0.8 }))] });
  const result = await evaluateScenario(ctx, "sk-openai", NOW, b.impl);
  assert.equal(result.status, "evaluated");
  assert.deepEqual(b.of("api.openai.com").map((c) => c.body.model), ["gpt-5.6-luna", "gpt-5.6-sol"]);
  assert.deepEqual(b.of("ai_usage_events").map((c) => c.body.model), ["gpt-5.6-luna", "gpt-5.6-sol"]);
  const p = b.of("rpc/")[0].body;
  assert.equal(p.p_ai_usage_event_id, 101);
  assert.equal(p.p_ai_model, "gpt-5.6-sol");
  assert.equal(p.p_decision_detail.escalated_to_sol, true);
});

test("[K] confidence is clamped by input quality (weak rates State)", async () => {
  const b = backend({
    ai: [responsePayload(validOutput({ confidence: 0.95 }))],
    states: [state("rates", RATES_RUN, { data_confidence: 0.6, observation_status: "stale" }), state("equity_index", EQ_RUN), state("macro", null)],
  });
  await evaluateScenario(ctx, "sk-openai", NOW, b.impl);
  const p = b.of("rpc/")[0].body;
  assert.equal(p.p_ai_confidence, 0.95);
  assert.ok(p.p_confidence <= 0.6 - 0.1 + 1e-9, `confidence ${p.p_confidence}`);
  assert.equal(p.p_decision_detail.weak[0].domain, "rates");
});

test("[L] malformed AI output: usage kept, no RPC, run failed", async () => {
  const b = backend({ ai: [responsePayload(validOutput({ confidence: 3 }))] });
  const result = await evaluateScenario(ctx, "sk-openai", NOW, b.impl);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /confidence/);
  assert.equal(b.of("ai_usage_events").length, 1);
  assert.equal(b.of("rpc/").length, 0);
  assert.equal(b.of("mic_scenario_evaluation_runs", "PATCH").filter((c) => c.body?.status === "failed" && c.url.includes("id=eq.")).length, 1);
});

test("[G] RPC rejects because a State changed during evaluation: run failed, nothing else written", async () => {
  const b = backend({
    ai: [lunaOk],
    rpc: new Response(JSON.stringify({ message: "MIC_SCENARIO_STATE_CHANGED_DURING_EVALUATION:rates" }), { status: 400 }),
  });
  const result = await evaluateScenario(ctx, "sk-openai", NOW, b.impl);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /STATE_CHANGED_DURING_EVALUATION/);
});

test("[N] RPC response lost after commit: read-back reconciles to evaluated", async () => {
  const b = backend({ ai: [lunaOk], rpc: new Error("connection reset"), readBackStatus: "evaluated" });
  const result = await evaluateScenario(ctx, "sk-openai", NOW, b.impl);
  assert.deepEqual(result, { status: "evaluated", runId: RUN, reason: "reconciled_after_error", error: "connection reset" });
});

test("missing OpenAI key when generation is needed: failed, no OpenAI call", async () => {
  const b = backend();
  const result = await evaluateScenario(ctx, null, NOW, b.impl);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "SECRET_MISSING:OPENAI_API_KEY");
  assert.equal(b.of("api.openai.com").length, 0);
});

test("[Q] only Scenario tables, State read, usage and the Scenario RPC are touched", async () => {
  const b = backend({ ai: [responsePayload(validOutput({ needs_sol: true })), lunaOk] });
  await evaluateScenario(ctx, "sk-openai", NOW, b.impl);
  const allowed = [
    /^GET \/rest\/v1\/market_state_current\?/,
    /^GET \/rest\/v1\/mic_scenario_current\?/,
    /^(GET|POST|PATCH) \/rest\/v1\/mic_scenario_evaluation_runs/,
    /^POST \/rest\/v1\/ai_usage_events$/,
    /^POST \/rest\/v1\/rpc\/apply_mic_scenario_update$/,
    /^POST https:\/\/api\.openai\.com\/v1\/responses$/,
  ];
  for (const call of b.calls) {
    const line = `${call.method} ${call.url.replace(ctx.supabaseUrl, "")}`;
    assert.ok(allowed.some((re) => re.test(line)), line);
  }
  // State is read-only for this evaluator.
  assert.equal(b.calls.filter((c) => c.url.includes("market_state") && c.method !== "GET").length, 0);
});

test("handler: POST + cron secret required", async () => {
  assert.equal((await handleRequest(new Request("http://x", { method: "GET" }))).status, 405);
  Deno.env.delete("MIC_SCENARIO_EVALUATOR_CRON_SECRET");
  const noSecret = await handleRequest(new Request("http://x", { method: "POST", headers: { "X-Cron-Secret": "" } }));
  assert.equal(noSecret.status, 401);
  Deno.env.set("MIC_SCENARIO_EVALUATOR_CRON_SECRET", "expected");
  try {
    assert.equal((await handleRequest(new Request("http://x", { method: "POST", headers: { "X-Cron-Secret": "wrong" } }))).status, 401);
  } finally {
    Deno.env.delete("MIC_SCENARIO_EVALUATOR_CRON_SECRET");
  }
});
