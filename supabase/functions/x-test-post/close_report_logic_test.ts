import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CLOSE_REPORT_FIXED_HASHTAGS,
  appendFixedCloseReportHashtags,
  evaluateCloseFacts, hasFixedCloseReportHashtagsExactlyOnce, localCloseReportSafetyIssues,
  normalizeCloseMetric, resolveCloseRunMode, validateCloseFreshness,
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
    requiredIndices: [], futures: null, optional: [], verifiedTodayPointCount: 3,
    trustedSourceCount: 2, dateConsistencyPassed: true,
    importantNewsPresent: false, importantNewsVerified: false,
    futureInformationAbsent: true, mode: "live",
  }), { status: "passed", notes: [] });
});

test("unverified close report facts safely stop generation", () => {
  const result = evaluateCloseFacts({
    requiredIndices: [], futures: null, optional: [], verifiedTodayPointCount: 2,
    trustedSourceCount: 2, dateConsistencyPassed: true,
    importantNewsPresent: true, importantNewsVerified: false,
    futureInformationAbsent: true, mode: "live",
  });
  assert.equal(result.status, "failed");
  assert.match(result.notes.join(" | "), /重要ニュース候補の裏取り不能/);
});

test("a stale optional material alone does not fail the close report", () => {
  const staleOptional = normalizeCloseMetric(raw({
    label: "古い為替材料", timestamp: "2026-08-31T05:00:00.000Z",
  }), "realtime_optional", reference, "live");
  assert.equal(staleOptional.freshness, "stale");
  assert.equal(evaluateCloseFacts({
    requiredIndices: [], futures: null, optional: [staleOptional], verifiedTodayPointCount: 3,
    trustedSourceCount: 2, dateConsistencyPassed: true,
    importantNewsPresent: false, importantNewsVerified: false,
    futureInformationAbsent: true, mode: "live",
  }).status, "passed");
});

test("future or invalid optional material still safely stops the close report", () => {
  const result = evaluateCloseFacts({
    requiredIndices: [], futures: null, optional: [], verifiedTodayPointCount: 3,
    trustedSourceCount: 2, dateConsistencyPassed: true,
    importantNewsPresent: false, importantNewsVerified: false,
    futureInformationAbsent: false, unsafeOptionalMaterialCount: 1, mode: "live",
  });
  assert.equal(result.status, "failed");
  assert.match(result.notes.join(" | "), /optional材料/);
});

// --- TODAY/NEXT material scope (STEP 2-6) -----------------------------------------------------------

test("1: zero verified TODAY points safely stops generation (no anchor to what happened today)", () => {
  const result = evaluateCloseFacts({
    requiredIndices: [], futures: null, optional: [], verifiedTodayPointCount: 0,
    trustedSourceCount: 2, dateConsistencyPassed: true,
    importantNewsPresent: false, importantNewsVerified: false,
    futureInformationAbsent: true, mode: "live",
  });
  assert.equal(result.status, "failed");
  assert.match(result.notes.join(" | "), /出典確認済みの本日の重要ポイントが0件/);
});

test("3: one or two verified TODAY points is enough for a safe, shorter report (no longer forced to 3)", () => {
  for (const count of [1, 2]) {
    const result = evaluateCloseFacts({
      requiredIndices: [], futures: null, optional: [], verifiedTodayPointCount: count,
      trustedSourceCount: 2, dateConsistencyPassed: true,
      importantNewsPresent: false, importantNewsVerified: false,
      futureInformationAbsent: true, mode: "live",
    });
    assert.equal(result.status, "passed", `expected count=${count} to pass`);
    assert.deepEqual(result.notes, []);
  }
});

test("4: three or more verified TODAY points still passes as a normal report", () => {
  const result = evaluateCloseFacts({
    requiredIndices: [], futures: null, optional: [], verifiedTodayPointCount: 4,
    trustedSourceCount: 2, dateConsistencyPassed: true,
    importantNewsPresent: false, importantNewsVerified: false,
    futureInformationAbsent: true, mode: "live",
  });
  assert.equal(result.status, "passed");
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

// --- fixed hashtags -------------------------------------------------------------------------------

const VALID_REPORT_BODY = `【大引け】きょうの日本株まとめ🌙
📌 今日の3ポイント
・半導体に強さ
・銀行はまちまち
・決算材料に反応

材料だけが先行しないかは気になりますが、今日は業種ごとの差がはっきり出ました。

🔎 強かった・弱かったテーマ
確認済みのテーマを整理します。

👀 明日への注目点
予定されている材料を見ます。ここは見ておきたいですね。

💬 今日のひとこと
指数より中身を見たい一日でした。`;

test("12: fixed hashtags are appended exactly once at the end", () => {
  const withTags = appendFixedCloseReportHashtags(VALID_REPORT_BODY);
  assert.equal(withTags.endsWith(CLOSE_REPORT_FIXED_HASHTAGS), true);
  assert.equal(hasFixedCloseReportHashtagsExactlyOnce(withTags), true);
  assert.equal(CLOSE_REPORT_FIXED_HASHTAGS, "#日本株 #日経平均 #株式投資 #かぶモリ");
});

test("13: hashtag duplication (already present, or appended twice) is detected", () => {
  const withTags = appendFixedCloseReportHashtags(VALID_REPORT_BODY);
  assert.equal(hasFixedCloseReportHashtagsExactlyOnce(appendFixedCloseReportHashtags(withTags)), false);
  const alreadyTagged = `${VALID_REPORT_BODY}\n\n#日本株`;
  assert.equal(hasFixedCloseReportHashtagsExactlyOnce(appendFixedCloseReportHashtags(alreadyTagged)), false);
});

test("text without the fixed hashtags fails the check", () => {
  assert.equal(hasFixedCloseReportHashtagsExactlyOnce(VALID_REPORT_BODY), false);
});

// --- local safety net (investment advice / fabricated experience) --------------------------------

test("11: investment-advice phrasing is detected locally, without relying on the AI Voice check alone", () => {
  assert.deepEqual(localCloseReportSafetyIssues("半導体株はこれから絶対に上がる展開です。"), ["INVESTMENT_ADVICE_DETECTED"]);
  assert.deepEqual(localCloseReportSafetyIssues("今は買い時です。"), ["INVESTMENT_ADVICE_DETECTED"]);
  assert.deepEqual(localCloseReportSafetyIssues(VALID_REPORT_BODY), []);
});

test("10: fabricated personal trading experience is detected locally", () => {
  assert.deepEqual(
    localCloseReportSafetyIssues("私は今日半導体株を買いました。含み益が出ています。"),
    ["FABRICATED_EXPERIENCE_DETECTED"],
  );
  assert.deepEqual(localCloseReportSafetyIssues(VALID_REPORT_BODY), []);
});

test("9: natural, ungrounded-feeling-but-not-fabricated commentary ('気になります' level) is not flagged locally", () => {
  // The close report writer/format logic has no phrase-level restriction on ordinary editorial voice —
  // only the two concrete safety patterns above (investment advice, fabricated trading experience).
  // This mirrors the 9/4 morning-report finding ("that level of expression is fine"); the shared AI
  // Voice check itself already carves out "一般的な感想や好みは違反ではありません" and is left untouched
  // here since it is shared with morning_report, which is out of scope for this change.
  assert.deepEqual(localCloseReportSafetyIssues(VALID_REPORT_BODY), []);
  assert.equal(validateCloseReportFormat(VALID_REPORT_BODY), true);
});

// --- weekend/holiday scheduling guard (already implemented at the DB level) ------------------------

test("15: the close_report dry-run branch in index.ts never calls the X API", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const branch = source.indexOf("if (isCloseReportDryRun)");
  const nextBranch = source.indexOf("if (isUsPremarketDryRun)", branch);
  assert.ok(branch >= 0 && nextBranch > branch, "close_report dry-run branch not found");
  const branchSource = source.slice(branch, nextBranch);
  assert.doesNotMatch(branchSource, /postToX|claimDuePost|loadXTokens/u);
});

test("generateCloseReport appends fixed hashtags and runs the local safety check before returning text", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function generateCloseReport(");
  const end = source.indexOf("\nasync function", start + 1);
  assert.ok(start >= 0 && end > start, "generateCloseReport not found");
  const fnSource = source.slice(start, end);
  assert.match(fnSource, /localCloseReportSafetyIssues\(text\)/u);
  assert.match(fnSource, /appendFixedCloseReportHashtags\(text\)/u);
  // The safety check and hashtag append must both come after format validation, and the append after
  // the safety check, so a rejected report never gets hashtags appended.
  const formatIdx = fnSource.indexOf("validateCloseReportFormat(text)");
  const safetyIdx = fnSource.indexOf("localCloseReportSafetyIssues(text)");
  const appendIdx = fnSource.indexOf("appendFixedCloseReportHashtags(text)");
  assert.ok(formatIdx < safetyIdx && safetyIdx < appendIdx);
});

test("2+7: generateCloseReport only counts material_scope 'today' points toward the safety gate, never 'next'", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function generateCloseReport(");
  const end = source.indexOf("\nasync function", start + 1);
  const fnSource = source.slice(start, end);
  assert.match(fnSource, /const todayPoints = importantPoints\.filter\(\(point\) => point\.material_scope === "today"\)/u);
  assert.match(fnSource, /verifiedTodayPointCount:\s*todayPoints\.length/u);
  // The filtered `importantPoints` set (which still includes "next" points, e.g. for the writer's
  // 明日への注目点 section) is deliberately NOT what's passed to the safety gate below.
  assert.doesNotMatch(fnSource, /verifiedTodayPointCount:\s*importantPoints\.length/u);
});

test("6: the collection schema tags every important_point with material_scope (today/next), close_report-only", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(source, /CLOSE_REPORT_MATERIAL_SCOPE_SCHEMA\s*=\s*\{\s*type:\s*"string",\s*enum:\s*\["today",\s*"next"\]/u);
  assert.match(source, /material_scope:\s*CLOSE_REPORT_MATERIAL_SCOPE_SCHEMA/u);
  assert.match(source, /required:\s*\[\.\.\.REPORT_POINT_REQUIRED,\s*"material_scope"\]/u);
  // The shared morning_report constants themselves are untouched.
  assert.doesNotMatch(source, /REPORT_POINT_REQUIRED\s*=\s*\[[^\]]*material_scope/u);
});

test("collection prompt tells the model to prefer today's own material over padding with next-scope items", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function generateCloseReport(");
  const end = source.indexOf("\nasync function", start + 1);
  const fnSource = source.slice(start, end);
  assert.match(fnSource, /件数を揃えるためだけにnextを使わず/u);
  assert.match(fnSource, /max_tool_calls:\s*4/u);
});

test("14: plan_close_report() already excludes weekends and JPX holidays (verified against the applied migration)", async () => {
  const migration = await readFile(
    new URL("../../migrations/20260829050000_add_close_report.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /extract\(isodow from p_date\) in \(6, ?7\)/u);
  assert.match(migration, /market_holidays/u);
});
