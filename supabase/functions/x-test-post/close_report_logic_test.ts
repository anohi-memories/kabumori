import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateCloseFacts, normalizeCloseMetric, resolveCloseRunMode, validateCloseFreshness,
  validateCloseReportFormat,
  type RawMarketMetric,
} from "./close_report_logic.ts";

const reference = "2026-08-31T07:00:00.000Z"; // 16:00 JST
const raw = (overrides: Partial<RawMarketMetric> = {}): RawMarketMetric => ({
  label: "日経平均", value: "65,800", previous_close: "65,500", change: "+300",
  change_percent: "+9.99%", timestamp: "2026-08-31T06:30:00.000Z",
  source_url: "https://www.jpx.co.jp/example", ...overrides,
});

test("15:45〜16:05 JST is live close-report mode", () => {
  assert.equal(resolveCloseRunMode(reference), "live");
  assert.equal(resolveCloseRunMode("2026-08-29T07:00:00.000Z"), "preflight");
});

test("close index and 15:45 futures use separate freshness rules", () => {
  assert.equal(validateCloseFreshness("jpx_close", "2026-08-31T06:30:00.000Z", reference, "live"), "fresh");
  assert.equal(validateCloseFreshness("nikkei_futures_1545", "2026-08-31T06:45:00.000Z", reference, "live"), "fresh");
  assert.equal(validateCloseFreshness("nikkei_futures_1545", "2026-08-31T06:15:00.000Z", reference, "live"), "stale");
});

test("change percent is recalculated from raw values", () => {
  const metric = normalizeCloseMetric(raw(), "jpx_close", reference, "live");
  assert.equal(metric.change, "+300");
  assert.equal(metric.change_percent, "+0.46%");
  assert.equal(metric.numeric_consistency, "passed");
});

test("contradictory change and future timestamps stop publication", () => {
  const contradiction = normalizeCloseMetric(raw({ change: "-300" }), "jpx_close", reference, "live");
  const future = normalizeCloseMetric(raw({ label: "TOPIX", timestamp: "2026-08-31T07:10:00.000Z" }), "jpx_close", reference, "live");
  const result = evaluateCloseFacts({
    requiredIndices: [contradiction, future], futures: null, optional: [], trustedSourceCount: 2,
    dateConsistencyPassed: true, importantNewsVerified: true, futureInformationAbsent: true, mode: "live",
  });
  assert.equal(result.status, "failed");
  assert.match(result.notes.join(" | "), /数値矛盾/);
  assert.match(result.notes.join(" | "), /未来時刻/);
});

test("missing futures can be omitted without failing required-index facts", () => {
  const indices = [raw(), raw({ label: "TOPIX", value: "3,100", previous_close: "3,090", change: "+10" })]
    .map((metric) => normalizeCloseMetric(metric, "jpx_close", reference, "live"));
  assert.deepEqual(evaluateCloseFacts({
    requiredIndices: indices, futures: null, optional: [], trustedSourceCount: 2,
    dateConsistencyPassed: true, importantNewsVerified: true, futureInformationAbsent: true, mode: "live",
  }), { status: "passed", notes: [] });
});

test("text length and emoji count are not fact-check inputs", () => {
  const indices = [raw(), raw({ label: "TOPIX" })].map((metric) =>
    normalizeCloseMetric(metric, "jpx_close", reference, "live")
  );
  assert.equal(evaluateCloseFacts({
    requiredIndices: indices, futures: null, optional: [], trustedSourceCount: 2,
    dateConsistencyPassed: true, importantNewsVerified: true, futureInformationAbsent: true, mode: "live",
  }).status, "passed");
});

test("close report can pass without Nikkei TOPIX or futures values", () => {
  assert.deepEqual(evaluateCloseFacts({
    requiredIndices: [], futures: null, optional: [], verifiedImportantPointCount: 3,
    trustedSourceCount: 2, dateConsistencyPassed: true,
    importantNewsPresent: false, importantNewsVerified: false,
    futureInformationAbsent: true, mode: "live",
  }), { status: "passed", notes: [] });
});

test("unverified close report facts safely stop generation", () => {
  const result = evaluateCloseFacts({
    requiredIndices: [], futures: null, optional: [], verifiedImportantPointCount: 2,
    trustedSourceCount: 2, dateConsistencyPassed: true,
    importantNewsPresent: true, importantNewsVerified: false,
    futureInformationAbsent: true, mode: "live",
  });
  assert.equal(result.status, "failed");
  assert.match(result.notes.join(" | "), /今日のポイントが3件未満/);
  assert.match(result.notes.join(" | "), /重要ニュース候補の裏取り不能/);
});

test("a stale optional material alone does not fail the close report", () => {
  const staleOptional = normalizeCloseMetric(raw({
    label: "古い為替材料", timestamp: "2026-08-31T05:00:00.000Z",
  }), "realtime_optional", reference, "live");
  assert.equal(staleOptional.freshness, "stale");
  assert.equal(evaluateCloseFacts({
    requiredIndices: [], futures: null, optional: [staleOptional], verifiedImportantPointCount: 3,
    trustedSourceCount: 2, dateConsistencyPassed: true,
    importantNewsPresent: false, importantNewsVerified: false,
    futureInformationAbsent: true, mode: "live",
  }).status, "passed");
});

test("future or invalid optional material still safely stops the close report", () => {
  const result = evaluateCloseFacts({
    requiredIndices: [], futures: null, optional: [], verifiedImportantPointCount: 3,
    trustedSourceCount: 2, dateConsistencyPassed: true,
    importantNewsPresent: false, importantNewsVerified: false,
    futureInformationAbsent: false, unsafeOptionalMaterialCount: 1, mode: "live",
  });
  assert.equal(result.status, "failed");
  assert.match(result.notes.join(" | "), /optional材料/);
});

test("removing stale material still stops safely when fewer than three close points remain", () => {
  const result = evaluateCloseFacts({
    requiredIndices: [], futures: null, optional: [], verifiedImportantPointCount: 2,
    trustedSourceCount: 2, dateConsistencyPassed: true,
    importantNewsPresent: false, importantNewsVerified: false,
    futureInformationAbsent: true, mode: "live",
  });
  assert.equal(result.status, "failed");
  assert.match(result.notes.join(" | "), /今日のポイントが3件未満/);
});

test("close report format keeps three points at the top and required sections", () => {
  assert.equal(validateCloseReportFormat(`【大引け】きょうの日本株まとめ🌙
📌 今日の3ポイント
・半導体に強さ
・銀行はまちまち
・決算材料に反応

今日は材料ごとの差が出ました。

🔎 強かった・弱かったテーマ
確認済みのテーマを整理します。

👀 明日への注目点
予定されている材料を見ます。

💬 今日のひとこと
指数より中身を見たい一日でした。`), true);
  assert.equal(validateCloseReportFormat(`【大引け】きょうの日本株まとめ🌙
📌 今日の3ポイント
・1件だけ
🔎 強かった・弱かったテーマ
なし
👀 明日への注目点
なし
💬 今日のひとこと
なし`), false);
});
