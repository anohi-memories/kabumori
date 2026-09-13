import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCoverage,
  COVERAGE_CATEGORIES,
  type CoverageCategory,
  coverageCategoriesFor,
  detectEmergency,
  isEmergencySourceHost,
  notificationEligibility,
  type NotificationCandidate,
  NOTIFICATION_PRESETS,
  type NotificationPreset,
  PRESET_THRESHOLDS,
  presetFromLegacySettings,
  shouldStoreForCoverage,
  type UserNotificationSettings,
} from "./news_coverage_logic.ts";
import {
  EXISTING_QUERY_KEYS,
  missingCoverage,
  PROPOSED_FEEDS,
  PROPOSED_QUERIES,
  proposedSearchBudget,
  TARGET_COVERAGE,
} from "./news_collection_scope_proposal.ts";

const NOW = new Date("2026-09-12T03:00:00Z");
const FRESH = "2026-09-12T02:30:00Z";

// --- categories -------------------------------------------------------------

test("category mapping is deterministic and never leaves an item uncategorised", () => {
  assert.deepEqual(coverageCategoriesFor({ category: "earnings", title: "決算短信", companyCode: "47510" }),
    ["corporate", "earnings"]);
  assert.deepEqual(coverageCategoriesFor({ category: "boj", title: "金融政策決定会合の結果" }),
    ["monetary_policy", "japan_market"]);
  // other_market_moving has no base mapping: the wording alone must classify it.
  assert.deepEqual(coverageCategoriesFor({ category: "other_market_moving", title: "Nikkei 225 falls sharply" }),
    ["japan_market"]);
  assert.deepEqual(coverageCategoriesFor({ category: "other_market_moving", title: "何かの話" }), ["japan_market"]);
  assert.deepEqual(coverageCategoriesFor({ category: "other_corporate_ir", title: "何かの開示", companyCode: "12340" }),
    ["corporate"]);
});

test("a tanker strike is tagged shipping and oil as well as geopolitics", () => {
  const categories = coverageCategoriesFor({
    category: "geopolitics",
    title: "Tanker reportedly struck by unknown projectile in northern Persian Gulf amid Iran tensions",
    bodySummary: "Crude oil rose after the attack near the Strait of Hormuz.",
  });
  assert.ok(categories.includes("geopolitics"));
  assert.ok(categories.includes("shipping_logistics"));
  assert.ok(categories.includes("oil_energy"));
});

test("a missile launch and an earthquake get their own categories", () => {
  assert.ok(coverageCategoriesFor({ category: "major_security_incident", title: "北朝鮮が弾道ミサイルを発射" })
    .includes("geopolitics"));
  assert.ok(coverageCategoriesFor({ category: "other_market_moving", title: "震度6強の地震、津波警報を発表" })
    .includes("disaster"));
});

// --- emergency --------------------------------------------------------------

test("emergency: a missile launch toward Japan from a trusted source", () => {
  const decision = detectEmergency({
    title: "North Korea fires ballistic missile that lands in waters near Japan's EEZ",
    sourceUrl: "https://www.reuters.com/world/asia-pacific/nk-missile",
    publishedAt: FRESH,
    now: NOW,
  });
  assert.equal(decision.isEmergency, true);
  assert.equal(decision.emergencyClass, "missile_near_japan");
});

test("emergency: Japanese authority sources count (JMA quake, MOD launch)", () => {
  assert.equal(detectEmergency({
    title: "震度6強の地震 大津波警報を発表",
    sourceUrl: "https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml",
    publishedAt: FRESH, now: NOW,
  }).emergencyClass, "major_disaster");
  assert.equal(detectEmergency({
    title: "北朝鮮による弾道ミサイルの発射について（第1報）",
    sourceUrl: "https://www.mod.go.jp/j/press/news/2026/09/12a.html",
    publishedAt: FRESH, now: NOW,
  }).emergencyClass, "missile_near_japan");
});

test("emergency: Hormuz closure, exchange outage, emergency Fed action", () => {
  assert.equal(detectEmergency({
    title: "Iran closes Strait of Hormuz to tanker traffic after attack",
    sourceUrl: "https://apnews.com/article/hormuz", publishedAt: FRESH, now: NOW,
  }).emergencyClass, "chokepoint_disruption");
  assert.equal(detectEmergency({
    title: "Tokyo Stock Exchange halts trading after system failure",
    sourceUrl: "https://www.jpx.co.jp/news/1.html", publishedAt: FRESH, now: NOW,
  }).emergencyClass, "market_infrastructure_failure");
  assert.equal(detectEmergency({
    title: "Federal Reserve announces emergency intermeeting rate cut",
    sourceUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary.htm",
    publishedAt: FRESH, now: NOW,
  }).emergencyClass, "emergency_monetary_action");
});

test("emergency needs both an event and a qualifier, so routine coverage is not one", () => {
  for (const title of [
    "North Korea policy talks resume in Beijing",
    "Japan holds earthquake preparedness drill",
    "Bank of Japan governor speaks on the economic outlook",
    "Taiwan reports record chip exports",
    "Shipping rates ease on the Suez route",
  ]) {
    const decision = detectEmergency({
      title, sourceUrl: "https://www.reuters.com/x", publishedAt: FRESH, now: NOW,
    });
    assert.equal(decision.isEmergency, false, title);
    assert.equal(decision.reason, "NO_EMERGENCY_PATTERN", title);
  }
});

test("emergency gates: untrusted host, http, stale, missing time, company scope", () => {
  const base = { title: "North Korea fires ballistic missile over Japan", publishedAt: FRESH, now: NOW };
  assert.equal(detectEmergency({ ...base, sourceUrl: "https://example.com/a" }).reason, "SOURCE_NOT_TRUSTED");
  assert.equal(detectEmergency({ ...base, sourceUrl: "http://www.reuters.com/a" }).reason, "SOURCE_NOT_TRUSTED");
  // A lookalike host must not pass as a subdomain match.
  assert.equal(isEmergencySourceHost("https://reuters.com.evil.example/a"), false);
  assert.equal(isEmergencySourceHost("https://www.reuters.com/a"), true);
  assert.equal(detectEmergency({ ...base, sourceUrl: "https://www.reuters.com/a", publishedAt: "2026-09-11T00:00:00Z" }).reason, "STALE");
  assert.equal(detectEmergency({ ...base, sourceUrl: "https://www.reuters.com/a", publishedAt: null }).reason, "MISSING_TIMESTAMP");
  assert.equal(detectEmergency({ ...base, sourceUrl: "https://www.reuters.com/a", companyCode: "47510" }).reason, "COMPANY_SCOPED");
});

// --- coverage severity ------------------------------------------------------

function marketInput(overrides: Partial<Parameters<typeof classifyCoverage>[0]> = {}) {
  return classifyCoverage({
    importance: "no_post",
    category: "major_security_incident",
    title: "North Korea fires ballistic missile into waters near Japan",
    sourceType: "breaking_market",
    sourceUrl: "https://www.reuters.com/world/asia-pacific/x",
    publishedAt: FRESH,
    companyCode: null,
    japanMarketRelevance: "medium",
    factCheckStatus: "needs_review",
    now: NOW,
    ...overrides,
  });
}

test("an unverified market item that today lands at medium becomes emergency, and skips the sector match", () => {
  const decision = marketInput();
  assert.equal(decision.appSeverity, "low", "today's shipped model keeps it out of the feed");
  assert.equal(decision.severity, "emergency");
  assert.equal(decision.bypassesSectorMatch, true);
  assert.ok(decision.categories.includes("geopolitics"));
});

test("existing severities are untouched when no emergency applies", () => {
  const published = classifyCoverage({
    importance: "most_important", category: "war_ceasefire",
    title: "Iraq confirms attacks on Saudi pipeline originated from Iraqi territory",
    sourceType: "breaking_market", sourceUrl: "https://apnews.com/a", publishedAt: FRESH,
    companyCode: null, japanMarketRelevance: "high", factCheckStatus: "passed", now: NOW,
  });
  assert.equal(published.severity, "critical");
  assert.equal(published.bypassesSectorMatch, false);
  const company = classifyCoverage({
    importance: "important", category: "share_buyback", title: "自己株式の取得に係る事項の決定に関するお知らせ",
    sourceType: "tdnet", sourceUrl: "https://www.release.tdnet.info/inbs/x.pdf", publishedAt: FRESH,
    companyCode: "35390", japanMarketRelevance: "low", factCheckStatus: "passed", now: NOW,
  });
  assert.equal(company.severity, "high");
  assert.equal(company.scope, "company");
  assert.deepEqual(company.categories, ["corporate"]);
});

// --- storage ----------------------------------------------------------------

test("storage drops only items without a verifiable https source and time", () => {
  assert.equal(shouldStoreForCoverage({ sourceUrl: "https://www.reuters.com/a", publishedAt: FRESH }).store, true);
  assert.equal(shouldStoreForCoverage({ sourceUrl: "http://www.reuters.com/a", publishedAt: FRESH }).store, false);
  assert.equal(shouldStoreForCoverage({ sourceUrl: "https://www.reuters.com/a", publishedAt: null }).store, false);
});

test("collection is independent of notification settings", () => {
  // The same item is stored regardless of any user's preset or push switches.
  const item = { sourceUrl: "https://www.reuters.com/a", publishedAt: FRESH };
  assert.equal(shouldStoreForCoverage(item).store, true);
  const silent: UserNotificationSettings = {
    pushEnabled: false, importantNews: false, preset: "quiet", emergencyAlerts: false,
  };
  assert.equal(notificationEligibility(candidate({ severity: "emergency", bypassesSectorMatch: true }), silent).send, false);
  assert.equal(shouldStoreForCoverage(item).store, true);
});

// --- notification policy ----------------------------------------------------

function candidate(overrides: Partial<NotificationCandidate> = {}): NotificationCandidate {
  return {
    scope: "market",
    severity: "critical",
    categories: ["geopolitics"],
    bypassesSectorMatch: false,
    trackedMatch: true,
    hasFactPassedText: true,
    alreadyNotified: false,
    ...overrides,
  };
}

function settings(overrides: Partial<UserNotificationSettings> = {}): UserNotificationSettings {
  return { pushEnabled: true, importantNews: true, preset: "standard", emergencyAlerts: true, ...overrides };
}

test("preset thresholds per scope", () => {
  const cases: Array<[NotificationPreset, CoverageCategory[], boolean, boolean, boolean]> = [
    // preset, categories, company-high, market-critical, market-high
    ["quiet", ["geopolitics"], false, false, false],
    ["standard", ["geopolitics"], true, true, false],
    ["many", ["geopolitics"], true, true, true],
    ["all_useful", ["geopolitics"], true, true, true],
  ];
  for (const [preset, categories, companyHigh, marketCritical, marketHigh] of cases) {
    assert.equal(
      notificationEligibility(candidate({ scope: "company", severity: "high", categories }), settings({ preset })).send,
      companyHigh, `${preset} company high`);
    assert.equal(
      notificationEligibility(candidate({ severity: "critical", categories }), settings({ preset })).send,
      marketCritical, `${preset} market critical`);
    assert.equal(
      notificationEligibility(candidate({ severity: "high", categories }), settings({ preset })).send,
      marketHigh, `${preset} market high`);
  }
  assert.equal(notificationEligibility(candidate({ scope: "company", severity: "critical" }), settings({ preset: "quiet" })).send, true);
  assert.equal(notificationEligibility(candidate({ scope: "company", severity: "medium" }), settings({ preset: "many" })).send, true);
  assert.equal(notificationEligibility(candidate({ severity: "medium" }), settings({ preset: "all_useful" })).send, true);
});

test("low is never pushed by any preset", () => {
  for (const preset of NOTIFICATION_PRESETS) {
    for (const scope of ["company", "market"] as const) {
      assert.equal(notificationEligibility(candidate({ scope, severity: "low" }), settings({ preset })).send, false,
        `${preset} ${scope}`);
    }
  }
});

test("an emergency reaches every preset, with no tracked match, and its own off switch", () => {
  const emergency = candidate({ severity: "emergency", bypassesSectorMatch: true, trackedMatch: false });
  for (const preset of NOTIFICATION_PRESETS) {
    assert.equal(notificationEligibility(emergency, settings({ preset })).send, true, preset);
  }
  assert.equal(notificationEligibility(emergency, settings({ emergencyAlerts: false })).reason, "EMERGENCY_DISABLED");
  assert.equal(notificationEligibility(emergency, settings({ pushEnabled: false })).reason, "PUSH_DISABLED");
  assert.equal(notificationEligibility(emergency, settings({ importantNews: false })).reason, "NEWS_PUSH_DISABLED");
});

test("hard blocks win over any preset", () => {
  assert.equal(notificationEligibility(candidate({ hasFactPassedText: false }), settings({ preset: "all_useful" })).reason,
    "NO_FACT_PASSED_TEXT");
  assert.equal(notificationEligibility(candidate({ alreadyNotified: true }), settings({ preset: "all_useful" })).reason,
    "ALREADY_NOTIFIED");
  assert.equal(notificationEligibility(candidate({ severity: "emergency", hasFactPassedText: false }), settings()).reason,
    "NO_FACT_PASSED_TEXT");
  assert.equal(notificationEligibility(candidate({ trackedMatch: false }), settings()).reason, "NO_TRACKED_MATCH");
  assert.equal(notificationEligibility(candidate({ scope: "company", severity: "critical", trackedMatch: false }), settings()).reason,
    "NO_TRACKED_MATCH");
});

test("a muted category blocks the push only when every category is muted", () => {
  const shipping = candidate({ categories: ["geopolitics", "shipping_logistics"] });
  assert.equal(notificationEligibility(shipping, settings({ mutedCategories: ["geopolitics"] })).send, true);
  assert.equal(
    notificationEligibility(shipping, settings({ mutedCategories: ["geopolitics", "shipping_logistics"] })).reason,
    "CATEGORY_MUTED");
  // Muting applies to emergencies too, so a user can silence a whole topic.
  assert.equal(
    notificationEligibility(candidate({ severity: "emergency", categories: ["disaster"] }),
      settings({ mutedCategories: ["disaster"] })).reason,
    "CATEGORY_MUTED");
});

test("today's production settings map onto presets without changing behaviour", () => {
  assert.equal(presetFromLegacySettings({ marketCriticalNews: true }), "standard");
  assert.equal(presetFromLegacySettings({ marketCriticalNews: false }), "quiet");
  // Regression on today's two live producers:
  // company X-tier (high) with a tracked stock still pushes under standard,
  // market critical with a sector match still pushes under standard,
  // market high (not X-published) still does not.
  const legacy = settings({ preset: "standard" });
  assert.equal(notificationEligibility(candidate({ scope: "company", severity: "high" }), legacy).send, true);
  assert.equal(notificationEligibility(candidate({ severity: "critical" }), legacy).send, true);
  assert.equal(notificationEligibility(candidate({ severity: "high" }), legacy).send, false);
  // A user who never opted into market news keeps getting no ordinary market push.
  const quiet = settings({ preset: "quiet" });
  assert.equal(notificationEligibility(candidate({ severity: "critical" }), quiet).send, false);
});

test("every preset has a Japanese label and both thresholds", () => {
  for (const preset of NOTIFICATION_PRESETS) {
    const threshold = PRESET_THRESHOLDS[preset];
    assert.ok(threshold.label.length > 0, preset);
    assert.ok(threshold.company && threshold.market, preset);
  }
});

// --- collection scope proposal ---------------------------------------------

test("the proposed collection scope covers every target category", () => {
  assert.deepEqual(missingCoverage(), []);
  assert.deepEqual([...TARGET_COVERAGE].sort(), [...COVERAGE_CATEGORIES].sort());
});

test("the two missed events now have a dedicated topic and an official feed", () => {
  const keys = PROPOSED_QUERIES.map((query) => query.key);
  assert.ok(keys.includes("japan_security_emergency"));
  assert.ok(keys.includes("shipping_chokepoints"));
  const missile = PROPOSED_QUERIES.find((query) => query.key === "japan_security_emergency")!;
  assert.match(missile.searchQuery, /North Korea missile/i);
  assert.equal(missile.slot, "fixed", "a launch must not wait for a rotation");
  const hormuz = PROPOSED_QUERIES.find((query) => query.key === "shipping_chokepoints")!;
  assert.match(hormuz.searchQuery, /Hormuz/i);
  assert.ok(PROPOSED_FEEDS.some((feed) => feed.host === "mod.go.jp"));
  assert.ok(PROPOSED_FEEDS.some((feed) => feed.host === "jma.go.jp"));
  // Proposed feeds are primary institutional sources, on https, with a stated basis.
  for (const feed of PROPOSED_FEEDS) {
    assert.ok(feed.feedUrl.startsWith("https://"), feed.key);
    assert.ok(new URL(feed.feedUrl).hostname.endsWith(feed.host), feed.key);
    assert.ok(feed.basis.length > 0, feed.key);
  }
});

test("the proposal states its own search cost", () => {
  const budget = proposedSearchBudget();
  assert.equal(budget.fixedPerCycle, 3);
  assert.equal(budget.searchesPerCycle, 4);
  assert.equal(budget.searchesPerHour, 12);
  assert.equal(budget.rotatingTopics, 8);
  assert.equal(budget.rotationMinutes, 160);
  assert.equal(EXISTING_QUERY_KEYS.length, 4);
});
