// The market-report callers use the Kabumori AI model registry: the request bodies, the cost, the audit metadata
// and the failure code of a response cut off by max_output_tokens. Offline: OpenAI and Supabase are mocked.
import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalysisInput } from "./analysis_input.ts";
import {
  ANALYSIS_MODEL,
  factRequestBody,
  generateSharedAnalysis,
  generationRequestBody,
  MAX_GENERATIONS,
  type Requester,
} from "./analysis_logic.ts";
import { type Deps, handleRequest, openAiRequester } from "./handler.ts";
import { rich0917 } from "./test_support.ts";
import {
  auditDiagnostics,
  estimateCallCostUsd,
  KABUMORI_AI_CONFIG_VERSION,
  MARKET_REPORT_FACT_ROLE,
  MARKET_REPORT_GENERATE_ROLE,
  responsesApiParams,
} from "../_shared/kabumori_ai_models.ts";

const directory = new URL("./fixtures/", import.meta.url);
const dataFixture = JSON.parse(await Deno.readTextFile(new URL("close_2026-09-17_data_packet.json", directory)));
const newsRows = JSON.parse(await Deno.readTextFile(new URL("close_2026-09-17_news_rows.json", directory)));
const input = () =>
  buildAnalysisInput({ dataPacket: dataFixture.payload, dataPacketId: dataFixture.id, dataContentHash: dataFixture.content_hash, newsRows });
const SUPABASE = "https://project-ref.supabase.co";

type Call = { url: string; body: Record<string, unknown> | null };

function harness(openAi: (body: Record<string, unknown>) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchMock: typeof fetch = (target, init) => {
    const url = typeof target === "string" ? target : target instanceof URL ? target.href : target.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }));
    if (url === "https://api.openai.com/v1/responses") return Promise.resolve(openAi(body as Record<string, unknown>));
    const path = url.slice(`${SUPABASE}/rest/v1/`.length);
    if (path.startsWith("market_holidays")) return json([{ holiday_date: "2026-09-21" }]);
    if (path === "rpc/claim_market_report_analysis") {
      return json([{ cycle_id: "11111111-1111-4111-8111-111111111111", claim_token: "22222222-2222-4222-8222-222222222222", attempt: 1, outcome: "claimed", data_packet_id: dataFixture.id }]);
    }
    if (path.startsWith("market_data_packets")) return json([{ id: dataFixture.id, content_hash: dataFixture.content_hash, payload: dataFixture.payload, data_quality_status: "partial" }]);
    if (path.startsWith("important_news_candidates")) return json(newsRows);
    if (path === "rpc/complete_market_report_analysis") return json("33333333-3333-4333-8333-333333333333");
    if (path === "rpc/fail_market_report_analysis") return json("failed");
    if (path === "market_report_generation_traces") return Promise.resolve(new Response(null, { status: 201 }));
    return Promise.reject(new Error(`UNEXPECTED_PATH:${path}`));
  };
  const deps: Deps = {
    env: (name) => ({
      SUPABASE_URL: SUPABASE, SUPABASE_SECRET_KEYS: JSON.stringify({ default: "service-secret" }),
      SEND_PUSH_NOTIFICATIONS_CRON_SECRET: "cron-secret", OPENAI_API_KEY: "openai-test-key",
    } as Record<string, string>)[name],
    fetch: fetchMock,
    now: () => new Date("2026-09-17T07:20:00Z"),
  };
  return { calls, deps };
}
const okResponse = (payload: unknown, usage = { input_tokens: 900, output_tokens: 300 }) =>
  new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: JSON.stringify(payload) }] }], usage }), { status: 200 });
const request = () =>
  new Request("https://functions.local/market-report-analysis", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Cron-Secret": "cron-secret" }, body: JSON.stringify({ mode: "close" }),
  });

test("request bodies carry exactly the registry's model, reasoning and output cap for each role", () => {
  const generate = generationRequestBody(input(), []);
  const fact = factRequestBody(input(), rich0917(input()));
  const expectedGenerate = responsesApiParams(MARKET_REPORT_GENERATE_ROLE);
  const expectedFact = responsesApiParams(MARKET_REPORT_FACT_ROLE);
  for (const key of ["model", "reasoning", "max_output_tokens"] as const) {
    assert.deepEqual(generate[key], expectedGenerate[key], `generate ${key}`);
    assert.deepEqual(fact[key], expectedFact[key], `fact ${key}`);
  }
  assert.deepEqual([generate.model, generate.reasoning, generate.max_output_tokens], ["gpt-6.1-sol", { effort: "medium" }, 16_000]);
  assert.deepEqual([fact.model, fact.reasoning, fact.max_output_tokens], ["gpt-6.1-sol", { effort: "low" }, 4_000]);
  assert.equal(generate.store, false);
  assert.equal(fact.store, false);
  assert.equal(ANALYSIS_MODEL, "gpt-6.1-sol");
  // The structured-output contract is untouched.
  assert.equal((generate.text as { format: { type: string; strict: boolean } }).format.strict, true);
  assert.equal((fact.text as { format: { name: string } }).format.name, "market_report_fact");
});

test("through the handler: the HTTP bodies sent to OpenAI use the registry for both calls, nothing else is called", async () => {
  const { calls, deps } = harness((body) => okResponse(String(body.instructions).includes("Factチェッカー") ? { passed: true, issues: [] } : rich0917(input())));
  const response = await handleRequest(request(), deps);
  assert.equal(((await response.json()) as { status: string }).status, "completed");
  const openAi = calls.filter((call) => call.url === "https://api.openai.com/v1/responses");
  assert.equal(openAi.length, 2);
  assert.deepEqual(openAi.map((call) => [call.body?.model, call.body?.reasoning, call.body?.max_output_tokens]), [
    ["gpt-6.1-sol", { effort: "medium" }, 16_000], ["gpt-6.1-sol", { effort: "low" }, 4_000],
  ]);
  for (const call of calls) assert.ok(new URL(call.url).host === "api.openai.com" || new URL(call.url).host === "project-ref.supabase.co");
});

test("cost: stored from the registry's official price, per request (2 requests of 900 in / 300 out)", async () => {
  const { calls, deps } = harness((body) => okResponse(String(body.instructions).includes("Factチェッカー") ? { passed: true, issues: [] } : rich0917(input())));
  await handleRequest(request(), deps);
  const complete = calls.find((call) => call.url.endsWith("rpc/complete_market_report_analysis"))!.body as Record<string, unknown>;
  const each = estimateCallCostUsd(MARKET_REPORT_GENERATE_ROLE, 900, 300);
  assert.equal(each, 0.0048);
  assert.equal(complete.p_api_cost_usd, 0.0096);
  assert.deepEqual([complete.p_input_tokens, complete.p_output_tokens, complete.p_generation_calls, complete.p_model], [1800, 600, 2, "gpt-6.1-sol"]);
  assert.equal((complete.p_diagnostics as Record<string, string>).cost_usd, "0.0096");
});

test("audit metadata: logical role, actual model, reasoning and configuration version are in the report diagnostics", async () => {
  const { calls, deps } = harness((body) => okResponse(String(body.instructions).includes("Factチェッカー") ? { passed: true, issues: [] } : rich0917(input())));
  await handleRequest(request(), deps);
  const diagnostics = (calls.find((call) => call.url.endsWith("rpc/complete_market_report_analysis"))!.body as { p_diagnostics: Record<string, string> }).p_diagnostics;
  for (const [key, value] of Object.entries(auditDiagnostics())) assert.equal(diagnostics[key], value, key);
  assert.equal(diagnostics.ai_config_version, KABUMORI_AI_CONFIG_VERSION);
  assert.equal(diagnostics.ai_generate_role, "kabumori.market_report.generate");
  assert.equal(diagnostics.ai_fact_role, "kabumori.market_report.fact");
  assert.equal(diagnostics.model, "gpt-6.1-sol", "the existing key still names the generation model");
});

test("audit metadata is also written when the run fails (so a failed cycle says which configuration ran)", async () => {
  // Unparsable output twice: nothing deliverable, the run fails (a Fact finding alone no longer fails it).
  const { calls, deps } = harness(() => okResponse({ broken: true }));
  await handleRequest(request(), deps);
  const fail = calls.find((call) => call.url.endsWith("rpc/fail_market_report_analysis"))!.body as { p_diagnostics: Record<string, string> };
  assert.equal(fail.p_diagnostics.ai_config_version, KABUMORI_AI_CONFIG_VERSION);
  assert.equal(fail.p_diagnostics.ai_generate_model, "gpt-6.1-sol");
});

test("a response cut off by max_output_tokens is reported as incomplete, not as an empty or invalid body", async () => {
  const cut = (text: string | null) =>
    new Response(JSON.stringify({
      status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      output: text === null ? [] : [{ content: [{ type: "output_text", text }] }], usage: { input_tokens: 1, output_tokens: 16_000 },
    }), { status: 200 });
  for (const text of [null, '{"headline_ja":"途中で切れ']) {
    const requester = openAiRequester("k", () => Promise.resolve(cut(text)));
    await assert.rejects(requester("generate", { model: "m" }), /^Error: ANALYSIS_OPENAI_GENERATE_INCOMPLETE:max_output_tokens$/);
    await assert.rejects(requester("fact", { model: "m" }), /^Error: ANALYSIS_OPENAI_FACT_INCOMPLETE:max_output_tokens$/);
  }
  // Unchanged: an empty or invalid body of a completed response keeps its old codes.
  await assert.rejects(openAiRequester("k", () => Promise.resolve(new Response(JSON.stringify({ output: [] }), { status: 200 })))("generate", {}), /ANALYSIS_OPENAI_GENERATE_EMPTY$/);
  await assert.rejects(openAiRequester("k", () => Promise.resolve(okResponseText("not json")))("generate", {}), /ANALYSIS_OPENAI_GENERATE_INVALID_JSON$/);
  // A complete response still parses.
  const parsed = await openAiRequester("k", () => Promise.resolve(okResponse({ passed: true, issues: [] })))("fact", {});
  assert.deepEqual(parsed.payload, { passed: true, issues: [] });
});
const okResponseText = (text: string) => new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text }] }], usage: {} }), { status: 200 });

test("accepted behaviour is unchanged by the migration: at most 4 calls, two generations, safe-original fallback", async () => {
  assert.equal(MAX_GENERATIONS, 2);
  const steps: string[] = [];
  const requester: Requester = (step) => {
    steps.push(step);
    return Promise.resolve({ payload: step === "fact" ? { passed: false, issues: ["x"] } : rich0917(input()), inputTokens: 1000, outputTokens: 500 });
  };
  const outcome = await generateSharedAnalysis(input(), requester, () => new Date("2026-09-17T07:20:30Z"));
  // Delivery first (2026-10-07): delivered with the Fact findings as advisory, within the same four calls.
  assert.equal(outcome.ok && outcome.packet.fact.ai_status, "advisory");
  assert.deepEqual(steps, ["generate", "fact", "generate", "fact"]);
  assert.equal(outcome.calls, steps.length);
  // 2 generations + 2 Fact checks, each priced as its own request.
  assert.equal(outcome.costUsd, Number((steps.length * (1000 * 2 + 500 * 10) / 1_000_000).toFixed(6)));
});
