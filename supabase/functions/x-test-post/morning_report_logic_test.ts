import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateMorningFacts,
  isNikkeiFuturesAvailable,
  isVerifiedFixedMorningSource,
  mentionsUnavailableNikkeiFutures,
  morningTargetMatches,
  NASDAQ_FIXED_SOURCE_URL,
  normalizeFixedUsIndexMetric,
  normalizeMorningMetric,
  parseMarketNumber,
  resolveMorningReferenceContext,
  resolveMorningReferenceTime,
  resolveMorningRunMode,
  SP500_FIXED_SOURCE_URL,
  validateMorningReportFormat,
  validateMetricFreshness,
  type RawMorningMetric,
} from "./morning_report_logic.ts";

const reference = "2026-08-31T23:18:00.000Z"; // 2026-09-01 08:18 JST
const metric = (overrides: Partial<RawMorningMetric> = {}): RawMorningMetric => ({
  label: "Dow", value: "53,559.99", previous_close: "53,569.44", change: "-9.45",
  change_percent: "0.00%", timestamp: "2026-08-28T20:00:00.000Z",
  source_url: "https://www.reuters.com/example", ...overrides,
});

test("market numbers are parsed without formatting characters", () => {
  assert.equal(parseMarketNumber("+53,559.99"), 53559.99);
  assert.equal(parseMarketNumber("取得不能"), null);
});

test("UTC reference stays on the correct JST calendar date", () => {
  const context = resolveMorningReferenceContext("2026-08-31T00:16:13Z", {
    date: "2026-08-31", isTradingDay: true,
  });
  assert.equal(context.referenceUtc, "2026-08-31T00:16:13.000Z");
  assert.equal(context.referenceJst, "2026-08-31T09:16:13+09:00");
  assert.equal(context.jstCalendarDate, "2026-08-31");
  assert.equal(context.targetTradingDate, "2026-08-31");
});

test("08:17 JST reference is inside the morning window", () => {
  const override = "2026-08-30T23:17:00Z";
  const context = resolveMorningReferenceContext(override, {
    date: "2026-08-31", isTradingDay: true,
  });
  assert.equal(context.referenceJst, "2026-08-31T08:17:00+09:00");
  assert.equal(resolveMorningRunMode(override), "live");
});

test("model target date must match the deterministic code target", () => {
  const context = resolveMorningReferenceContext("2026-08-31T00:16:13Z", {
    date: "2026-08-31", isTradingDay: true,
  });
  assert.equal(morningTargetMatches(context, "2026-09-01", true), false);
  assert.equal(morningTargetMatches(context, "2026-08-31", true), true);
});

test("target mismatch makes the existing fact check fail", () => {
  const result = evaluateMorningFacts({
    required: [], optional: [], trustedSourceCount: 2,
    dateConsistencyPassed: false, importantNewsPresent: false,
    importantNewsVerified: false, mode: "live",
  });
  assert.equal(result.status, "failed");
  assert.match(result.notes.join(" | "), /取引日またはセッション日付の取り違え/);
});

test("reference override is accepted only for morning report dry-run", () => {
  const now = "2026-08-31T02:00:00Z";
  const override = "2026-08-30T23:17:00Z";
  assert.equal(
    resolveMorningReferenceTime("morning_report_dry_run", override, now),
    "2026-08-30T23:17:00.000Z",
  );
  assert.equal(
    resolveMorningReferenceTime("dispatch", override, now),
    "2026-08-31T02:00:00.000Z",
  );
});

test("important news absence is distinct from verification failure", () => {
  const basis = {
    required: [], optional: [], trustedSourceCount: 2,
    dateConsistencyPassed: true, mode: "live" as const,
  };
  assert.deepEqual(evaluateMorningFacts({
    ...basis, importantNewsPresent: false, importantNewsVerified: false,
  }), { status: "passed", notes: [] });
  assert.deepEqual(evaluateMorningFacts({
    ...basis, importantNewsPresent: true, importantNewsVerified: true,
  }), { status: "passed", notes: [] });
  const unverified = evaluateMorningFacts({
    ...basis, importantNewsPresent: true, importantNewsVerified: false,
  });
  assert.equal(unverified.status, "failed");
  assert.match(unverified.notes.join(" | "), /重要ニュース候補の裏取り不能/);
});

test("market overview can pass with no concrete market metrics", () => {
  assert.deepEqual(evaluateMorningFacts({
    required: [], strictRequired: [], optional: [], verifiedImportantPointCount: 3,
    trustedSourceCount: 2, dateConsistencyPassed: true,
    importantNewsPresent: false, importantNewsVerified: false, mode: "live",
  }), { status: "passed", notes: [] });
});

test("unverified important facts safely stop the morning report", () => {
  const result = evaluateMorningFacts({
    required: [], optional: [], verifiedImportantPointCount: 2,
    trustedSourceCount: 2, dateConsistencyPassed: true,
    importantNewsPresent: false, importantNewsVerified: false, mode: "live",
  });
  assert.equal(result.status, "failed");
  assert.match(result.notes.join(" | "), /注目ポイントが3件未満/);
});

test("a stale optional material alone does not fail the morning report", () => {
  const staleOptional = normalizeMorningMetric(metric({
    label: "古い為替材料", timestamp: "2026-08-31T20:00:00.000Z",
  }), "realtime_optional", reference, "live");
  assert.equal(staleOptional.freshness, "stale");
  assert.equal(evaluateMorningFacts({
    required: [], optional: [staleOptional], verifiedImportantPointCount: 3,
    trustedSourceCount: 2, dateConsistencyPassed: true,
    importantNewsPresent: false, importantNewsVerified: false, mode: "live",
  }).status, "passed");
});

test("future or invalid optional material still safely stops the morning report", () => {
  const result = evaluateMorningFacts({
    required: [], optional: [], verifiedImportantPointCount: 3,
    trustedSourceCount: 2, dateConsistencyPassed: true,
    importantNewsPresent: false, importantNewsVerified: false,
    unsafeOptionalMaterialCount: 1, mode: "live",
  });
  assert.equal(result.status, "failed");
  assert.match(result.notes.join(" | "), /optional材料/);
});

test("removing stale material still stops safely when fewer than three points remain", () => {
  const result = evaluateMorningFacts({
    required: [], optional: [], verifiedImportantPointCount: 2,
    trustedSourceCount: 2, dateConsistencyPassed: true,
    importantNewsPresent: false, importantNewsVerified: false, mode: "live",
  });
  assert.equal(result.status, "failed");
  assert.match(result.notes.join(" | "), /注目ポイントが3件未満/);
});

test("morning report format keeps three points at the top and required closing sections", () => {
  assert.equal(validateMorningReportFormat(`【朝刊】きょうの日本株、ここをチェック☀️
📌 今日の注目ポイント
・半導体の流れ
・金融政策の材料
・国内企業の発表

海外市場では確認済みの材料がありました。

⚠️ きょう注意したいこと
未確認情報を追いかけないこと。

💬 今日のひとこと
寄り後の広がりを見たい朝です。`), true);
  assert.equal(validateMorningReportFormat(`【朝刊】きょうの日本株、ここをチェック☀️
📌 今日の注目ポイント
・1件だけ
⚠️ きょう注意したいこと
注意
💬 今日のひとこと
ひとこと`), false);
});

test("invalid dry-run reference override is rejected", () => {
  assert.throws(
    () => resolveMorningReferenceTime("morning_report_dry_run", "2026-08-31 08:17", "2026-08-31T02:00:00Z"),
    /MORNING_REPORT_INVALID_REFERENCE_TIME/,
  );
});

test("percentage is recalculated from value and previous close", () => {
  const normalized = normalizeMorningMetric(metric(), "us_close", reference, "live");
  assert.equal(normalized.change, "-9.45");
  assert.equal(normalized.change_percent, "-0.02%");
  assert.equal(normalized.numeric_consistency, "passed");
});

const fixedIndexMetric = (label: string, sourceUrl: string): RawMorningMetric => ({
  label,
  value: "7,711.76",
  previous_close: "7,730.99",
  change: "-19.23",
  change_percent: "-0.25%",
  timestamp: "2026-08-28T20:00:00.000Z",
  source_url: sourceUrl,
});

const fixedIndexFact = (metric: RawMorningMetric) => {
  const normalized = normalizeFixedUsIndexMetric(metric, reference, "live");
  return evaluateMorningFacts({
    required: [normalized], strictRequired: [normalized], optional: [],
    trustedSourceCount: 2, dateConsistencyPassed: true,
    importantNewsPresent: false, importantNewsVerified: false, mode: "live",
  });
};

test("S&P500 fixed page provides a complete passable metric", () => {
  const metric = fixedIndexMetric("S&P 500", SP500_FIXED_SOURCE_URL);
  assert.equal(isVerifiedFixedMorningSource(
    metric.source_url, SP500_FIXED_SOURCE_URL, new Set([SP500_FIXED_SOURCE_URL]),
  ), true);
  assert.equal(fixedIndexFact(metric).status, "passed");
});

test("Nasdaq fixed page provides a complete passable metric", () => {
  const metric = fixedIndexMetric("Nasdaq Composite", NASDAQ_FIXED_SOURCE_URL);
  assert.equal(isVerifiedFixedMorningSource(
    metric.source_url, NASDAQ_FIXED_SOURCE_URL, new Set([NASDAQ_FIXED_SOURCE_URL]),
  ), true);
  assert.equal(fixedIndexFact(metric).status, "passed");
});

test("fixed index fails when previous close is missing", () => {
  assert.equal(fixedIndexFact({
    ...fixedIndexMetric("S&P 500", SP500_FIXED_SOURCE_URL), previous_close: "",
  }).status, "failed");
});

test("fixed index fails when timestamp is missing", () => {
  assert.equal(fixedIndexFact({
    ...fixedIndexMetric("Nasdaq Composite", NASDAQ_FIXED_SOURCE_URL), timestamp: "",
  }).status, "failed");
});

test("fixed index rejects an unverified source URL", () => {
  assert.equal(isVerifiedFixedMorningSource(
    SP500_FIXED_SOURCE_URL, SP500_FIXED_SOURCE_URL, new Set([NASDAQ_FIXED_SOURCE_URL]),
  ), false);
  assert.equal(fixedIndexFact({
    ...fixedIndexMetric("S&P 500", SP500_FIXED_SOURCE_URL), source_url: "",
  }).status, "failed");
});

test("fixed index recalculation passes matching change and percentage", () => {
  const normalized = normalizeFixedUsIndexMetric(
    fixedIndexMetric("S&P 500", SP500_FIXED_SOURCE_URL), reference, "live",
  );
  assert.equal(normalized.change, "-19.23");
  assert.equal(normalized.change_percent, "-0.25%");
  assert.equal(normalized.numeric_consistency, "passed");
});

test("fixed index rejects mismatched supplied change percentage", () => {
  const normalized = normalizeFixedUsIndexMetric({
    ...fixedIndexMetric("Nasdaq Composite", NASDAQ_FIXED_SOURCE_URL), change_percent: "+1.00%",
  }, reference, "live");
  assert.equal(normalized.numeric_consistency, "failed");
});

test("a contradictory supplied change fails numeric consistency", () => {
  const normalized = normalizeMorningMetric(metric({ change: "+100" }), "us_close", reference, "live");
  assert.equal(normalized.numeric_consistency, "failed");
});

test("each data class has its own freshness rule", () => {
  assert.equal(validateMetricFreshness("us_close", "2026-08-28T20:00:00.000Z", reference, "live"), "fresh");
  assert.equal(validateMetricFreshness("nikkei_futures", "2026-08-31T23:10:00.000Z", reference, "live"), "fresh");
  assert.equal(validateMetricFreshness("nikkei_futures", "2026-08-30T23:10:00.000Z", reference, "live"), "stale");
});

test("weekend or non-morning execution is treated as preflight", () => {
  assert.equal(resolveMorningRunMode("2026-08-29T09:30:00.000Z"), "preflight");
  assert.equal(validateMetricFreshness("nikkei_futures", "2026-08-28T21:00:00.000Z", "2026-08-29T09:30:00.000Z", "preflight"), "preflight_latest");
});

test("fact check is independent from text length and emoji count", () => {
  const required = ["Dow", "S&P500", "NASDAQ", "SOX", "日経225先物"].map((label, index) =>
    normalizeMorningMetric(metric({
      label,
      timestamp: index === 4 ? "2026-08-31T23:10:00.000Z" : "2026-08-28T20:00:00.000Z",
    }), index === 4 ? "nikkei_futures" : "us_close", reference, "live")
  );
  assert.deepEqual(evaluateMorningFacts({
    required, optional: [], trustedSourceCount: 3, dateConsistencyPassed: true,
    importantNewsPresent: true, importantNewsVerified: true, mode: "live",
  }), { status: "passed", notes: [] });
});

test("fact check stops on missing required data or insufficient trusted sources", () => {
  const missing = normalizeMorningMetric(metric({ label: "日経225先物", value: "", source_url: "" }), "nikkei_futures", reference, "live");
  const result = evaluateMorningFacts({
    required: [missing], optional: [], trustedSourceCount: 1,
    dateConsistencyPassed: true, importantNewsPresent: false,
    importantNewsVerified: false, mode: "live",
  });
  assert.equal(result.status, "failed");
  assert.match(result.notes.join(" | "), /必須市場データ取得不能/);
  assert.match(result.notes.join(" | "), /信頼できる独立ソースが不足/);
});

const normalizedUsIndices = () => ["Dow", "S&P500", "NASDAQ", "SOX"].map((label) =>
  normalizeMorningMetric(metric({ label }), "us_close", reference, "live")
);

test("verified Nikkei futures can be included as an optional metric", () => {
  const futures = normalizeMorningMetric(metric({
    label: "日経225先物",
    timestamp: "2026-08-31T23:10:00.000Z",
  }), "nikkei_futures", reference, "live");
  assert.equal(isNikkeiFuturesAvailable(futures), true);
  assert.equal(evaluateMorningFacts({
    required: normalizedUsIndices(), optional: [futures], trustedSourceCount: 3,
    dateConsistencyPassed: true, importantNewsPresent: false,
    importantNewsVerified: false, mode: "live",
  }).status, "passed");
});

test("missing Nikkei futures are omitted without failing morning facts", () => {
  const futures = normalizeMorningMetric(metric({
    label: "日経225先物", value: "", previous_close: "", change: "",
    change_percent: "", timestamp: "", source_url: "",
  }), "nikkei_futures", reference, "live");
  assert.equal(isNikkeiFuturesAvailable(futures), false);
  assert.equal(evaluateMorningFacts({
    required: normalizedUsIndices(), optional: [], trustedSourceCount: 3,
    dateConsistencyPassed: true, importantNewsPresent: false,
    importantNewsVerified: false, mode: "live",
  }).status, "passed");
});

test("partial Nikkei futures are omitted without failing morning facts", () => {
  const futures = normalizeMorningMetric(metric({
    label: "日経225先物", previous_close: "", change: "", change_percent: "",
    timestamp: "2026-08-31T23:10:00.000Z",
  }), "nikkei_futures", reference, "live");
  assert.equal(isNikkeiFuturesAvailable(futures), false);
  assert.equal(evaluateMorningFacts({
    required: normalizedUsIndices(), optional: [], trustedSourceCount: 3,
    dateConsistencyPassed: true, importantNewsPresent: false,
    importantNewsVerified: false, mode: "live",
  }).status, "passed");
});

test("missing one of the four required US indices still safely fails", () => {
  const required = normalizedUsIndices();
  required[2] = normalizeMorningMetric(metric({
    label: "NASDAQ", value: "", source_url: "",
  }), "us_close", reference, "live");
  const result = evaluateMorningFacts({
    required, optional: [], trustedSourceCount: 3, dateConsistencyPassed: true,
    importantNewsPresent: false, importantNewsVerified: false, mode: "live",
  });
  assert.equal(result.status, "failed");
  assert.match(result.notes.join(" | "), /NASDAQ/);
});

test("Nikkei futures claims are blocked when verified futures are unavailable", () => {
  assert.equal(mentionsUnavailableNikkeiFutures("日経先物は堅調です"), true);
  assert.equal(mentionsUnavailableNikkeiFutures("先物は前日比プラスです"), true);
  assert.equal(mentionsUnavailableNikkeiFutures("米国4指数と半導体株の動きを見たい朝です"), false);
});
