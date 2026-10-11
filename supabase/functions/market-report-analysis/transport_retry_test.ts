// Transport retry for the shared analysis (2026-09-28 morning: ANALYSIS_OPENAI_GENERATE_FAILED:429 on both
// scheduled attempts). Fake fetch + fake sleep: no network, no real waiting.
import assert from "node:assert/strict";
import test from "node:test";
import { type Deps, handleRequest } from "./handler.ts";
import { buildAnalysisInput } from "./analysis_input.ts";
import { rich0917 } from "./test_support.ts";
import { MAX_GENERATIONS } from "./analysis_logic.ts";
import {
  DEFAULT_TRANSPORT_RETRY,
  fetchWithTransportRetry,
  isRetryableNetworkError,
  newTransportStats,
  retryAfterMs,
  transientReason,
} from "./transport_retry.ts";

// --- unit: policy ------------------------------------------------------------------------------

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const status = (code: number, headers: Record<string, string> = {}, body: unknown = { error: { code: "rate_limit_exceeded" } }) =>
  new Response(JSON.stringify(body), { status: code, headers });

function sequence(responses: Array<Response | Error>) {
  let index = 0;
  const fetchCalls = () => index;
  const doFetch = () => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next.clone());
  };
  return { doFetch, fetchCalls };
}

function sleeper() {
  const waits: number[] = [];
  return { waits, sleep: (ms: number) => { waits.push(ms); return Promise.resolve(); } };
}

test("429 then success: one retry with backoff, success-after-retry recorded", async () => {
  const { doFetch, fetchCalls } = sequence([status(429), ok()]);
  const stats = newTransportStats();
  const { waits, sleep } = sleeper();
  const response = await fetchWithTransportRetry(doFetch, { stats, sleep });
  assert.equal(response.status, 200);
  assert.equal(fetchCalls(), 2);
  assert.deepEqual(waits, [DEFAULT_TRANSPORT_RETRY.backoffMs[0]]);
  assert.deepEqual([stats.retries, stats.succeededAfterRetry, stats.exhausted, stats.reasons], [1, true, false, ["http_429"]]);
});

test("Retry-After is honoured when sane; too-long Retry-After is not waited for", async () => {
  {
    const { doFetch } = sequence([status(429, { "retry-after": "3" }), ok()]);
    const { waits, sleep } = sleeper();
    await fetchWithTransportRetry(doFetch, { stats: newTransportStats(), sleep });
    assert.deepEqual(waits, [3000]);
  }
  {
    const { doFetch } = sequence([status(429, { "retry-after-ms": "1500" }), ok()]);
    const { waits, sleep } = sleeper();
    await fetchWithTransportRetry(doFetch, { stats: newTransportStats(), sleep });
    assert.deepEqual(waits, [1500]);
  }
  {
    const { doFetch, fetchCalls } = sequence([status(429, { "retry-after": "120" }), ok()]);
    const stats = newTransportStats();
    const { waits, sleep } = sleeper();
    const response = await fetchWithTransportRetry(doFetch, { stats, sleep });
    assert.equal(response.status, 429, "a 2-minute Retry-After is left to the scheduled retry");
    assert.deepEqual([fetchCalls(), waits.length, stats.exhausted], [1, 0, true]);
  }
  assert.equal(retryAfterMs(new Headers({ "retry-after": "Wed, 01 Jan 2031 00:00:05 GMT" }), Date.parse("2031-01-01T00:00:00Z")), 5000);
  assert.equal(retryAfterMs(new Headers({}), 0), null);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "soon" }), 0), null);
});

test("repeated 429 exhausts the per-call bound and returns the last 429 (caller keeps its error code)", async () => {
  const { doFetch, fetchCalls } = sequence([status(429)]);
  const stats = newTransportStats();
  const { waits, sleep } = sleeper();
  const response = await fetchWithTransportRetry(doFetch, { stats, sleep });
  assert.equal(response.status, 429);
  assert.equal(fetchCalls(), 1 + DEFAULT_TRANSPORT_RETRY.maxRetriesPerCall);
  assert.deepEqual(waits, DEFAULT_TRANSPORT_RETRY.backoffMs);
  assert.equal(stats.exhausted, true);
  assert.equal(stats.succeededAfterRetry, false);
});

test("500 / 502 / 503 / 504 are retryable; network TypeError is retryable; timeout abort is not", async () => {
  for (const code of [500, 502, 503, 504]) {
    const { doFetch } = sequence([status(code, {}, {}), ok()]);
    assert.equal((await fetchWithTransportRetry(doFetch, { stats: newTransportStats(), sleep: sleeper().sleep })).status, 200, String(code));
  }
  {
    const { doFetch, fetchCalls } = sequence([new TypeError("error sending request"), ok()]);
    const stats = newTransportStats();
    assert.equal((await fetchWithTransportRetry(doFetch, { stats, sleep: sleeper().sleep })).status, 200);
    assert.deepEqual([fetchCalls(), stats.reasons], [2, ["network"]]);
  }
  const timeout = new DOMException("Signal timed out.", "TimeoutError");
  assert.equal(isRetryableNetworkError(timeout), false);
  const { doFetch, fetchCalls } = sequence([timeout as unknown as Error, ok()]);
  await assert.rejects(fetchWithTransportRetry(doFetch, { stats: newTransportStats(), sleep: sleeper().sleep }));
  assert.equal(fetchCalls(), 1, "our own 90s timeout is not retried");
});

test("non-retryable 4xx and quota-exhausted 429 are returned immediately, no retry", async () => {
  for (const response of [status(400, {}, {}), status(401, {}, {}), status(404, {}, {}), status(429, {}, { error: { code: "insufficient_quota" } })]) {
    const { doFetch, fetchCalls } = sequence([response, ok()]);
    const stats = newTransportStats();
    const { waits, sleep } = sleeper();
    const final = await fetchWithTransportRetry(doFetch, { stats, sleep });
    assert.equal(final.status, response.status);
    assert.deepEqual([fetchCalls(), waits.length, stats.retries], [1, 0, 0]);
  }
  assert.equal(await transientReason(status(429, {}, "not json")), "http_429");
});

test("run-wide budget caps total extra requests and total waiting across calls", async () => {
  const stats = newTransportStats();
  const { waits, sleep } = sleeper();
  let total = 0;
  for (let call = 0; call < 4; call += 1) {
    const { doFetch, fetchCalls } = sequence([status(503, {}, {})]);
    await fetchWithTransportRetry(doFetch, { stats, sleep });
    total += fetchCalls();
  }
  assert.equal(stats.retries, DEFAULT_TRANSPORT_RETRY.runRetryBudget, "never more than the run budget of extra requests");
  assert.equal(total, 4 + DEFAULT_TRANSPORT_RETRY.runRetryBudget);
  assert.ok(waits.reduce((a, b) => a + b, 0) <= DEFAULT_TRANSPORT_RETRY.runWaitBudgetMs);
});

// --- integration: handler (claim fencing, one packet, diagnostics) ------------------------------

const directory = new URL("./fixtures/", import.meta.url);
const dataFixture = JSON.parse(await Deno.readTextFile(new URL("close_2026-09-17_data_packet.json", directory)));
const newsRows = JSON.parse(await Deno.readTextFile(new URL("close_2026-09-17_news_rows.json", directory)));
const SUPABASE = "https://project-ref.supabase.co";
const SECRET = "cron-secret-for-tests";

function analysisPayload() {
  return rich0917(buildAnalysisInput({
    dataPacket: dataFixture.payload, dataPacketId: dataFixture.id, dataContentHash: dataFixture.content_hash, newsRows,
  }));
}

type Plan = Array<{ status: number; headers?: Record<string, string>; body?: unknown } | "ok" | "network">;

function harness(plan: { generate: Plan; fact?: Plan; factPassed?: boolean }) {
  const openaiCalls: string[] = [];
  const rpc: Array<{ name: string; body: Record<string, unknown> }> = [];
  const counters = { generate: 0, fact: 0 };
  const waits: number[] = [];
  const fetchMock: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const json = (value: unknown, code = 200, headers: Record<string, string> = {}) =>
      Promise.resolve(new Response(JSON.stringify(value), { status: code, headers }));
    if (url === "https://api.openai.com/v1/responses") {
      const step = String(body?.instructions).includes("Factチェッカー") ? "fact" : "generate";
      openaiCalls.push(step);
      const steps = step === "fact" ? plan.fact ?? ["ok"] : plan.generate;
      const next = steps[Math.min(counters[step], steps.length - 1)];
      counters[step] += 1;
      if (next === "network") return Promise.reject(new TypeError("error sending request"));
      if (next !== "ok") return json(next.body ?? { error: { code: "rate_limit_exceeded" } }, next.status, next.headers ?? {});
      const payload = step === "fact" ? { passed: plan.factPassed ?? true, issues: plan.factPassed === false ? ["事実不一致"] : [] } : analysisPayload();
      return json({ output: [{ content: [{ type: "output_text", text: JSON.stringify(payload) }] }], usage: { input_tokens: 900, output_tokens: 300 } });
    }
    const path = url.slice(`${SUPABASE}/rest/v1/`.length);
    if (path.startsWith("market_holidays")) return json([]);
    if (path.startsWith("rpc/")) {
      rpc.push({ name: path.slice(4), body });
      if (path === "rpc/claim_market_report_analysis") {
        return json([{ cycle_id: "11111111-1111-4111-8111-111111111111", claim_token: "22222222-2222-4222-8222-222222222222", attempt: 1, outcome: "claimed", data_packet_id: dataFixture.id }]);
      }
      if (path === "rpc/complete_market_report_analysis") return json("33333333-3333-4333-8333-333333333333");
      if (path === "rpc/fail_market_report_analysis") return json("failed");
    }
    if (path.startsWith("market_data_packets")) return json([{ id: dataFixture.id, content_hash: dataFixture.content_hash, payload: dataFixture.payload, data_quality_status: "partial" }]);
    if (path.startsWith("important_news_candidates")) return json(newsRows);
    return Promise.reject(new Error(`UNEXPECTED:${url}`));
  };
  const deps = (now: string): Deps => ({
    env: (name) => ({ SUPABASE_URL: SUPABASE, SUPABASE_SECRET_KEYS: JSON.stringify({ default: "service-secret" }), SEND_PUSH_NOTIFICATIONS_CRON_SECRET: SECRET, OPENAI_API_KEY: "openai-test-key" } as Record<string, string>)[name],
    fetch: fetchMock,
    now: () => new Date(now),
    sleep: (ms) => { waits.push(ms); return Promise.resolve(); },
  });
  return { openaiCalls, rpc, waits, deps };
}

const request = (mode: "morning" | "close") => new Request("https://functions.local/market-report-analysis", {
  method: "POST", headers: { "Content-Type": "application/json", "X-Cron-Secret": SECRET }, body: JSON.stringify({ mode }),
});
// 07:55 JST on 2026-09-29 (Tue) and 16:20 JST on 2026-09-28 (Mon): the scheduled analysis times.
const MORNING_NOW = "2026-09-28T22:55:00Z";
const CLOSE_NOW = "2026-09-28T07:20:00Z";

for (const [mode, now] of [["morning", MORNING_NOW], ["close", CLOSE_NOW]] as const) {
  test(`${mode}: first generation 429 then success → one completed packet, one claim, retry recorded`, async () => {
    const h = harness({ generate: [{ status: 429, headers: { "retry-after": "2" } }, "ok"] });
    const body = await (await handleRequest(request(mode), h.deps(now))).json();
    assert.equal(body.status, "completed");
    assert.deepEqual(h.openaiCalls, ["generate", "generate", "fact"]);
    assert.equal(body.calls, 2, "billed model calls unchanged: the 429 request produced no output");
    assert.deepEqual(h.waits, [2000]);
    assert.deepEqual(h.rpc.map((r) => r.name), ["claim_market_report_analysis", "complete_market_report_analysis"], "one claim, one completion, no fail");
    const diagnostics = h.rpc[1].body.p_diagnostics as Record<string, string>;
    assert.equal(diagnostics.transport_retries, "1");
    assert.equal(diagnostics.transport_success_after_retry, "true");
    assert.equal(diagnostics.transport_retry_reasons, "http_429");
    assert.ok(!JSON.stringify(h.rpc).includes("openai-test-key"), "no secret in diagnostics");
  });

  test(`${mode}: 2026-09-28 mechanism — persistent 429 exhausts the bounded retry and fails with the same code`, async () => {
    const h = harness({ generate: [{ status: 429 }] });
    const response = await handleRequest(request(mode), h.deps(now));
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.error, "ANALYSIS_OPENAI_GENERATE_FAILED:429", "same code as production on 2026-09-28");
    assert.equal(h.openaiCalls.length, 1 + DEFAULT_TRANSPORT_RETRY.maxRetriesPerCall);
    assert.deepEqual(h.rpc.map((r) => r.name), ["claim_market_report_analysis", "fail_market_report_analysis"]);
    const diagnostics = h.rpc[1].body.p_diagnostics as Record<string, string>;
    assert.equal(diagnostics.transport_retry_exhausted, "true");
    assert.equal(diagnostics.transport_retries, String(DEFAULT_TRANSPORT_RETRY.maxRetriesPerCall));
  });
}

test("5xx on the Fact call then success → completed; network drop then success → completed", async () => {
  {
    const h = harness({ generate: ["ok"], fact: [{ status: 503, body: {} }, "ok"] });
    const body = await (await handleRequest(request("close"), h.deps(CLOSE_NOW))).json();
    assert.equal(body.status, "completed");
    assert.deepEqual(h.openaiCalls, ["generate", "fact", "fact"]);
  }
  {
    const h = harness({ generate: ["network", "ok"] });
    const body = await (await handleRequest(request("close"), h.deps(CLOSE_NOW))).json();
    assert.equal(body.status, "completed");
  }
});

test("non-retryable 4xx fails immediately with its existing code", async () => {
  const h = harness({ generate: [{ status: 400, body: {} }] });
  const body = await (await handleRequest(request("close"), h.deps(CLOSE_NOW))).json();
  assert.equal(body.error, "ANALYSIS_OPENAI_GENERATE_FAILED:400");
  assert.deepEqual([h.openaiCalls.length, h.waits.length], [1, 0]);
});

test("Fact rejection is content, not transport: no transport retry, existing regeneration bound only", async () => {
  const h = harness({ generate: ["ok"], factPassed: false });
  const body = await (await handleRequest(request("close"), h.deps(CLOSE_NOW))).json();
  // Delivery first (2026-10-07): after the one regeneration the Fact findings are advisory and the packet is stored.
  assert.equal(body.status, "completed");
  assert.equal(h.waits.length, 0);
  assert.equal(h.openaiCalls.length, MAX_GENERATIONS * 2, "2 generations + 2 Fact, unchanged");
  assert.equal(h.rpc.filter((r) => r.name === "complete_market_report_analysis").length, 1, "one packet stored");
});

test("worst-case call budget per run is bounded: 4 model calls + 3 transport retries", async () => {
  // Every call gets one 503 first, and Fact always rejects: the maximum number of requests in one run.
  const h = harness({ generate: [{ status: 503, body: {} }, "ok", { status: 503, body: {} }, "ok"], fact: [{ status: 503, body: {} }, "ok", { status: 503, body: {} }, "ok"], factPassed: false });
  const body = await (await handleRequest(request("close"), h.deps(CLOSE_NOW))).json();
  assert.equal(body.status, "completed", "delivered as advisory after the bounded regeneration");
  assert.ok(h.openaiCalls.length <= MAX_GENERATIONS * 2 + DEFAULT_TRANSPORT_RETRY.runRetryBudget, `requests: ${h.openaiCalls.length}`);
  assert.ok(h.waits.reduce((a, b) => a + b, 0) <= DEFAULT_TRANSPORT_RETRY.runWaitBudgetMs);
});
