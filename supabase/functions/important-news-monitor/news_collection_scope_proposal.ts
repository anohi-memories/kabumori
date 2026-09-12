// Proposed widening of the COLLECTION stage, UNWIRED.
//
// Today's collection reaches the world through 4 web_search topics (2 searches
// per 20-minute cycle: 1 fixed + 1 rotating) and 5 official RSS feeds. Nothing
// in either set covers North Korean missile launches, J-alert-grade events,
// earthquakes/tsunami, shipping chokepoints on their own, market-infrastructure
// failures, or Japanese-language wires — which is why the 2026-09-12 missile
// launch never became a candidate row.
//
// This file is data + validation only: it declares the proposed topics/feeds and
// the target scope they must cover, and its tests prove the coverage. It is NOT
// imported by index.ts, adds no source to the live lane, and changes no cost
// ceiling. Wiring it (and any rotation/quota change) is a separate,
// K1-approved step — see docs/news-coverage/REDESIGN.md.

import type { ImportantNewsCategory } from "./news_candidate_logic.ts";
import type { CoverageCategory } from "./news_coverage_logic.ts";

export type ProposedQuery = {
  key: string;
  searchQuery: string;
  defaultCategory: ImportantNewsCategory;
  defaultTopicKey: string;
  coverage: CoverageCategory[];
  /** A fixed slot runs every cycle; rotating topics share the remaining slots. */
  slot: "fixed" | "rotating";
  requireEventTimestamp?: boolean;
};

/** The four topics already live, restated so the proposal is a superset. */
export const EXISTING_QUERY_KEYS = [
  "critical_market_events",
  "trump_tariff_semiconductor",
  "war_geopolitics_taiwan",
  "bank_china_stimulus",
] as const;

export const PROPOSED_QUERIES: ProposedQuery[] = [
  {
    key: "japan_security_emergency",
    searchQuery:
      "North Korea missile launch ballistic projectile Japan J-Alert EEZ Taiwan strait incursion Japan defense ministry breaking today",
    defaultCategory: "major_security_incident",
    defaultTopicKey: "breaking:japan_security",
    coverage: ["geopolitics"],
    // A fixed slot: a launch is only market-relevant within the hour, so it must
    // not wait for a rotation.
    slot: "fixed",
    requireEventTimestamp: true,
  },
  {
    key: "disaster_infrastructure",
    searchQuery:
      "major earthquake tsunami warning eruption typhoon evacuation Japan power grid blackout refinery shutdown plant halt breaking today",
    defaultCategory: "major_security_incident",
    defaultTopicKey: "breaking:disaster",
    coverage: ["disaster", "japan_market"],
    slot: "fixed",
    requireEventTimestamp: true,
  },
  {
    key: "shipping_chokepoints",
    searchQuery:
      "Strait of Hormuz Suez Red Sea Bab el-Mandeb Panama Canal closure blockade tanker attack seizure shipping rates container freight disruption today",
    defaultCategory: "geopolitics",
    defaultTopicKey: "breaking:chokepoint",
    coverage: ["shipping_logistics", "oil_energy"],
    slot: "rotating",
  },
  {
    key: "financial_system_infrastructure",
    searchQuery:
      "stock exchange outage trading halt clearing settlement failure bank run deposit insurance systemic risk cyber attack on financial institution today",
    defaultCategory: "major_security_incident",
    defaultTopicKey: "breaking:financial_system",
    coverage: ["financial_system"],
    slot: "rotating",
  },
  {
    key: "commodities_energy_supply",
    searchQuery:
      "OPEC production cut crude oil supply disruption LNG gold copper iron ore rare earth export restriction price surge today",
    defaultCategory: "other_market_moving",
    defaultTopicKey: "breaking:commodities",
    coverage: ["commodities", "oil_energy"],
    slot: "rotating",
  },
  {
    key: "us_market_session",
    searchQuery:
      "Nasdaq S&P 500 Dow selloff rally semiconductor SOX index Nvidia AI data center capex guidance US Treasury yields today",
    defaultCategory: "other_market_moving",
    defaultTopicKey: "breaking:us_session",
    coverage: ["us_market", "semiconductors", "ai_tech", "rates"],
    slot: "rotating",
  },
  {
    key: "japan_market_session",
    searchQuery:
      "Nikkei 225 Topix Tokyo stocks yen USDJPY Bank of Japan policy Japanese government economic package today",
    defaultCategory: "other_market_moving",
    defaultTopicKey: "breaking:japan_session",
    coverage: ["japan_market", "fx", "monetary_policy"],
    slot: "rotating",
  },
];

export type ProposedFeed = {
  key: string;
  feedUrl: string;
  host: string;
  defaultCategory: ImportantNewsCategory;
  defaultTopicKey: string;
  coverage: CoverageCategory[];
  /** Why this feed is trustworthy as a primary source. */
  basis: string;
};

/**
 * Official / primary feeds to add to the market_macro lane. Every host is an
 * institution publishing its own facts; none is an aggregator or a blog. Each
 * URL must still be probed for a working feed before wiring (a separate step —
 * this file does not fetch anything).
 */
export const PROPOSED_FEEDS: ProposedFeed[] = [
  {
    key: "jma_quake_tsunami",
    feedUrl: "https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml",
    host: "jma.go.jp",
    defaultCategory: "major_security_incident",
    defaultTopicKey: "disaster:jma_eqvol",
    coverage: ["disaster"],
    basis: "気象庁の地震・火山情報の公式配信（一次情報）",
  },
  {
    key: "jma_weather_warnings",
    feedUrl: "https://www.data.jma.go.jp/developer/xml/feed/extra.xml",
    host: "jma.go.jp",
    defaultCategory: "major_security_incident",
    defaultTopicKey: "disaster:jma_extra",
    coverage: ["disaster"],
    basis: "気象庁の気象警報・特別警報の公式配信",
  },
  {
    key: "mod_japan",
    feedUrl: "https://www.mod.go.jp/j/rss/press.xml",
    host: "mod.go.jp",
    defaultCategory: "major_security_incident",
    defaultTopicKey: "security:mod",
    coverage: ["geopolitics"],
    basis: "防衛省の公表資料（弾道ミサイル発射などの公式確認）",
  },
  {
    key: "mof_japan",
    feedUrl: "https://www.mof.go.jp/rss/all.xml",
    host: "mof.go.jp",
    defaultCategory: "fx",
    defaultTopicKey: "macro:mof",
    coverage: ["fx", "rates"],
    basis: "財務省（為替介入実績・国債発行）",
  },
  {
    key: "jpx_notices",
    feedUrl: "https://www.jpx.co.jp/rss/news.xml",
    host: "jpx.co.jp",
    defaultCategory: "other_market_moving",
    defaultTopicKey: "market:jpx",
    coverage: ["japan_market", "financial_system"],
    basis: "日本取引所グループ（売買停止・システム障害・制度変更）",
  },
  {
    key: "cabinet_japan",
    feedUrl: "https://www.kantei.go.jp/jp/rss/index.rdf",
    host: "kantei.go.jp",
    defaultCategory: "us_government_policy",
    defaultTopicKey: "policy:kantei",
    coverage: ["regulation_policy", "japan_market"],
    basis: "首相官邸（緊急事態・経済対策の公式発表）",
  },
  {
    key: "treasury_us",
    feedUrl: "https://home.treasury.gov/system/files/126/press_releases.xml",
    host: "treasury.gov",
    defaultCategory: "us_government_policy",
    defaultTopicKey: "policy:treasury",
    coverage: ["regulation_policy", "rates", "fx"],
    basis: "米財務省（制裁・国債・為替報告）",
  },
  {
    key: "bis_export_controls",
    feedUrl: "https://www.bis.doc.gov/index.php/about-bis/newsroom/rss",
    host: "bis.doc.gov",
    defaultCategory: "us_government_policy",
    defaultTopicKey: "policy:export_controls",
    coverage: ["regulation_policy", "semiconductors"],
    basis: "米商務省BIS（半導体などの輸出規制）",
  },
];

/** The collection scope the product requires; the tests pin that it is covered. */
export const TARGET_COVERAGE: CoverageCategory[] = [
  "geopolitics", "disaster", "monetary_policy", "fx", "rates", "oil_energy", "commodities",
  "shipping_logistics", "semiconductors", "ai_tech", "us_market", "japan_market",
  "regulation_policy", "corporate", "earnings", "financial_system",
];

/** Categories the corporate (TDnet / company IR) lane already covers. */
export const CORPORATE_LANE_COVERAGE: CoverageCategory[] = ["corporate", "earnings"];

export function proposedCoverage(): Set<CoverageCategory> {
  const covered = new Set<CoverageCategory>(CORPORATE_LANE_COVERAGE);
  for (const query of PROPOSED_QUERIES) query.coverage.forEach((category) => covered.add(category));
  for (const feed of PROPOSED_FEEDS) feed.coverage.forEach((category) => covered.add(category));
  return covered;
}

export function missingCoverage(): CoverageCategory[] {
  const covered = proposedCoverage();
  return TARGET_COVERAGE.filter((category) => !covered.has(category));
}

/**
 * Search budget the proposal needs. Today: 2 searches per 20-minute cycle
 * (1 fixed + 1 rotating) = 6/hour. With 3 fixed topics (the existing critical
 * one plus Japan security and disaster) and 1 rotating slot the cost becomes
 * 4 per cycle = 12/hour, and every rotating topic is reached within ~100
 * minutes. Stated here so the cost decision is explicit, not implied.
 */
export function proposedSearchBudget(): {
  fixedPerCycle: number;
  rotatingPerCycle: number;
  searchesPerCycle: number;
  searchesPerHour: number;
  rotatingTopics: number;
  rotationMinutes: number;
} {
  const fixed = PROPOSED_QUERIES.filter((query) => query.slot === "fixed").length + 1; // +1: existing critical topic
  const rotatingTopics = PROPOSED_QUERIES.filter((query) => query.slot === "rotating").length
    + (EXISTING_QUERY_KEYS.length - 1);
  const rotatingPerCycle = 1;
  const cyclesPerHour = 3;
  return {
    fixedPerCycle: fixed,
    rotatingPerCycle,
    searchesPerCycle: fixed + rotatingPerCycle,
    searchesPerHour: (fixed + rotatingPerCycle) * cyclesPerHour,
    rotatingTopics,
    rotationMinutes: rotatingTopics * 20,
  };
}
