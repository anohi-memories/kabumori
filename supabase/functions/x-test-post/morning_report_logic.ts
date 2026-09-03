export type MorningMetricKind = "us_close" | "nikkei_futures" | "realtime_optional";
export type MorningRunMode = "live" | "preflight";

export const SP500_FIXED_SOURCE_URL = "https://finance.yahoo.com/quote/%5EGSPC/";
export const NASDAQ_FIXED_SOURCE_URL = "https://finance.yahoo.com/quote/%5EIXIC/";

export type RawMorningMetric = {
  label: string;
  value: string;
  previous_close: string;
  change: string;
  change_percent: string;
  timestamp: string;
  source_url: string;
};

export type NormalizedMorningMetric = RawMorningMetric & {
  calculated_change: number | null;
  calculated_change_percent: number | null;
  numeric_consistency: "passed" | "failed" | "insufficient";
  freshness: "fresh" | "stale" | "preflight_latest" | "invalid_timestamp";
};

export type MorningFactResult = {
  status: "passed" | "failed";
  notes: string[];
};

export type MorningReferenceContext = {
  referenceUtc: string;
  referenceJst: string;
  jstCalendarDate: string;
  targetTradingDate: string;
  isTargetTradingDay: boolean;
};

type TradingDayReference = {
  date: string;
  isTradingDay: boolean;
};

function isoDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("INVALID_REFERENCE_TIME");
  return parsed;
}

export function resolveMorningReferenceTime(
  mode: unknown,
  requestedReferenceTime: unknown,
  currentTimeIso: string,
): string {
  const current = isoDate(currentTimeIso).toISOString();
  if (mode !== "morning_report_dry_run" || requestedReferenceTime === undefined) return current;
  if (
    typeof requestedReferenceTime !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(requestedReferenceTime)
  ) {
    throw new Error("MORNING_REPORT_INVALID_REFERENCE_TIME");
  }
  return isoDate(requestedReferenceTime).toISOString();
}

export function resolveMorningReferenceContext(
  referenceIso: string,
  tradingDay: TradingDayReference,
): MorningReferenceContext {
  const date = isoDate(referenceIso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const jstCalendarDate = `${part("year")}-${part("month")}-${part("day")}`;
  if (tradingDay.date !== jstCalendarDate) throw new Error("MORNING_REPORT_TRADING_DATE_MISMATCH");
  return {
    referenceUtc: date.toISOString(),
    referenceJst: `${jstCalendarDate}T${part("hour")}:${part("minute")}:${part("second")}+09:00`,
    jstCalendarDate,
    targetTradingDate: tradingDay.date,
    isTargetTradingDay: tradingDay.isTradingDay,
  };
}

export function morningTargetMatches(
  reference: MorningReferenceContext,
  modelTargetTradingDate: string,
  modelIsJpxBusinessDay: boolean,
): boolean {
  return modelTargetTradingDate === reference.targetTradingDate &&
    modelIsJpxBusinessDay === reference.isTargetTradingDay;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function parseMarketNumber(value: string): number | null {
  if (!value || /取得不能|不明|N\/A/i.test(value)) return null;
  const normalized = value.replace(/[,%円ドル\s]/g, "").replace(/^\+/, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalMarketSource(value: string): string | null {
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname).replace(/\/$/, "");
    return `${url.protocol}//${url.hostname.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

export function isVerifiedFixedMorningSource(
  sourceUrl: string,
  expectedSourceUrl: string,
  actualSourceUrls: Iterable<string>,
): boolean {
  const source = canonicalMarketSource(sourceUrl);
  const expected = canonicalMarketSource(expectedSourceUrl);
  if (!source || !expected || source !== expected) return false;
  return Array.from(actualSourceUrls).some((actual) => canonicalMarketSource(actual) === expected);
}

export function isJstMorningWindow(referenceIso: string): boolean {
  let date: Date;
  try { date = isoDate(referenceIso); } catch { return false; }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = get("weekday");
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return !["Sat", "Sun"].includes(weekday) && minutes >= 8 * 60 + 15 && minutes <= 8 * 60 + 22;
}

export function resolveMorningRunMode(referenceIso: string): MorningRunMode {
  return isJstMorningWindow(referenceIso) ? "live" : "preflight";
}

export function validateMetricFreshness(
  kind: MorningMetricKind,
  timestamp: string,
  referenceIso: string,
  mode: MorningRunMode,
): NormalizedMorningMetric["freshness"] {
  const observedAt = new Date(timestamp);
  const referenceAt = new Date(referenceIso);
  if (Number.isNaN(observedAt.getTime()) || Number.isNaN(referenceAt.getTime())) return "invalid_timestamp";
  const ageMinutes = (referenceAt.getTime() - observedAt.getTime()) / 60_000;
  if (ageMinutes < -5) return "invalid_timestamp";
  if (mode === "preflight" && kind !== "us_close") return "preflight_latest";
  const maxAgeMinutes = kind === "us_close" ? 96 * 60 : kind === "nikkei_futures" ? 20 : 45;
  return ageMinutes <= maxAgeMinutes ? "fresh" : "stale";
}

export function normalizeMorningMetric(
  raw: RawMorningMetric,
  kind: MorningMetricKind,
  referenceIso: string,
  mode: MorningRunMode,
): NormalizedMorningMetric {
  const value = parseMarketNumber(raw.value);
  const previousClose = parseMarketNumber(raw.previous_close);
  const suppliedChange = parseMarketNumber(raw.change);
  let calculatedChange: number | null = null;
  let calculatedPercent: number | null = null;
  let consistency: NormalizedMorningMetric["numeric_consistency"] = "insufficient";

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
    freshness: validateMetricFreshness(kind, raw.timestamp, referenceIso, mode),
  };
}

export function normalizeFixedUsIndexMetric(
  raw: RawMorningMetric,
  referenceIso: string,
  mode: MorningRunMode,
): NormalizedMorningMetric {
  const suppliedPercent = parseMarketNumber(raw.change_percent);
  const normalized = normalizeMorningMetric(raw, "us_close", referenceIso, mode);
  if (
    normalized.calculated_change_percent !== null &&
    suppliedPercent !== null &&
    Math.abs(suppliedPercent - normalized.calculated_change_percent) > 0.01
  ) {
    return { ...normalized, numeric_consistency: "failed" };
  }
  return normalized;
}

export function isNikkeiFuturesAvailable(metric: NormalizedMorningMetric): boolean {
  return parseMarketNumber(metric.value) !== null &&
    parseMarketNumber(metric.previous_close) !== null &&
    parseMarketNumber(metric.change) !== null &&
    parseMarketNumber(metric.change_percent) !== null &&
    Boolean(metric.timestamp) &&
    Boolean(metric.source_url) &&
    metric.numeric_consistency === "passed" &&
    (metric.freshness === "fresh" || metric.freshness === "preflight_latest");
}

export function mentionsUnavailableNikkeiFutures(text: string): boolean {
  return /日経(?:225|平均)?\s*先物|(?:^|[\s\n、。！？!?「『【（(])先物(?:は|が|も|の|を|で|、|：|:)/mu.test(text);
}

export function evaluateMorningFacts(args: {
  required: NormalizedMorningMetric[];
  strictRequired?: NormalizedMorningMetric[];
  optional: NormalizedMorningMetric[];
  verifiedImportantPointCount?: number;
  trustedSourceCount: number;
  importantNewsPresent: boolean;
  importantNewsVerified: boolean;
  unsafeOptionalMaterialCount?: number;
  mode: MorningRunMode;
}): MorningFactResult {
  const notes: string[] = [];
  if ((args.verifiedImportantPointCount ?? 3) < 3) {
    notes.push("出典確認済みの注目ポイントが3件未満");
  }
  const missing = args.required.filter((metric) =>
    parseMarketNumber(metric.value) === null || !metric.timestamp || !metric.source_url
  );
  if (missing.length) notes.push(`必須市場データ取得不能: ${missing.map((metric) => metric.label).join(", ")}`);

  const incomplete = (args.strictRequired ?? []).filter((metric) =>
    parseMarketNumber(metric.value) === null ||
    parseMarketNumber(metric.previous_close) === null ||
    parseMarketNumber(metric.change) === null ||
    parseMarketNumber(metric.change_percent) === null ||
    !metric.timestamp || !metric.source_url
  );
  if (incomplete.length) {
    notes.push(`固定指数データ不足: ${incomplete.map((metric) => metric.label).join(", ")}`);
  }

  const contradictory = [...args.required, ...args.optional]
    .filter((metric) => metric.numeric_consistency === "failed");
  if (contradictory.length) notes.push(`数値矛盾: ${contradictory.map((metric) => metric.label).join(", ")}`);

  const freshnessFailures = args.required.filter((metric, index) => {
    if (metric.freshness === "invalid_timestamp") return true;
    if (args.mode === "preflight" && index === args.required.length - 1) return false;
    return metric.freshness === "stale";
  });
  freshnessFailures.push(...args.optional.filter((metric) => metric.freshness === "invalid_timestamp"));
  if (freshnessFailures.length) notes.push(`鮮度基準外: ${freshnessFailures.map((metric) => metric.label).join(", ")}`);
  if ((args.unsafeOptionalMaterialCount ?? 0) > 0) notes.push("optional材料に未来時刻または不正なtimestampが混入");
  if (args.trustedSourceCount < 2) notes.push("信頼できる独立ソースが不足");
  if (args.importantNewsPresent && !args.importantNewsVerified) {
    notes.push("重要ニュース候補の裏取り不能");
  }
  if (args.mode === "preflight") notes.push("事前dry-run: 現在取得可能な最新データで構造と取得経路を確認");

  return { status: notes.some((note) => !note.startsWith("事前dry-run:")) ? "failed" : "passed", notes };
}

export function validateMorningReportFormat(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const points = normalized.match(
    /^【朝刊】きょうの日本株、ここをチェック☀️\n+📌 今日の注目ポイント\n((?:・[^\n]+\n){2}・[^\n]+)/,
  );
  if (!points || points[1].split("\n").length !== 3) return false;
  return normalized.includes("⚠️ きょう注意したいこと") &&
    normalized.includes("💬 今日のひとこと");
}
