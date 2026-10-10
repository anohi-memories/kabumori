import assert from "node:assert/strict";
import test from "node:test";
import { runProbe } from "./probe.ts";
import { loadCases } from "./fixtures.ts";
import { buildTaskRequest, buildWebSearchRequests } from "./tasks.ts";

const FAKE_KEY = "sk-ant-FAKEFAKE0123456789";
const cases = await loadCases();
const judgement = (await buildTaskRequest("judgement_primary", cases[0]))!;
const search = buildWebSearchRequests()[0];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const modelRow = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "model", id, display_name: id, created_at: "2026-09-01T00:00:00Z", lifecycle: "active", max_input_tokens: 1_000_000, max_tokens: 128_000,
  capabilities: {
    server_tools: { supported: true, web_search: { supported: true }, code_execution: { supported: true } },
    structured_outputs: { supported: true },
    thinking: { supported: true, types: { adaptive: { supported: true }, disabled: { supported: id !== "claude-opus-5-5" }, enabled: { supported: false } } },
    effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, max: { supported: true } },
  },
  ...extra,
});

function fakeApi(handlers: { onCount?: (body: Record<string, unknown>) => Response }) {
  const calls: string[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (new URL(url).pathname === "/v1/models") {
      return Promise.resolve(json({
        data: [modelRow("claude-haiku-5-5"), modelRow("claude-opus-5-5"), modelRow("claude-sonnet-5-5"), modelRow("claude-other")],
        has_more: false, first_id: "a", last_id: "b",
      }));
    }
    if (new URL(url).pathname === "/v1/messages/count_tokens") {
      return Promise.resolve((handlers.onCount ?? (() => json({ input_tokens: 2000 })))(JSON.parse(String(init?.body))));
    }
    return Promise.resolve(json({ type: "error", error: { type: "not_found_error", message: "nope" } }, 404));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test("the probe reads capabilities and counts tokens without ever calling the billed messages endpoint", async () => {
  const api = fakeApi({});
  const report = await runProbe({
    apiKey: FAKE_KEY, models: ["claude-haiku-5-5", "claude-opus-5-5"], requests: [judgement, search],
    ledgerInputTokens: { judgement_primary: 1792 }, fetch: api.fetchImpl,
  });
  assert.equal(report.keyWorks, true);
  assert.ok(api.calls.every((call) => call === "GET /v1/models" || call === "POST /v1/messages/count_tokens"), api.calls.join(","));
  assert.ok(!(api.calls as string[]).includes("POST /v1/messages"));
  assert.deepEqual(report.models.map((m) => m.id), ["claude-haiku-5-5", "claude-opus-5-5"]);
  const opus = report.models.find((m) => m.id === "claude-opus-5-5")!;
  assert.equal(opus.thinkingCanBeDisabled, false);
  assert.equal(opus.webSearch, true);
  assert.deepEqual(opus.effortLevels, ["low", "medium", "high", "max"]);
  assert.equal(report.models.find((m) => m.id === "claude-haiku-5-5")!.thinkingCanBeDisabled, true);
});

test("web search requests are not sent to the count endpoint (it rejects server tools)", async () => {
  const api = fakeApi({});
  const report = await runProbe({ apiKey: FAKE_KEY, models: ["claude-haiku-5-5"], requests: [search], ledgerInputTokens: {}, fetch: api.fetchImpl });
  assert.equal(report.tokenCounts.length, 0);
  assert.ok(!api.calls.includes("POST /v1/messages/count_tokens"));
});

test("token counts are collected per model and task and compared with the OpenAI ledger mean", async () => {
  const api = fakeApi({ onCount: () => json({ input_tokens: 2000 }) });
  const report = await runProbe({
    apiKey: FAKE_KEY, models: ["claude-haiku-5-5", "claude-sonnet-5-5"], requests: [judgement], ledgerInputTokens: { judgement_primary: 1600 }, fetch: api.fetchImpl,
  });
  assert.equal(report.tokenCounts.length, 2);
  assert.deepEqual(report.factors.map((f) => [f.model, f.taskId, f.meanClaudeTokens, f.factor]), [
    ["claude-haiku-5-5", "judgement_primary", 2000, 1.25],
    ["claude-sonnet-5-5", "judgement_primary", 2000, 1.25],
  ]);
  assert.equal(report.tokenCounts[0].includesSchema, true);
});

test("if the count endpoint rejects the schema the probe falls back to system + user and says so", async () => {
  const api = fakeApi({
    onCount: (body) => "output_config" in body
      ? json({ type: "error", error: { type: "invalid_request_error", message: "output_config not supported here" } }, 400)
      : json({ input_tokens: 1500 }),
  });
  const report = await runProbe({ apiKey: FAKE_KEY, models: ["claude-haiku-5-5"], requests: [judgement], ledgerInputTokens: {}, fetch: api.fetchImpl });
  assert.equal(report.tokenCounts[0].inputTokens, 1500);
  assert.equal(report.tokenCounts[0].includesSchema, false);
});

test("a rejected key is reported, redacted, with no model or count work attempted", async () => {
  const report = await runProbe({
    apiKey: FAKE_KEY, models: ["claude-haiku-5-5"], requests: [judgement], ledgerInputTokens: {},
    fetch: (() => Promise.resolve(json({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${FAKE_KEY}` } }, 401))) as unknown as typeof fetch,
  });
  assert.equal(report.keyWorks, false);
  assert.ok(report.error);
  assert.ok(!JSON.stringify(report).includes("FAKEFAKE"));
  assert.equal(report.tokenCounts.length, 0);
});
