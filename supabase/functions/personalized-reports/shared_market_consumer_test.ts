import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPacket,
  buildSnapshot,
  localReportIssues,
  priceFactFromSharedMetric,
  reportDraftRequestBody,
  REPORT_FACT_INSTRUCTIONS,
  type ReportBody,
  type ReportOutcome,
  reportUpdate,
  type SharedMarketInput,
  sharedDirectionContradiction,
} from "./report_logic.ts";
import type { AppMarketSection } from "../_shared/market_report_packet.ts";

const SECTION: AppMarketSection = {
  report_packet_id: "r1",
  report_content_hash: "b".repeat(64),
  market_direction: "up",
  headline_ja: "日経平均は64,136.25で小幅高",
  market_summary_ja: "日経平均は+0.33%、TOPIX連動ETF（1306）は+0.83%でした。",
  major_moves: [],
  claims: [{ text_ja: "日経平均は+0.33%でした。", claim_type: "observation", scope: "today" }],
  key_news: [],
  next_watch_ja: ["今夜の米国株"],
  risks_ja: [],
  data_gaps_ja: [],
};

const SHARED: SharedMarketInput = {
  direction: "up",
  headlineJa: SECTION.headline_ja,
  summaryJa: SECTION.market_summary_ja,
  claims: SECTION.claims,
  nextWatchJa: SECTION.next_watch_ja,
  section: SECTION,
};

const NIKKEI = { key: "nikkei225", value: 64136.25, previous_close: 63923, change: 213.25, change_pct: 0.33, session_date: "2026-09-17", freshness: "fresh" };
const ETF = { key: "topix_proxy_1306", value: 427.4, previous_close: 423.9, change: 3.5, change_pct: 0.83, session_date: "2026-09-17", freshness: "fresh" };

function snapshot() {
  return buildSnapshot({
    reportType: "close",
    tradingDate: "2026-09-17",
    tracked: [{
      trackedStockId: "t1", tickerCode: "4751", companyName: "サイバーエージェント", sector: "サービス業",
      trackingType: "holding", quantity: 100, averagePrice: 1000, positionType: "cash", side: "long",
    }],
    prices: new Map([["4751", { bars: [{ date: "2026-09-16", close: 1100 }, { date: "2026-09-17", close: 1120 }], marketTimeIso: "2026-09-17T06:30:00.000Z" }]]),
    indices: [
      { label: "日経平均", series: null, price: priceFactFromSharedMetric(NIKKEI) },
      { label: "TOPIX連動ETF（1306）", series: null, price: priceFactFromSharedMetric(ETF) },
    ],
    news: [],
  });
}

test("index values come from the shared market_data_packet, not a separate Yahoo fetch", () => {
  const snap = snapshot();
  assert.deepEqual(snap.indices.map((index) => [index.label, index.price.close, index.price.changePercent]), [
    ["日経平均", 64136.25, 0.33],
    ["TOPIX連動ETF（1306）", 427.4, 0.83],
  ]);
  assert.equal(snap.totals.topix_change_percent, 0.83);
  assert.equal(priceFactFromSharedMetric({ ...NIKKEI, freshness: "stale" }).status, "unavailable");
  assert.equal(priceFactFromSharedMetric(undefined).status, "unavailable");
});

test("the shared analysis is passed as read-only context with its own instructions", () => {
  const packet = buildPacket(snapshot(), [], SHARED) as Record<string, unknown>;
  assert.deepEqual(packet.shared_market, {
    direction: "上昇",
    headline: SECTION.headline_ja,
    summary: SECTION.market_summary_ja,
    points: ["日経平均は+0.33%でした。"],
    next_watch: ["今夜の米国株"],
    tailwind_themes: [],
    headwind_themes: [],
    cross_asset: [],
  });
  const instructions = String(reportDraftRequestBody("close", packet).instructions);
  assert.ok(instructions.includes("shared_market と矛盾する方向"));
  assert.ok(REPORT_FACT_INSTRUCTIONS.includes("shared_market"));
  // Without the gate the packet and prompt are exactly as before.
  const legacy = buildPacket(snapshot(), []) as Record<string, unknown>;
  assert.equal("shared_market" in legacy, false);
  assert.ok(!String(reportDraftRequestBody("close", legacy).instructions).includes("shared_market"));
});

test("portfolio text cannot contradict the shared market direction", () => {
  const packet = buildPacket(snapshot(), [], SHARED);
  assert.equal(sharedDirectionContradiction(["日経平均は下落しました。"], packet), "SAID_DOWN");
  assert.equal(sharedDirectionContradiction(["保有銘柄は下落しました。"], packet), null);
  assert.equal(sharedDirectionContradiction(["日経平均は上昇しました。"], packet), null);
  const body: ReportBody = {
    title_ja: "今日のポート", summary_ja: "保有は上昇しました。", tone: "positive",
    overview_ja: "市場全体が下落するなか、保有銘柄は上昇しました。",
    holding_impacts: [{
      ticker_code: "4751", stance: "no_clear_material", basis: [],
      fact_ja: "サイバーエージェントは上昇しました。", inference_ja: "", watch_ja: "",
    }],
    morning_review_ja: "",
    watch_notes: [], risk_notes_ja: [], checkpoints_ja: ["明日の値動き"],
  };
  assert.ok(localReportIssues(body, snapshot(), packet).includes("CONTRADICTS_SHARED_MARKET:SAID_DOWN"));
});

test("the stored body carries the shared market section verbatim; legacy body unchanged", () => {
  const outcome: ReportOutcome = {
    status: "passed",
    body: {
      title_ja: "t", summary_ja: "s", tone: "neutral", overview_ja: "o",
      holding_impacts: [], morning_review_ja: "", watch_notes: [], risk_notes_ja: [], checkpoints_ja: ["c"],
    },
    issues: [], error: null, model: "gpt-6-luna", calls: 2, inputTokens: 1, outputTokens: 1, estimatedCost: 0,
  };
  const now = new Date("2026-09-17T08:15:30Z");
  const shared = reportUpdate(outcome, snapshot(), {}, now, SECTION);
  assert.deepEqual((shared.body as { market_section: AppMarketSection }).market_section, SECTION);
  const legacy = reportUpdate(outcome, snapshot(), {}, now);
  assert.equal("market_section" in (legacy.body as Record<string, unknown>), false);
});
