import {
  BREAKING_MARKET_QUERIES,
  type BreakingMarketQuery,
} from "./breaking_market_source_fetchers.ts";

// Generic breaking_market web search, cost-reduced (2026-10-06).
//
// Until now every hourly fetch ran 4 generic web searches (3 fixed topics + 1 rotating): ~96 a day,
// ~$1.3 a day, and in the 8 days before this change none of the 44 important/most_important breaking
// posts came from them — all came from the BBC / Al Jazeera headline-trigger lane, which is untouched and
// still runs on every hourly fetch.  What the trigger lane is weak at is Japan-specific news, so the
// generic search is cut to DAILY_BREAKING_MARKET_SEARCH_LIMIT searches a day, one per slot below, each on
// a different Japan-market area:
//
//   08:00 JST  国内の重大災害・インフラ・安全保障 (the window before it covers the early-morning launches/quakes)
//   13:00 JST  日銀・金融政策                       (policy-meeting results arrive around noon)
//   16:00 JST  日本市場の重大急変                   (afternoon session and the close)
//   23:00 JST  為替介入・財務省                     (London / New York hours, when most interventions happen)
//
// A slot becomes due at its hour and is consumed by one billed search.  The hourly fetch cron is the only
// caller, so a slot whose run was skipped or failed without cost (e.g. HTTP 429, nothing billed) is
// retried on the next fetch for up to DAILY_SLOT_CATCH_UP_MS; a search that was billed is never
// repeated.  So the ceiling is 4 billed searches a day, regardless of cron cadence.
//
// The 12-topic catalog and its rotation (selectBreakingMarketQueriesForCycle) are unchanged and not called
// from production any more; reinstating them is a one-line wiring change in index.ts.

export const DAILY_BREAKING_MARKET_SEARCH_LIMIT = 4;
export const MAX_DAILY_BREAKING_MARKET_SEARCHES_PER_FETCH = 1;
/** A slot may still run until this long after its hour (exclusive: the hours H and H+1 only). */
export const DAILY_SLOT_CATCH_UP_MS = 2 * 60 * 60 * 1000;
/** With no run history a slot runs only in the first 10 minutes of its hour (the fetch cron fires at :00). */
export const NO_HISTORY_WINDOW_MS = 10 * 60 * 1000;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Topic vocabulary is Japan-specific on purpose: the headline-trigger lane (BBC / Al Jazeera) already
// covers world news, and the generic US/geopolitics topics produced no important post in 8 days.
export const DAILY_BREAKING_MARKET_ONLY_QUERIES: BreakingMarketQuery[] = [
  {
    key: "japan_disaster_security_emergency",
    searchQuery:
      "Japan major earthquake tsunami warning volcanic eruption typhoon evacuation power grid blackout infrastructure outage North Korea ballistic missile launch J-Alert Japan EEZ Ministry of Defense breaking today",
    defaultCategory: "disaster",
    defaultTopicKey: "breaking:japan_disaster_security",
  },
  {
    key: "boj_monetary_policy",
    searchQuery:
      "Bank of Japan BOJ monetary policy meeting decision rate hike Governor Ueda press conference emergency meeting JGB bond purchase yield surge Japan interest rate today",
    defaultCategory: "boj",
    defaultTopicKey: "breaking:boj_policy",
  },
  {
    key: "fx_intervention_mof",
    searchQuery:
      "Japan Ministry of Finance yen intervention confirmed rate check verbal warning finance minister currency diplomat USDJPY sharp yen surge plunge today",
    defaultCategory: "fx",
    defaultTopicKey: "breaking:fx_intervention",
  },
];

const JAPAN_MARKET_SESSION_KEY = "japan_market_session";

export const DAILY_BREAKING_MARKET_QUERIES: BreakingMarketQuery[] = [
  ...DAILY_BREAKING_MARKET_ONLY_QUERIES,
  BREAKING_MARKET_QUERIES.find((query) => query.key === JAPAN_MARKET_SESSION_KEY) as BreakingMarketQuery,
];

export type DailyBreakingMarketSlot = { hourJst: number; key: string };

export const DAILY_BREAKING_MARKET_SLOTS: readonly DailyBreakingMarketSlot[] = [
  { hourJst: 8, key: "japan_disaster_security_emergency" },
  { hourJst: 13, key: "boj_monetary_policy" },
  { hourJst: 16, key: JAPAN_MARKET_SESSION_KEY },
  { hourJst: 23, key: "fx_intervention_mof" },
];

/** Epoch ms of today's (JST calendar day) slot start. Asia/Tokyo has no DST, so a fixed offset is exact. */
export function dailySlotStartMs(now: Date, hourJst: number): number {
  const jstDayStart = Math.floor((now.getTime() + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
  return jstDayStart + hourJst * HOUR_MS;
}

/**
 * Latest attempt per query key that consumed its slot, from important_news_monitor_runs rows shaped
 * `{ started_at, queries: diagnostics->breakingMarket->queries }`.  An attempt that failed without
 * billing anything (HTTP 429 or a 5xx answer) does not count, so the slot is retried; any attempt that
 * searched or used tokens does, and so does a failure with no HTTP status (timeout / network), which
 * may have run the search.  Malformed rows are skipped.
 */
export function dailySlotConsumedAt(rows: unknown): Map<string, number> {
  const latest = new Map<string, number>();
  if (!Array.isArray(rows)) return latest;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as { started_at?: unknown; queries?: unknown };
    const at = typeof record.started_at === "string" ? Date.parse(record.started_at) : NaN;
    if (!Number.isFinite(at) || !Array.isArray(record.queries)) continue;
    for (const item of record.queries) {
      if (typeof item !== "object" || item === null) continue;
      const attempt = item as {
        queryKey?: unknown;
        providerStatus?: unknown;
        httpStatus?: unknown;
        webSearchCallCount?: unknown;
        inputTokens?: unknown;
        outputTokens?: unknown;
      };
      if (typeof attempt.queryKey !== "string") continue;
      const billed = (typeof attempt.webSearchCallCount === "number" && attempt.webSearchCallCount > 0) ||
        (typeof attempt.inputTokens === "number" && attempt.inputTokens > 0) ||
        (typeof attempt.outputTokens === "number" && attempt.outputTokens > 0);
      // Only a failure the provider answered with a rate-limit or server error is known to be free.
      // A timeout / network error (no HTTP status) may have run the search, so it consumes the slot:
      // with a 10-minute fetch cadence a retry loop on those would otherwise repeat up to 12 times.
      const status = attempt.httpStatus;
      const knownUnbilled = typeof status === "number" && (status === 429 || (status >= 500 && status <= 599));
      if (attempt.providerStatus === "failed" && !billed && knownUnbilled) continue;
      if (at > (latest.get(attempt.queryKey) ?? Number.NEGATIVE_INFINITY)) latest.set(attempt.queryKey, at);
    }
  }
  return latest;
}

/**
 * The generic searches to run in this fetch cycle: at most one, the earliest slot that is due.
 * A slot is due from its hour until DAILY_SLOT_CATCH_UP_MS later, unless a billed attempt for its topic
 * already exists since the slot started.  Without history (first run or the history read failed) only the
 * slot's own hour counts, so a failing history read can neither skip a slot for good nor repeat one.
 */
export function selectDailyBreakingMarketQueries(
  now: Date,
  consumedAt: ReadonlyMap<string, number> | null,
  queries: readonly BreakingMarketQuery[] = DAILY_BREAKING_MARKET_QUERIES,
  slots: readonly DailyBreakingMarketSlot[] = DAILY_BREAKING_MARKET_SLOTS,
): BreakingMarketQuery[] {
  const nowMs = now.getTime();
  // Without history a slot can only run in the first NO_HISTORY_WINDOW_MS of its hour, so an unreadable
  // history cannot repeat a search on every cycle of the hour at a 10-minute fetch cadence.
  const lateness = consumedAt ? DAILY_SLOT_CATCH_UP_MS : NO_HISTORY_WINDOW_MS;
  const due = [...slots]
    .sort((a, b) => a.hourJst - b.hourJst)
    .map((slot) => ({ slot, start: dailySlotStartMs(now, slot.hourJst) }))
    .filter(({ slot, start }) => {
      if (nowMs < start || nowMs - start >= lateness) return false;
      return consumedAt === null || (consumedAt.get(slot.key) ?? Number.NEGATIVE_INFINITY) < start;
    });
  for (const { slot } of due) {
    const query = queries.find((item) => item.key === slot.key);
    if (query) return [query].slice(0, MAX_DAILY_BREAKING_MARKET_SEARCHES_PER_FETCH);
  }
  return [];
}
