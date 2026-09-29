import assert from "node:assert/strict";
import test from "node:test";
import { buildAliasIndex } from "./company_alias.ts";
import { HostRateGate } from "./fetcher.ts";
import { holdingNewsCandidates } from "./holdings.ts";
import { filterItem, runDiscovery, signalUrlKey, summarizeRates, titleSimilarity } from "./pipeline.ts";
import { fetchableSources, NEWS_SOURCE_REGISTRY, sourceById, validateRegistry } from "./source_registry.ts";
import { InMemoryNewsSignalStore } from "./store.ts";
import { classifyTopics, extractEntities } from "./topics.ts";
import type { RawItem, SourceDefinition } from "./types.ts";

const NOW = new Date("2026-09-28T06:00:00Z");
const gate = () => new HostRateGate(() => 0, () => Promise.resolve());
const aliasIndex = buildAliasIndex([
  { ticker_code: "7203", company_name: "トヨタ自動車" },
  { ticker_code: "7974", company_name: "任天堂" },
]);

function rss(items: string): string {
  return `<?xml version="1.0"?><rss><channel><title>x</title>${items}</channel></rss>`;
}
function item(title: string, link: string, date = "Sun, 28 Sep 2026 03:00:00 GMT", extra = ""): string {
  return `<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate>${extra}</item>`;
}

function routeFetch(routes: Record<string, string | number>) {
  const calls: string[] = [];
  const impl = (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    const value = key === undefined ? 404 : routes[key];
    return Promise.resolve(typeof value === "number" ? new Response("err", { status: value }) : new Response(value));
  };
  return { impl, calls };
}

const fed = sourceById("us_fed_press")!;
const mof = sourceById("jp_mof_news")!;
const caa = sourceById("jp_caa_news")!;

test("registry policy is structurally valid and N2 fetches only allowed sources", () => {
  assert.deepEqual(validateRegistry(), []);
  const fetchable = fetchableSources().map((s) => s.source_id);
  for (const id of ["al_jazeera", "nhk_news", "jiji_rss", "tdnet_list", "jpx_rss", "boj_whatsnew", "bbc_world", "un_news", "prtimes_rss"]) {
    assert.ok(!fetchable.includes(id), `${id} must not be fetchable`);
  }
  assert.ok(!fetchable.includes("jp_edinet_documents"), "EDINET needs a key we do not have");
  assert.ok(fetchable.includes("gdelt_doc"));
  const gdelt = sourceById("gdelt_doc")!;
  assert.equal(gdelt.policy, "DISCOVERY_ONLY");
  assert.equal(gdelt.image_usage_allowed || gdelt.article_body_allowed, false);
  assert.ok(NEWS_SOURCE_REGISTRY.filter((s) => s.policy === "DIRECT_SOURCE").every((s) => s.commercial_usage_status.startsWith("allowed")));
});

test("validateRegistry rejects an enabled source with prohibited terms", () => {
  const bad: SourceDefinition = { ...sourceById("jp_mof_news")!, source_id: "bad", commercial_usage_status: "prohibited" };
  assert.ok(validateRegistry([bad]).some((p) => p.includes("prohibited")));
});

test("one failing source does not stop the run; stats record the failure", async () => {
  const { impl } = routeFetch({
    [fed.endpoint]: 503,
    [mof.endpoint]: rss(item("財務省、トヨタ自動車に関する発表", "https://www.mof.go.jp/a.html")),
  });
  const store = new InMemoryNewsSignalStore(signalUrlKey);
  const result = await runDiscovery({ sources: [fed, mof], store, aliasIndex, fetchImpl: impl, gate: gate(), now: () => NOW });
  assert.equal(result.totals.failed_requests, 1);
  assert.equal(result.stats[0].failures[0].code, "HTTP_ERROR");
  assert.equal(result.totals.kept, 1);
  assert.equal(result.ai_calls, 0);
  assert.equal(result.web_search_calls, 0);
  assert.equal(result.signals[0].ticker_candidates[0].ticker, "7203");
});

test("dedupe: same URL, tracking-parameter variant, same title from another source, repeat run", async () => {
  const title = "消費者庁、任天堂の製品について注意喚起を公表しました";
  const { impl } = routeFetch({
    [mof.endpoint]: rss(
      item(title, "https://www.caa.go.jp/notice/1?utm_source=rss") +
        item(title, "https://www.caa.go.jp/notice/1") + // same URL after canonicalization
        item("別の発表でタイトルは十分に長いものです", "http://caa.go.jp/notice/2") +
        item("別の発表でタイトルは十分に長いものです", "https://www.caa.go.jp/notice/2/"), // www/scheme/slash variant
    ),
    [caa.endpoint]: rss(item(`${title} - 消費者庁`, "https://www.caa.go.jp/other-path/1")), // same title, other source/URL
  });
  const store = new InMemoryNewsSignalStore(signalUrlKey);
  const first = await runDiscovery({ sources: [mof, caa], store, aliasIndex, fetchImpl: impl, gate: gate(), now: () => NOW });
  assert.equal(first.totals.kept, 2);
  assert.equal(first.totals.duplicates.canonical_url, 1);
  assert.equal(first.totals.duplicates.normalized_url, 1);
  assert.equal(first.totals.duplicates.title_fingerprint, 1);
  const second = await runDiscovery({ sources: [mof, caa], store, aliasIndex, fetchImpl: impl, gate: gate(), now: () => NOW });
  assert.equal(second.totals.kept, 0, "a repeat run adds nothing");
});

test("generic short titles are not deduped by title (JMA 震度速報 repeats for different quakes)", async () => {
  const jma = sourceById("jp_jma_eqvol")!;
  const atom = `<feed><entry><title>震度速報</title><id>a</id><updated>2026-09-28T05:00:00Z</updated><link href="https://www.data.jma.go.jp/x/1.xml"/></entry>
<entry><title>震度速報</title><id>b</id><updated>2026-09-28T05:10:00Z</updated><link href="https://www.data.jma.go.jp/x/2.xml"/></entry>
<entry><title>降灰予報（定時）</title><id>c</id><updated>2026-09-28T05:10:00Z</updated><link href="https://www.data.jma.go.jp/x/3.xml"/></entry></feed>`;
  const { impl } = routeFetch({ [jma.endpoint]: atom });
  const result = await runDiscovery({ sources: [jma], store: new InMemoryNewsSignalStore(signalUrlKey), aliasIndex, fetchImpl: impl, gate: gate(), now: () => NOW });
  assert.equal(result.totals.kept, 2);
  assert.equal(result.totals.filtered, 1, "routine ash-fall forecast filtered");
  assert.ok(result.signals.every((s) => s.published_at === null && s.updated_at !== null), "Atom updated is not relabelled as published");
  assert.ok(result.signals.every((s) => s.topics.includes("disaster")));
});

test("published_at is never invented; date-only and future timestamps are flagged", async () => {
  const fr = sourceById("us_federal_register")!;
  const { impl } = routeFetch({
    [fr.endpoint]: JSON.stringify({ results: [{ title: "Export Administration Regulations: Entity List Additions", html_url: "https://www.federalregister.gov/d/2026-1",
      document_number: "2026-1", publication_date: "2026-09-28" }] }),
    [mof.endpoint]: rss(item("日付のない財務省のお知らせ（テスト用に十分な長さ）", "https://www.mof.go.jp/n.html", "") +
      item("未来時刻の財務省のお知らせ（テスト用に十分な長さ）", "https://www.mof.go.jp/f.html", "Sun, 28 Sep 2026 12:00:00 GMT")),
  });
  const result = await runDiscovery({ sources: [fr, mof], store: new InMemoryNewsSignalStore(signalUrlKey), aliasIndex, fetchImpl: impl, gate: gate(), now: () => NOW });
  const [frSignal, noDate, future] = result.signals;
  assert.equal(frSignal.published_at, "2026-09-28");
  assert.equal(frSignal.published_at_precision, "date");
  assert.ok(frSignal.needs_verification.includes("date_only_precision"));
  assert.ok(frSignal.topics.includes("sanctions") && frSignal.topics.includes("regulation"));
  assert.equal(noDate.published_at, null);
  assert.ok(noDate.needs_verification.includes("no_published_at"));
  assert.ok(future.needs_verification.includes("future_timestamp"));
  assert.equal(future.published_at, "2026-09-28T12:00:00.000Z", "kept as given, only flagged");
});

test("GDELT signals are discovery-only: no summary, no image, flagged for a primary source", async () => {
  const gdelt = sourceById("gdelt_doc")!;
  const { impl, calls } = routeFetch({
    [gdelt.endpoint]: JSON.stringify({ articles: [{ url: "https://news.example/toyota", title: "Toyota halts output at plant after fire",
      seendate: "20260928T050000Z", socialimage: "https://news.example/i.jpg", domain: "news.example", language: "English", sourcecountry: "Japan" }] }),
  });
  const result = await runDiscovery({
    sources: [gdelt],
    store: new InMemoryNewsSignalStore(signalUrlKey),
    aliasIndex,
    fetchImpl: impl,
    gate: gate(),
    now: () => NOW,
    gdeltQueries: [{ key: "t", query: "Toyota", timespan: "1h", maxrecords: 10 }],
  });
  const [signal] = result.signals;
  assert.equal(calls.length, 1);
  assert.equal(signal.discovery_only, true);
  assert.equal(signal.policy, "DISCOVERY_ONLY");
  assert.equal(signal.summary_hint, null);
  assert.equal(signal.image_url, null);
  assert.equal(signal.published_at, null);
  assert.equal(signal.detected_at, "2026-09-28T05:00:00.000Z");
  assert.equal(signal.discovered_via, "gdelt:t");
  assert.ok(signal.needs_verification.includes("discovery_only_needs_primary"));
  assert.ok(signal.topics.includes("supply_chain"));
  assert.equal(signal.ticker_candidates[0].ticker, "7203");
  // Discovery-only signals are not handed to holdings unless explicitly asked.
  assert.deepEqual(holdingNewsCandidates(result.signals, [{ user_id: "u1", ticker_code: "7203" }]), []);
});

test("image_url is recorded only when the source allows images (N2 DIRECT sources do not)", async () => {
  const { impl } = routeFetch({
    [mof.endpoint]: rss(item("画像付きの財務省のお知らせ（十分な長さのタイトル）", "https://www.mof.go.jp/i.html", undefined,
      `<enclosure url="https://www.mof.go.jp/i.jpg" type="image/jpeg"/>`)),
  });
  const result = await runDiscovery({ sources: [mof], store: new InMemoryNewsSignalStore(signalUrlKey), aliasIndex, fetchImpl: impl, gate: gate(), now: () => NOW });
  assert.equal(result.signals[0].image_url, null);
  assert.equal(result.signals[0].image_usage_allowed, false);
  const rates = summarizeRates(result.totals);
  assert.equal(rates.thumbnail_rate, 0);
  assert.equal(rates.published_at_rate, 1);
});

test("same_event_group links similar titles from different sources", async () => {
  const { impl } = routeFetch({
    [fed.endpoint]: rss(item("Federal Reserve announces new Treasury market liquidity facility today", "https://www.federalreserve.gov/a.htm")),
    [sourceById("us_ustr")!.endpoint]: rss(item("Federal Reserve announces new Treasury market liquidity facility", "https://ustr.gov/b")),
  });
  const result = await runDiscovery({ sources: [fed, sourceById("us_ustr")!], store: new InMemoryNewsSignalStore(signalUrlKey), aliasIndex, fetchImpl: impl, gate: gate(), now: () => NOW });
  assert.equal(result.signals.length, 2);
  assert.equal(result.signals[1].same_event_group, result.signals[0].id);
  assert.ok(titleSimilarity("日銀が利上げを決定", "日銀、利上げ決定") > 0.5);
});

test("holdings fan-out is a join over confirmed tickers (not wired to real users)", async () => {
  const { impl } = routeFetch({ [mof.endpoint]: rss(item("任天堂に関する財務省のお知らせ（十分な長さ）", "https://www.mof.go.jp/n7974.html")) });
  const result = await runDiscovery({ sources: [mof], store: new InMemoryNewsSignalStore(signalUrlKey), aliasIndex, fetchImpl: impl, gate: gate(), now: () => NOW });
  const out = holdingNewsCandidates(result.signals, [{ user_id: "u1", ticker_code: "7974" }, { user_id: "u2", ticker_code: "7203" }]);
  assert.deepEqual(out.map((o) => [o.user_id, o.ticker]), [["u1", "7974"]]);
});

test("topic taxonomy and entities (ja/en), with acronym case-sensitivity", () => {
  assert.deepEqual(classifyTopics("日銀が利上げ、円高進む").sort(), ["fx", "monetary_policy"]);
  assert.ok(classifyTopics("Tanker attacked in the Red Sea; crude jumps").includes("oil"));
  assert.ok(classifyTopics("OPEC+ agrees to output cut").includes("oil"));
  assert.ok(!classifyTopics("The committee fed the data into the model").includes("monetary_policy"));
  assert.ok(!extractEntities("they fed the cat").some((e) => e.value === "Federal Reserve"));
  assert.ok(extractEntities("The Fed held rates").some((e) => e.value === "Federal Reserve"));
  assert.ok(extractEntities("ホルムズ海峡でタンカー攻撃").some((e) => e.kind === "chokepoint"));
  assert.ok(!extractEntities("金曜日の会合").some((e) => e.value === "gold"), "金 alone is not gold");
  assert.ok(!classifyTopics("Establishment of Class E Airspace; designation of controlled airspace").includes("sanctions"));
  assert.ok(classifyTopics("Additions to the Entity List").includes("sanctions"));
});

test("JMA extra keeps special warnings only", () => {
  const extra = sourceById("jp_jma_extra")!;
  const raw = (title: string, summary: string | null): RawItem => ({
    title, link: "https://www.data.jma.go.jp/x.xml", external_id: null, summary, published_raw: null, updated_raw: null,
    seen_raw: null, structured_ticker: null, image_url: null, publisher: null, language: null, country: null,
  });
  assert.equal(filterItem(extra, raw("気象特別警報・警報・注意報", "【東京都気象警報・注意報】")).keep, false);
  assert.equal(filterItem(extra, raw("気象特別警報・警報・注意報", "【大雨特別警報】")).keep, true);
  assert.equal(filterItem(extra, raw("記録的短時間大雨情報", null)).keep, true);
});

test("same-source same-title documents are kept (官邸 missile instruction, Federal Register notices)", async () => {
  const kantei = sourceById("jp_kantei_news")!;
  const title = "高市総理は北朝鮮からの弾道ミサイルの可能性があるものの発射に関する総理指示を行いました";
  const { impl } = routeFetch({
    [kantei.endpoint]: `<rdf:RDF><item rdf:about="https://www.kantei.go.jp/jp/105/discourse/20260920shiji2.html"><title>${title}</title><dc:date>2026-09-20T08:00:00+09:00</dc:date></item>` +
      `<item rdf:about="https://www.kantei.go.jp/jp/105/discourse/20260928shiji.html"><title>${title}</title><dc:date>2026-09-28T08:00:00+09:00</dc:date></item></rdf:RDF>`,
  });
  const result = await runDiscovery({ sources: [kantei], store: new InMemoryNewsSignalStore(signalUrlKey), aliasIndex, fetchImpl: impl, gate: gate(), now: () => NOW });
  assert.equal(result.totals.kept, 2, "a new launch must never be swallowed by an older identical title");
  assert.ok(result.signals.every((s) => s.topics.includes("war")));
});

test("a source reusing one URL for a new title yields a new signal; same URL + same title is a duplicate", async () => {
  const esri = sourceById("jp_esri")!;
  const { impl } = routeFetch({
    [esri.endpoint]: rss(item("景気動向指数（令和8年7月分速報）の公表について", "https://www.esri.cao.go.jp/jp/stat/di/di.html") +
      item("景気動向指数（令和8年6月分速報からの改訂状況）", "https://www.esri.cao.go.jp/jp/stat/di/di.html") +
      item("景気動向指数（令和8年6月分速報からの改訂状況）", "https://www.esri.cao.go.jp/jp/stat/di/di.html")),
  });
  const result = await runDiscovery({ sources: [esri], store: new InMemoryNewsSignalStore(signalUrlKey), aliasIndex, fetchImpl: impl, gate: gate(), now: () => NOW });
  assert.equal(result.totals.kept, 2);
  assert.equal(result.totals.duplicates.canonical_url, 1);
  assert.notEqual(result.signals[0].id, result.signals[1].id);
});
