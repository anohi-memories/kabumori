import assert from "node:assert/strict";
import test from "node:test";
import { HostRateGate } from "../_shared/news_discovery/fetcher.ts";
import { signalUrlKey } from "../_shared/news_discovery/pipeline.ts";
import { sourceById } from "../_shared/news_discovery/source_registry.ts";
import { InMemoryNewsSignalStore } from "../_shared/news_discovery/store.ts";
import type { RpcClient, RpcFunction } from "../_shared/news_discovery/supabase_store.ts";
import type { NewsSignal } from "../_shared/news_discovery/types.ts";
import { OBSERVER_SECRET_HEADER } from "./observer_auth.ts";
import { createObserverHandler, defaultObserverSources, registrySummary, resolveSources } from "./observer_handler.ts";

const SECRET = "A".repeat(42) + "A"; // valid 32-byte base64url shape
const NOW = new Date("2026-09-28T06:00:00Z");

/** In-memory stand-in for the news_discovery_* RPCs (the real SQL is proven in the disposable-DB run). */
class FakeDb implements RpcClient {
  runs = new Map<string, { status: string; totals?: Record<string, number>; sources?: unknown[]; error_summary?: string | null }>();
  rows = new Map<string, Record<string, unknown>>();
  store = new InMemoryNewsSignalStore(signalUrlKey);
  calls: RpcFunction[] = [];
  failInsert = false;
  failBegin = false;
  #seq = 0;

  async call(fn: RpcFunction, p: Record<string, unknown>): Promise<unknown> {
    this.calls.push(fn);
    switch (fn) {
      case "news_discovery_begin_run": {
        if (this.failBegin) throw new Error("DB_RPC_FAILED:news_discovery_begin_run:503");
        const id = `00000000-0000-4000-8000-${String(++this.#seq).padStart(12, "0")}`;
        this.runs.set(id, { status: "running" });
        return { run_id: id };
      }
      case "news_discovery_find_duplicates": {
        const out = [];
        for (const lookup of p.lookups as Array<Record<string, unknown>>) {
          const hit = await this.store.findDuplicate({ ...lookup, since_ms: Date.parse(String(lookup.since)) } as never);
          if (hit) out.push({ i: lookup.i, ...hit });
        }
        return out;
      }
      case "news_discovery_insert_signals": {
        if (this.failInsert) throw new Error("DB_RPC_FAILED:news_discovery_insert_signals:23514:400");
        if (this.runs.get(String(p.run_id))?.status !== "running") throw new Error("NEWS_DISCOVERY_RUN_NOT_RUNNING");
        const inserted: string[] = [];
        const conflicted: string[] = [];
        for (const row of p.signals as Array<Record<string, unknown>>) {
          const id = String(row.id);
          if (this.rows.has(id)) {
            conflicted.push(id);
            continue;
          }
          this.rows.set(id, row);
          inserted.push(id);
          await this.store.save([{ ...row, ticker_candidates: [], updated_at: row.updated_at } as unknown as NewsSignal]);
        }
        return { inserted, conflicted };
      }
      case "news_discovery_recent_for_grouping":
        return [];
      case "news_discovery_finish_run": {
        const run = this.runs.get(String(p.run_id));
        if (!run || run.status !== "running") return { finished: false };
        Object.assign(run, { status: p.status, totals: p.totals, sources: p.sources, error_summary: p.error_summary });
        return { finished: true };
      }
    }
  }
}

const rss = (items: string) => `<?xml version="1.0"?><rss><channel><title>x</title>${items}</channel></rss>`;
const item = (title: string, link: string) => `<item><title>${title}</title><link>${link}</link><pubDate>Sun, 28 Sep 2026 03:00:00 GMT</pubDate></item>`;

function routes(map: Record<string, string | number>) {
  const calls: string[] = [];
  const impl = (url: string) => {
    calls.push(url);
    const key = Object.keys(map).find((prefix) => url.startsWith(prefix));
    const value = key === undefined ? 404 : map[key];
    return Promise.resolve(typeof value === "number" ? new Response("x", { status: value }) : new Response(value));
  };
  return { impl, calls };
}

const mof = sourceById("jp_mof_news")!;
const fed = sourceById("us_fed_press")!;
const gdelt = sourceById("gdelt_doc")!;

function handler(db: FakeDb, fetchMap: Record<string, string | number>, extra: Partial<Parameters<typeof createObserverHandler>[0]> = {}) {
  const fetch = routes(fetchMap);
  const logs: Array<Record<string, unknown>> = [];
  const h = createObserverHandler({
    observerSecret: SECRET,
    rpc: db,
    loadStocks: () => Promise.resolve([{ ticker_code: "7203", company_name: "トヨタ自動車", is_listed: true }]),
    fetchImpl: fetch.impl,
    gate: new HostRateGate(() => 0, () => Promise.resolve()),
    now: () => NOW,
    log: (line) => logs.push(line),
    ...extra,
  });
  return { h, fetch, logs };
}

function post(body: unknown, secret: string | null = SECRET): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers[OBSERVER_SECRET_HEADER] = secret;
  return new Request("http://localhost/news-discovery-observer", { method: "POST", headers, body: JSON.stringify(body) });
}

const TWO = { sources: ["jp_mof_news", "us_fed_press"], trigger_type: "local_validation" };

test("defaults: DIRECT sources only; GDELT, EDINET, disabled and State Dept are not in the default set", () => {
  const ids = defaultObserverSources().map((s) => s.source_id);
  assert.ok(ids.includes("jp_mof_news") && ids.includes("us_federal_register"));
  for (const id of ["gdelt_doc", "jp_edinet_documents", "us_state_press", "al_jazeera", "boj_whatsnew"]) assert.ok(!ids.includes(id), id);
  const summary = registrySummary();
  assert.deepEqual(summary.discovery_only, ["gdelt_doc"]);
  assert.ok(summary.direct_disabled.includes("jp_edinet_documents"));
});

test("auth: unconfigured secret -> 503, wrong/missing secret -> 401, GET -> 405 (no run created)", async () => {
  const db = new FakeDb();
  assert.equal((await handler(db, {}, { observerSecret: undefined }).h(post(TWO))).status, 503);
  assert.equal((await handler(db, {}).h(post(TWO, "B".repeat(43)))).status, 401);
  assert.equal((await handler(db, {}).h(post(TWO, null))).status, 401);
  assert.equal((await handler(db, {}).h(new Request("http://localhost/x"))).status, 405);
  assert.equal(db.runs.size, 0);
});

test("bad input: invalid JSON, unknown source and bad trigger are rejected before a run starts", async () => {
  const db = new FakeDb();
  const bad = new Request("http://localhost/x", { method: "POST", headers: { [OBSERVER_SECRET_HEADER]: SECRET }, body: "{" });
  assert.equal((await handler(db, {}).h(bad)).status, 400);
  assert.equal((await handler(db, {}).h(post({ sources: ["nope"] }))).status, 400);
  assert.equal((await handler(db, {}).h(post({ trigger_type: "cron" }))).status, 400);
  assert.equal(db.runs.size, 0);
});

test("all sources succeed: signals inserted, run completed, AI/Web Search 0, logs carry no titles", async () => {
  const db = new FakeDb();
  const { h, logs } = handler(db, {
    [mof.endpoint]: rss(item("財務省、トヨタ自動車の件で発表（テスト用の十分な長さ）", "https://www.mof.go.jp/a.html")),
    [fed.endpoint]: rss(item("Federal Reserve Board announces an enforcement action", "https://www.federalreserve.gov/a.htm")),
  });
  const response = await h(post(TWO));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "completed");
  assert.equal(body.totals.inserted_count, 2);
  assert.equal(body.totals.ticker_confirmed_count, 1);
  assert.equal(body.totals.ai_calls, 0);
  assert.equal(body.totals.web_search_calls, 0);
  const run = db.runs.get(body.run_id)!;
  assert.equal(run.status, "completed");
  assert.equal((run.sources as unknown[]).length, 2);
  assert.ok(!JSON.stringify(logs).includes("財務省、トヨタ"), "logs never contain article titles");
  assert.ok(logs.some((l) => l.event === "news_discovery_source" && l.source_id === "jp_mof_news" && l.inserted === 1));
});

test("one source fails (403): run completed_with_errors, the other source is stored", async () => {
  const db = new FakeDb();
  const { h } = handler(db, { [mof.endpoint]: rss(item("財務省のお知らせ（テスト用の十分な長さのタイトル）", "https://www.mof.go.jp/b.html")), [fed.endpoint]: 403 });
  const body = await (await h(post(TWO))).json();
  assert.equal(body.status, "completed_with_errors");
  assert.equal(body.totals.inserted_count, 1);
  assert.equal(body.totals.failed_sources, 1);
  const run = db.runs.get(body.run_id)!;
  assert.match(String(run.error_summary), /us_fed_press:HTTP_ERROR:403/);
  const fedRecord = (run.sources as Array<Record<string, unknown>>).find((s) => s.source_id === "us_fed_press")!;
  assert.equal(fedRecord.outcome, "failed");
  assert.equal((fedRecord.requests as Array<Record<string, unknown>>)[0].http_status, 403);
});

test("all sources fail: run recorded as failed, response still 200 with the run id", async () => {
  const db = new FakeDb();
  const { h } = handler(db, { [mof.endpoint]: 500, [fed.endpoint]: 429 });
  const body = await (await h(post(TWO))).json();
  assert.equal(body.status, "failed");
  assert.equal(db.runs.get(body.run_id)!.status, "failed");
  assert.match(String(db.runs.get(body.run_id)!.error_summary), /RATE_LIMITED:429/);
});

test("disabled / key-requiring sources are refused, recorded with policy, and never requested", async () => {
  const db = new FakeDb();
  const { h, fetch } = handler(db, { [mof.endpoint]: rss(item("財務省のお知らせ（テスト用の十分な長さのタイトル）", "https://www.mof.go.jp/c.html")) });
  const body = await (await h(post({ sources: ["jp_mof_news", "al_jazeera", "jp_edinet_documents", "us_state_press"] }))).json();
  assert.equal(body.status, "completed");
  assert.deepEqual(fetch.calls.map((u) => new URL(u).host), ["www.mof.go.jp"]);
  const records = db.runs.get(body.run_id)!.sources as Array<Record<string, unknown>>;
  const refused = Object.fromEntries(records.filter((r) => r.outcome === "refused").map((r) => [r.source_id, [r.policy, (r.requests as Array<Record<string, unknown>>)[0].outcome]]));
  assert.deepEqual(refused, {
    al_jazeera: ["DISABLED", "SOURCE_DISABLED"],
    jp_edinet_documents: ["DIRECT_SOURCE", "SOURCE_REQUIRES_API_KEY"],
    us_state_press: ["DIRECT_SOURCE", "SOURCE_NOT_ENABLED_FOR_N2"],
  });
});

test("GDELT 429 does not fail or degrade the run (discovery sources are optional)", async () => {
  const db = new FakeDb();
  const { h } = handler(db, {
    [mof.endpoint]: rss(item("財務省のお知らせ（テスト用の十分な長さのタイトル）", "https://www.mof.go.jp/d.html")),
    [gdelt.endpoint]: 429,
  });
  const body = await (await h(post({ sources: ["jp_mof_news"], include_gdelt: true }))).json();
  assert.equal(body.status, "completed");
  assert.equal(body.totals.inserted_count, 1);
  assert.match(String(db.runs.get(body.run_id)!.error_summary), /gdelt_doc:RATE_LIMITED:429/);
  assert.equal(body.sources.find((s: { source_id: string }) => s.source_id === "gdelt_doc").outcome, "failed");
});

test("a repeat run with only duplicates inserts nothing and completes", async () => {
  const db = new FakeDb();
  const map = { [mof.endpoint]: rss(item("財務省のお知らせ（テスト用の十分な長さのタイトル）", "https://www.mof.go.jp/e.html")) };
  await (await handler(db, map).h(post({ sources: ["jp_mof_news"] }))).json();
  const second = await (await handler(db, map).h(post({ sources: ["jp_mof_news"] }))).json();
  assert.equal(second.status, "completed");
  assert.equal(second.totals.inserted_count, 0);
  assert.equal(second.totals.duplicate_count, 1);
});

test("zero results (empty feed) is a completed run with zero inserts", async () => {
  const db = new FakeDb();
  const { h } = handler(db, { [mof.endpoint]: rss("") });
  const body = await (await h(post({ sources: ["jp_mof_news"] }))).json();
  assert.equal(body.status, "completed");
  assert.equal(body.totals.fetched_count, 0);
  assert.equal(body.totals.inserted_count, 0);
});

test("DB write failure: 500, run finished as failed with a coded summary", async () => {
  const db = new FakeDb();
  db.failInsert = true;
  const { h } = handler(db, { [mof.endpoint]: rss(item("財務省のお知らせ（テスト用の十分な長さのタイトル）", "https://www.mof.go.jp/f.html")) });
  const response = await h(post({ sources: ["jp_mof_news"] }));
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(db.runs.get(body.run_id)!.status, "failed");
  assert.match(String(db.runs.get(body.run_id)!.error_summary), /RUN_FAILED:DB_RPC_FAILED:news_discovery_insert_signals/);
});

test("DB unavailable at start: 500 and no fetch happens", async () => {
  const db = new FakeDb();
  db.failBegin = true;
  const { h, fetch } = handler(db, { [mof.endpoint]: rss("") });
  assert.equal((await h(post({ sources: ["jp_mof_news"] }))).status, 500);
  assert.equal(fetch.calls.length, 0);
});

test("stocks_master unavailable: run continues without ticker matching and says so", async () => {
  const db = new FakeDb();
  const { h } = handler(db, { [mof.endpoint]: rss(item("トヨタ自動車に関する財務省のお知らせ（十分な長さ）", "https://www.mof.go.jp/g.html")) }, {
    loadStocks: () => Promise.reject(new Error("STOCKS_MASTER_READ_FAILED:503")),
  });
  const body = await (await h(post({ sources: ["jp_mof_news"] }))).json();
  assert.equal(body.status, "completed");
  assert.equal(body.totals.ticker_confirmed_count, 0);
  assert.equal(body.alias_index, null);
  assert.equal(db.runs.get(body.run_id)!.error_summary, "ALIAS_INDEX_UNAVAILABLE");
});

test("resolveSources rejects oversized lists", () => {
  assert.deepEqual(resolveSources({ sources: Array.from({ length: 51 }, () => "jp_mof_news") }), { error: "INVALID_SOURCES" });
});

// ---------------------------------------------------------------------------------------- Layer 3 search
import { InMemorySearchBudget, type ProviderResult, type WebSearchProvider } from "../_shared/news_discovery/web_search.ts";

class StubProvider implements WebSearchProvider {
  readonly name = "stub";
  readonly model = "stub-model";
  calls = 0;
  constructor(private readonly result: ProviderResult) {}
  search(): Promise<ProviderResult> {
    this.calls += 1;
    return Promise.resolve(this.result);
  }
}
const searchUsage = { model_calls: 1, web_search_calls: 1, input_tokens: 1, output_tokens: 1 };

test("search is off by default: no provider call even when a provider is configured", async () => {
  const db = new FakeDb();
  const provider = new StubProvider({ ok: true, results: [], rejected_unverified: 0, usage: searchUsage });
  const { h } = handler(db, { [mof.endpoint]: rss("") }, { searchProvider: provider, searchBudget: new InMemorySearchBudget(undefined, () => NOW) });
  const body = await (await h(post({ sources: ["jp_mof_news"] }))).json();
  assert.equal(provider.calls, 0);
  assert.equal(body.search.enabled, false);
  assert.equal(body.totals.ai_calls, 0);
});

test("search enabled without a provider: skipped and noted, run still completed", async () => {
  const db = new FakeDb();
  const { h } = handler(db, { [mof.endpoint]: rss("") });
  const body = await (await h(post({ sources: ["jp_mof_news"], search: { enabled: true } }))).json();
  assert.equal(body.status, "completed");
  assert.equal(body.search.note, "SEARCH_PROVIDER_NOT_CONFIGURED");
  assert.match(String(db.runs.get(body.run_id)!.error_summary), /SEARCH_PROVIDER_NOT_CONFIGURED/);
});

test("search enabled: anomaly trigger + rotation run under budget; results stored; counts in run totals", async () => {
  const db = new FakeDb();
  const provider = new StubProvider({
    ok: true,
    results: [{ url: "https://open.example/oil", title: "Oil jumps after pipeline outage in Gulf", publisher: "open.example" }],
    rejected_unverified: 0,
    usage: searchUsage,
  });
  const budget = new InMemorySearchBudget(undefined, () => NOW);
  const { h } = handler(db, { [mof.endpoint]: rss("") }, { searchProvider: provider, searchBudget: budget });
  const body = await (await h(post({ sources: ["jp_mof_news"], search: { enabled: true, anomalies: [{ instrument: "WTI", change_pct: 5 }] } }))).json();
  assert.equal(body.status, "completed");
  assert.equal(provider.calls, 2, "anomaly trigger + one rotation");
  assert.equal(body.totals.search_count, 2);
  assert.equal(body.totals.ai_calls, 2);
  assert.ok(body.totals.ai_calls <= body.totals.search_count);
  assert.equal(body.search.new_signals, 1, "second search returns the same URL -> duplicate");
  assert.equal(body.search.duplicates, 1);
  const stored = [...db.rows.values()].filter((row) => row.policy === "SEARCH_DISCOVERY");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].summary_hint, null);
  assert.equal(stored[0].title_display_allowed, false);
  assert.ok(stored[0].search_id);
  // A second run inside the cooldown does not search the same themes again.
  const again = await (await h(post({ sources: ["jp_mof_news"], search: { enabled: true, anomalies: [{ instrument: "WTI" }] } }))).json();
  assert.equal(provider.calls, 2);
  assert.deepEqual(again.search.denied.map((d: { reason: string }) => d.reason), ["duplicate_search_key", "duplicate_search_key"]);
});

test("search failures never fail or degrade the run", async () => {
  const db = new FakeDb();
  const provider = new StubProvider({ ok: false, code: "PROVIDER_HTTP_ERROR", status: 500, usage: { model_calls: 0, web_search_calls: 0, input_tokens: 0, output_tokens: 0 } });
  const { h } = handler(db, { [mof.endpoint]: rss(item("財務省のお知らせ（テスト用の十分な長さのタイトル）", "https://www.mof.go.jp/s.html")) }, {
    searchProvider: provider,
    searchBudget: new InMemorySearchBudget(undefined, () => NOW),
  });
  const body = await (await h(post({ sources: ["jp_mof_news"], search: { enabled: true } }))).json();
  assert.equal(body.status, "completed");
  assert.equal(body.totals.inserted_count, 1);
  assert.match(String(db.runs.get(body.run_id)!.error_summary), /PROVIDER_HTTP_ERROR/);
});

test("invalid search options are rejected", async () => {
  const db = new FakeDb();
  const { h } = handler(db, {});
  assert.equal((await h(post({ search: { anomalies: "WTI" } }))).status, 400);
  assert.equal((await h(post({ search: { anomalies: Array.from({ length: 11 }, () => ({ instrument: "WTI" })) } }))).status, 400);
});
