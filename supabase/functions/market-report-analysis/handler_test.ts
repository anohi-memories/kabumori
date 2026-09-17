import assert from "node:assert/strict";
import test from "node:test";
import { type Deps, handleRequest } from "./handler.ts";
import { buildAnalysisInput } from "./analysis_input.ts";

const directory = new URL("./fixtures/", import.meta.url);
const dataFixture = JSON.parse(await Deno.readTextFile(new URL("close_2026-09-17_data_packet.json", directory)));
const newsRows = JSON.parse(await Deno.readTextFile(new URL("close_2026-09-17_news_rows.json", directory)));
const SUPABASE = "https://project-ref.supabase.co";
const SECRET = "cron-secret-for-tests";

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function analysisPayload() {
  const built = buildAnalysisInput({
    dataPacket: dataFixture.payload, dataPacketId: dataFixture.id, dataContentHash: dataFixture.content_hash, newsRows,
  });
  return {
    headline_ja: "日経平均は64,136.25で小幅高",
    market_summary_ja: "日経平均は+0.33%、TOPIX連動ETF（1306）は+0.83%でした。",
    claims: [{ claim_id: "c1", text_ja: "日経平均は+0.33%でした。", claim_type: "observation", evidence_refs: ["metric:nikkei225"], scope: "today" }],
    key_news: [{ ref: built.news[0].ref, why_it_matters_ja: "業績見通しの変更です。" }],
    strong_themes: [], weak_themes: [], next_watch_ja: ["今夜の米国株"], risks_ja: [],
    x_post: {
      lead_ja: "きょうの日本株は日経平均が+0.33%、TOPIX連動ETF（1306）が+0.83%でした",
      points_ja: ["日経平均は64,136.25で取引終了", "TOPIX連動ETF（1306）は427.4円", "前夜のNYダウは−1.21%でした"],
      closing_ja: "今夜の米国株の動きもあわせて見ておきたいです",
    },
  };
}

function harness(options: { claimOutcome?: string; dataQuality?: string; factPassed?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method: init?.method ?? "GET", body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url === "https://api.openai.com/v1/responses") {
      const isFact = String(body?.instructions).includes("Factチェッカー");
      const payload = isFact ? { passed: options.factPassed ?? true, issues: [] } : analysisPayload();
      return json({ output: [{ content: [{ type: "output_text", text: JSON.stringify(payload) }] }], usage: { input_tokens: 900, output_tokens: 300 } });
    }
    if (!url.startsWith(`${SUPABASE}/rest/v1/`)) throw new Error(`UNEXPECTED_HOST:${url}`);
    const path = url.slice(`${SUPABASE}/rest/v1/`.length);
    if (path.startsWith("market_holidays")) return json([{ holiday_date: "2026-09-21" }]);
    if (path === "rpc/claim_market_report_analysis") {
      const outcome = options.claimOutcome ?? "claimed";
      return json([{
        cycle_id: outcome === "data_not_ready" ? null : "11111111-1111-4111-8111-111111111111",
        claim_token: outcome === "claimed" ? "22222222-2222-4222-8222-222222222222" : null,
        attempt: 1, outcome, data_packet_id: outcome === "data_not_ready" ? null : dataFixture.id,
      }]);
    }
    if (path.startsWith("market_data_packets")) {
      return json([{ id: dataFixture.id, content_hash: dataFixture.content_hash, payload: dataFixture.payload, data_quality_status: options.dataQuality ?? "partial" }]);
    }
    if (path.startsWith("important_news_candidates")) return json(newsRows);
    if (path === "rpc/complete_market_report_analysis") return json("33333333-3333-4333-8333-333333333333");
    if (path === "rpc/fail_market_report_analysis") return json("failed");
    throw new Error(`UNEXPECTED_PATH:${path}`);
  };
  const deps: Deps = {
    env: (name) => ({
      SUPABASE_URL: SUPABASE,
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: "service-secret" }),
      SEND_PUSH_NOTIFICATIONS_CRON_SECRET: SECRET,
      OPENAI_API_KEY: "openai-test-key",
    } as Record<string, string>)[name],
    fetch: fetchMock,
    now: () => new Date("2026-09-17T07:20:00Z"),
  };
  return { calls, deps };
}

const request = (body: unknown, secret = SECRET) =>
  new Request("https://functions.local/market-report-analysis", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Cron-Secret": secret }, body: JSON.stringify(body),
  });

function assertNoConsumerOrPublishCalls(calls: Call[]) {
  for (const call of calls) {
    const host = new URL(call.url).host;
    assert.ok(host === "api.openai.com" || host === "project-ref.supabase.co", `unexpected host ${host}`);
    assert.ok(!/api\.x\.com|twitter|exp\.host|functions\/v1\//.test(call.url), `forbidden call ${call.url}`);
  }
}

test("rejects callers without the cron secret", async () => {
  const { calls, deps } = harness();
  assert.equal((await handleRequest(request({ mode: "close" }, "wrong"), deps)).status, 401);
  assert.equal(calls.length, 0);
});

test("completed data packet → one generation + one Fact check → shared packet stored; no X / push / consumer calls", async () => {
  const { calls, deps } = harness();
  const body = await (await handleRequest(request({ mode: "close" }), deps)).json();
  assert.equal(body.status, "completed");
  assert.equal(body.direction, "up");
  assert.equal(body.calls, 2);
  const openai = calls.filter((call) => call.url.includes("openai"));
  assert.equal(openai.length, 2);
  assert.ok(openai.every((call) => !("tools" in (call.body ?? {}))), "no web_search tools");
  const complete = calls.find((call) => call.url.endsWith("rpc/complete_market_report_analysis"))!;
  const payload = complete.body!.p_payload as Record<string, unknown>;
  assert.equal(payload.schema_version, "market_report_packet.v1");
  assert.equal(payload.data_packet_id, dataFixture.id);
  assert.equal(complete.body!.p_generation_calls, 2);
  assert.equal(complete.body!.p_input_tokens, 1800);
  assert.ok(!JSON.stringify(complete.body).includes("openai-test-key"));
  assertNoConsumerOrPublishCalls(calls);
});

test("data packet not completed → no OpenAI call", async () => {
  const { calls, deps } = harness({ claimOutcome: "data_not_ready" });
  const body = await (await handleRequest(request({ mode: "close" }), deps)).json();
  assert.equal(body.status, "skipped");
  assert.equal(body.reason, "data_not_ready");
  assert.ok(!calls.some((call) => call.url.includes("openai")));
});

test("blocked data packet → fail closed without generation", async () => {
  const { calls, deps } = harness({ dataQuality: "blocked" });
  const body = await (await handleRequest(request({ mode: "close" }), deps)).json();
  assert.equal(body.error, "DATA_PACKET_NOT_USABLE");
  assert.ok(!calls.some((call) => call.url.includes("openai")));
  assert.ok(calls.some((call) => call.url.endsWith("rpc/fail_market_report_analysis")));
});

test("Fact failure on both generations records fail_market_report_analysis and stores nothing", async () => {
  const { calls, deps } = harness({ factPassed: false });
  const body = await (await handleRequest(request({ mode: "close" }), deps)).json();
  assert.equal(body.status, "failed");
  assert.equal(body.error, "ANALYSIS_FACT_FAILED");
  assert.ok(!calls.some((call) => call.url.endsWith("rpc/complete_market_report_analysis")));
  assert.ok(calls.some((call) => call.url.endsWith("rpc/fail_market_report_analysis")));
});

test("already completed cycle is idempotent: no OpenAI call", async () => {
  const { calls, deps } = harness({ claimOutcome: "already_completed" });
  const body = await (await handleRequest(request({ mode: "close" }), deps)).json();
  assert.equal(body.reason, "already_completed");
  assert.ok(!calls.some((call) => call.url.includes("openai")));
});
