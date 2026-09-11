import { parseMarketNumber, type RawMorningMetric as RawMarketMetric } from "./morning_report_logic.ts";
import {
  appendKabumoriReportFixedHashtags,
  hasKabumoriReportFixedHashtagsExactlyOnce,
  KABUMORI_REPORT_FIXED_HASHTAGS,
} from "./fixed_hashtags_logic.ts";

export type CloseMetricKind = "jpx_close" | "nikkei_futures_1545" | "realtime_optional";
export type CloseRunMode = "live" | "preflight";
export type { RawMarketMetric };

export type NormalizedCloseMetric = RawMarketMetric & {
  calculated_change: number | null;
  calculated_change_percent: number | null;
  numeric_consistency: "passed" | "failed" | "insufficient";
  freshness: "fresh" | "stale" | "preflight_latest" | "future" | "invalid_timestamp";
};

export type CloseFactResult = { status: "passed" | "failed"; notes: string[] };

function jstParts(value: string): { date: string; weekday: string; minutes: number } | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday"),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/** Live close reports require same-day post-session index values, not front-session snapshots. */
export function hasSameDayCloseData(
  metric: NormalizedCloseMetric,
  referenceIso: string,
  mode: CloseRunMode,
): boolean {
  if (mode !== "live") return true;
  if (parseMarketNumber(metric.value) === null || !metric.source_url || metric.freshness !== "fresh") return false;
  const observed = jstParts(metric.timestamp);
  const reference = jstParts(referenceIso);
  return Boolean(observed && reference && observed.date === reference.date && observed.minutes >= 15 * 60 + 30);
}

export function resolveCloseRunMode(referenceIso: string): CloseRunMode {
  const parts = jstParts(referenceIso);
  if (!parts) return "preflight";
  return !["Sat", "Sun"].includes(parts.weekday) &&
      parts.minutes >= 16 * 60 + 45 && parts.minutes <= 17 * 60 + 5
    ? "live" : "preflight";
}

export function validateCloseFreshness(
  kind: CloseMetricKind,
  timestamp: string,
  referenceIso: string,
  mode: CloseRunMode,
): NormalizedCloseMetric["freshness"] {
  const observed = new Date(timestamp);
  const reference = new Date(referenceIso);
  const observedParts = jstParts(timestamp);
  const referenceParts = jstParts(referenceIso);
  if (!observedParts || !referenceParts || Number.isNaN(observed.getTime()) || Number.isNaN(reference.getTime())) {
    return "invalid_timestamp";
  }
  const ageMinutes = (reference.getTime() - observed.getTime()) / 60_000;
  if (ageMinutes < -2) return "future";
  if (mode === "preflight") return "preflight_latest";
  if (observedParts.date !== referenceParts.date) return "stale";
  if (kind === "jpx_close") return ageMinutes <= 90 ? "fresh" : "stale";
  if (kind === "nikkei_futures_1545") {
    const around1545 = observedParts.minutes >= 15 * 60 + 35 && observedParts.minutes <= 15 * 60 + 55;
    return around1545 && ageMinutes <= 30 ? "fresh" : "stale";
  }
  return ageMinutes <= 45 ? "fresh" : "stale";
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function normalizeCloseMetric(
  raw: RawMarketMetric,
  kind: CloseMetricKind,
  referenceIso: string,
  mode: CloseRunMode,
): NormalizedCloseMetric {
  const value = parseMarketNumber(raw.value);
  const previousClose = parseMarketNumber(raw.previous_close);
  const suppliedChange = parseMarketNumber(raw.change);
  let calculatedChange: number | null = null;
  let calculatedPercent: number | null = null;
  let consistency: NormalizedCloseMetric["numeric_consistency"] = "insufficient";
  if (value !== null && previousClose !== null && previousClose !== 0) {
    calculatedChange = round(value - previousClose, 4);
    calculatedPercent = round((calculatedChange / previousClose) * 100, 2);
    consistency = suppliedChange === null || Math.abs(suppliedChange - calculatedChange) <= Math.max(0.02, Math.abs(value) * 0.00001)
      ? "passed" : "failed";
  }
  return {
    ...raw,
    change: calculatedChange === null ? raw.change : `${calculatedChange >= 0 ? "+" : ""}${calculatedChange}`,
    change_percent: calculatedPercent === null ? raw.change_percent : `${calculatedPercent >= 0 ? "+" : ""}${calculatedPercent}%`,
    calculated_change: calculatedChange,
    calculated_change_percent: calculatedPercent,
    numeric_consistency: consistency,
    freshness: validateCloseFreshness(kind, raw.timestamp, referenceIso, mode),
  };
}

export function evaluateCloseFacts(args: {
  requiredIndices: NormalizedCloseMetric[];
  futures: NormalizedCloseMetric | null;
  optional: NormalizedCloseMetric[];
  // Only points tagged material_scope "today" (something that happened within today's Japan market
  // session) should ever be counted here — a "next" (upcoming/scheduled) point does not establish that
  // today's move can be explained, no matter how well-sourced it is. Safety requirement is "at least one
  // verified today-fact exists", not "exactly three points survived" — a scarce-material day can still
  // produce a safe, shorter report as long as it has a real anchor to what happened today.
  //
  // "重要ニュース候補が未確認" is deliberately NOT one of this function's inputs. Whether a specific
  // important-news candidate is usable is decided per-item, upstream, by the same source/freshness/
  // causal-support filter every point already goes through before it ever reaches this gate or the
  // writer — an unconfirmed candidate is simply absent from verifiedTodayPointCount, not a reason to
  // fail the whole report. A close report is not required to contain a "重要ニュース" at all (see
  // ケースA/B/C in the brief this implements); it only needs at least one verified today-fact, of
  // whatever kind, from requiredIndices/optional/points feeding verifiedTodayPointCount.
  // A blanket "the whole report must cite >=2 independent publisher domains" requirement used to live
  // here too. Removed: it conflated source DIVERSITY with fact RELIABILITY. Every point already carries
  // its own appropriately-scoped source requirement — a simple verified fact (sourceVerified=true,
  // trusted domain) is usable from one reliable outlet, exactly as a human close-report writer would
  // cite "日経平均は806円高で引けた" from a single trusted publisher without needing a second outlet to
  // repeat the same number. A STRONG causal/interpretive claim ("〜を背景に買われた") still requires
  // independent corroboration — but that is hasIndependentCausalSupport()'s job, enforced per-point
  // where importantPoints/strongThemes/weakThemes are filtered (index.ts), not a report-wide aggregate.
  verifiedTodayPointCount?: number;
  dateConsistencyPassed: boolean;
  futureInformationAbsent: boolean;
  unsafeOptionalMaterialCount?: number;
  mode: CloseRunMode;
}): CloseFactResult {
  const notes: string[] = [];
  if ((args.verifiedTodayPointCount ?? 1) === 0) {
    notes.push("出典確認済みの本日の重要ポイントが0件（今日の相場を説明する裏取り済み事実がありません）");
  }
  const missing = args.requiredIndices.filter((metric) =>
    parseMarketNumber(metric.value) === null || !metric.timestamp || !metric.source_url
  );
  if (missing.length) notes.push(`必須指数取得不能: ${missing.map((metric) => metric.label).join(", ")}`);
  const present = [...args.requiredIndices, ...(args.futures ? [args.futures] : []), ...args.optional];
  const contradictory = present.filter((metric) => metric.numeric_consistency === "failed");
  if (contradictory.length) notes.push(`数値矛盾: ${contradictory.map((metric) => metric.label).join(", ")}`);
  const requiredPresent = [...args.requiredIndices, ...(args.futures ? [args.futures] : [])];
  const freshnessFailures = requiredPresent.filter((metric) =>
    metric.freshness === "future" || metric.freshness === "invalid_timestamp" ||
    (args.mode === "live" && metric.freshness === "stale")
  );
  freshnessFailures.push(...args.optional.filter((metric) =>
    metric.freshness === "future" || metric.freshness === "invalid_timestamp"
  ));
  if (freshnessFailures.length) notes.push(`鮮度または未来時刻エラー: ${freshnessFailures.map((metric) => metric.label).join(", ")}`);
  if ((args.unsafeOptionalMaterialCount ?? 0) > 0) notes.push("optional材料に未来時刻または不正なtimestampが混入");
  if (!args.dateConsistencyPassed) notes.push("取引日の日付取り違え");
  if (!args.futureInformationAbsent) notes.push("17:00以降に公開された未来情報が混入");
  if (args.mode === "preflight") notes.push("事前dry-run: 最新取得可能データで構造と取得経路を確認");
  return { status: notes.some((note) => !note.startsWith("事前dry-run:")) ? "failed" : "passed", notes };
}

export function validateCloseReportFormat(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const points = normalized.match(
    /^【大引け】きょうの日本株まとめ🌙\n+📌 今日の3ポイント\n((?:・[^\n]+\n){2}・[^\n]+)/,
  );
  if (!points || points[1].split("\n").length !== 3) return false;
  return normalized.includes("🔎 強かった・弱かったテーマ") &&
    normalized.includes("👀 明日への注目点") &&
    normalized.includes("💬 今日のひとこと");
}

// Fixed, code-side hashtags — never left to the model to generate or omit. The actual definition now
// lives in fixed_hashtags_logic.ts, shared with morning_report, so the two report types can never drift
// apart. Re-exported here under the existing close-report-specific names so nothing else in this
// codebase (index.ts, close_report_logic_test.ts) needs to change.
export const CLOSE_REPORT_FIXED_HASHTAGS = KABUMORI_REPORT_FIXED_HASHTAGS;
export const appendFixedCloseReportHashtags = appendKabumoriReportFixedHashtags;
export const hasFixedCloseReportHashtagsExactlyOnce = hasKabumoriReportFixedHashtagsExactlyOnce;

// A deterministic, local safety net ahead of the AI Voice check — mirrors the important-news-monitor
// local-guard pattern. Investment-advice and fabricated-experience phrasing are already prohibited in
// the writing prompt and the shared Voice evaluation; this catches the clearest violations in code so
// a close report can never publish on an unlucky Voice-check miss alone.
const INVESTMENT_ADVICE_PATTERN =
  /絶対(?:に)?上がる|必ず上がる|買うべき|売るべき|今すぐ買|今すぐ売|買い時です|売り時です|儲かります|損はしません/u;
const FABRICATED_EXPERIENCE_PATTERN =
  /私(?:は|も)(?:今日|先ほど|さっき)?[^。！？\n]{0,20}(?:買いました|売りました|保有して|含み益|含み損|利益が出)/u;

export function localCloseReportSafetyIssues(text: string): string[] {
  const issues: string[] = [];
  if (INVESTMENT_ADVICE_PATTERN.test(text)) issues.push("INVESTMENT_ADVICE_DETECTED");
  if (FABRICATED_EXPERIENCE_PATTERN.test(text)) issues.push("FABRICATED_EXPERIENCE_DETECTED");
  return issues;
}
