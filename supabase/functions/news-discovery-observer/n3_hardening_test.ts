// Boundary tests for the N3 hardening: invocation deadline + finalization reserve (H1), search usage
// durability and persisted-vs-discovered counts (M1), DB-resolved URL duplicates (M2).
import assert from "node:assert/strict";
import test from "node:test";
import { HostRateGate } from "../_shared/news_discovery/fetcher.ts";
import { OBSERVER_DEADLINE, RunDeadline } from "../_shared/news_discovery/run_deadline.ts";
import { sourceById } from "../_shared/news_discovery/source_registry.ts";
import type { RpcClient, RpcFunction } from "../_shared/news_discovery/supabase_store.ts";
import { SupabaseNewsSignalStore } from "../_shared/news_discovery/supabase_store.ts";
import { InMemorySearchBudget, type ProviderResult, type WebSearchProvider } from "../_shared/news_discovery/web_search.ts";
import { OBSERVER_SECRET_HEADER } from "./observer_auth.ts";
import { createObserverHandler } from "./observer_handler.ts";

const SECRET = "A".repeat(42) + "A";
const NOW = new Date("2026-09-28T06:00:00Z");
const mof = sourceById("jp_mof_news")!;
const rss = (items: string) => `<?xml version="1.0"?><rss><channel><title>x</title>${items}</channel></rss>`;
const item = (title: string, link: string) => `<item><title>${title}</title><link>${link}</link><pubDate>Sun, 28 Sep 2026 03:00:00 GMT</pubDate></item>`;
const usage = { model_calls: 1, web_search_calls: 1, input_tokens: 10, output_tokens: 5 };

/** Minimal RPC fake: records every call and its payload; failures injected per function / call number. */
class Db implements RpcClient {
  calls: Array<{ fn: RpcFunction; p: Record<string, unknown> }> = [];
  rows = new Set<string>();
  failOn = new Map<RpcFunction, number>(); // fn -> fail on this (1-based) call of that fn
  #count = new Map<RpcFunction, number>();
  call(fn: RpcFunction, p: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ fn, p });
    const n = (this.#count.get(fn) ?? 0) + 1;
    this.#count.set(fn, n);
    if (this.failOn.get(fn) === n) return Promise.reject(new Error(`DB_RPC_FAILED:${fn}:503`));
    switch (fn) {
      case "news_discovery_begin_run":
        return Promise.resolve({ run_id: "00000000-0000-4000-8000-000000000001" });
      case "news_discovery_find_duplicates":
      case "news_discovery_recent_for_grouping":
        return Promise.resolve([]);
      case "news_discovery_insert_signals": {
        const ids = (p.signals as Array<{ id: string }>).map((s) => s.id);
        const inserted = ids.filter((id) => !this.rows.has(id));
        inserted.forEach((id) => this.rows.add(id));
        return Promise.resolve({ inserted, conflicted: ids.filter((id) => !inserted.includes(id)), duplicates: [] });
      }
      case "news_discovery_finish_run":
        return Promise.resolve({ finished: true });
      default:
        return Promise.resolve({});
    }
  }
  of(fn: RpcFunction) {
    return this.calls.filter((c) => c.fn === fn);
  }
}

class Provider implements WebSearchProvider {
  readonly name = "stub";
  readonly model = "stub";
  calls: Array<{ timeoutMs?: number }> = [];
  constructor(private readonly result: () => ProviderResult) {}
  search(input: { timeoutMs?: number }): Promise<ProviderResult> {
    this.calls.push({ timeoutMs: input.timeoutMs });
    return Promise.resolve(this.result());
  }
}

/** A clock the fake fetch advances, so "time passes" while sources are fetched. */
function setup(opts: { clockStepMs?: number; provider?: WebSearchProvider; db?: Db; budget?: InMemorySearchBudget } = {}) {
  let now = 1_000_000;
  const db = opts.db ?? new Db();
  const fetched: string[] = [];
  const handler = createObserverHandler({
    observerSecret: SECRET,
    rpc: db,
    loadStocks: () => Promise.resolve([]),
    fetchImpl: (url: string) => {
      fetched.push(url);
      now += opts.clockStepMs ?? 0;
      const body = url.startsWith(mof.endpoint)
        ? rss(item("財務省のお知らせ（テスト用の十分な長さのタイトル）", "https://www.mof.go.jp/h.html"))
        : rss(item("Federal Reserve Board announces a hardening fixture", "https://www.federalreserve.gov/h.htm"));
      return Promise.resolve(new Response(body));
    },
    gate: new HostRateGate(() => 0, () => Promise.resolve()),
    now: () => NOW,
    clock: () => now,
    log: () => {},
    searchProvider: opts.provider,
    searchBudget: opts.budget ?? new InMemorySearchBudget(undefined, () => NOW),
  });
  const post = (body: unknown) =>
    handler(new Request("http://local/x", { method: "POST", headers: { [OBSERVER_SECRET_HEADER]: SECRET }, body: JSON.stringify(body) }));
  return { db, fetched, post, advance: (ms: number) => { now += ms; } };
}

test("deadline: usable time excludes the finalization reserve; gates and caps are monotonic", () => {
  let t = 0;
  const d = new RunDeadline(0, OBSERVER_DEADLINE, () => t);
  assert.equal(d.usableMs(), OBSERVER_DEADLINE.invocation_budget_ms - OBSERVER_DEADLINE.finalization_reserve_ms);
  assert.equal(d.capTimeout(60_000), 60_000);
  t = OBSERVER_DEADLINE.invocation_budget_ms - OBSERVER_DEADLINE.finalization_reserve_ms - 30_000; // 30 s usable
  assert.equal(d.canStartSearch(false), true);
  assert.equal(d.canStartSearch(true), false, "follow-up needs more headroom");
  assert.equal(d.capTimeout(60_000), 30_000, "a request never reaches into the reserve");
  t = OBSERVER_DEADLINE.invocation_budget_ms - OBSERVER_DEADLINE.finalization_reserve_ms; // reserve only
  assert.equal(d.canStartFetch(), false);
  assert.equal(d.stats.deadline_reached, true);
  // Supabase: 150 s request idle timeout -> the whole budget must fit inside it.
  assert.ok(OBSERVER_DEADLINE.invocation_budget_ms < 150_000);
});

test("deadline reached during feeds: remaining sources skipped (not failed), signals persisted, run finished with execution", async () => {
  const usable = OBSERVER_DEADLINE.invocation_budget_ms - OBSERVER_DEADLINE.finalization_reserve_ms;
  const { db, fetched, post } = setup({ clockStepMs: usable }); // the first fetch eats all usable time
  const response = await post({ sources: ["jp_mof_news", "us_fed_press"] });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(fetched.length, 1, "no request starts inside the finalization reserve");
  assert.equal(body.status, "completed_with_errors");
  assert.equal(body.execution.deadline_reached, true);
  assert.equal(body.execution.sources_completed, 1);
  assert.equal(body.execution.sources_skipped, 1);
  assert.equal(body.totals.inserted_count, 1, "what was fetched is still persisted");
  const finish = db.of("news_discovery_finish_run")[0].p;
  assert.match(String(finish.error_summary), /DEADLINE_REACHED:sources_skipped=1/);
  assert.equal((finish.execution as Record<string, unknown>).deadline_reached, true);
  const fedRecord = (finish.sources as Array<Record<string, unknown>>).find((s) => s.source_id === "us_fed_press")!;
  assert.equal((fedRecord.requests as Array<Record<string, unknown>>)[0].outcome, "DEADLINE_SKIPPED");
});

test("deadline: no reservation and no API call when a search cannot start; follow-up is dropped first", async () => {
  // 1) not enough usable time for any search -> 0 reservations
  const usable = OBSERVER_DEADLINE.invocation_budget_ms - OBSERVER_DEADLINE.finalization_reserve_ms;
  const provider = new Provider(() => ({ ok: true, results: [], rejected_unverified: 0, usage }));
  const budget = new InMemorySearchBudget(undefined, () => NOW);
  const late = setup({ clockStepMs: usable - OBSERVER_DEADLINE.min_search_usable_ms + 1, provider, budget });
  const body = await (await late.post({ sources: ["jp_mof_news"], search: { enabled: true, anomalies: [{ instrument: "SOX" }] } })).json();
  assert.equal(provider.calls.length, 0);
  assert.equal(budget.rows.length, 0, "nothing reserved");
  assert.deepEqual(body.search.skipped.filter((s: { reason: string }) => s.reason === "deadline").length, 2);
  assert.equal(body.execution.searches_skipped, 2);

  // 2) enough for a first search but not for its follow-up -> trigger runs (timeout capped), follow-up skipped
  const provider2 = new Provider(() => ({ ok: true, results: [], rejected_unverified: 0, usage }));
  const budget2 = new InMemorySearchBudget(undefined, () => NOW);
  const mid = setup({ clockStepMs: usable - 30_000, provider: provider2, budget: budget2 });
  const body2 = await (await mid.post({ sources: ["jp_mof_news"], search: { enabled: true, scheduled: false, anomalies: [{ instrument: "SOX" }] } })).json();
  assert.equal(provider2.calls.length, 1);
  assert.equal(provider2.calls[0].timeoutMs, 30_000, "provider timeout capped to usable time");
  assert.equal(budget2.rows.length, 1, "the follow-up was never reserved");
  assert.deepEqual(body2.search.skipped.map((s: { reason: string }) => s.reason), ["deadline"]);
});

test("M1: search succeeds but its signals cannot be written -> usage kept, row completed with error, no further search, run failed", async () => {
  const db = new Db();
  db.failOn.set("news_discovery_insert_signals", 2); // 1st = feed flush, 2nd = the search's signals
  const provider = new Provider(() => ({
    ok: true,
    results: [{ url: "https://open.example/a", title: "Chip plant fire halts production", publisher: "open.example" }],
    rejected_unverified: 0,
    usage,
  }));
  const budget = new InMemorySearchBudget(undefined, () => NOW);
  const { post } = setup({ db, provider, budget });
  const response = await post({ sources: ["jp_mof_news"], search: { enabled: true, anomalies: [{ instrument: "SOX" }] } });
  const body = await response.json();
  assert.equal(provider.calls.length, 1, "no retry of the search, no further search after a write failure");
  assert.equal(budget.completions.length, 1);
  assert.equal(budget.completions[0].status, "succeeded", "the API call happened and was paid for");
  assert.equal(budget.completions[0].error_code, "SIGNAL_PERSIST_FAILED");
  assert.deepEqual(budget.completions[0].usage, usage, "usage kept");
  assert.equal(body.search.persisted_signals, 0);
  assert.equal(body.search.new_signals, 1, "discovered != persisted");
  assert.equal(body.status, "failed");
  assert.equal(response.status, 500);
  const finish = db.of("news_discovery_finish_run").at(-1)!.p;
  assert.equal((finish.totals as Record<string, number>).ai_calls, 1);
  assert.equal((finish.totals as Record<string, number>).search_count, 1);
});

test("M1: search signals are persisted BEFORE the search row is completed", async () => {
  const db = new Db();
  const order: string[] = [];
  const provider = new Provider(() => ({
    ok: true,
    results: [{ url: "https://open.example/b", title: "Oil jumps after pipeline outage", publisher: "open.example" }],
    rejected_unverified: 0,
    usage,
  }));
  const budget = new InMemorySearchBudget(undefined, () => NOW);
  const complete = budget.complete.bind(budget);
  budget.complete = (c) => {
    order.push(`complete:${db.of("news_discovery_insert_signals").length}`);
    return complete(c);
  };
  const { post } = setup({ db, provider, budget });
  const body = await (await post({ sources: ["jp_mof_news"], search: { enabled: true, scheduled: false, anomalies: [{ instrument: "WTI" }] } })).json();
  assert.deepEqual(order, ["complete:2"], "feed flush + search flush happened before complete");
  assert.equal(body.search.persisted_signals, 1);
  assert.equal(body.search.persisted_useful_signals, 1);
});

test("M1: a run that fails after searching still reports the usage it spent (no totals={} reset)", async () => {
  const db = new Db();
  db.failOn.set("news_discovery_finish_run", 1); // the normal finish fails; the failure path must keep usage
  const provider = new Provider(() => ({ ok: true, results: [], rejected_unverified: 0, usage }));
  const { post } = setup({ db, provider });
  const response = await post({ sources: ["jp_mof_news"], search: { enabled: true, scheduled: false, anomalies: [{ instrument: "WTI" }] } });
  assert.equal(response.status, 500);
  const finishes = db.of("news_discovery_finish_run");
  assert.equal(finishes.length, 2);
  const failed = finishes[1].p;
  assert.equal(failed.status, "failed");
  const totals = failed.totals as Record<string, number>;
  assert.equal(totals.search_count, 2, "trigger + its follow-up both ran");
  assert.equal(totals.ai_calls, 2);
  assert.equal(totals.web_search_calls, 2);
  assert.equal(totals.fetched_count, 1, "feed progress kept too");
  assert.ok((failed.execution as Record<string, number>).searches_completed >= 2);
});

test("M2: DB-resolved URL duplicates (concurrent run won) are returned, not errors", async () => {
  const rpc: RpcClient = {
    call: () => Promise.resolve({ inserted: [], conflicted: [], duplicates: [{ id: "a".repeat(64), duplicate_of: "b".repeat(64), reason: "url" }] }),
  };
  const store = new SupabaseNewsSignalStore(rpc, "run", "v0");
  const result = await store.save([]);
  assert.deepEqual(result, { inserted: [], conflicted: [], duplicates: [] }, "empty batch makes no call");
  const saved = await store.save([{
    id: "a".repeat(64), source_id: "web_search", source_type: "web_search", policy: "SEARCH_DISCOVERY", source_url: "https://x.example/a",
    canonical_url: "https://x.example/a", external_id: null, title: "t", title_display_allowed: false, summary_hint: null, published_at: null,
    published_at_precision: null, updated_at: null, detected_at: null, fetched_at: NOW.toISOString(), language: "en", country: "INT",
    publisher: "x", topics: [], entities: [], ticker_candidates: [], image_url: null, image_source: null, image_usage_allowed: false,
    discovery_only: true, restricted_publisher: false, search_id: null, discovered_via: "search:WORLD:manual",
    raw_reference: { feed_url: "https://api.openai.com/v1/responses", item_index: 0 }, fingerprint: "a".repeat(64),
    title_fingerprint: "c".repeat(32), same_event_group: null, needs_verification: [],
  }]);
  assert.deepEqual(saved.duplicates, [{ id: "a".repeat(64), duplicate_of: "b".repeat(64), reason: "url" }]);
  assert.deepEqual(saved.inserted, []);
});

test("restricted-domain lookalikes: punycode / homoglyph hosts are never treated as the trusted publisher", async () => {
  const { publisherRestriction } = await import("../_shared/news_discovery/source_registry.ts");
  const { safeSearchUrl } = await import("../_shared/news_discovery/web_search.ts");
  assert.equal(publisherRestriction("https://xn--nhk-ofa.or.jp/news/x")?.source_id, undefined);
  assert.equal(publisherRestriction("https://nһk.or.jp/news/x")?.source_id, undefined, "Cyrillic һ becomes a different punycode host");
  assert.equal(publisherRestriction("https://ft.com.xn--p1ai/x")?.source_id, undefined);
  assert.equal(publisherRestriction("https://WWW.FT.COM./x")?.scope, "no_access");
  assert.equal(safeSearchUrl("https://user:pw@www.ft.com/x"), null);
  assert.equal(safeSearchUrl("https://intranet/x"), null);
});

test("multiple_weak needs two DISTINCT weak aliases: repeating one weak alias never confirms", async () => {
  const { buildAliasIndex, matchTickers } = await import("../_shared/news_discovery/company_alias.ts");
  const index = buildAliasIndex([{ ticker_code: "4689", company_name: "ＬＩＮＥヤフー" }]);
  const repeated = matchTickers({ title: "LINE outage; LINE users affected; LINE says" }, index);
  assert.deepEqual(repeated.map((c) => [c.ticker, c.status, c.confirmation_basis]), [["4689", "candidate", null]]);
  const two = matchTickers({ title: "LINE and ヤフー services restored" }, index);
  assert.deepEqual(two.map((c) => [c.status, c.confirmation_basis]), [["confirmed", "multiple_weak"]]);
});
