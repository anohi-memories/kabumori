// Recovery tests for the breaking_market lane (2026-09-25):
//   B. rotation must visit every rotating topic whatever the fetch cadence (20 min / 1 h / 2 h);
//   A. GPT-6-shaped Responses payloads must parse, and the web_search summary must say whether an
//      empty answer came from an empty search or from the model declining the sources it got.
import assert from "node:assert/strict";
import test from "node:test";
import {
  BREAKING_MARKET_QUERIES,
  breakingMarketLastSearchedAt,
  breakingMarketRequestBody,
  fetchBreakingMarketQueryWithDiagnostics,
  isFixedBreakingMarketQuery,
  MAX_BREAKING_MARKET_SEARCHES_PER_FETCH,
  selectBreakingMarketQueriesForCycle,
  summarizeBreakingMarketWebSearch,
  type BreakingMarketQuery,
} from "./breaking_market_source_fetchers.ts";

const FIXED = BREAKING_MARKET_QUERIES.filter(isFixedBreakingMarketQuery).map((query) => query.key);
const ROTATING = BREAKING_MARKET_QUERIES.filter((query) => !isFixedBreakingMarketQuery(query)).map((query) => query.key);
const HOUR = 60 * 60 * 1000;

/** Runs the selector the way index.ts does: each run's queries become the next run's history. */
function simulate(start: Date, stepMs: number, runs: number): string[][] {
  const history: Array<{ started_at: string; queries: Array<{ queryKey: string }> }> = [];
  const selections: string[][] = [];
  for (let run = 0; run < runs; run += 1) {
    const now = new Date(start.getTime() + run * stepMs);
    const recent = history.filter((row) => Date.parse(row.started_at) >= now.getTime() - 48 * HOUR);
    const selected = selectBreakingMarketQueriesForCycle(
      BREAKING_MARKET_QUERIES,
      now,
      MAX_BREAKING_MARKET_SEARCHES_PER_FETCH,
      breakingMarketLastSearchedAt(recent),
    ).map((query) => query.key);
    selections.push(selected);
    history.push({ started_at: now.toISOString(), queries: selected.map((queryKey) => ({ queryKey })) });
  }
  return selections;
}

function rotatingOf(selection: string[]): string[] {
  return selection.filter((key) => ROTATING.includes(key));
}

test("B: the shipped set still has 3 fixed topics and 9 rotating topics sharing one slot", () => {
  assert.equal(FIXED.length, 3);
  assert.equal(ROTATING.length, 9);
  assert.equal(MAX_BREAKING_MARKET_SEARCHES_PER_FETCH - FIXED.length, 1);
});

test("B: regression — the wall-clock index alone reaches only 3 of 9 rotating topics at an hourly cadence", () => {
  const seen = new Set<string>();
  for (let run = 0; run < 48; run += 1) {
    const now = new Date(Date.UTC(2026, 8, 24, 0, 0) + run * HOUR);
    for (const key of rotatingOf(selectBreakingMarketQueriesForCycle(BREAKING_MARKET_QUERIES, now).map((q) => q.key))) {
      seen.add(key);
    }
  }
  assert.equal(seen.size, 3, "documents the production defect the history-based rotation fixes");
});

for (const [label, stepMs] of [["20-minute", HOUR / 3], ["hourly", HOUR], ["2-hourly (holiday)", 2 * HOUR]] as const) {
  test(`B: ${label} cadence visits every rotating topic exactly once per 9 runs`, () => {
    const selections = simulate(new Date("2026-09-24T13:00:00Z"), stepMs, 27);
    for (let block = 0; block < 3; block += 1) {
      const window = selections.slice(block * 9, block * 9 + 9).flatMap(rotatingOf);
      assert.deepEqual([...window].sort(), [...ROTATING].sort(), `block ${block}`);
    }
  });

  test(`B: ${label} cadence keeps every fixed topic in every run and never exceeds the budget`, () => {
    for (const selection of simulate(new Date("2026-09-24T13:00:00Z"), stepMs, 20)) {
      assert.ok(selection.length <= MAX_BREAKING_MARKET_SEARCHES_PER_FETCH);
      for (const key of FIXED) assert.ok(selection.includes(key));
      assert.equal(rotatingOf(selection).length, 1);
    }
  });
}

test("B: rotation continues across the JST and UTC date boundaries", () => {
  // 14:00 UTC = 23:00 JST; the 2-hourly holiday cadence crosses both midnights in this window.
  const selections = simulate(new Date("2026-09-21T14:00:00Z"), 2 * HOUR, 18);
  assert.deepEqual([...new Set(selections.flatMap(rotatingOf))].sort(), [...ROTATING].sort());
});

test("B: a cadence change mid-stream does not strand any topic", () => {
  const first = simulate(new Date("2026-09-24T00:00:00Z"), HOUR / 3, 4);
  const lastRun = new Date("2026-09-24T01:00:00Z");
  const history = first.map((keys, run) => ({
    started_at: new Date(Date.parse("2026-09-24T00:00:00Z") + run * HOUR / 3).toISOString(),
    queries: keys.map((queryKey) => ({ queryKey })),
  }));
  const seen = new Set(first.flatMap(rotatingOf));
  for (let run = 1; run <= 9; run += 1) {
    const now = new Date(lastRun.getTime() + run * 2 * HOUR);
    const keys = selectBreakingMarketQueriesForCycle(
      BREAKING_MARKET_QUERIES,
      now,
      MAX_BREAKING_MARKET_SEARCHES_PER_FETCH,
      breakingMarketLastSearchedAt(history),
    ).map((query) => query.key);
    rotatingOf(keys).forEach((key) => seen.add(key));
    history.push({ started_at: now.toISOString(), queries: keys.map((queryKey) => ({ queryKey })) });
  }
  assert.deepEqual([...seen].sort(), [...ROTATING].sort());
});

test("B: never-searched topics go first, then the oldest; ties keep declaration order", () => {
  const history = new Map<string, number>([
    [ROTATING[0], Date.parse("2026-09-24T10:00:00Z")],
    [ROTATING[1], Date.parse("2026-09-24T09:00:00Z")],
  ]);
  const pick = (map: Map<string, number>) =>
    rotatingOf(selectBreakingMarketQueriesForCycle(BREAKING_MARKET_QUERIES, new Date(), 4, map).map((q) => q.key))[0];
  assert.equal(pick(history), ROTATING[2], "first never-searched topic in declaration order");
  const all = new Map(ROTATING.map((key, index) => [key, Date.parse("2026-09-24T00:00:00Z") + index * HOUR]));
  all.set(ROTATING[5], Date.parse("2026-09-23T00:00:00Z"));
  assert.equal(pick(all), ROTATING[5], "oldest attempt wins once every topic has a history");
});

test("B: fixed-only budgets and the stateless fallback are unchanged", () => {
  const history = new Map<string, number>();
  const two = selectBreakingMarketQueriesForCycle(BREAKING_MARKET_QUERIES, new Date(), 2, history).map((q) => q.key);
  assert.deepEqual(two, FIXED.slice(0, 2));
  const now = new Date("2026-09-24T12:00:00Z");
  assert.deepEqual(
    selectBreakingMarketQueriesForCycle(BREAKING_MARKET_QUERIES, now, 4, null),
    selectBreakingMarketQueriesForCycle(BREAKING_MARKET_QUERIES, now),
  );
});

test("B: history parsing keeps the latest attempt per key and skips malformed rows", () => {
  const latest = breakingMarketLastSearchedAt([
    { started_at: "2026-09-24T01:00:00Z", queries: [{ queryKey: "shipping_chokepoints" }] },
    { started_at: "2026-09-24T03:00:00Z", queries: [{ queryKey: "shipping_chokepoints" }, { queryKey: 7 }] },
    { started_at: "not a date", queries: [{ queryKey: "war_geopolitics_taiwan" }] },
    { started_at: "2026-09-24T02:00:00Z", queries: null },
    null,
    "row",
  ]);
  assert.deepEqual([...latest.entries()], [["shipping_chokepoints", Date.parse("2026-09-24T03:00:00Z")]]);
  assert.equal(breakingMarketLastSearchedAt(null).size, 0);
  assert.equal(breakingMarketLastSearchedAt({ rows: [] }).size, 0);
});

// ---------------------------------------------------------------------------------------------------
// A. Responses payload shapes

const query = BREAKING_MARKET_QUERIES.find((item) => item.key === "shipping_chokepoints") as BreakingMarketQuery;
const now = new Date("2026-09-21T13:00:00Z");
const AP = "https://apnews.com/article/93dfe17125c63897b232f6461d81d85c";
const candidate = {
  title: "Houthis declare blockade on Saudi shipping in Bab el-Mandeb and Red Sea",
  summary: "Yemen's Houthis declared a blockade on Saudi shipping.",
  source_url: AP,
  published_at: "2026-09-21T12:01:00Z",
  event_at: "2026-09-21T11:40:00Z",
  category: "geopolitics",
};

function respond(body: unknown): typeof fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

function message(candidates: unknown[]) {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: JSON.stringify({ candidates }), annotations: [] }],
  };
}

/** GPT-6-shaped: a reasoning item, a search plus an open_page action, then the JSON message. */
function gpt6Payload(candidates: unknown[], sources: string[] = [AP]) {
  return {
    status: "completed",
    model: "gpt-6-luna",
    usage: { input_tokens: 12100, output_tokens: 120 },
    output: [
      { type: "reasoning", summary: [] },
      { type: "web_search_call", status: "completed", action: { type: "search", query: "q", sources: sources.map((url) => ({ type: "url", url })) } },
      { type: "web_search_call", status: "completed", action: { type: "open_page", url: sources[0] ?? null } },
      message(candidates),
    ],
  };
}

/** GPT-5.6-shaped: one search call and the message, no reasoning item. */
function gpt56Payload(candidates: unknown[]) {
  return {
    status: "completed",
    model: "gpt-5.6-luna",
    usage: { input_tokens: 12300, output_tokens: 300 },
    output: [
      { type: "web_search_call", status: "completed", action: { type: "search", sources: [{ url: AP }] } },
      message(candidates),
    ],
  };
}

test("A: a GPT-6-shaped response with a web search yields the candidate", async () => {
  const result = await fetchBreakingMarketQueryWithDiagnostics("k", query, now, respond(gpt6Payload([candidate])));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.diagnostics.rawCandidateCount, 1);
  assert.equal(result.diagnostics.validatedCandidateCount, 1);
  assert.equal(result.diagnostics.webSearchCallCount, 2);
  assert.deepEqual(result.diagnostics.webSearchActions, { search: 1, open_page: 1 });
  assert.equal(result.diagnostics.searchSourceCount, 1);
  assert.equal(result.diagnostics.allowedSourceCount, 1);
});

test("A: a GPT-5.6-shaped response still yields the same candidate", async () => {
  const result = await fetchBreakingMarketQueryWithDiagnostics("k", query, now, respond(gpt56Payload([candidate])));
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.diagnostics.webSearchActions, { search: 1 });
});

test("A: an empty answer is a normal zero-candidate result and records what the search returned", async () => {
  const declined = await fetchBreakingMarketQueryWithDiagnostics("k", query, now, respond(gpt6Payload([])));
  assert.equal(declined.candidates.length, 0);
  assert.equal(declined.diagnostics.providerStatus, "succeeded");
  assert.equal(declined.diagnostics.failureCode, null);
  assert.equal(declined.diagnostics.allowedSourceCount, 1, "sources existed: the model declined them");

  const nothing = await fetchBreakingMarketQueryWithDiagnostics("k", query, now, respond(gpt6Payload([], [])));
  assert.equal(nothing.diagnostics.searchSourceCount, 0, "the search itself returned nothing");
  assert.equal(nothing.diagnostics.allowedSourceCount, 0);
});

test("A: invalid JSON and empty output fail with stable codes and keep billed usage", async () => {
  const invalid = gpt6Payload([candidate]);
  (invalid.output[3] as { content: Array<{ text: string }> }).content[0].text = "{not json";
  await assert.rejects(
    fetchBreakingMarketQueryWithDiagnostics("k", query, now, respond(invalid)),
    (error: Error & { diagnostics?: { failureCode: string; inputTokens: number; webSearchActions?: unknown } }) => {
      assert.equal(error.message, "BREAKING_MARKET_INVALID_OUTPUT:shipping_chokepoints");
      assert.equal(error.diagnostics?.inputTokens, 12100);
      assert.deepEqual(error.diagnostics?.webSearchActions, { search: 1, open_page: 1 });
      return true;
    },
  );
  const empty = { ...gpt6Payload([candidate]), output: gpt6Payload([candidate]).output.slice(0, 3) };
  await assert.rejects(
    fetchBreakingMarketQueryWithDiagnostics("k", query, now, respond(empty)),
    /BREAKING_MARKET_EMPTY_OUTPUT:shipping_chokepoints/,
  );
});

test("A: web_search summary tolerates missing actions and non-object output", () => {
  assert.deepEqual(summarizeBreakingMarketWebSearch(null), { actions: {}, sourceCount: 0, allowedSourceCount: 0 });
  assert.deepEqual(
    summarizeBreakingMarketWebSearch({ output: [{ type: "web_search_call" }, { type: "message" }, 3] }),
    { actions: { unknown: 1 }, sourceCount: 0, allowedSourceCount: 0 },
  );
  assert.deepEqual(
    summarizeBreakingMarketWebSearch({
      output: [{ type: "web_search_call", action: { type: "search", sources: [{ url: AP }, { url: "https://example.com/x" }] } }],
    }),
    { actions: { search: 1 }, sourceCount: 2, allowedSourceCount: 1 },
  );
});

test("A: the lane is held on gpt-5.6-luna and the request is identical across models apart from the model", () => {
  const active = breakingMarketRequestBody(query, now);
  const gpt6 = breakingMarketRequestBody(query, now, "gpt-6-luna");
  assert.equal(active.model, "gpt-5.6-luna");
  assert.equal(gpt6.model, "gpt-6-luna");
  assert.deepEqual({ ...active, model: null }, { ...gpt6, model: null });
  assert.equal(active.max_tool_calls, 1);
  assert.deepEqual(active.include, ["web_search_call.action.sources"]);
});
