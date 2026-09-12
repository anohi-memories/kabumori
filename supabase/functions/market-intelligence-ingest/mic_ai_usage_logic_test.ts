import assert from "node:assert/strict";
import test from "node:test";
import { buildAiUsageEventInsertBody, recordAiUsageEvent } from "./mic_ai_usage_logic.ts";
import type { RestContext } from "./mic_writer_logic.ts";

const ctx: RestContext = { supabaseUrl: "https://example.supabase.co", secretKey: "secret-key" };

test("buildAiUsageEventInsertBody maps camelCase fields to snake_case columns with safe defaults", () => {
  const body = buildAiUsageEventInsertBody({
    feature: "mic_market_state_update",
    model: "gpt-5.6-luna",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.0002,
  });
  assert.deepEqual(body, {
    feature: "mic_market_state_update",
    model: "gpt-5.6-luna",
    input_tokens: 100,
    output_tokens: 50,
    web_search_calls: 0,
    cost_usd: 0.0002,
    related_table: null,
    related_id: null,
  });
});

test("recordAiUsageEvent inserts and returns the new row's id", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify([{ id: 42 }]), { status: 201 });
  };
  const result = await recordAiUsageEvent(
    ctx,
    { feature: "mic_market_state_update", model: "gpt-5.6-luna", inputTokens: 10, outputTokens: 5, costUsd: 0.00001 },
    fetchImpl as typeof fetch,
  );
  assert.deepEqual(result, { id: 42 });
  assert.match(calls[0].url, /\/rest\/v1\/ai_usage_events$/);
});

test("recordAiUsageEvent throws on a non-2xx status", async () => {
  const fetchImpl = async () => new Response("bad", { status: 400 });
  await assert.rejects(
    () =>
      recordAiUsageEvent(
        ctx,
        { feature: "x", model: "gpt-5.6-luna", inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
        fetchImpl as typeof fetch,
      ),
    /AI_USAGE_EVENT_INSERT_FAILED:400/,
  );
});
