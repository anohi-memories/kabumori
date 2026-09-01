export const IMPORTANT_NEWS_MIN_POST_INTERVAL_MS = 10 * 60 * 1000;

export type RateControlImportance = "important" | "most_important";

export type ImportantNewsRateControlDecision = {
  allowed: boolean;
  bypassed: boolean;
  rateLimitedUntil: string | null;
  reason: string | null;
};

export type RateControlledPublishCandidate = {
  id: string;
  importance: string;
  generatedAt: string | null;
};

export function evaluateImportantNewsRateControl(
  importance: string,
  latestPublishedAt: string | null,
  now: Date,
): ImportantNewsRateControlDecision {
  if (importance === "most_important") {
    return { allowed: true, bypassed: true, rateLimitedUntil: null, reason: null };
  }
  if (importance !== "important") {
    return {
      allowed: false,
      bypassed: false,
      rateLimitedUntil: null,
      reason: "NEWS_RATE_CONTROL_INVALID_IMPORTANCE",
    };
  }
  if (latestPublishedAt === null) {
    return { allowed: true, bypassed: false, rateLimitedUntil: null, reason: null };
  }
  const latest = Date.parse(latestPublishedAt);
  if (!Number.isFinite(latest)) {
    return {
      allowed: false,
      bypassed: false,
      rateLimitedUntil: null,
      reason: "NEWS_RATE_CONTROL_INVALID_HISTORY",
    };
  }
  const nextAllowedAt = latest + IMPORTANT_NEWS_MIN_POST_INTERVAL_MS;
  if (now.getTime() >= nextAllowedAt) {
    return { allowed: true, bypassed: false, rateLimitedUntil: null, reason: null };
  }
  return {
    allowed: false,
    bypassed: false,
    rateLimitedUntil: new Date(nextAllowedAt).toISOString(),
    reason: "NEWS_PUBLISH_RATE_LIMITED",
  };
}

function importancePriority(value: string): number {
  if (value === "most_important") return 0;
  if (value === "important") return 1;
  return 2;
}

function queueTime(value: string | null): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function orderImportantNewsPublishQueue<T extends RateControlledPublishCandidate>(
  candidates: T[],
): T[] {
  return [...candidates].sort((left, right) =>
    importancePriority(left.importance) - importancePriority(right.importance) ||
    queueTime(left.generatedAt) - queueTime(right.generatedAt) ||
    left.id.localeCompare(right.id)
  );
}
