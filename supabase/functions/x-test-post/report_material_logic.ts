export type ReportMaterialType =
  | "realtime_market"
  | "market_session"
  | "central_bank_policy"
  | "economic_indicator"
  | "corporate"
  | "geopolitics"
  | "other";

export type MaterialFreshness = "usable" | "stale" | "future" | "invalid_timestamp";
export type OptionalMaterialFilterReason = "future" | "unknown_timestamp" | "stale" | null;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T/;

function validCalendarDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function calendarDayDistance(fromDate: string, toDate: string): number | null {
  if (!validCalendarDate(fromDate) || !validCalendarDate(toDate)) return null;
  return (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000;
}

function businessDayDistance(fromDate: string, toDate: string): number | null {
  const days = calendarDayDistance(fromDate, toDate);
  if (days === null || days < 0) return days;
  let count = 0;
  const cursor = new Date(`${fromDate}T00:00:00Z`);
  for (let index = 0; index < days; index += 1) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

export function classifyMaterialFreshness(args: {
  materialType: ReportMaterialType;
  timestamp: string;
  referenceIso: string;
  targetTradingDate: string;
  expectedSessionDate?: string;
  realtimeMaxMinutes?: number;
  futureToleranceMinutes?: number;
}): MaterialFreshness {
  const {
    materialType, timestamp, referenceIso, targetTradingDate,
    expectedSessionDate, realtimeMaxMinutes = 45, futureToleranceMinutes = 5,
  } = args;
  const reference = new Date(referenceIso);
  if (Number.isNaN(reference.getTime()) || !validCalendarDate(targetTradingDate)) return "invalid_timestamp";

  const dateOnly = DATE_ONLY.test(timestamp);
  const dateTime = DATE_TIME.test(timestamp);
  if (!dateOnly && !dateTime) return "invalid_timestamp";
  const materialDate = timestamp.slice(0, 10);
  if (!validCalendarDate(materialDate)) return "invalid_timestamp";

  if (dateOnly) {
    if (materialDate > targetTradingDate) return "future";
    if (materialType === "realtime_market") return "stale";
  } else {
    const observed = new Date(timestamp);
    if (Number.isNaN(observed.getTime())) return "invalid_timestamp";
    const ageMinutes = (reference.getTime() - observed.getTime()) / 60_000;
    if (ageMinutes < -futureToleranceMinutes) return "future";
    if (materialType === "realtime_market") {
      return ageMinutes <= realtimeMaxMinutes ? "usable" : "stale";
    }
  }

  if (materialType === "market_session") {
    return expectedSessionDate && materialDate === expectedSessionDate ? "usable" : "stale";
  }
  if (materialType === "corporate") {
    const distance = businessDayDistance(materialDate, targetTradingDate);
    return distance !== null && distance >= 0 && distance <= 3 ? "usable" : "stale";
  }
  const distance = calendarDayDistance(materialDate, targetTradingDate);
  if (distance === null || distance < 0) return distance !== null && distance < 0 ? "future" : "invalid_timestamp";
  const maxDays = materialType === "central_bank_policy" ? 7
    : materialType === "economic_indicator" ? 4
    : materialType === "geopolitics" ? 3
    : 3;
  return distance <= maxDays ? "usable" : "stale";
}

const FUTURE_SCHEDULE_PATTERN = /(?:公表|発表|決算|開催|会合|イベント).{0,16}(?:予定|見込み)|(?:upcoming|scheduled|earnings\s+due|due\s+to\s+be\s+released|will\s+be\s+released|expected\s+to\s+be\s+released)/iu;

export function classifyOptionalMaterialForInclusion(args: {
  materialType: ReportMaterialType;
  timestamp: string;
  referenceIso: string;
  targetTradingDate: string;
  expectedSessionDate?: string;
  text?: string;
}): { include: boolean; freshness: MaterialFreshness; filteredReason: OptionalMaterialFilterReason } {
  if (FUTURE_SCHEDULE_PATTERN.test(args.text ?? "")) {
    return { include: false, freshness: "future", filteredReason: "future" };
  }
  const freshness = classifyMaterialFreshness(args);
  if (freshness === "future") return { include: false, freshness, filteredReason: "future" };
  if (freshness === "invalid_timestamp") {
    return { include: false, freshness, filteredReason: "unknown_timestamp" };
  }
  if (freshness === "stale") return { include: false, freshness, filteredReason: "stale" };
  return { include: true, freshness, filteredReason: null };
}

export function resolveConditionalMaterialType(
  category: string,
  declaredType?: ReportMaterialType,
): ReportMaterialType {
  if (["fx", "rates", "oil", "crypto"].includes(category)) return "realtime_market";
  if (category === "central_bank") return "central_bank_policy";
  if (category === "economic_indicator") return "economic_indicator";
  if (category === "geopolitics") return "geopolitics";
  if (category === "china" && declaredType === "realtime_market") return "realtime_market";
  return declaredType ?? (category === "china" ? "central_bank_policy" : "other");
}

export function publisherKey(urlValue: string, trustedPublisherDomains: readonly string[]): string | null {
  let hostname: string;
  try {
    hostname = new URL(urlValue).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  const matches = trustedPublisherDomains
    .map((domain) => domain.toLowerCase().replace(/^www\./, ""))
    .filter((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
    .sort((left, right) => right.length - left.length);
  return matches[0] ?? null;
}

export function independentPublisherCount(
  urls: Iterable<string>,
  trustedPublisherDomains: readonly string[],
): number {
  return new Set(Array.from(urls).map((url) => publisherKey(url, trustedPublisherDomains)).filter(Boolean)).size;
}

export function hasStrongCausalAssertion(text: string): boolean {
  return text.split(/[。！？!?\n]+/u).some((sentence) => {
    if (/可能性|とみられ|とみられる|ようです|との見方|意識され/u.test(sentence)) return false;
    return /(?:により|によって|を受けて?|が原因で|が主因となり).*(?:上昇|下落|反落|急騰|急落|買い|売り|重し)|(?:上昇|下落|反落|急騰|急落)の(?:原因|主因)/u.test(sentence);
  });
}

export function hasIndependentCausalSupport(
  sourceUrls: Iterable<string>,
  trustedPublisherDomains: readonly string[],
): boolean {
  return independentPublisherCount(sourceUrls, trustedPublisherDomains) >= 2;
}
