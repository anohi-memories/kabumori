import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchJpxCloseMetrics,
  fetchYahooJpxCloseMetric,
  YAHOO_NIKKEI_CLOSE_URL,
} from "./close_report_data_logic.ts";

function response(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 503, headers: { "content-type": "application/json" } });
}

function chart(timestamp: number, close: number, previous = 38_000, meta: Record<string, unknown> = {}): unknown {
  return { chart: { result: [{ meta: { chartPreviousClose: previous, ...meta }, timestamp: [timestamp], indicators: { quote: [{ close: [close] }] } }] } };
}

const reference = "2026-09-10T08:00:00.000Z"; // 17:00 JST

test("direct close source uses the query2 structured chart with a multi-day window", () => {
  assert.match(YAHOO_NIKKEI_CLOSE_URL, /^https:\/\/query2\.finance\.yahoo\.com\/v8\/finance\/chart\//u);
  assert.match(YAHOO_NIKKEI_CLOSE_URL, /range=5d&interval=1m/u);
});

test("same-day Nikkei close at 15:30 JST is accepted from the direct chart source", async () => {
  const metric = await fetchYahooJpxCloseMetric(
    YAHOO_NIKKEI_CLOSE_URL, "日経平均", reference,
    async () => response(chart(Date.parse("2026-09-10T06:30:00.000Z") / 1000, 42_123.45)),
  );
  assert.equal(metric?.value, "42123.45");
  assert.equal(metric?.previous_close, "38000");
  assert.equal(metric?.timestamp, "2026-09-10T06:30:00.000Z");
});

test("TOPIX is unavailable in the production path and only Nikkei is fetched", async () => {
  const calls: string[] = [];
  const metrics = await fetchJpxCloseMetrics(reference, async (url) => {
    calls.push(url);
    const value = url.includes("N225") ? 3_200 : 3_050;
    return response(chart(Date.parse("2026-09-10T06:30:00.000Z") / 1000, value));
  });
  assert.equal(metrics.nikkei?.value, "3200");
  assert.equal(metrics.topix, null);
  assert.equal(calls.length, 1);
});

test("Yahoo ^TPX is rejected instead of being labeled as Japanese TOPIX", async () => {
  let calls = 0;
  const metric = await fetchYahooJpxCloseMetric(
    "https://query2.finance.yahoo.com/v8/finance/chart/%5ETPX?range=5d&interval=1m&events=history",
    "TOPIX",
    reference,
    async () => {
      calls += 1;
      return response(chart(Date.parse("2026-09-10T06:30:00.000Z") / 1000, 3_050));
    },
  );
  assert.equal(metric, null);
  assert.equal(calls, 0);
});

test("same-day 15:30 TOPIX is accepted only with matching JPX/Japanese metadata", async () => {
  const metric = await fetchYahooJpxCloseMetric(
    "https://example.test/topix-structured",
    "TOPIX",
    reference,
    async () => response(chart(
      Date.parse("2026-09-10T06:30:00.000Z") / 1000,
      3_050,
      3_020,
      { symbol: "TOPIX", exchangeName: "JPX", currency: "JPY" },
    )),
  );
  assert.equal(metric?.value, "3050");
  assert.equal(metric?.timestamp, "2026-09-10T06:30:00.000Z");
});

test("TOPIX source metadata mismatch is rejected", async () => {
  const metric = await fetchYahooJpxCloseMetric(
    "https://example.test/topix-structured",
    "TOPIX",
    reference,
    async () => response(chart(
      Date.parse("2026-09-10T06:30:00.000Z") / 1000,
      105.18,
      105.18,
      { symbol: "^TPX", exchangeName: "CBO", fullExchangeName: "OPRA Indices", currency: "USD" },
    )),
  );
  assert.equal(metric, null);
});

test("TOPIX unavailable is fail-safe and does not block Nikkei acquisition", async () => {
  const metrics = await fetchJpxCloseMetrics(reference, async (url) => {
    assert.match(url, /%5EN225/u);
    return response(chart(Date.parse("2026-09-10T06:30:00.000Z") / 1000, 42_123.45));
  });
  assert.equal(metrics.nikkei?.value, "42123.45");
  assert.equal(metrics.topix, null);
});

test("15:29 JST is rejected as intraday", async () => {
  const beforeClose = await fetchYahooJpxCloseMetric(
    YAHOO_NIKKEI_CLOSE_URL, "日経平均", reference,
    async () => response(chart(Date.parse("2026-09-10T06:29:00.000Z") / 1000, 42_000)),
  );
  assert.equal(beforeClose, null);
});

test("15:15 JST is rejected as intraday", async () => {
  const beforeClose = await fetchYahooJpxCloseMetric(
    YAHOO_NIKKEI_CLOSE_URL, "日経平均", reference,
    async () => response(chart(Date.parse("2026-09-10T06:15:00.000Z") / 1000, 42_000)),
  );
  assert.equal(beforeClose, null);
});

test("15:00 JST is rejected as intraday", async () => {
  const beforeClose = await fetchYahooJpxCloseMetric(
    YAHOO_NIKKEI_CLOSE_URL, "日経平均", reference,
    async () => response(chart(Date.parse("2026-09-10T06:00:00.000Z") / 1000, 42_000)),
  );
  assert.equal(beforeClose, null);
});

test("front-session, previous-day, unknown, and failed responses are rejected", async () => {
  const front = await fetchYahooJpxCloseMetric(
    YAHOO_NIKKEI_CLOSE_URL, "日経平均", reference,
    async () => response(chart(Date.parse("2026-09-10T02:00:00.000Z") / 1000, 42_000)),
  );
  const previous = await fetchYahooJpxCloseMetric(
    YAHOO_NIKKEI_CLOSE_URL, "日経平均", reference,
    async () => response(chart(Date.parse("2026-09-09T06:30:00.000Z") / 1000, 42_000)),
  );
  const unknown = await fetchYahooJpxCloseMetric(
    YAHOO_NIKKEI_CLOSE_URL, "日経平均", reference,
    async () => response({ chart: { result: [{ timestamp: [Date.parse("2026-09-10T06:30:00.000Z") / 1000], indicators: { quote: [{ close: [null] }] } }] } }),
  );
  const failed = await fetchYahooJpxCloseMetric(
    YAHOO_NIKKEI_CLOSE_URL, "日経平均", reference,
    async () => response({}, false),
  );
  assert.equal(front, null);
  assert.equal(previous, null);
  assert.equal(unknown, null);
  assert.equal(failed, null);
});
