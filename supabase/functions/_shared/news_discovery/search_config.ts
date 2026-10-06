// Observer Web Search configuration (N3 v2). Every number that shapes search volume lives here.
//
// The production authority for the daily budget is the single row of
// public.news_discovery_search_config (seeded with the same values by the migration), read inside
// news_discovery_reserve_search under a lock. These code defaults drive the in-memory budget
// (tests, local runs) and document the seed. Change both together.
//
// Independent of important-news-monitor: its breaking cadence, queries, allowed_domains, verify
// search and Luna/Sol routing are not read or changed here.
import type { Topic } from "./types.ts";

export type SearchLane = "WORLD" | "MARKET" | "ENERGY" | "JAPAN" | "TECH";
export const SEARCH_LANES_ORDER: readonly SearchLane[] = ["WORLD", "MARKET", "ENERGY", "JAPAN", "TECH"];

export type SearchReason =
  | "scheduled_rotation"
  | "trigger_market_anomaly"
  | "trigger_discovery_signal"
  | "escalation"
  | "manual";

export type SearchBudgetConfig = {
  /** Above this, only triggered / escalation / manual searches may run (no rotation). */
  daily_soft_budget: number;
  /** Absolute daily ceiling for every kind of search. */
  daily_hard_limit: number;
  /** Budget day boundary (JST). */
  day_timezone: "Asia/Tokyo";
  /** A lane's rotation search runs at most once per interval (5 lanes x every 6 h = 20/day). */
  lane_rotation_interval_minutes: number;
  max_scheduled_searches_per_run: number;
  max_trigger_searches_per_run: number;
  /** The same search_key (lane/theme/anomaly) is not searched again within this window. */
  search_key_cooldown_minutes: number;
  /** Search escalation: at most this many follow-up searches per key per day. */
  max_escalations_per_key_per_day: number;
  max_results_per_search: number;
  /** Results older than this are not asked for. */
  recency_hours: number;
  /** An anomaly is considered explained when the pool has a DIRECT signal of the lane within this window. */
  anomaly_explained_window_minutes: number;
};

export const SEARCH_BUDGET_DEFAULTS: SearchBudgetConfig = {
  daily_soft_budget: 30,
  daily_hard_limit: 48,
  day_timezone: "Asia/Tokyo",
  lane_rotation_interval_minutes: 360,
  max_scheduled_searches_per_run: 1,
  max_trigger_searches_per_run: 2,
  search_key_cooldown_minutes: 180,
  max_escalations_per_key_per_day: 1,
  max_results_per_search: 8,
  recency_hours: 6,
  anomaly_explained_window_minutes: 180,
};

export type SearchProviderConfig = {
  model: string;
  search_context_size: "low" | "medium" | "high";
  max_output_tokens: number;
  timeout_ms: number;
};

/**
 * Observer's own provider settings. Not shared with important-news-monitor (whose model choice
 * and routing are unchanged). Model is config, not a code constant elsewhere.
 */
export const SEARCH_PROVIDER_DEFAULTS: SearchProviderConfig = {
  model: "gpt-5.6-luna",
  search_context_size: "low",
  max_output_tokens: 1500,
  timeout_ms: 60_000,
};

export type LaneDefinition = {
  lane: SearchLane;
  topics: readonly Topic[];
  /** Broad query: many stories per search, never one company per search. */
  query: string;
  /** Used once for an escalation when the first search found nothing useful. */
  fallback_query: string;
};

export const SEARCH_LANES: Readonly<Record<SearchLane, LaneDefinition>> = {
  WORLD: {
    lane: "WORLD",
    topics: ["geopolitics", "war", "sanctions"],
    query: "latest major world news: war, military strikes, missile launches, terrorism, coups, sanctions, strait closures, international crises",
    fallback_query: "breaking international crisis news last few hours",
  },
  MARKET: {
    lane: "MARKET",
    topics: ["monetary_policy", "rates", "fx", "macro_data"],
    query: "latest market-moving news: stock market selloff or rally, central bank surprise, bond yields, currency moves, commodities",
    fallback_query: "why are markets moving today stocks yields dollar yen",
  },
  ENERGY: {
    lane: "ENERGY",
    topics: ["oil", "energy"],
    query: "latest oil, LNG and energy supply news: OPEC, Middle East supply, refinery outages, tanker and shipping disruption",
    fallback_query: "oil price move reason today supply disruption",
  },
  JAPAN: {
    lane: "JAPAN",
    topics: ["regulation", "recall", "cyber", "supply_chain", "lawsuit", "mna", "product"],
    query: "日本企業 最新ニュース 工場火災 生産停止 リコール システム障害 サイバー攻撃 不正 行政処分 提携 新製品",
    fallback_query: "Japan listed company incident news today factory halt recall cyberattack",
  },
  TECH: {
    lane: "TECH",
    topics: ["semiconductor", "ai", "cyber"],
    query: "latest semiconductor and AI industry news: chipmakers, export controls, data centers, memory prices, major tech outages",
    fallback_query: "semiconductor stocks move reason today",
  },
};

/** Topics whose appearance in a discovery-only signal may trigger one search (radar confirmation). */
export const TRIGGER_TOPICS: readonly Topic[] = ["war", "sanctions", "disaster", "cyber", "supply_chain", "recall"];

export const TOPIC_TO_LANE: Partial<Record<Topic, SearchLane>> = {
  war: "WORLD",
  sanctions: "WORLD",
  geopolitics: "WORLD",
  disaster: "WORLD",
  oil: "ENERGY",
  energy: "ENERGY",
  cyber: "TECH",
  semiconductor: "TECH",
  ai: "TECH",
  supply_chain: "JAPAN",
  recall: "JAPAN",
};

/** Market-anomaly trigger: instrument -> lanes to search when the pool cannot explain the move. */
export const ANOMALY_INSTRUMENT_LANES: Readonly<Record<string, readonly SearchLane[]>> = {
  WTI: ["ENERGY"],
  BRENT: ["ENERGY"],
  NATURAL_GAS: ["ENERGY"],
  GOLD: ["MARKET", "WORLD"],
  VIX: ["MARKET", "WORLD"],
  USDJPY: ["MARKET"],
  US10Y: ["MARKET"],
  NIKKEI_FUTURES: ["MARKET", "JAPAN"],
  SOX: ["TECH"],
  COPPER: ["MARKET"],
};
