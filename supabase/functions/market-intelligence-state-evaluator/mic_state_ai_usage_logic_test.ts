import assert from "node:assert/strict";
import test from "node:test";
import { recordStateAiUsageEvent } from "./mic_state_ai_usage_logic.ts";
import type { RestContext } from "./mic_state_run_logic.ts";

const ctx: RestContext = { supabaseUrl: "https://example.supabase.co", secretKey: "secret-key" };
const RUN_ID = "55555555-5555-5555-5555-555555555555";

test("recordStateAiUsageEvent: the primary relation is the evaluation run; the domain stays in feature", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(new Response(JSON.stringify([{ id: 7 }]), { status: 201 }));
  };
  const result = await recordStateAiUsageEvent(
    ctx,
    { runId: RUN_ID, domain: "rates", model: "gpt-5.6-luna", inputTokens: 100, outputTokens: 50, costUsd: 0.00007 },
    fetchImpl as typeof fetch,
  );
  assert.deepEqual(result, { id: 7 });
  assert.match(calls[0].url, /\/rest\/v1\/ai_usage_events$/);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.related_table, "mic_state_evaluation_runs");
  assert.equal(body.related_id, RUN_ID);
  assert.equal(body.feature, "mic_state_evaluation_rates");
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.input_tokens, 100);
  assert.equal(body.output_tokens, 50);
  assert.equal(body.cost_usd, 0.00007);
});

test("recordStateAiUsageEvent: throws on a non-2xx status", async () => {
  const fetchImpl = () => Promise.resolve(new Response("bad", { status: 400 }));
  await assert.rejects(
    () =>
      recordStateAiUsageEvent(
        ctx,
        { runId: RUN_ID, domain: "rates", model: "gpt-5.6-luna", inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
        fetchImpl as typeof fetch,
      ),
    /STATE_AI_USAGE_INSERT_FAILED:400/,
  );
});
