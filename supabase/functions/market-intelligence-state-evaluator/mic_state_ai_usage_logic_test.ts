import assert from "node:assert/strict";
import test from "node:test";
import { recordStateAiUsageEvent } from "./mic_state_ai_usage_logic.ts";
import type { RestContext } from "./mic_state_run_logic.ts";

const ctx: RestContext = { supabaseUrl: "https://example.supabase.co", secretKey: "secret-key" };

test("recordStateAiUsageEvent: feature is namespaced per domain, related_table points at market_state_current", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify([{ id: 7 }]), { status: 201 });
  };
  const result = await recordStateAiUsageEvent(
    ctx,
    { domain: "rates", model: "gpt-5.6-luna", inputTokens: 100, outputTokens: 50, costUsd: 0.00007, relatedId: "rates" },
    fetchImpl as typeof fetch,
  );
  assert.deepEqual(result, { id: 7 });
  assert.match(calls[0].url, /\/rest\/v1\/ai_usage_events$/);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.feature, "mic_state_evaluation_rates");
  assert.equal(body.related_table, "market_state_current");
  assert.equal(body.related_id, "rates");
});

test("recordStateAiUsageEvent: throws on a non-2xx status", async () => {
  const fetchImpl = async () => new Response("bad", { status: 400 });
  await assert.rejects(
    () =>
      recordStateAiUsageEvent(
        ctx,
        { domain: "rates", model: "gpt-5.6-luna", inputTokens: 1, outputTokens: 1, costUsd: 0.001, relatedId: "rates" },
        fetchImpl as typeof fetch,
      ),
    /STATE_AI_USAGE_INSERT_FAILED:400/,
  );
});
