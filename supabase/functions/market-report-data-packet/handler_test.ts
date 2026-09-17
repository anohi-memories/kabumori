import assert from "node:assert/strict";
import test from "node:test";
import { type Deps, handleRequest } from "./handler.ts";
import { type MarketDataPacket, validateMarketDataPacket } from "./packet_schema.ts";
import { CLOSE_0916, MIC_ROWS, MIC_THRESHOLDS } from "./test_fixtures.ts";

const SUPABASE = "https://project-ref.supabase.co";
const SECRET = "cron-secret-for-tests";
const NOW = new Date("2026-09-16T07:15:00Z"); // 16:15 JST, Wednesday

type Call = { url: string; method: string; body: unknown };

function harness(options: {
  claimOutcome?: string;
  yahooFails?: string[];
  completeStatus?: number;
} = {}) {
  const calls: Call[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

    if (url.startsWith("https://query2.finance.yahoo.com/v8/finance/chart/")) {
      const symbol = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
      if (options.yahooFails?.includes(symbol)) return json({}, 503);
      if (symbol === "^N225") return json(CLOSE_0916.n225);
      if (symbol === "1306.T") return json(CLOSE_0916.etf1306);
      return json(CLOSE_0916.us(symbol));
    }
    if (!url.startsWith(`${SUPABASE}/rest/v1/`)) throw new Error(`UNEXPECTED_HOST:${url}`);
    const path = url.slice(`${SUPABASE}/rest/v1/`.length);
    if (path.startsWith("market_holidays")) {
      return json([
        { market: "JPX", holiday_date: "2026-09-21" },
        { market: "NYSE", holiday_date: "2026-09-07" },
        { market: "NYSE", holiday_date: "2026-12-25" },
      ]);
    }
    if (path.startsWith("market_metrics")) {
      return json(MIC_ROWS.map((row) => row.metric_key.startsWith("JGB") ? { ...row, observed_date: "2026-09-15" } : row));
    }
    if (path.startsWith("mic_metric_domain_map")) return json(MIC_THRESHOLDS);
    if (path.startsWith("important_news_candidates")) return json([]);
    if (path === "rpc/claim_market_report_cycle") {
      const outcome = options.claimOutcome ?? "claimed";
      return json([{
        cycle_id: "11111111-1111-4111-8111-111111111111",
        claim_token: outcome === "claimed" ? "22222222-2222-4222-8222-222222222222" : null,
        attempt: 1,
        outcome,
      }]);
    }
    if (path === "rpc/complete_market_report_cycle") {
      if (options.completeStatus) return json({ message: "boom" }, options.completeStatus);
      const quality = (body as { p_payload: MarketDataPacket }).p_payload.data_quality.status;
      return json([{ packet_id: "33333333-3333-4333-8333-333333333333", cycle_status: quality === "blocked" ? "blocked" : "completed" }]);
    }
    if (path === "rpc/fail_market_report_cycle") return json("failed");
    throw new Error(`UNEXPECTED_PATH:${path}`);
  };
  const deps: Deps = {
    env: (name) => ({
      SUPABASE_URL: SUPABASE,
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: "service-secret" }),
      SEND_PUSH_NOTIFICATIONS_CRON_SECRET: SECRET,
    } as Record<string, string>)[name],
    fetch: fetchMock,
    now: () => new Date(NOW),
  };
  return { calls, deps };
}

function request(body: unknown, secret: string | null = SECRET): Request {
  return new Request("https://functions.local/market-report-data-packet", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { "X-Cron-Secret": secret } : {}) },
    body: JSON.stringify(body),
  });
}

const FORBIDDEN_HOSTS = /openai\.com|api\.x\.com|api\.twitter\.com|twitter\.com|exp\.host|expo\.dev|functions\/v1\//i;

function assertOnlyAllowedHosts(calls: Call[]) {
  for (const call of calls) {
    assert.ok(!FORBIDDEN_HOSTS.test(call.url), `forbidden call: ${call.url}`);
    const host = new URL(call.url).host;
    assert.ok(host === "query2.finance.yahoo.com" || host === "project-ref.supabase.co", `unexpected host ${host}`);
  }
}

test("rejects callers without the cron secret before any I/O", async () => {
  const { calls, deps } = harness();
  const response = await handleRequest(request({ mode: "close" }, "wrong"), deps);
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("rejects an unknown mode", async () => {
  const { deps } = harness();
  assert.equal((await handleRequest(request({ mode: "noon" }), deps)).status, 400);
});

test("claimed close cycle: builds a valid packet and completes it once; no AI / X / push calls", async () => {
  const { calls, deps } = harness();
  const response = await handleRequest(request({ mode: "close" }), deps);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "completed");
  assert.equal(body.dataQuality, "ok");
  assert.match(body.contentHash, /^[0-9a-f]{64}$/);

  const completes = calls.filter((call) => call.url.endsWith("rpc/complete_market_report_cycle"));
  assert.equal(completes.length, 1);
  const args = completes[0].body as { p_payload: MarketDataPacket; p_claim_token: string; p_diagnostics: Record<string, string> };
  assert.equal(args.p_claim_token, "22222222-2222-4222-8222-222222222222");
  assert.deepEqual(validateMarketDataPacket(args.p_payload), []);
  assert.equal(args.p_payload.trading_date, "2026-09-16");
  assert.equal(args.p_diagnostics["yahoo:^N225"], "ok");
  assert.ok(!JSON.stringify(args.p_diagnostics).includes("service-secret"));
  assert.ok(!JSON.stringify(args.p_payload).includes("service-secret"));

  assertOnlyAllowedHosts(calls);
  const writes = calls.filter((call) => call.method !== "GET");
  assert.deepEqual(writes.map((call) => new URL(call.url).pathname), [
    "/rest/v1/rpc/claim_market_report_cycle",
    "/rest/v1/rpc/complete_market_report_cycle",
  ]);
});

test("already completed cycle is idempotent: no fetches and no writes after the claim", async () => {
  const { calls, deps } = harness({ claimOutcome: "already_completed" });
  const body = await (await handleRequest(request({ mode: "close" }), deps)).json();
  assert.equal(body.status, "skipped");
  assert.equal(body.reason, "already_completed");
  assert.ok(!calls.some((call) => call.url.includes("yahoo.com")));
  assert.ok(!calls.some((call) => call.url.endsWith("rpc/complete_market_report_cycle")));
});

test("required metric failure stores a blocked packet (cycle stays retryable)", async () => {
  const { calls, deps } = harness({ yahooFails: ["1306.T"] });
  const body = await (await handleRequest(request({ mode: "close" }), deps)).json();
  assert.equal(body.status, "blocked");
  assert.deepEqual(body.requiredMissing, ["topix_proxy_1306"]);
  assert.equal(body.diagnostics["yahoo:1306.T"], "http_503");
  assertOnlyAllowedHosts(calls);
});

test("dry run returns the packet without claiming or writing", async () => {
  const { calls, deps } = harness();
  const body = await (await handleRequest(request({ mode: "close", dry_run: true }), deps)).json();
  assert.equal(body.status, "dry_run");
  assert.deepEqual(body.issues, []);
  assert.ok(!calls.some((call) => call.url.includes("/rpc/")));
  assert.ok(calls.every((call) => call.method === "GET"));
  assertOnlyAllowedHosts(calls);
});

test("failure after the claim records fail_market_report_cycle with a code only", async () => {
  const { calls, deps } = harness({ completeStatus: 500 });
  const response = await handleRequest(request({ mode: "close" }), deps);
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(body.error, "RPC_FAILED:complete_market_report_cycle:500");
  const fails = calls.filter((call) => call.url.endsWith("rpc/fail_market_report_cycle"));
  assert.equal(fails.length, 1);
  assert.equal((fails[0].body as { p_error: string }).p_error, "RPC_FAILED:complete_market_report_cycle:500");
});

test("close before 15:30 JST and JPX holidays are skipped without claiming", async () => {
  const early = harness();
  early.deps.now = () => new Date("2026-09-16T06:00:00Z");
  assert.equal((await (await handleRequest(request({ mode: "close" }), early.deps)).json()).reason, "CLOSE_TOO_EARLY");
  assert.ok(!early.calls.some((call) => call.url.includes("/rpc/")));

  const holiday = harness();
  holiday.deps.now = () => new Date("2026-09-21T07:15:00Z");
  assert.equal((await (await handleRequest(request({ mode: "close" }), holiday.deps)).json()).reason, "NOT_TRADING_DAY");
  assert.ok(!holiday.calls.some((call) => call.url.includes("/rpc/")));
});

test("function source never references AI, X, push or other consumers", async () => {
  const directory = new URL(".", import.meta.url);
  const sources = ["index.ts", "handler.ts", "packet_builder.ts", "packet_schema.ts", "session_logic.ts", "yahoo_daily.ts", "mic_metrics.ts"];
  for (const name of sources) {
    const source = await Deno.readTextFile(new URL(name, directory));
    // Code only: comments may describe what the function does not do, and the
    // reused cron secret's env name happens to contain "PUSH_NOTIFICATIONS".
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replaceAll("SEND_PUSH_NOTIFICATIONS_CRON_SECRET", "");
    assert.ok(
      !/openai|gpt-|api\.x\.com|twitter|exp\.host|expo-server|send-push-notifications|notifications|x-test-post|x_oauth|postToX|personalized-reports|important-news-monitor/i.test(code),
      `${name} references a forbidden integration`,
    );
    assert.ok(!/from\s+["']\.\.\/(x-test-post|personalized-reports|important-news-monitor|send-push-notifications)\//.test(source), `${name} imports another function`);
  }
});
