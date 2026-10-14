// TOPIX index candidate (2026-10-14, F2 Phase 2 follow-up). Offline only: every Yahoo response here is a hand-made
// fixture in the shape of the existing ^N225 chart responses. Neither "^TOPX" nor "998405.T" has been checked against a
// live response, so these tests pin what the code accepts, not what Yahoo returns.
import assert from "node:assert/strict";
import test from "node:test";
import { type Deps, handleRequest, TOPIX_SOURCE_ENV, topixSource } from "./handler.ts";
import { buildMarketDataPacket, type PacketInputs, packetContentHash } from "./packet_builder.ts";
import {
  type MarketDataPacket,
  METRIC_SPECS,
  specsFor,
  TOPIX_INDEX_LABEL,
  TOPIX_PROXY_LABEL,
  validateMarketDataPacket,
} from "./packet_schema.ts";
import { yahooDailyUrl } from "./yahoo_daily.ts";
import { chart, CLOSE_0916, JPX_HOLIDAYS, jpBar, MIC_ROWS, MIC_THRESHOLDS, NYSE_HOLIDAYS } from "./test_fixtures.ts";

const FRESH_MIC = MIC_ROWS.map((row) => row.metric_key.startsWith("JGB") ? { ...row, observed_date: "2026-09-15" } : row);
const TOPIX_BARS = [
  jpBar("2026-09-11", 2890.12), jpBar("2026-09-14", 2875.4), jpBar("2026-09-15", 2870.15), jpBar("2026-09-16", 2885.03),
];
const topixChart = (overrides: Partial<Parameters<typeof chart>[0]> = {}) =>
  chart({
    symbol: "^TOPX", currency: "JPY", timezone: "Asia/Tokyo", instrumentType: "INDEX",
    regularMarketTime: "2026-09-16T06:45:00Z", bars: TOPIX_BARS, ...overrides,
  });

type Result = { ok: true; payload: unknown } | { ok: false };

function inputs(topix: Result | null, overrides: Partial<PacketInputs> = {}): PacketInputs {
  const base: Record<string, Result> = {
    "^N225": { ok: true, payload: CLOSE_0916.n225 },
    "1306.T": { ok: true, payload: CLOSE_0916.etf1306 },
    "^DJI": { ok: true, payload: CLOSE_0916.us("^DJI") },
    "^GSPC": { ok: true, payload: CLOSE_0916.us("^GSPC") },
    "^IXIC": { ok: true, payload: CLOSE_0916.us("^IXIC") },
    "^SOX": { ok: true, payload: CLOSE_0916.us("^SOX") },
    ...(topix ? { "^TOPX": topix } : {}),
  };
  return {
    reportType: "close",
    tradingDate: "2026-09-16",
    asOf: new Date("2026-09-16T07:15:00Z"),
    generatedAt: new Date("2026-09-16T07:15:04Z"),
    jpxHolidays: JPX_HOLIDAYS,
    nyseHolidays: NYSE_HOLIDAYS,
    nyseCalendarLastDate: "2026-12-31",
    yahoo: new Map(Object.entries(base).map(([symbol, result]) => [symbol, { result, fetchedAt: "2026-09-16T07:15:02.000Z" }])),
    micRows: FRESH_MIC,
    micThresholds: MIC_THRESHOLDS,
    newsRows: [],
    newsWindowStart: new Date("2026-09-15T06:30:00Z"),
    topixSymbol: topix ? "^TOPX" : null,
    ...overrides,
  };
}

const metric = (packet: MarketDataPacket, key: string) => packet.metrics.find((item) => item.key === key);

test("switch: only the two exact candidate values turn TOPIX on; anything else is off", () => {
  for (const raw of [undefined, "", "off", " off "]) assert.deepEqual(topixSource(raw), { symbol: null, diagnostic: "off" });
  assert.deepEqual(topixSource("yahoo:^TOPX"), { symbol: "^TOPX", diagnostic: "yahoo:^TOPX" });
  assert.deepEqual(topixSource("yahoo:998405.T"), { symbol: "998405.T", diagnostic: "yahoo:998405.T" });
  // ^TPX once came back as a US options instrument; 1306.T is the ETF. Neither is a TOPIX source.
  for (const raw of ["yahoo:^TPX", "yahoo:1306.T", "^TOPX", "on", "true"]) {
    assert.deepEqual(topixSource(raw), { symbol: null, diagnostic: "unknown_value_off" });
  }
});

test("off: the catalogue and the packet are exactly as before (no topix metric, same content hash)", async () => {
  assert.deepEqual(specsFor("close").map((spec) => spec.key), METRIC_SPECS.map((spec) => spec.key));
  const { topixSymbol: _omit, ...withoutField } = inputs(null);
  const before = buildMarketDataPacket(withoutField);
  const off = buildMarketDataPacket(inputs(null));
  assert.equal(metric(off, "topix"), undefined);
  assert.equal(await packetContentHash(off), await packetContentHash(before));
  assert.deepEqual(off, before);
});

test("on: a JPY index on Tokyo time becomes the topix metric — index points, its own previous close, change and %", () => {
  const packet = buildMarketDataPacket(inputs({ ok: true, payload: topixChart() }));
  assert.deepEqual(validateMarketDataPacket(packet), []);
  const topix = metric(packet, "topix")!;
  assert.deepEqual(
    {
      label: topix.label, kind: topix.kind, unit: topix.unit, value: topix.value, previous_close: topix.previous_close,
      change: topix.change, change_pct: topix.change_pct, session_date: topix.session_date, freshness: topix.freshness,
      is_proxy: topix.is_proxy, proxy_for: topix.proxy_for, required: topix.required, provider: topix.provider,
      source_url: topix.source_url, observed_at: topix.observed_at,
    },
    {
      label: TOPIX_INDEX_LABEL, kind: "index", unit: "index_points", value: 2885.03, previous_close: 2870.15,
      change: 14.88, change_pct: 0.52, session_date: "2026-09-16", freshness: "fresh",
      is_proxy: false, proxy_for: null, required: false, provider: "yahoo_chart",
      source_url: yahooDailyUrl("^TOPX"), observed_at: "2026-09-16T06:45:00.000Z",
    },
  );
  // Same session as the Nikkei 225; the ETF stays a separate, labelled proxy.
  assert.equal(topix.session_date, metric(packet, "nikkei225")!.session_date);
  assert.equal(metric(packet, "topix_proxy_1306")!.label, TOPIX_PROXY_LABEL);
  assert.equal(metric(packet, "topix_proxy_1306")!.value, 423.9);
  assert.deepEqual(packet.data_quality.proxies, ["topix_proxy_1306"]);
  assert.equal(packet.data_quality.status, "ok");
  // Right after the Tokyo metrics.
  assert.deepEqual(packet.metrics.slice(0, 3).map((item) => item.key), ["nikkei225", "topix_proxy_1306", "topix"]);
});

test("never 1306: the ETF's response (or any non-index, non-JPY, non-Tokyo instrument) is identity_mismatch, not TOPIX", () => {
  const cases: Array<[string, unknown]> = [
    ["the 1306 ETF response itself", CLOSE_0916.etf1306],
    ["an ETF under the TOPIX symbol", topixChart({ instrumentType: "ETF" })],
    ["a USD instrument (the ^TPX precedent)", topixChart({ currency: "USD" })],
    ["New York time", topixChart({ timezone: "America/New_York" })],
    ["another symbol", topixChart({ symbol: "TOPIX" })],
  ];
  for (const [name, payload] of cases) {
    const packet = buildMarketDataPacket(inputs({ ok: true, payload }));
    const topix = metric(packet, "topix")!;
    assert.equal(topix.gap_reason, "identity_mismatch", name);
    assert.equal(topix.value, null, name);
    assert.equal(topix.change_pct, null, name);
    assert.deepEqual(validateMarketDataPacket(packet), [], name);
    // Optional: a missing TOPIX never blocks the report, and 1306 is untouched.
    assert.notEqual(packet.data_quality.status, "blocked", name);
    assert.deepEqual(packet.data_quality.unavailable, ["topix"], name);
    assert.equal(metric(packet, "topix_proxy_1306")!.value, 423.9, name);
  }
});

test("old or unfinished data: no bar for the session, or a session not yet closed, is a gap — never the previous close", () => {
  const stale = buildMarketDataPacket(inputs({ ok: true, payload: topixChart({ bars: TOPIX_BARS.slice(0, 3), regularMarketTime: "2026-09-15T06:45:00Z" }) }));
  assert.equal(metric(stale, "topix")!.gap_reason, "expected_session_not_available");
  assert.equal(metric(stale, "topix")!.value, null);

  const open = buildMarketDataPacket(inputs({ ok: true, payload: topixChart({ regularMarketTime: "2026-09-16T05:10:00Z" }) }, {
    asOf: new Date("2026-09-16T05:15:00Z"),
  }));
  assert.equal(metric(open, "topix")!.gap_reason, "session_not_closed");

  const failed = buildMarketDataPacket(inputs({ ok: false }));
  assert.equal(metric(failed, "topix")!.gap_reason, "fetch_failed");
  assert.equal(failed.data_quality.status, "partial");
});

test("morning: the previous Tokyo session, the same one the Nikkei 225 uses", () => {
  const packet = buildMarketDataPacket(inputs({ ok: true, payload: topixChart() }, {
    reportType: "morning", tradingDate: "2026-09-17", asOf: new Date("2026-09-16T22:50:00Z"),
    generatedAt: new Date("2026-09-16T22:50:04Z"),
  }));
  assert.equal(metric(packet, "topix")!.session_date, "2026-09-16");
  assert.equal(metric(packet, "topix")!.session_date, metric(packet, "nikkei225")!.session_date);
});

test("validator: the index label belongs to the topix key only, and the topix key is never a proxy or a yen price", () => {
  const packet = buildMarketDataPacket(inputs({ ok: true, payload: topixChart() }));
  const withMetric = (key: string, patch: Record<string, unknown>) => ({
    ...packet,
    metrics: packet.metrics.map((item) => item.key === key ? { ...item, ...patch } : item),
  }) as MarketDataPacket;
  assert.ok(validateMarketDataPacket(withMetric("topix_proxy_1306", { label: TOPIX_INDEX_LABEL })).includes("metrics.topix_proxy_1306.topix_label"));
  assert.ok(validateMarketDataPacket(withMetric("topix_proxy_1306", { label: "TOPIX" })).includes("metrics.topix_proxy_1306.topix_label"));
  assert.ok(validateMarketDataPacket(withMetric("topix", { unit: "jpy_per_unit" })).includes("metrics.topix.topix_identity"));
  assert.ok(validateMarketDataPacket(withMetric("topix", { kind: "proxy_etf" })).includes("metrics.topix.topix_identity"));
  assert.ok(validateMarketDataPacket(withMetric("topix", { label: TOPIX_PROXY_LABEL })).includes("metrics.topix.topix_identity"));
});

// ---------------------------------------------------------------------------
// Handler: the switch decides whether Yahoo is asked for TOPIX at all.
// ---------------------------------------------------------------------------

const SUPABASE = "https://project-ref.supabase.co";
const SECRET = "cron-secret-for-tests";

function harness(topixEnv: string | undefined) {
  const urls: string[] = [];
  const fetchMock: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const json = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value), { status: 200 }));
    if (url.startsWith("https://query2.finance.yahoo.com/v8/finance/chart/")) {
      const symbol = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
      if (symbol === "^N225") return json(CLOSE_0916.n225);
      if (symbol === "1306.T") return json(CLOSE_0916.etf1306);
      if (symbol === "^TOPX") return json(topixChart());
      if (symbol === "998405.T") return json(topixChart({ symbol: "998405.T" }));
      return json(CLOSE_0916.us(symbol));
    }
    const path = url.slice(`${SUPABASE}/rest/v1/`.length);
    if (path.startsWith("market_holidays")) return json([{ market: "JPX", holiday_date: "2026-09-21" }, { market: "NYSE", holiday_date: "2026-12-25" }]);
    if (path.startsWith("market_metrics")) return json(FRESH_MIC);
    if (path.startsWith("mic_metric_domain_map")) return json(MIC_THRESHOLDS);
    if (path.startsWith("important_news_candidates") || path.startsWith("market_data_packets")) return json([]);
    if (path === "rpc/claim_market_report_cycle") {
      return json([{ cycle_id: "11111111-1111-4111-8111-111111111111", claim_token: "22222222-2222-4222-8222-222222222222", attempt: 1, outcome: "claimed" }]);
    }
    if (path === "rpc/complete_market_report_cycle") return json([{ packet_id: "33333333-3333-4333-8333-333333333333", cycle_status: "completed" }]);
    throw new Error(`UNEXPECTED:${url}`);
  };
  const env: Record<string, string> = {
    SUPABASE_URL: SUPABASE,
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: "service-secret" }),
    SEND_PUSH_NOTIFICATIONS_CRON_SECRET: SECRET,
    ...(topixEnv === undefined ? {} : { [TOPIX_SOURCE_ENV]: topixEnv }),
  };
  const deps: Deps = { env: (name) => env[name], fetch: fetchMock, now: () => new Date("2026-09-16T07:15:00Z") };
  const run = async (extra: Record<string, unknown> = {}) => {
    const response = await handleRequest(new Request("https://functions.local/market-report-data-packet", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cron-Secret": SECRET },
      body: JSON.stringify({ mode: "close", dry_run: true, ...extra }),
    }), deps);
    return await response.json() as {
      issues: string[];
      diagnostics: Record<string, string>;
      packet: MarketDataPacket;
      topixProbe: { symbol: string; instrumentType: string; currency: string; timezone: string; bars: unknown[] } | null;
    };
  };
  return { urls, run, deps };
}

const yahooSymbols = (urls: string[]) =>
  urls.filter((url) => url.includes("finance.yahoo.com")).map((url) => decodeURIComponent(new URL(url).pathname.split("/").pop()!));

test("handler, switch unset: Yahoo is never asked for TOPIX and nothing new is recorded", async () => {
  const { urls, run } = harness(undefined);
  const body = await run();
  assert.deepEqual(yahooSymbols(urls).sort(), ["1306.T", "^DJI", "^GSPC", "^IXIC", "^N225", "^SOX"]);
  assert.equal(metric(body.packet, "topix"), undefined);
  assert.equal("topix_source" in body.diagnostics, false);
});

test("handler, an unknown value: stays off and says so in the diagnostics", async () => {
  const { urls, run } = harness("yahoo:^TPX");
  const body = await run();
  assert.ok(!yahooSymbols(urls).some((symbol) => /TPX|TOPX|998405/.test(symbol)));
  assert.equal(body.diagnostics.topix_source, "unknown_value_off");
  assert.equal(metric(body.packet, "topix"), undefined);
});

for (const symbol of ["^TOPX", "998405.T"] as const) {
  test(`handler, yahoo:${symbol}: one extra chart request, a valid packet with the topix metric`, async () => {
    const { urls, run } = harness(`yahoo:${symbol}`);
    const body = await run();
    assert.deepEqual(body.issues, []);
    assert.equal(yahooSymbols(urls).filter((item) => item === symbol).length, 1);
    assert.equal(body.diagnostics.topix_source, `yahoo:${symbol}`);
    assert.equal(body.diagnostics[`yahoo:${symbol}`], "ok");
    assert.equal(metric(body.packet, "topix")!.value, 2885.03);
    assert.equal(metric(body.packet, "topix")!.source_url, yahooDailyUrl(symbol));
  });
}

test("dry run: a candidate named in the request is fetched once and its identity is shown; nothing is written", async () => {
  const { urls, run } = harness(undefined);
  const body = await run({ topix_source: "yahoo:998405.T" });
  assert.equal(yahooSymbols(urls).filter((item) => item === "998405.T").length, 1);
  assert.deepEqual(
    body.topixProbe && { symbol: body.topixProbe.symbol, instrumentType: body.topixProbe.instrumentType, currency: body.topixProbe.currency, timezone: body.topixProbe.timezone, bars: body.topixProbe.bars.length },
    { symbol: "998405.T", instrumentType: "INDEX", currency: "JPY", timezone: "Asia/Tokyo", bars: 3 },
  );
  assert.equal(metric(body.packet, "topix")!.value, 2885.03);
  assert.ok(!urls.some((url) => url.includes("/rpc/")), "no claim / complete / fail");
});

test("dry run: an unknown candidate is off; without dry_run the request cannot turn TOPIX on", async () => {
  const unknown = harness(undefined);
  const body = await unknown.run({ topix_source: "yahoo:1306.T" });
  assert.equal(body.topixProbe, null);
  assert.equal(body.diagnostics.topix_source, "unknown_value_off");
  assert.ok(!yahooSymbols(unknown.urls).includes("^TOPX") && !yahooSymbols(unknown.urls).includes("998405.T"));

  const scheduled = harness(undefined);
  const response = await handleRequest(new Request("https://functions.local/market-report-data-packet", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cron-Secret": SECRET },
    body: JSON.stringify({ mode: "close", topix_source: "yahoo:^TOPX" }),
  }), scheduled.deps);
  assert.equal((await response.json()).status, "completed");
  assert.ok(yahooSymbols(scheduled.urls).includes("^N225"), "the run did fetch");
  assert.ok(!yahooSymbols(scheduled.urls).includes("^TOPX"), "a normal run reads only the Secret");
  const completed = scheduled.urls.filter((url) => url.endsWith("rpc/complete_market_report_cycle"));
  assert.equal(completed.length, 1);
});
