import { parseMarketNumber, type RawMorningMetric as RawMarketMetric } from "./morning_report_logic.ts";

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

export function resolveCloseRunMode(referenceIso: string): CloseRunMode {
  const parts = jstParts(referenceIso);
  if (!parts) return "preflight";
  return !["Sat", "Sun"].includes(parts.weekday) &&
      parts.minutes >= 15 * 60 + 45 && parts.minutes <= 16 * 60 + 5
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
  verifiedImportantPointCount?: number;
  trustedSourceCount: number;
  dateConsistencyPassed: boolean;
  importantNewsPresent?: boolean;
  importantNewsVerified: boolean;
  futureInformationAbsent: boolean;
  unsafeOptionalMaterialCount?: number;
  mode: CloseRunMode;
}): CloseFactResult {
  const notes: string[] = [];
  if ((args.verifiedImportantPointCount ?? 3) < 3) {
    notes.push("出典確認済みの今日のポイントが3件未満");
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
  if (args.trustedSourceCount < 2) notes.push("信頼できる独立ソースが不足");
  if ((args.importantNewsPresent ?? true) && !args.importantNewsVerified) {
    notes.push("重要ニュース候補の裏取り不能");
  }
  if (!args.futureInformationAbsent) notes.push("16:00以降に公開された未来情報が混入");
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
