// Official Federal Reserve FOMC statement adapter (Phase 2B2).
//
// This module is deliberately pure at its core: HTML extraction, target-range
// parsing, deterministic decision classification, and document identity are
// independently testable. It accepts only official federalreserve.gov URLs;
// no third-party news source is a valid fallback.
import type { MarketEventInput } from "./mic_normalize_logic.ts";

export const FED_STATEMENT_SOURCE_KEY = "fed" as const;
export const FED_STATEMENT_SOURCE_NAME = "Federal Reserve" as const;
export const FED_STATEMENT_SOURCE_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
export const FED_FOMC_CALENDAR_URL = FED_STATEMENT_SOURCE_URL;

export class FedStatementAdapterError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "FedStatementAdapterError";
  }
}

export type FedDecision = "hike" | "cut" | "hold" | "mixed" | "non_rate";

export type FedTargetRange = {
  lower: number;
  upper: number;
};

export type FedStatement = {
  statementUrl: string;
  meetingDate: string;
  publishedAt: string;
  normalizedText: string;
  documentHash: string;
  targetRange: FedTargetRange | null;
};

export type FedStatementIdentity = {
  meetingDate: string;
  documentHash: string;
};

const OFFICIAL_HOST = "www.federalreserve.gov";
const STATEMENT_PATH = /^\/newsevents\/pressreleases\/monetary\d{8}[a-z0-9]+\.htm$/i;
const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

export function assertOfficialFedStatementUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FedStatementAdapterError("FED_INVALID_URL", "statement URL is not a URL");
  }
  if (url.protocol !== "https:" || url.hostname !== OFFICIAL_HOST || !STATEMENT_PATH.test(url.pathname)) {
    throw new FedStatementAdapterError("FED_NON_OFFICIAL_URL", "only official Federal Reserve statement URLs are accepted");
  }
  return url.toString();
}

export function extractOfficialFedStatementUrls(calendarHtml: string): string[] {
  const ranked: Array<{ url: string; score: number }> = [];
  for (const match of calendarHtml.matchAll(/<a\b[^>]*href=["']([^"']*monetary\d{8}[a-z0-9]+\.htm)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const candidate = new URL(match[1], FED_FOMC_CALENDAR_URL).toString();
    try {
      const officialUrl = assertOfficialFedStatementUrl(candidate);
      const path = new URL(officialUrl).pathname;
      const label = normalizeFedStatementHtml(match[2]).toLowerCase();
      const exactStatement = /\/monetary\d{8}a\.htm$/i.test(path);
      const implementationNote = /\/monetary\d{8}a\d+\.htm$/i.test(path) || /implementation|technical note|press conference|minutes|projection|dot plot|sep|longer-run goals|monetary policy strategy|notation vote/.test(label);
      if (implementationNote) continue;
      ranked.push({
        url: officialUrl,
        score: (exactStatement ? 1000 : 0) + (label.includes("statement") ? 100 : 0),
      });
    } catch {
      // Ignore malformed/non-official links from the page.
    }
  }
  return [...new Map(ranked.map((entry) => [entry.url, entry])).values()]
    .sort((a, b) => b.score - a.score || b.url.localeCompare(a.url))
    .map((entry) => entry.url);
}

function decodeHtml(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;|&mdash;/gi, "-")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)));
}

export function normalizeFedStatementHtml(html: string): string {
  const withoutNonContent = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const text = withoutNonContent.replace(/<[^>]+>/g, " ");
  return decodeHtml(text).replace(/\s+/g, " ").trim();
}

function parseMonthDate(month: string, day: string, year: string): string {
  const monthNumber = MONTHS[month.toLowerCase()];
  if (!monthNumber) throw new FedStatementAdapterError("FED_DATE_MISSING", `unknown month ${month}`);
  return `${year}-${monthNumber}-${day.padStart(2, "0")}`;
}

export function parseFedMeetingDate(text: string): string {
  const match = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:\s*[-–]\s*\d{1,2})?,\s*(\d{4})\b/i);
  if (!match) throw new FedStatementAdapterError("FED_MEETING_DATE_MISSING", "FOMC meeting date is missing");
  return parseMonthDate(match[1], match[2], match[3]);
}

export function parseFedPublishedAt(text: string, fallbackDate?: string): string {
  const dateMatch = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})\b/i);
  if (!dateMatch && !fallbackDate) throw new FedStatementAdapterError("FED_PUBLISHED_AT_MISSING", "publication date is missing");
  const date = dateMatch ? parseMonthDate(dateMatch[1], dateMatch[2], dateMatch[3]) : fallbackDate!;
  const timeMatch = text.match(/For release at\s+(\d{1,2}):(\d{2})\s*(a\.m\.|p\.m\.)\s*(ET|EDT|EST)?/i);
  if (!timeMatch || !timeMatch[4]) throw new FedStatementAdapterError("FED_PUBLISHED_AT_MISSING", "publication time and timezone are missing");
  let hour = Number(timeMatch[1]);
  if (timeMatch[3].toLowerCase().startsWith("p") && hour !== 12) hour += 12;
  if (timeMatch[3].toLowerCase().startsWith("a") && hour === 12) hour = 0;
  try {
    // Resolve America/New_York with the runtime timezone database instead of
    // hardcoding an EDT/EST offset. The abbreviation is validated against the
    // official text but DST conversion is delegated to Temporal.
    const [year, month, day] = date.split("-").map(Number);
    const zoned = Temporal.ZonedDateTime.from({
      timeZone: "America/New_York",
      year,
      month,
      day,
      hour,
      minute: Number(timeMatch[2]),
      second: 0,
      millisecond: 0,
    });
    return zoned.toInstant().toString({ fractionalSecondDigits: 3 });
  } catch {
    throw new FedStatementAdapterError("FED_PUBLISHED_AT_INVALID", "publication timestamp is invalid");
  }
}

function parseFraction(value: string): number {
  const normalized = value.trim().replace(/¾/g, "-3/4").replace(/½/g, "-1/2").replace(/¼/g, "-1/4");
  const mixed = normalized.match(/^(\d+(?:\.\d+)?)\s*(?:-|\s)\s*(\d+)\s*\/\s*(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const number = Number(normalized.replace(/%$/, ""));
  if (!Number.isFinite(number)) throw new FedStatementAdapterError("FED_TARGET_RANGE_INVALID", `invalid rate ${value}`);
  return number;
}

export function parseFedTargetRange(text: string): FedTargetRange | null {
  const match = text.match(/target range for the federal funds rate[^.]{0,180}?\b(\d+(?:\.\d+)?(?:\s*[-–]\s*\d+\/\d+)?|\d+[¾½¼])\s*(?:to|–|-)\s*(\d+(?:\.\d+)?(?:\s*[-–]\s*\d+\/\d+)?|\d+[¾½¼])\s*percent/i);
  if (!match) return null;
  const lower = parseFraction(match[1]);
  const upper = parseFraction(match[2]);
  if (lower > upper) throw new FedStatementAdapterError("FED_TARGET_RANGE_INVALID", "lower rate exceeds upper rate");
  return { lower, upper };
}

export function classifyFedDecision(previous: FedTargetRange | null, current: FedTargetRange | null): FedDecision {
  if (!current) return "non_rate";
  if (!previous) return "hold";
  const lower = Math.sign(current.lower - previous.lower);
  const upper = Math.sign(current.upper - previous.upper);
  if (lower > 0 && upper > 0) return "hike";
  if (lower < 0 && upper < 0) return "cut";
  if (lower === 0 && upper === 0) return "hold";
  return "mixed";
}

export function statementIdentityChanged(previous: FedStatementIdentity | null, current: FedStatementIdentity): "new_meeting" | "duplicate" | "revision" {
  if (!previous || previous.meetingDate !== current.meetingDate) return "new_meeting";
  return previous.documentHash === current.documentHash ? "duplicate" : "revision";
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function parseFedStatementHtml(statementUrl: string, html: string, previousRange: FedTargetRange | null = null): Promise<FedStatement & { decision: FedDecision }> {
  const officialUrl = assertOfficialFedStatementUrl(statementUrl);
  const normalizedText = normalizeFedStatementHtml(html);
  if (normalizedText.length < 80) throw new FedStatementAdapterError("FED_MALFORMED_HTML", "statement body is too short");
  const meetingDate = parseFedMeetingDate(normalizedText);
  const publishedAt = parseFedPublishedAt(normalizedText, meetingDate);
  const targetRange = parseFedTargetRange(normalizedText);
  const documentHash = await sha256Hex(normalizedText);
  return {
    statementUrl: officialUrl,
    meetingDate,
    publishedAt,
    normalizedText,
    documentHash,
    targetRange,
    decision: classifyFedDecision(previousRange, targetRange),
  };
}

export function buildFedDecisionEvent(
  statement: FedStatement & { decision: FedDecision },
  previousRange: FedTargetRange | null,
  isRevision = false,
): MarketEventInput {
  const current = statement.targetRange;
  const changeBps = current && previousRange
    ? { lower: Math.round((current.lower - previousRange.lower) * 100), upper: Math.round((current.upper - previousRange.upper) * 100) }
    : null;
  const ratePayload = current ? {
    FED_FUNDS_TARGET_LOWER: { old_rate: previousRange?.lower ?? null, new_rate: current.lower, change_bps: changeBps?.lower ?? null },
    FED_FUNDS_TARGET_UPPER: { old_rate: previousRange?.upper ?? null, new_rate: current.upper, change_bps: changeBps?.upper ?? null },
  } : null;
  return {
    occurredAt: statement.meetingDate + "T00:00:00.000Z",
    publishedAt: statement.publishedAt,
    eventType: "central_bank_decision",
    category: "macro",
    subcategory: "fomc",
    country: "US",
    entityType: "central_bank",
    // The document identity is part of the normalized event identity. This
    // makes a same-meeting statement revision a new content hash while an
    // exact re-fetch remains a duplicate; URL alone is never the identity.
    entityId: `Fed:${statement.meetingDate}:${statement.documentHash}`,
    title: `Fed FOMC ${statement.meetingDate} ${statement.decision}`,
    summary: current
      ? `Federal Reserve target range ${current.lower}% to ${current.upper}% (${statement.decision}).`
      : `Federal Reserve FOMC statement published for ${statement.meetingDate}; no target-range change was extracted.`,
    sourceName: FED_STATEMENT_SOURCE_NAME,
    sourceUrl: statement.statementUrl,
    sourceKey: FED_STATEMENT_SOURCE_KEY,
    sourceTimestamp: statement.publishedAt,
    importance: "high",
    marketDirection: "unclear",
    confidence: current ? 0.99 : 0.8,
    rawPayload: {
      central_bank: "Fed",
      meeting_date: statement.meetingDate,
      published_at: statement.publishedAt,
      effective_at: null,
      decision: statement.decision,
      statement_url: statement.statementUrl,
      source_key: FED_STATEMENT_SOURCE_KEY,
      rates: ratePayload,
      document_hash: statement.documentHash,
      content_hash: statement.documentHash,
      normalized_statement_hash: statement.documentHash,
      is_revision: isRevision,
    },
  };
}

export async function fetchFedStatement(statementUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const officialUrl = assertOfficialFedStatementUrl(statementUrl);
  const response = await fetchImpl(officialUrl, { headers: { Accept: "text/html" } });
  if (!response.ok) throw new FedStatementAdapterError("FED_HTTP_ERROR", `status=${response.status}`);
  const html = await response.text();
  if (!html) throw new FedStatementAdapterError("FED_EMPTY_HTML", "statement response was empty");
  return html;
}

export async function fetchFedStatementEvents(
  fetchImpl: typeof fetch = fetch,
  previousRange: FedTargetRange | null = null,
  previousIdentities: FedStatementIdentity[] = [],
): Promise<MarketEventInput[]> {
  const calendarResponse = await fetchImpl(FED_FOMC_CALENDAR_URL, { headers: { Accept: "text/html" } });
  if (!calendarResponse.ok) throw new FedStatementAdapterError("FED_CALENDAR_HTTP_ERROR", `status=${calendarResponse.status}`);
  const calendarHtml = await calendarResponse.text();
  const statementUrl = extractOfficialFedStatementUrls(calendarHtml)[0];
  if (!statementUrl) throw new FedStatementAdapterError("FED_STATEMENT_NOT_FOUND", "official calendar contained no statement link");
  const statementHtml = await fetchFedStatement(statementUrl, fetchImpl);
  const statement = await parseFedStatementHtml(statementUrl, statementHtml, previousRange);
  const previousIdentity = previousIdentities.find((identity) => identity.meetingDate === statement.meetingDate) ?? null;
  const identityOutcome = statementIdentityChanged(previousIdentity, statement);
  return [buildFedDecisionEvent(statement, previousRange, identityOutcome === "revision")];
}
