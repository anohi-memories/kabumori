import assert from "node:assert/strict";
import test from "node:test";
import { createObserverHandler } from "../../news-discovery-observer/observer_handler.ts";
import { OBSERVER_SECRET_HEADER } from "../../news-discovery-observer/observer_auth.ts";
import { HostRateGate } from "./fetcher.ts";
import { buildAliasIndex, matchTickers } from "./company_alias.ts";
import { publisherRestriction } from "./source_registry.ts";
import { postgrestRpcClient, type RpcClient, type RpcFunction, signalToRow } from "./supabase_store.ts";
import type { NewsSignal } from "./types.ts";
import { InMemorySearchBudget, OpenAiWebSearchProvider, parseOpenAiSearchResponse, safeSearchUrl, type SearchCompletion } from "./web_search.ts";

const url = "https://news.example/story";
const response = () => ({
  status: "completed",
  output: [
    { type: "web_search_call", status: "completed", action: { type: "search", sources: [{ url }] } },
    { type: "message", content: [{ type: "output_text", text: JSON.stringify({ items: [{ url, title: "Headline", publisher: null }] }), annotations: [] }] },
  ],
  usage: { input_tokens: 123, output_tokens: 45 },
});

test("N3 URL: reject local/IP/credentials/non-HTTP even if the tool cited them", () => {
  for (const unsafe of ["javascript:alert(1)", "data:text/plain,x", "file:///tmp/x", "not a URL",
    "http://localhost/x", "http://api.localhost/x", "http://127.0.0.1/x", "http://2130706433/x",
    "http://10.0.0.1/x", "http://172.16.0.1/x", "http://192.168.0.1/x", "http://169.254.169.254/x",
    "http://[::1]/x", "http://[::ffff:127.0.0.1]/x", "http://host.local/x", "https://user:pass@news.example/x"]) {
    assert.equal(safeSearchUrl(unsafe), null, unsafe);
    const raw = response();
    raw.output[0].action!.sources = [{ url: unsafe }];
    raw.output[1].content![0].text = JSON.stringify({ items: [{ url: unsafe, title: "x", publisher: null }] });
    assert.equal(parseOpenAiSearchResponse(raw)!.results.length, 0, unsafe);
  }
  assert.equal(safeSearchUrl("https://News.Example./story?utm_source=x"), url);
});

test("N3 publisher: trailing-dot/uppercase/subdomains blocked without lookalike suffix confusion", () => {
  for (const host of ["FT.COM", "ft.com.", "www.ft.com.", "news.ft.com"]) {
    assert.equal(publisherRestriction(`https://${host}/story`)?.scope, "no_access", host);
  }
  assert.equal(publisherRestriction("https://www3.nhk.or.jp./x")?.scope, "no_direct_fetch");
  for (const host of ["nhk.or.jp.evil.com", "evilnhk.or.jp", "ft.com.evil.com", "notft.com"]) {
    assert.equal(publisherRestriction(`https://${host}/x`), null, host);
  }
});

test("N3 response: partial/failed/missing status, incomplete tool, no tool and multiple tools fail closed", () => {
  for (const status of [undefined, "incomplete", "failed", "in_progress"]) {
    assert.equal(parseOpenAiSearchResponse({ ...response(), status }), null);
  }
  const raw = response();
  raw.output[0].status = "in_progress";
  assert.equal(parseOpenAiSearchResponse(raw), null);
  assert.equal(parseOpenAiSearchResponse({ ...response(), output: response().output.slice(1) }), null);
  assert.equal(parseOpenAiSearchResponse({ ...response(), output: [...response().output, response().output[0]] }), null);
});

test("N3 response: malformed items/content/annotations never escape as exceptions", () => {
  for (const text of ["null", '{"items":null}', '{"items":[null,123,"x"]}', '{"items":[]}']) {
    const raw = response();
    raw.output[1].content![0].text = text;
    assert.doesNotThrow(() => parseOpenAiSearchResponse(raw));
  }
  const raw = response();
  const output = raw.output as unknown as Array<Record<string, unknown>>;
  output.push(null as unknown as Record<string, unknown>);
  output[1].content = [null, { type: "output_text", text: '{"items":[]}', annotations: [null] }];
  assert.equal(parseOpenAiSearchResponse(raw)!.results.length, 0);
});

test("N3 provider: invalid partial response preserves observed calls and tokens, no retry", async () => {
  let calls = 0;
  const provider = new OpenAiWebSearchProvider("mock-key", undefined, () => {
    calls++;
    return Promise.resolve(Response.json({ ...response(), status: "incomplete" }));
  });
  const result = await provider.search({ query: "q", lane: "WORLD", maxResults: 8, recencyHours: 6, now: new Date() });
  assert.equal(result.ok, false);
  assert.deepEqual(result.usage, { model_calls: 1, web_search_calls: 1, input_tokens: 123, output_tokens: 45 });
  assert.equal(calls, 1);
});

test("N3 RPC: begin/reserve must not replay lost acknowledgements or 5xx", async () => {
  for (const fn of ["news_discovery_begin_run", "news_discovery_reserve_search"] as const) {
    for (const transportError of [true, false]) {
      let calls = 0;
      const client = postgrestRpcClient("https://mock.example", "mock-key", { retries: 99, fetchImpl: () => {
        calls++;
        return transportError ? Promise.reject(new Error("ack lost")) : Promise.resolve(new Response("{}", { status: 503 }));
      } });
      await assert.rejects(() => client.call(fn, {}));
      assert.equal(calls, 1, `${fn}:${transportError}`);
    }
  }
});

test("N3 budget mirror: cross-run/lane/day and rotation parent cannot escalate; completion once", async () => {
  let now = new Date("2026-09-28T06:00:00Z");
  const budget = new InMemorySearchBudget(undefined, () => now);
  const root = { run_id: "run-a", lane: "WORLD" as const, reason: "trigger_discovery_signal" as const,
    search_key: "signal:war:x", query: "q", triggered_by: "x", parent_search_id: null };
  const parent = await budget.reserve(root);
  assert.ok(parent.allowed);
  const escalation = { ...root, reason: "escalation" as const, parent_search_id: parent.search_id };
  for (const patch of [{ run_id: "run-b" }, { lane: "ENERGY" as const }]) {
    const result = await budget.reserve({ ...escalation, ...patch });
    assert.equal(!result.allowed && result.reason, "bad_parent");
  }
  const completion: SearchCompletion = { search_id: parent.search_id, status: "succeeded", error_code: null,
    result_count: 0, new_signal_count: 0, useful_signal_count: 0, duplicate_count: 0, restricted_count: 0,
    policy_blocked_count: 0, rejected_unverified_count: 0,
    usage: { model_calls: 1, web_search_calls: 1, input_tokens: 0, output_tokens: 0 } };
  await budget.complete(completion);
  await budget.complete({ ...completion, status: "failed" });
  assert.equal(budget.completions.length, 1);
  now = new Date("2026-09-28T15:00:00Z");
  const stale = await budget.reserve(escalation);
  assert.equal(!stale.allowed && stale.reason, "bad_parent");
  const rotation = await budget.reserve({ ...root, search_key: "rotation:WORLD", reason: "scheduled_rotation" });
  assert.ok(rotation.allowed);
  const badRoot = await budget.reserve({ ...escalation, search_key: "rotation:WORLD", parent_search_id: rotation.search_id });
  assert.equal(!badRoot.allowed && badRoot.reason, "bad_parent");
});

test("N3 alias regressions: recall/database/politician headlines never confirm unrelated tickers", () => {
  const index = buildAliasIndex([
    { ticker_code: "7752", company_name: "リコー" },
    { ticker_code: "4477", company_name: "ＢＡＳＥ" },
    { ticker_code: "8418", company_name: "山口フィナンシャルグループ" },
  ]);
  for (const title of ["リコール製品で火災", "新しいデータベースの運用を開始", "山口政務官が記者会見"]) {
    assert.deepEqual(matchTickers({ title }, index).filter((item) => item.status === "confirmed"), [], title);
  }
});

test("N3 discovery row: raw_reference cannot smuggle body/summary/image fields", () => {
  const row = signalToRow({ discovery_only: true, source_url: url, canonical_url: url, ticker_candidates: [], entities: [], raw_reference: {
    feed_url: "https://source.example/feed", item_index: 1, body: "forbidden", summary: "forbidden", image: "forbidden",
  } } as unknown as NewsSignal);
  assert.deepEqual(row.raw_reference, { feed_url: "https://source.example/feed", item_index: 1 });
});

const secret = "A".repeat(43);
function observer() {
  const calls: RpcFunction[] = [];
  let fetches = 0;
  const rpc: RpcClient = { call(fn) {
    calls.push(fn);
    if (fn === "news_discovery_begin_run") return Promise.resolve({ run_id: "00000000-0000-4000-8000-000000000001" });
    if (fn === "news_discovery_recent_for_grouping") return Promise.resolve([]);
    if (fn === "news_discovery_finish_run") return Promise.resolve({ finished: true });
    throw new Error(`unexpected RPC ${fn}`);
  } };
  const handle = createObserverHandler({ observerSecret: secret, rpc, loadStocks: () => Promise.resolve([]),
    fetchImpl: () => { fetches++; return Promise.resolve(new Response("limited", { status: 429 })); },
    gate: new HostRateGate(() => 0, () => Promise.resolve()), log: () => {} });
  return { calls, handle, fetches: () => fetches };
}
const request = (body: unknown) => new Request("https://mock.example", { method: "POST",
  headers: { [OBSERVER_SECRET_HEADER]: secret }, body: JSON.stringify(body) });

test("N3 request: malformed search/anomaly and free query rejected before DB or fetch", async () => {
  const { handle, calls, fetches } = observer();
  for (const search of [null, [], { enabled: "true" }, { scheduled: "false" }, { query: "arbitrary free query" },
    { anomalies: [null] }, { anomalies: [{ instrument: 1 }] }, { anomalies: [{ instrument: "WTI", change_pct: "query injection" }] },
    { anomalies: [{ instrument: "WTI", query: "arbitrary" }] }]) {
    assert.equal((await handle(request({ sources: [], search }))).status, 400);
  }
  assert.equal((await handle(request({ include_gdelt: "false" }))).status, 400);
  assert.equal(calls.length, 0);
  assert.equal(fetches(), 0);
});

test("N3 GDELT-only 429: optional-source failure is recorded, no run failure or AI call", async () => {
  const { handle, fetches } = observer();
  const result = await (await handle(request({ sources: ["gdelt_doc"], gdelt_queries: 1 }))).json();
  assert.equal(result.status, "completed");
  assert.equal(result.totals.ai_calls, 0);
  assert.equal(result.totals.search_count, 0);
  assert.equal(fetches(), 1);
});
