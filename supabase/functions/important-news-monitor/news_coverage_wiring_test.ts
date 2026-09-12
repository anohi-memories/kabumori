import assert from "node:assert/strict";
import test from "node:test";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import {
  BREAKING_MARKET_QUERIES,
  BREAKING_MARKET_SOURCE_DOMAINS,
  CRITICAL_BREAKING_MARKET_QUERY_KEY,
  isFixedBreakingMarketQuery,
  MAX_BREAKING_MARKET_SEARCHES_PER_FETCH,
  maxUnwatchedMinutes,
  selectBreakingMarketQueriesForCycle,
} from "./breaking_market_source_fetchers.ts";
import {
  isSignificantJmaItem,
  MARKET_MACRO_ALLOWED_DOMAINS,
  MARKET_MACRO_SOURCES,
  parseMarketMacroRss,
} from "./market_macro_source_fetchers.ts";
import { IMPORTANT_NEWS_CATEGORIES } from "./news_candidate_logic.ts";
import {
  classifyCollectionCoverage,
  classifyCoverage,
  COVERAGE_CATEGORIES,
  type CoverageCategory,
} from "./news_coverage_logic.ts";

const HERE = dirname(fromFileUrl(import.meta.url));
const MIGRATION = join(HERE, "../../migrations/20260912180000_news_coverage_classification.sql");
const INDEX = join(HERE, "index.ts");

const NOW = new Date("2026-09-12T03:00:00Z");
const FRESH = "2026-09-12T02:30:00Z";

// ---------------------------------------------------------------------------
// A. Collection: query coverage and search budget
// ---------------------------------------------------------------------------

test("every required Phase 2 subject has an explicit search topic", () => {
  const all = BREAKING_MARKET_QUERIES.map((query) => query.searchQuery.toLowerCase()).join("\n");
  for (const term of [
    "north korea", "missile", "ballistic", "j-alert", "eez",
    "hormuz", "tanker", "blockade", "red sea", "suez",
    "iran", "israel", "taiwan",
    "oil supply disruption", "crude oil supply", "opec",
    "earthquake", "tsunami", "typhoon", "blackout",
    "exchange outage", "clearing", "settlement failure", "bank run",
  ]) {
    assert.ok(all.includes(term), `missing search vocabulary: ${term}`);
  }
  // Emergency central-bank action stays in the existing critical topic.
  const critical = BREAKING_MARKET_QUERIES.find((query) => query.key === CRITICAL_BREAKING_MARKET_QUERY_KEY)!;
  assert.match(critical.searchQuery.toLowerCase(), /emergency boj|emergency|rate decision/);
});

test("the search budget grows to 4 per cycle, with 3 fixed topics and a stated worst-case latency", () => {
  assert.equal(MAX_BREAKING_MARKET_SEARCHES_PER_FETCH, 4);
  const fixed = BREAKING_MARKET_QUERIES.filter(isFixedBreakingMarketQuery).map((query) => query.key);
  assert.deepEqual(fixed, ["critical_market_events", "japan_security_emergency", "disaster_infrastructure"]);
  // 8 rotating topics over 1 rotating slot every 20 minutes.
  assert.equal(maxUnwatchedMinutes(), 160);
  const selected = selectBreakingMarketQueriesForCycle(BREAKING_MARKET_QUERIES, NOW);
  assert.equal(selected.length, 4);
  assert.deepEqual(selected.slice(0, 3).map((query) => query.key), fixed);
});

test("the fixed topics run in every cycle and the rotating ones all come round", () => {
  const seen = new Set<string>();
  for (let cycle = 0; cycle < BREAKING_MARKET_QUERIES.length + 2; cycle += 1) {
    const at = new Date(NOW.getTime() + cycle * 20 * 60 * 1000);
    const selected = selectBreakingMarketQueriesForCycle(BREAKING_MARKET_QUERIES, at);
    assert.ok(selected.length <= MAX_BREAKING_MARKET_SEARCHES_PER_FETCH);
    assert.equal(new Set(selected.map((query) => query.key)).size, selected.length, "no duplicate in a cycle");
    for (const query of BREAKING_MARKET_QUERIES.filter(isFixedBreakingMarketQuery)) {
      assert.ok(selected.some((item) => item.key === query.key), `${query.key} must run every cycle`);
    }
    selected.forEach((query) => seen.add(query.key));
  }
  for (const query of BREAKING_MARKET_QUERIES) {
    assert.ok(seen.has(query.key), `${query.key} never ran`);
  }
});

test("a tighter budget never exceeds the ceiling, even with more fixed topics than slots", () => {
  for (const max of [1, 2, 3]) {
    const selected = selectBreakingMarketQueriesForCycle(BREAKING_MARKET_QUERIES, NOW, max);
    assert.equal(selected.length, max);
  }
});

test("Japanese primary hosts are allowed as breaking_market sources", () => {
  for (const host of ["jma.go.jp", "mod.go.jp", "kantei.go.jp", "jpx.co.jp"]) {
    assert.ok(BREAKING_MARKET_SOURCE_DOMAINS.includes(host), host);
  }
  // Existing hosts are kept.
  for (const host of ["reuters.com", "apnews.com", "centcom.mil", "bls.gov"]) {
    assert.ok(BREAKING_MARKET_SOURCE_DOMAINS.includes(host), host);
  }
});

// ---------------------------------------------------------------------------
// B. Primary source: the JMA feed and its filter
// ---------------------------------------------------------------------------

test("the JMA earthquake/volcano feed is registered and its host is allowed", () => {
  const jma = MARKET_MACRO_SOURCES.find((source) => source.key === "jma_eqvol");
  assert.ok(jma, "jma_eqvol source must exist");
  assert.equal(jma!.feedUrl, "https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml");
  assert.equal(jma!.defaultCategory, "disaster");
  assert.ok(MARKET_MACRO_ALLOWED_DOMAINS.includes("jma.go.jp"));
  // The five existing feeds are untouched.
  for (const key of ["boj", "fed", "ustr", "un_peace_security", "eia"]) {
    assert.ok(MARKET_MACRO_SOURCES.some((source) => source.key === key), key);
  }
});

test("the JMA filter keeps serious quakes, tsunami and eruptions and drops routine bulletins", () => {
  assert.equal(isSignificantJmaItem("震度速報", "【震度速報】１２日０３時００分ころ、地震がありました。最大震度６強"), true);
  assert.equal(isSignificantJmaItem("津波警報・注意報・予報", "大津波警報を発表しました"), true);
  assert.equal(isSignificantJmaItem("噴火警報・予報", "噴火警戒レベル４（避難準備）に引上げ"), true);
  // Routine: an advisory, a scheduled ash forecast, a weak quake.
  assert.equal(isSignificantJmaItem("降灰予報（定時）", "現在、噴火警戒レベル２（火口周辺規制）です"), false);
  assert.equal(isSignificantJmaItem("気象特別警報・警報・注意報", "波浪注意報を発表"), false);
  assert.equal(isSignificantJmaItem("震度速報", "最大震度２"), false);
  assert.equal(isSignificantJmaItem("地震情報（顕著な地震の震源要素更新のお知らせ）", ""), false);
});

test("the JMA filter is applied by the feed parser (real Atom shape)", () => {
  const jma = MARKET_MACRO_SOURCES.find((source) => source.key === "jma_eqvol")!;
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>降灰予報（定時）</title>
    <id>https://www.data.jma.go.jp/developer/xml/data/a.xml</id>
    <updated>${FRESH}</updated>
    <link type="application/xml" href="https://www.data.jma.go.jp/developer/xml/data/a.xml"/>
    <content type="text">【火山名 口永良部島 降灰予報（定時）】現在、噴火警戒レベル２（火口周辺規制）です。</content>
  </entry>
  <entry>
    <title>津波警報・注意報・予報</title>
    <id>https://www.data.jma.go.jp/developer/xml/data/b.xml</id>
    <updated>${FRESH}</updated>
    <link type="application/xml" href="https://www.data.jma.go.jp/developer/xml/data/b.xml"/>
    <content type="text">大津波警報を発表しました。沿岸から離れてください。</content>
  </entry>
</feed>`;
  const candidates = parseMarketMacroRss(jma, xml, NOW);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].title, "津波警報・注意報・予報");
  assert.equal(candidates[0].category, "disaster");
  assert.equal(candidates[0].entityKey, "disaster:tsunami");
  assert.equal(candidates[0].sourceType, "market_macro");
  assert.equal(candidates[0].companyCode, null);
});

// ---------------------------------------------------------------------------
// C. Classification of the events Phase 1 lost (anonymised real headlines)
// ---------------------------------------------------------------------------

function collection(title: string, extra: Partial<Parameters<typeof classifyCollectionCoverage>[0]> = {}) {
  return classifyCollectionCoverage({
    category: "major_security_incident",
    title,
    sourceUrl: "https://www.reuters.com/world/x",
    publishedAt: FRESH,
    now: NOW,
    ...extra,
  });
}

test("North Korea missile launch: candidate-eligible, geopolitics, emergency", () => {
  const decision = collection("North Korea fires ballistic missile that fell inside Japan's EEZ, government says");
  assert.ok(decision.categories.includes("geopolitics"));
  assert.equal(decision.severity, "emergency");
  assert.equal(decision.emergencyClass, "missile_near_japan");
});

test("J-Alert bulletin from the Japanese government: geopolitics + emergency", () => {
  const decision = collection("Jアラート発令 北朝鮮から弾道ミサイル発射 北海道方向へ", {
    sourceUrl: "https://www.kantei.go.jp/jp/emergency/1.html",
  });
  assert.ok(decision.categories.includes("geopolitics"));
  assert.equal(decision.emergencyClass, "missile_near_japan");
});

test("Hormuz tanker attack: shipping_logistics + geopolitics; emergency only when severe", () => {
  const attack = collection(
    "Tanker reportedly struck by unknown projectile in northern Persian Gulf amid Iran tensions",
    { category: "geopolitics", bodySummary: "Crude oil rose after the attack near the Strait of Hormuz." },
  );
  assert.ok(attack.categories.includes("shipping_logistics"));
  assert.ok(attack.categories.includes("geopolitics"));
  assert.ok(attack.categories.includes("oil_energy"));
  // An attack inside a chokepoint is itself an emergency: this is exactly the
  // 2026-09-09 item production stored and then hid at severity low.
  assert.equal(attack.severity, "emergency");
  assert.equal(attack.emergencyClass, "chokepoint_disruption");
  const closure = collection("Iran blockades the Strait of Hormuz, halting tanker traffic", { category: "geopolitics" });
  assert.equal(closure.emergencyClass, "chokepoint_disruption");
  // Shipping news away from a chokepoint, or with no severity wording, is not.
  assert.equal(collection("Shipping rates ease on the Suez route as traffic normalises", { category: "geopolitics" }).severity, null);
  assert.equal(collection("Tanker charter rates rise on strong Asian demand", { category: "geopolitics" }).severity, null);
});

test("oil supply disruption maps to oil_energy", () => {
  const decision = collection("Saudi refinery shutdown after attack cuts crude supply", { category: "geopolitics" });
  assert.ok(decision.categories.includes("oil_energy"));
  assert.equal(decision.emergencyClass, "oil_supply_disruption");
});

test("earthquake and tsunami map to disaster, with emergency for a serious one", () => {
  const decision = collection("震度6強の地震 大津波警報を発表 沿岸に避難指示", { category: "disaster" });
  assert.ok(decision.categories.includes("disaster"));
  assert.equal(decision.emergencyClass, "major_disaster");
  const drill = collection("Japan holds nationwide earthquake preparedness drill", { category: "disaster" });
  assert.ok(drill.categories.includes("disaster"));
  assert.equal(drill.severity, null);
});

test("an emergency central-bank action maps to monetary_policy", () => {
  const decision = collection("Federal Reserve announces emergency intermeeting rate cut", { category: "frb" });
  assert.ok(decision.categories.includes("monetary_policy"));
  assert.equal(decision.emergencyClass, "emergency_monetary_action");
});

test("ordinary low-impact geopolitical coverage is not escalated", () => {
  for (const title of [
    "Security Council LIVE: Ambassadors mark 9/11 with counter-terrorism push",
    "Terrorist propaganda is outpacing global efforts to stop it, UN report says",
    "Agencies seek comment on proposed third-party risk management guidance",
  ]) {
    const decision = collection(title, { category: "geopolitics" });
    assert.equal(decision.severity, null, title);
    assert.equal(decision.emergencyClass, null, title);
  }
});

test("'disaster' is a real category in the enum and every coverage category is reachable", () => {
  assert.ok((IMPORTANT_NEWS_CATEGORIES as readonly string[]).includes("disaster"));
  const reachable = new Set<CoverageCategory>();
  for (const category of IMPORTANT_NEWS_CATEGORIES) {
    classifyCollectionCoverage({
      category, title: "x", sourceUrl: "https://www.reuters.com/x", publishedAt: FRESH, now: NOW,
    }).categories.forEach((item) => reachable.add(item));
  }
  // Categories only reachable through wording are covered by the keyword rules.
  for (const category of COVERAGE_CATEGORIES) {
    const byKeyword = classifyCollectionCoverage({
      category: "other_market_moving",
      title: {
        geopolitics: "missile launch", disaster: "tsunami warning", monetary_policy: "FOMC decision",
        fx: "yen intervention", rates: "10-year JGB yield", oil_energy: "crude oil OPEC",
        commodities: "gold copper", shipping_logistics: "Hormuz tanker", semiconductors: "semiconductor wafer",
        ai_tech: "AI data center", us_market: "Nasdaq payrolls", japan_market: "Nikkei Topix",
        regulation_policy: "tariff sanction", corporate: "決算", earnings: "決算 業績予想",
        financial_system: "exchange outage clearing",
      }[category],
      sourceUrl: "https://www.reuters.com/x", publishedAt: FRESH, now: NOW,
    }).categories;
    assert.ok(reachable.has(category) || byKeyword.includes(category), `unreachable category: ${category}`);
  }
});

// ---------------------------------------------------------------------------
// D. Collection vs notification boundary
// ---------------------------------------------------------------------------

test("a market emergency is classified without any tracked stock or sector", () => {
  // classifyCollectionCoverage takes no user, portfolio or sector input at all.
  const decision = collection("North Korea fires ballistic missile over Japan");
  assert.equal(decision.severity, "emergency");
  const source = Deno.readTextFileSync(join(HERE, "news_coverage_logic.ts"));
  const collectionSection = source.slice(0, source.indexOf("// 5. Notification policy"));
  assert.ok(!collectionSection.includes("tracked_stocks"), "collection must not read tracked stocks");
  assert.ok(!collectionSection.includes("alert_settings"), "collection must not read alert settings");
});

test("judgement fills in the wider severity and keeps an emergency recorded at collection", () => {
  // The Hormuz item that production judged no_post / high / needs_review.
  const judged = classifyCoverage({
    importance: "no_post",
    category: "war_ceasefire",
    title: "Asian shares fall as crude oil trades above $100 amid U.S.-Iran conflict",
    sourceType: "breaking_market",
    sourceUrl: "https://apnews.com/article/x",
    publishedAt: FRESH,
    companyCode: null,
    japanMarketRelevance: "high",
    factCheckStatus: "needs_review",
    now: NOW,
  });
  assert.equal(judged.severity, "medium", "unchanged app severity when it is not an emergency");
  // Same row, but an emergency was recorded hours earlier at collection time.
  const aged = classifyCoverage({
    importance: "no_post",
    category: "geopolitics",
    title: "Iran blockades the Strait of Hormuz",
    sourceType: "breaking_market",
    sourceUrl: "https://apnews.com/article/x",
    publishedAt: "2026-09-11T10:00:00Z",
    companyCode: null,
    japanMarketRelevance: "high",
    factCheckStatus: "needs_review",
    now: NOW,
    priorEmergencyClass: "chokepoint_disruption",
  });
  assert.equal(aged.severity, "emergency");
  assert.equal(aged.emergencyClass, "chokepoint_disruption");
  assert.equal(aged.bypassesSectorMatch, true);
});

test("the monitor writes only the new coverage columns, and no push logic reads them", async () => {
  const source = await Deno.readTextFile(INDEX);
  // Wired at both classification points.
  assert.match(source, /classifyCollectionCoverage\(\{/);
  assert.match(source, /classifyCoverage\(\{/);
  assert.match(source, /coverage_categories: coverage\.categories/);
  assert.match(source, /coverage_severity: coverage\.severity/);
  assert.match(source, /emergency_class: coverage\.emergencyClass/);
  // The notification half stays out of the function entirely.
  assert.ok(!source.includes("notificationEligibility"), "notification policy must stay unwired");
  assert.ok(!source.includes("PRESET_THRESHOLDS"), "presets must stay unwired");
  assert.ok(!source.includes("notification_preset"), "no preset column is read or written");
  // The existing X publish gate and producers are untouched by this phase.
  assert.match(source, /enqueue_market_critical_notifications/);
  assert.ok(!source.includes("coverage_severity=eq."), "no producer selects on coverage_severity yet");
});

test("the migration is expand-only and leaves the existing pipeline alone", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert.match(sql, /add column if not exists coverage_categories text\[\]/);
  assert.match(sql, /add column if not exists coverage_severity text/);
  assert.match(sql, /add column if not exists emergency_class text/);
  assert.match(sql, /'disaster'/);
  assert.match(sql, /coverage_severity in \('emergency', 'critical', 'high', 'medium', 'low'\)/);
  // An emergency is market-wide only.
  assert.match(sql, /check \(emergency_class is null or company_code is null\)/);
  // Nothing destructive, and no touching of the existing decision columns or RPCs.
  assert.ok(!/drop\s+table/i.test(sql));
  assert.ok(!/drop\s+column/i.test(sql));
  assert.ok(!/truncate/i.test(sql));
  assert.ok(!/create or replace function/i.test(sql), "no RPC is redefined in this phase");
  assert.ok(!/alter column\s+importance/i.test(sql));
  assert.ok(!/get_my_important_stock_news/.test(sql));
  assert.ok(!/alert_settings/.test(sql), "user notification settings are a later phase");
  assert.ok(!/notifications/.test(sql), "no notification schema change in this phase");
  // Only the category check is replaced, and it is re-created in the same transaction.
  const drops = sql.match(/drop constraint if exists ([a-z_]+)/g) ?? [];
  assert.deepEqual(drops, [
    "drop constraint if exists important_news_candidates_category_check",
    "drop constraint if exists important_news_candidates_coverage_severity_check",
    "drop constraint if exists important_news_candidates_emergency_class_check",
    "drop constraint if exists important_news_candidates_emergency_is_market_wide",
  ]);
  assert.match(sql, /add constraint important_news_candidates_category_check/);
});
