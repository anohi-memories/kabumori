export const IMPORTANT_NEWS_CATEGORIES = [
  "earnings_revision_up", "earnings_revision_down", "earnings",
  "share_buyback", "dividend_increase", "dividend_decrease", "no_dividend",
  "ma", "tob", "business_alliance", "capital_alliance", "large_order",
  "misconduct", "administrative_action", "litigation", "major_shareholder",
  "large_shareholding", "other_corporate_ir", "boj", "frb", "interest_rates",
  "fx", "tariffs", "china_policy", "us_government_policy", "geopolitics",
  "war_ceasefire", "sanctions", "major_security_incident",
  "semiconductor_ai", "other_market_moving",
] as const;

export const IMPORTANT_NEWS_IMPORTANCE = ["no_post", "important", "most_important"] as const;
export const IMPORTANT_NEWS_STATUSES = [
  "fetched", "duplicate", "pending_judgement", "rejected",
  "ready_for_generation", "ready_for_publish", "generation_failed",
  "publishing", "publish_failed", "published", "failed",
] as const;

export type ImportantNewsCategory = typeof IMPORTANT_NEWS_CATEGORIES[number];
export type ImportantNewsImportance = typeof IMPORTANT_NEWS_IMPORTANCE[number];
export type ImportantNewsStatus = typeof IMPORTANT_NEWS_STATUSES[number];
export type ImportantNewsSourceType = "tdnet" | "company_ir" | "market_macro" | "breaking_market";

export const DEFAULT_IMPORTANT_NEWS_SETTINGS = {
  isActive: false,
  intervalMinutes: 20,
  autoPublish: false,
  lunaEnabled: true,
  solEscalationEnabled: true,
} as const;

export type IncomingNewsCandidate = {
  sourceType: ImportantNewsSourceType;
  sourceUrl: string;
  sourceName: string;
  title: string;
  bodySummary?: string | null;
  companyName?: string | null;
  companyCode?: string | null;
  entityKey?: string | null;
  category: ImportantNewsCategory;
  publishedAt: string;
};

export type PreparedNewsCandidate = IncomingNewsCandidate & {
  sourceUrl: string;
  normalizedTitle: string;
  contentHash: string;
};

export type DuplicateComparable = {
  id: string;
  sourceUrl: string;
  normalizedTitle: string;
  contentHash: string;
  companyCode: string | null;
  entityKey: string | null;
  publishedAt: string;
};

export function isImportantNewsCategory(value: unknown): value is ImportantNewsCategory {
  return typeof value === "string" && (IMPORTANT_NEWS_CATEGORIES as readonly string[]).includes(value);
}

export function isImportantNewsImportance(value: unknown): value is ImportantNewsImportance {
  return typeof value === "string" && (IMPORTANT_NEWS_IMPORTANCE as readonly string[]).includes(value);
}

export function isImportantNewsStatus(value: unknown): value is ImportantNewsStatus {
  return typeof value === "string" && (IMPORTANT_NEWS_STATUSES as readonly string[]).includes(value);
}

export function candidateStatusForDuplicate(
  duplicateId: string | null,
): "pending_judgement" | "duplicate" {
  return duplicateId ? "duplicate" : "pending_judgement";
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

export function normalizeNewsTitle(title: string): string {
  return normalizeText(title).replace(/[「」『』【】［］()[\]“”‘’"']/gu, " ").replace(/\s+/gu, " ").trim();
}

export function normalizeSourceUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("INVALID_SOURCE_URL");
  url.hash = "";
  for (const key of Array.from(url.searchParams.keys())) {
    if (/^(utm_|ref$|source$|campaign$)/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  return url.toString();
}

function entityIdentity(candidate: Pick<IncomingNewsCandidate, "entityKey" | "companyCode">): string {
  return normalizeText(candidate.entityKey || candidate.companyCode || "");
}

export async function createImportantNewsContentHash(
  candidate: Pick<IncomingNewsCandidate, "title" | "bodySummary" | "entityKey" | "companyCode">,
): Promise<string> {
  const payload = [
    normalizeNewsTitle(candidate.title),
    normalizeText(candidate.bodySummary || ""),
    entityIdentity(candidate),
  ].join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function prepareNewsCandidate(candidate: IncomingNewsCandidate): Promise<PreparedNewsCandidate> {
  return {
    ...candidate,
    sourceUrl: normalizeSourceUrl(candidate.sourceUrl),
    normalizedTitle: normalizeNewsTitle(candidate.title),
    contentHash: await createImportantNewsContentHash(candidate),
  };
}

export function findNewsDuplicate(
  candidate: PreparedNewsCandidate,
  existing: DuplicateComparable[],
): DuplicateComparable | null {
  const exact = existing.find((item) =>
    item.contentHash === candidate.contentHash || item.sourceUrl === candidate.sourceUrl
  );
  if (exact) return exact;
  const identity = entityIdentity(candidate);
  const publishedAt = Date.parse(candidate.publishedAt);
  if (!Number.isFinite(publishedAt)) return null;
  return existing.find((item) => {
    const existingIdentity = normalizeText(item.entityKey || item.companyCode || "");
    const existingPublishedAt = Date.parse(item.publishedAt);
    return item.normalizedTitle === candidate.normalizedTitle &&
      existingIdentity === identity && Number.isFinite(existingPublishedAt) &&
      Math.abs(existingPublishedAt - publishedAt) <= 24 * 60 * 60 * 1000;
  }) ?? null;
}
