import {
  normalizeMorningMetric,
  parseMarketNumber,
  type NormalizedMorningMetric,
  type RawMorningMetric,
} from "./morning_report_logic.ts";

export type UsPremarketMetricKind =
  | "futures"
  | "premarket_stock"
  | "semiconductor_signal"
  | "realtime_optional";
export type UsPremarketRunMode = "live" | "preflight";
export type UsPremarketMetric = NormalizedMorningMetric;
export type { RawMorningMetric as RawUsPremarketMetric };

export type UsPremarketFactResult = { status: "passed" | "failed"; notes: string[] };

function zonedParts(value: string, timeZone: string): { weekday: string; minutes: number } | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { weekday: get("weekday"), minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function isUsDaylightSaving(referenceIso: string): boolean {
  const date = new Date(referenceIso);
  if (Number.isNaN(date.getTime())) return false;
  const zoneName = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", timeZoneName: "shortOffset",
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? "";
  return zoneName === "GMT-4";
}

export function resolveUsPremarketRunMode(referenceIso: string): UsPremarketRunMode {
  const jst = zonedParts(referenceIso, "Asia/Tokyo");
  if (!jst || ["Sat", "Sun"].includes(jst.weekday)) return "preflight";
  const start = isUsDaylightSaving(referenceIso) ? 21 * 60 + 50 : 22 * 60 + 50;
  return jst.minutes >= start && jst.minutes <= start + 20 ? "live" : "preflight";
}

export function validateUsPremarketFreshness(
  kind: UsPremarketMetricKind,
  timestamp: string,
  referenceIso: string,
  mode: UsPremarketRunMode,
): UsPremarketMetric["freshness"] {
  const observed = new Date(timestamp);
  const reference = new Date(referenceIso);
  if (Number.isNaN(observed.getTime()) || Number.isNaN(reference.getTime())) return "invalid_timestamp";
  const ageMinutes = (reference.getTime() - observed.getTime()) / 60_000;
  if (ageMinutes < -5) return "invalid_timestamp";
  if (mode === "preflight") return "preflight_latest";
  const maxAgeMinutes = kind === "semiconductor_signal" ? 96 * 60
    : kind === "realtime_optional" ? 60 : 45;
  return ageMinutes <= maxAgeMinutes ? "fresh" : "stale";
}

export function normalizeUsPremarketMetric(
  raw: RawMorningMetric,
  kind: UsPremarketMetricKind,
  referenceIso: string,
  mode: UsPremarketRunMode,
): UsPremarketMetric {
  const normalized = normalizeMorningMetric(raw, "realtime_optional", referenceIso, mode === "live" ? "live" : "preflight");
  return { ...normalized, freshness: validateUsPremarketFreshness(kind, raw.timestamp, referenceIso, mode) };
}

export function evaluateUsPremarketFacts(args: {
  requiredFutures: UsPremarketMetric[];
  semiconductorSignal: UsPremarketMetric | null;
  movers: UsPremarketMetric[];
  optional: UsPremarketMetric[];
  trustedSourceCount: number;
  dateConsistencyPassed: boolean;
  importantNewsVerified: boolean;
  isUsMarketOpen: boolean;
  mode: UsPremarketRunMode;
}): UsPremarketFactResult {
  const notes: string[] = [];
  const missing = args.requiredFutures.filter((metric) =>
    parseMarketNumber(metric.value) === null || !metric.timestamp || !metric.source_url
  );
  if (missing.length) notes.push(`必須米先物データ取得不能: ${missing.map((metric) => metric.label).join(", ")}`);
  if (!args.semiconductorSignal || parseMarketNumber(args.semiconductorSignal.value) === null ||
    !args.semiconductorSignal.timestamp || !args.semiconductorSignal.source_url) {
    notes.push("半導体関連データ取得不能");
  }
  const present = [
    ...args.requiredFutures,
    ...(args.semiconductorSignal ? [args.semiconductorSignal] : []),
    ...args.movers,
    ...args.optional,
  ];
  const contradictory = present.filter((metric) => metric.numeric_consistency === "failed");
  if (contradictory.length) notes.push(`数値矛盾: ${contradictory.map((metric) => metric.label).join(", ")}`);
  const stale = present.filter((metric) =>
    metric.freshness === "invalid_timestamp" || (args.mode === "live" && metric.freshness === "stale")
  );
  if (stale.length) notes.push(`鮮度基準外: ${stale.map((metric) => metric.label).join(", ")}`);
  if (!args.dateConsistencyPassed) notes.push("米国取引日またはデータ日付の取り違え");
  if (args.mode === "live" && !args.isUsMarketOpen) notes.push("米国市場休場");
  if (args.trustedSourceCount < 2) notes.push("信頼できる独立ソースが不足");
  if (!args.importantNewsVerified) notes.push("重要ニュースの裏取り不能");
  if (args.mode === "preflight") notes.push("事前dry-run: 最新取得可能データで構造と取得経路を確認");
  return { status: notes.some((note) => !note.startsWith("事前dry-run:")) ? "failed" : "passed", notes };
}
