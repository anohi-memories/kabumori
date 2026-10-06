// Generic breaking_market search cut from 4 searches every hour to 4 a day (2026-10-06).  In the 8 days
// before, none of the 44 important/most_important breaking posts came from the generic topic searches
// (~$1.3/day); all came from the BBC / Al Jazeera headline-trigger lane, which this change leaves alone.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DAILY_BREAKING_MARKET_QUERIES,
  DAILY_BREAKING_MARKET_SEARCH_LIMIT,
  DAILY_BREAKING_MARKET_SLOTS,
  DAILY_SLOT_CATCH_UP_MS,
  dailySlotConsumedAt,
  dailySlotStartMs,
  MAX_DAILY_BREAKING_MARKET_SEARCHES_PER_FETCH,
  selectDailyBreakingMarketQueries,
} from "./breaking_market_daily_schedule.ts";
import {
  BREAKING_MARKET_NEWS_DOMAINS,
  BREAKING_MARKET_QUERIES,
  BREAKING_MARKET_SOURCE_DOMAINS,
  breakingMarketRequestBody,
  MAX_BREAKING_MARKET_SEARCHES_PER_FETCH,
  selectBreakingMarketQueriesForCycle,
} from "./breaking_market_source_fetchers.ts";

const HOUR = 60 * 60 * 1000;
// 2026-10-07 00:00 JST
const DAY_START = Date.parse("2026-10-06T15:00:00Z");
const at = (dayOffset: number, hourJst: number, minute = 0) =>
  new Date(DAY_START + dayOffset * 24 * HOUR + hourJst * HOUR + minute * 60 * 1000);

type Row = { started_at: string; queries: unknown[] };
const billed = (queryKey: string) => ({ queryKey, providerStatus: "succeeded", webSearchCallCount: 1, inputTokens: 9000, outputTokens: 700 });
const unbilled429 = (queryKey: string) => ({ queryKey, providerStatus: "failed", httpStatus: 429, webSearchCallCount: 0, inputTokens: 0, outputTokens: 0 });

/** Runs `days` days of hourly fetches against the real selector, recording each attempt as run diagnostics. */
function simulate(
  days: number,
  attempt: (key: string, when: Date) => unknown = billed,
  useHistory = true,
  stepMinutes = 60,
) {
  const rows: Row[] = [];
  const searches: Array<{ key: string; when: Date }> = [];
  const perCycle: number[] = [];
  for (let step = 0; step < (days * 24 * 60) / stepMinutes; step += 1) {
    const when = new Date(DAY_START + step * stepMinutes * 60 * 1000 + 2000); // the cron fires a couple of seconds after the mark
    const history = useHistory ? dailySlotConsumedAt(rows) : null;
    const selected = selectDailyBreakingMarketQueries(when, history);
    perCycle.push(selected.length);
    const queries = selected.map((query) => attempt(query.key, when));
    for (const query of selected) searches.push({ key: query.key, when });
    rows.push({ started_at: when.toISOString(), queries });
  }
  return { searches, perCycle };
}

// --- the schedule ----------------------------------------------------------------------------------------

test("exactly four slots, four different topics, four different categories", () => {
  assert.equal(DAILY_BREAKING_MARKET_SLOTS.length, 4);
  assert.equal(DAILY_BREAKING_MARKET_SEARCH_LIMIT, 4);
  assert.equal(DAILY_BREAKING_MARKET_QUERIES.length, 4);
  const keys = DAILY_BREAKING_MARKET_SLOTS.map((slot) => slot.key);
  assert.equal(new Set(keys).size, 4, "no topic appears in two slots");
  const queries = keys.map((key) => DAILY_BREAKING_MARKET_QUERIES.find((query) => query.key === key));
  assert.ok(queries.every(Boolean), "every slot resolves to a query");
  assert.equal(new Set(queries.map((query) => query!.defaultCategory)).size, 4, "no category is repeated");
  assert.equal(new Set(queries.map((query) => query!.defaultTopicKey)).size, 4);
  assert.deepEqual(queries.map((query) => query!.defaultCategory).sort(), ["boj", "disaster", "fx", "other_market_moving"]);
});

test("the slots are the four Japan-specific areas, spread across the day", () => {
  assert.deepEqual(
    DAILY_BREAKING_MARKET_SLOTS.map((slot) => [slot.hourJst, slot.key]),
    [
      [8, "japan_disaster_security_emergency"],
      [13, "boj_monetary_policy"],
      [16, "japan_market_session"],
      [23, "fx_intervention_mof"],
    ],
  );
  const hours = DAILY_BREAKING_MARKET_SLOTS.map((slot) => slot.hourJst);
  for (let index = 0; index < hours.length; index += 1) {
    const gap = (hours[(index + 1) % hours.length] - hours[index] + 24) % 24;
    assert.ok(gap * HOUR >= DAILY_SLOT_CATCH_UP_MS, "a slot's catch-up window never reaches the next slot");
  }
});

test("a day of hourly fetches runs exactly four searches, one per slot, at most one per cycle", () => {
  const { searches, perCycle } = simulate(1);
  assert.equal(searches.length, 4);
  assert.ok(perCycle.every((count) => count <= MAX_DAILY_BREAKING_MARKET_SEARCHES_PER_FETCH));
  assert.deepEqual(
    searches.map((item) => [new Date(item.when.getTime() + 9 * HOUR).getUTCHours(), item.key]),
    DAILY_BREAKING_MARKET_SLOTS.map((slot) => [slot.hourJst, slot.key]),
  );
});

test("over a week every topic runs once a day — no topic is favoured", () => {
  const { searches } = simulate(7);
  assert.equal(searches.length, 28);
  for (const slot of DAILY_BREAKING_MARKET_SLOTS) {
    assert.equal(searches.filter((item) => item.key === slot.key).length, 7, slot.key);
  }
});

test("without any history (the history read failed) only each slot's own hour searches", () => {
  const { searches, perCycle } = simulate(3, billed, false);
  assert.equal(searches.length, 12);
  assert.ok(perCycle.every((count) => count <= 1));
});

test("the cron firing late or twice inside the hour cannot repeat a billed search", () => {
  const rows: Row[] = [{ started_at: at(0, 13, 0).toISOString(), queries: [billed("boj_monetary_policy")] }];
  for (const minute of [1, 20, 40, 59]) {
    assert.deepEqual(selectDailyBreakingMarketQueries(at(0, 13, minute), dailySlotConsumedAt(rows)), []);
  }
  assert.deepEqual(selectDailyBreakingMarketQueries(at(0, 14, 0), dailySlotConsumedAt(rows)), []);
});

test("off-slot hours select nothing", () => {
  for (const hour of [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 18, 19, 20, 21]) {
    assert.deepEqual(selectDailyBreakingMarketQueries(at(0, hour), new Map()), [], `${hour}:00`);
  }
});

// --- failures and catch-up ---------------------------------------------------------------------------

test("a slot that failed without billing anything (HTTP 429) is retried on the next hourly fetch", () => {
  const { searches } = simulate(1, (key, when) => {
    const hourJst = new Date(when.getTime() + 9 * HOUR).getUTCHours();
    return key === "boj_monetary_policy" && hourJst === 13 ? unbilled429(key) : billed(key);
  });
  const boj = searches.filter((item) => item.key === "boj_monetary_policy");
  assert.deepEqual(boj.map((item) => new Date(item.when.getTime() + 9 * HOUR).getUTCHours()), [13, 14]);
  assert.equal(searches.length, 5, "one free retry, still four billed searches");
});

test("an outage longer than the catch-up window loses that slot for the day instead of piling up searches", () => {
  const { searches } = simulate(1, (key) => (key === "boj_monetary_policy" ? unbilled429(key) : billed(key)));
  const boj = searches.filter((item) => item.key === "boj_monetary_policy");
  assert.deepEqual(boj.map((item) => new Date(item.when.getTime() + 9 * HOUR).getUTCHours()), [13, 14]);
  assert.equal(searches.length - boj.length, 3);
});

test("a failed attempt that did bill (search or tokens used) consumes the slot", () => {
  const rows: Row[] = [{
    started_at: at(0, 13, 0).toISOString(),
    queries: [{ queryKey: "boj_monetary_policy", providerStatus: "failed", webSearchCallCount: 1, inputTokens: 0, outputTokens: 0 }],
  }];
  assert.deepEqual(selectDailyBreakingMarketQueries(at(0, 14, 0), dailySlotConsumedAt(rows)), []);
  const tokens: Row[] = [{
    started_at: at(0, 13, 0).toISOString(),
    queries: [{ queryKey: "boj_monetary_policy", providerStatus: "failed", webSearchCallCount: 0, inputTokens: 5000, outputTokens: 0 }],
  }];
  assert.deepEqual(selectDailyBreakingMarketQueries(at(0, 14, 0), dailySlotConsumedAt(tokens)), []);
});

test("yesterday's search never counts for today's slot", () => {
  const rows: Row[] = [{ started_at: at(-1, 13, 0).toISOString(), queries: [billed("boj_monetary_policy")] }];
  const selected = selectDailyBreakingMarketQueries(at(0, 13, 0), dailySlotConsumedAt(rows));
  assert.deepEqual(selected.map((query) => query.key), ["boj_monetary_policy"]);
});

test("a skipped fetch (no run row at all) is caught up within the window", () => {
  const selected = selectDailyBreakingMarketQueries(at(0, 9, 0), new Map());
  assert.deepEqual(selected.map((query) => query.key), ["japan_disaster_security_emergency"]);
  assert.deepEqual(selectDailyBreakingMarketQueries(at(0, 10, 1), new Map()), []);
});

test("the day boundary is JST: a slot is judged against today's JST date", () => {
  assert.equal(dailySlotStartMs(new Date("2026-10-06T14:59:59Z"), 8), Date.parse("2026-10-05T23:00:00Z"));
  assert.equal(dailySlotStartMs(new Date("2026-10-06T15:00:00Z"), 8), Date.parse("2026-10-06T23:00:00Z"));
  assert.equal(dailySlotStartMs(new Date("2026-10-06T23:00:00Z"), 23), Date.parse("2026-10-07T14:00:00Z"));
});

test("malformed history rows are ignored", () => {
  assert.equal(dailySlotConsumedAt(null).size, 0);
  assert.equal(dailySlotConsumedAt({ rows: [] }).size, 0);
  assert.equal(dailySlotConsumedAt([null, 3, { started_at: "x", queries: [] }, { started_at: at(0, 1).toISOString(), queries: "no" }]).size, 0);
  const latest = dailySlotConsumedAt([
    { started_at: at(0, 13).toISOString(), queries: [null, { queryKey: 5 }, billed("boj_monetary_policy")] },
    { started_at: at(0, 9).toISOString(), queries: [billed("boj_monetary_policy")] },
  ]);
  assert.equal(latest.get("boj_monetary_policy"), at(0, 13).getTime());
});

// --- the topics ---------------------------------------------------------------------------------------

test("the new topics keep the request contract of every other breaking topic", () => {
  const now = at(0, 13, 0);
  for (const query of DAILY_BREAKING_MARKET_QUERIES) {
    const body = breakingMarketRequestBody(query, now);
    assert.equal(body.model, "gpt-5.6-luna", query.key);
    assert.equal(body.max_tool_calls, 1, query.key);
    assert.equal(body.max_output_tokens, 1200, query.key);
    assert.equal(body.tool_choice, "required", query.key);
    assert.deepEqual(body.tools, [{
      type: "web_search",
      filters: { allowed_domains: BREAKING_MARKET_NEWS_DOMAINS },
      search_context_size: "low",
    }], query.key);
    assert.match(body.input as string, new RegExp(`search topic: ${query.searchQuery.slice(0, 20)}`), query.key);
    assert.doesNotMatch(query.searchQuery, /site:/i, query.key);
    for (const domain of BREAKING_MARKET_SOURCE_DOMAINS) assert.ok(!query.searchQuery.includes(domain), `${query.key}: ${domain}`);
    assert.match(
      body.instructions as string,
      /直近3時間以内に発生・発表され、記事も直近3時間以内に公開された材料だけを候補にします/,
      `${query.key} keeps the freshness rule`,
    );
    const concrete = query.searchQuery.toLowerCase().split(/\s+/).filter((word) => !["breaking", "today", "news", "latest"].includes(word));
    assert.ok(concrete.length >= 5, `${query.key} needs topic words`);
  }
});

test("the topics cover the Japan-specific areas the headline-trigger lane is weak at", () => {
  const text = (key: string) => DAILY_BREAKING_MARKET_QUERIES.find((query) => query.key === key)!.searchQuery.toLowerCase();
  for (const term of ["bank of japan", "monetary policy", "rate hike", "jgb"]) assert.ok(text("boj_monetary_policy").includes(term), term);
  for (const term of ["ministry of finance", "intervention", "usdjpy", "yen"]) assert.ok(text("fx_intervention_mof").includes(term), term);
  for (const term of ["nikkei", "topix", "yen"]) assert.ok(text("japan_market_session").includes(term), term);
  for (const term of ["earthquake", "tsunami", "blackout", "north korea", "ballistic", "j-alert", "ministry of defense"]) {
    assert.ok(text("japan_disaster_security_emergency").includes(term), term);
  }
});

// --- what stays unchanged ------------------------------------------------------------------------------

test("the 12-topic catalog and its rotation are untouched (kept for reinstating)", () => {
  assert.equal(BREAKING_MARKET_QUERIES.length, 12);
  assert.equal(MAX_BREAKING_MARKET_SEARCHES_PER_FETCH, 4);
  assert.equal(selectBreakingMarketQueriesForCycle(BREAKING_MARKET_QUERIES, at(0, 12)).length, 4);
  assert.ok(DAILY_BREAKING_MARKET_QUERIES.some((query) => query === BREAKING_MARKET_QUERIES.find((item) => item.key === "japan_market_session")));
});

test("index.ts: the daily selector replaces the hourly rotation and the trigger lane still runs every cycle", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert.match(source, /selectDailyBreakingMarketQueries\(now, dailySlotHistory\)/);
  assert.doesNotMatch(source, /selectBreakingMarketQueriesForCycle\(/);
  assert.doesNotMatch(source, /MAX_BREAKING_MARKET_SEARCHES_PER_FETCH/);
  const trigger = source.match(/headlineTrigger = await runHeadlineTriggerLaneSafely\([^)]*\);/);
  assert.ok(trigger, "the headline-trigger lane is still called");
  const before = source.slice(0, trigger.index);
  const loopStart = before.lastIndexOf("for (const query of selectedQueries)");
  assert.ok(loopStart > 0);
  // The trigger call sits after the generic-search loop, not inside it or behind any slot condition.
  const between = before.slice(loopStart);
  const opened = (between.match(/\{/g) ?? []).length;
  const closed = (between.match(/\}/g) ?? []).length;
  assert.equal(opened, closed, "the loop is closed before the trigger lane starts");
  assert.doesNotMatch(between, /selectedQueries\.length\s*(?:>|===|!==)/);
});

test("projected generic searches: 4 a day against 96 before", () => {
  const before = 24 * MAX_BREAKING_MARKET_SEARCHES_PER_FETCH;
  const { searches } = simulate(1);
  assert.equal(before, 96);
  assert.equal(searches.length, DAILY_BREAKING_MARKET_SEARCH_LIMIT);
});

// --- 10-minute fetch cadence (2026-10-06) ---------------------------------------------------------------
// The fetch cron moves from hourly to every 10 minutes so BBC / Al Jazeera items are noticed sooner.  The
// generic search is driven by the daily slots, not by the cadence, so its cost must not move.

test("10-minute cadence: still exactly four generic searches a day, one per slot", () => {
  const { searches, perCycle } = simulate(1, billed, true, 10);
  assert.equal(perCycle.length, 144);
  assert.equal(searches.length, 4);
  assert.ok(perCycle.every((count) => count <= 1));
  assert.deepEqual(
    searches.map((item) => item.key),
    DAILY_BREAKING_MARKET_SLOTS.map((slot) => slot.key),
  );
  // Each runs in the first cycle of its hour, not later.
  for (const [index, slot] of DAILY_BREAKING_MARKET_SLOTS.entries()) {
    assert.equal(new Date(searches[index].when.getTime() + 9 * HOUR).getUTCHours(), slot.hourJst);
    assert.equal(new Date(searches[index].when.getTime() + 9 * HOUR).getUTCMinutes(), 0);
  }
});

test("10-minute cadence: a week is 28 searches", () => {
  assert.equal(simulate(7, billed, true, 10).searches.length, 28);
});

test("10-minute cadence: with no history readable the day is still 4 searches, never a repeat inside the hour", () => {
  const { searches } = simulate(3, billed, false, 10);
  assert.equal(searches.length, 12);
});

test("10-minute cadence: HTTP 429 and 5xx are retried every cycle for the two-hour window and cost nothing", () => {
  const free = (status: number) => (key: string, when: Date) => {
    const hourJst = new Date(when.getTime() + 9 * HOUR).getUTCHours();
    return key === "boj_monetary_policy" && (hourJst === 13 || hourJst === 14)
      ? { queryKey: key, providerStatus: "failed", httpStatus: status, webSearchCallCount: 0, inputTokens: 0, outputTokens: 0 }
      : billed(key);
  };
  for (const status of [429, 500, 503]) {
    const { searches } = simulate(1, free(status), true, 10);
    const boj = searches.filter((item) => item.key === "boj_monetary_policy");
    assert.equal(boj.length, 12, `HTTP ${status}: 13:00-14:50 every cycle`);
    assert.equal(searches.length - boj.length, 3);
  }
});

test("a timeout / network failure (no HTTP status, nothing billed on record) consumes the slot — no retry loop", () => {
  for (const failure of [
    { providerStatus: "failed", httpStatus: null, webSearchCallCount: 0, inputTokens: 0, outputTokens: 0 },
    { providerStatus: "failed", webSearchCallCount: 0, inputTokens: 0, outputTokens: 0 },
    { providerStatus: "failed", httpStatus: 400, webSearchCallCount: 0, inputTokens: 0, outputTokens: 0 },
  ]) {
    const { searches } = simulate(1, (key) => (key === "boj_monetary_policy" ? { queryKey: key, ...failure } : billed(key)), true, 10);
    assert.equal(searches.filter((item) => item.key === "boj_monetary_policy").length, 1, JSON.stringify(failure));
    assert.equal(searches.length, 4);
  }
});

test("the history read (newest 100 run rows) covers the two-hour catch-up window at a 10-minute cadence", () => {
  assert.ok(DAILY_SLOT_CATCH_UP_MS / (10 * 60 * 1000) <= 100);
});
