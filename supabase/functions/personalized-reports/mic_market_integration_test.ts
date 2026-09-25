import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPacket,
  buildSnapshot,
  priceFactFromSharedMetric,
  reportDraftRequestBody,
  reportFactRequestBody,
  REPORT_FACT_INSTRUCTIONS,
  type ReportBody,
  type SharedMarketInput,
} from "./report_logic.ts";
import { MIC_MARKET_FACT_INSTRUCTIONS, MIC_MARKET_INSTRUCTIONS, toMicDomainState, toMicPacketEntries } from "./mic_market_context.ts";
import type { AppMarketSection } from "../_shared/market_report_packet.ts";

const SECTION: AppMarketSection = {
  report_packet_id: "r1", report_content_hash: "b".repeat(64), market_direction: "up",
  headline_ja: "日経平均は64,136.25で小幅高", market_summary_ja: "日経平均は+0.33%でした。",
  major_moves: [], claims: [{ text_ja: "日経平均は+0.33%でした。", claim_type: "observation", scope: "today" }],
  key_news: [], next_watch_ja: ["今夜の米国株"], risks_ja: [], data_gaps_ja: [],
};
const SHARED: SharedMarketInput = {
  direction: "up", headlineJa: SECTION.headline_ja, summaryJa: SECTION.market_summary_ja,
  claims: SECTION.claims, nextWatchJa: SECTION.next_watch_ja, section: SECTION,
};
const NIKKEI = { key: "nikkei225", value: 64136.25, previous_close: 63923, change: 213.25, change_pct: 0.33, session_date: "2026-09-17", freshness: "fresh" };

function snapshot() {
  return buildSnapshot({
    reportType: "close", tradingDate: "2026-09-17",
    tracked: [{
      trackedStockId: "t1", tickerCode: "4751", companyName: "サイバーエージェント", sector: "サービス業",
      trackingType: "holding", quantity: 100, averagePrice: 1000, positionType: "cash", side: "long",
    }],
    prices: new Map([["4751", { bars: [{ date: "2026-09-16", close: 1100 }, { date: "2026-09-17", close: 1120 }], marketTimeIso: "2026-09-17T06:30:00.000Z" }]]),
    indices: [{ label: "日経平均", series: null, price: priceFactFromSharedMetric(NIKKEI) }],
    news: [],
  });
}

const micEntries = toMicPacketEntries([
  toMicDomainState({
    domain: "rates", narrative: "米金利は前日から小幅な動きにとどまりました。",
    bullish_factors: ["インフレ鈍化観測"], bearish_factors: [], key_risks: ["米雇用統計の下振れ"],
    data_confidence: 0.9, coverage_status: "full", observation_status: "fresh",
    ai_model: "gpt-5.6-luna", ai_evaluated_at: "2026-09-17T09:00:00Z",
    as_of: "2026-09-17T09:00:00Z", source_evaluation_run_id: "run-1",
  })!,
], Date.parse("2026-09-17T10:00:00Z"));

test("mic_market reaches the packet only when passed and non-empty; the writer instructions gain MIC_MARKET_INSTRUCTIONS only then", () => {
  const withMic = buildPacket(snapshot(), [], null, micEntries) as Record<string, unknown>;
  assert.deepEqual(withMic.mic_market, micEntries);
  const instructions = String(reportDraftRequestBody("close", withMic).instructions);
  assert.ok(instructions.includes(MIC_MARKET_INSTRUCTIONS));
  assert.ok(String(reportDraftRequestBody("morning", withMic).instructions).includes(MIC_MARKET_INSTRUCTIONS));

  const withoutMic = buildPacket(snapshot(), [], null, []) as Record<string, unknown>;
  assert.equal("mic_market" in withoutMic, false, "an empty MIC array must not add the key at all");
  assert.ok(!String(reportDraftRequestBody("close", withoutMic).instructions).includes(MIC_MARKET_INSTRUCTIONS));

  const legacy = buildPacket(snapshot(), []) as Record<string, unknown>;
  assert.equal("mic_market" in legacy, false, "the pre-existing 3-arg call site is untouched (fallback)");
});

test("each user packet gets independent MIC arrays; mutating one packet cannot change the shared entries or another packet", () => {
  const first = buildPacket(snapshot(), [], null, micEntries) as { mic_market: Array<{ bullish_points: string[] }> };
  const second = buildPacket(snapshot(), [], null, micEntries) as { mic_market: Array<{ bullish_points: string[] }> };
  first.mic_market[0].bullish_points.push("user-specific mutation");
  assert.deepEqual(second.mic_market[0].bullish_points, ["インフレ鈍化観測"]);
  assert.deepEqual(micEntries[0].bullish_points, ["インフレ鈍化観測"]);
});

test("mic_market and shared_market can both be present, independently, and neither disables the other's instructions", () => {
  const packet = buildPacket(snapshot(), [], SHARED, micEntries) as Record<string, unknown>;
  assert.ok("shared_market" in packet && "mic_market" in packet);
  const instructions = String(reportDraftRequestBody("close", packet).instructions);
  assert.ok(instructions.includes("shared_market と矛盾する方向"), "shared_market instructions still present");
  assert.ok(instructions.includes(MIC_MARKET_INSTRUCTIONS), "mic_market instructions also present");
});

test("mic_market instructions explicitly forbid verbatim pasting, require inference-only phrasing, and defer to shared_market on conflict", () => {
  assert.ok(MIC_MARKET_INSTRUCTIONS.includes("そのまま書き写したり"));
  assert.ok(MIC_MARKET_INSTRUCTIONS.includes("fact_ja"));
  assert.ok(MIC_MARKET_INSTRUCTIONS.includes("低"));
  assert.ok(MIC_MARKET_INSTRUCTIONS.includes("shared_market を優先"));
  assert.ok(MIC_MARKET_INSTRUCTIONS.includes("narrative_freshness が stale または unknown"));
  assert.ok(MIC_MARKET_INSTRUCTIONS.includes("observation_status が stale または unknown"));
  assert.ok(MIC_MARKET_INSTRUCTIONS.includes("coverage_status が unavailable"));
});

test("the Fact-check prompt gains MIC_MARKET_FACT_INSTRUCTIONS only when the packet carries mic_market, and REPORT_FACT_INSTRUCTIONS itself is untouched", () => {
  const body: ReportBody = {
    title_ja: "t", summary_ja: "s", tone: "neutral", overview_ja: "o",
    holding_impacts: [], morning_review_ja: "", watch_notes: [], risk_notes_ja: [], checkpoints_ja: ["c"],
  };
  const withMic = buildPacket(snapshot(), [], null, micEntries);
  const withoutMic = buildPacket(snapshot(), [], null, []);
  assert.equal(String(reportFactRequestBody(withMic, body).instructions).includes(MIC_MARKET_FACT_INSTRUCTIONS), true);
  assert.equal(String(reportFactRequestBody(withoutMic, body).instructions), REPORT_FACT_INSTRUCTIONS);
  assert.equal(String(reportFactRequestBody(withoutMic, body).instructions).includes(MIC_MARKET_FACT_INSTRUCTIONS), false);
});

test("mic_market entries carry no numbers the Fact-checker's existing 'no number outside packet' rule wouldn't already cover", () => {
  // The packet-wide rule ("packetに無い数字...は passed を false") already applies to
  // whatever mic_market contains, since it is now part of packet -- no separate
  // numeric-grounding rule is needed for MIC content specifically.
  for (const entry of micEntries) {
    assert.equal(typeof entry.confidence, "string");
    assert.equal(/^[0-9]+$/.test(entry.confidence), false);
  }
});
