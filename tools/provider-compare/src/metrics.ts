import type { CaseFixture, Importance } from "./fixtures.ts";
import type { NeutralRequest, ProviderResult } from "./types.ts";
import { generationCandidate } from "./tasks.ts";
import {
  appendSourceUrl,
  applyRequiredNewsLabel,
  localFactIssues,
  localVoiceIssues,
} from "../../../supabase/functions/important-news-monitor/post_generation_logic.ts";

// Metrics are deterministic functions of (provider output, fixture). None of them calls a model. They are screens that
// make differences visible, not a verdict: the recorded production decision is a reference, not ground truth, and the
// text checks are string heuristics (documented per function) plus production's own deterministic local Fact/Voice
// checks. Anything that matters for a decision still needs a human read of the paired outputs.

export const IMPORTANCE_RANK: Readonly<Record<Importance, number>> = { no_post: 0, important: 1, most_important: 2 };

function isImportance(value: unknown): value is Importance {
  return value === "no_post" || value === "important" || value === "most_important";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// --- importance judgement ---------------------------------------------------------------------------------------

export type JudgementMetric = {
  valid: boolean;
  importance: Importance | null;
  matchesRecorded: boolean;
  matchesExpected: boolean;
  /** Against the expected label: "over" ranks higher than expected, "under" lower. */
  direction: "match" | "over" | "under" | "invalid";
  /** Expected important or most_important, answered no_post. */
  missedImportant: boolean;
  /** Expected no_post, answered important or most_important. */
  falseAlarm: boolean;
  hasReason: boolean;
};

export function judgementMetric(result: ProviderResult, fixture: CaseFixture): JudgementMetric {
  const parsed = asRecord(result.parsed);
  const importance = parsed && isImportance(parsed.importance) ? parsed.importance : null;
  const expected = fixture.expected.importance;
  if (!result.ok || importance === null) {
    return {
      valid: false, importance: null, matchesRecorded: false, matchesExpected: false,
      direction: "invalid", missedImportant: false, falseAlarm: false, hasReason: false,
    };
  }
  const rank = IMPORTANCE_RANK[importance];
  const expectedRank = IMPORTANCE_RANK[expected];
  return {
    valid: true,
    importance,
    matchesRecorded: importance === fixture.recorded.judgement.importance,
    matchesExpected: importance === expected,
    direction: rank === expectedRank ? "match" : rank > expectedRank ? "over" : "under",
    missedImportant: expectedRank >= 1 && rank === 0,
    falseAlarm: expectedRank === 0 && rank >= 1,
    hasReason: typeof parsed?.reason === "string" && parsed.reason.trim().length > 0,
  };
}

// --- generated post ---------------------------------------------------------------------------------------------

export type DraftMetric = {
  present: boolean;
  charCount: number;
  /** Numbers (2+ digits or decimals) in the post that appear nowhere in the title, body or judgement reason. */
  unsupportedNumbers: string[];
  /** Month-day dates written in the TITLE that the post does not mention. */
  missingTitleDates: string[];
  /** The company's short name (first 3 characters, after stripping market prefix and legal form) appears in the post. */
  companyNameRetained: boolean | null;
  localFactIssues: string[];
  localVoiceIssues: string[];
};

function normalise(text: string): string {
  return text.normalize("NFKC");
}

function numbersIn(text: string): string[] {
  const matches = normalise(text).match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return matches.map((value) => value.replace(/,/g, "")).filter((value) => value.length >= 2 || value.includes("."));
}

function titleDates(title: string): string[] {
  return [...normalise(title).matchAll(/(\d{1,2})月(\d{1,2})日/g)].map((match) => `${Number(match[1])}月${Number(match[2])}日`);
}

function shortCompanyName(name: string | null): string | null {
  if (!name) return null;
  const stripped = normalise(name)
    .replace(/^[gps]-/i, "")
    .replace(/株式会社|有限会社|合同会社/g, "")
    .replace(/[\s・･._-]/g, "");
  return stripped.length >= 2 ? stripped.slice(0, Math.min(3, stripped.length)).toLowerCase() : null;
}

export function draftMetric(text: string | null, fixture: CaseFixture): DraftMetric {
  if (text === null || text.trim().length === 0) {
    return {
      present: false, charCount: 0, unsupportedNumbers: [], missingTitleDates: [],
      companyNameRetained: null, localFactIssues: [], localVoiceIssues: [],
    };
  }
  const candidate = fixture.candidate;
  const sourcePool = new Set(numbersIn(
    [candidate.title, candidate.bodySummary ?? "", fixture.recorded.judgement.reason, candidate.publishedAt].join("\n"),
  ));
  const unsupported = [...new Set(numbersIn(text).filter((value) => !sourcePool.has(value)))].sort();
  const normalisedText = normalise(text);
  const missingDates = [...new Set(titleDates(candidate.title))]
    .filter((date) => !normalisedText.includes(date)).sort();
  const short = shortCompanyName(candidate.companyName);
  const generation = generationCandidate(fixture);
  // Production runs its local checks on the FINAL post: headline label + body + the source line it appends itself.
  const finalText = appendSourceUrl(applyRequiredNewsLabel(text, generation.importance), generation.sourceUrl);
  return {
    present: true,
    charCount: text.length,
    unsupportedNumbers: unsupported,
    missingTitleDates: missingDates,
    companyNameRetained: short === null || candidate.sourceType !== "tdnet" ? null : normalisedText.toLowerCase().includes(short),
    localFactIssues: localFactIssues(generation, finalText),
    localVoiceIssues: localVoiceIssues(finalText),
  };
}

// --- Fact / Voice checks ----------------------------------------------------------------------------------------

export type CheckMetric = {
  valid: boolean;
  passed: boolean | null;
  issueCount: number;
  /** Same verdict as production's recorded check of the same post (a reference, not ground truth). */
  agreesWithRecorded: boolean | null;
};

export function checkMetric(result: ProviderResult, fixture: CaseFixture, kind: "fact" | "voice"): CheckMetric {
  const parsed = asRecord(result.parsed);
  const recordedStatus = kind === "fact"
    ? fixture.recorded.generation?.factStatus
    : fixture.recorded.generation?.voiceStatus;
  if (!result.ok || !parsed || typeof parsed.passed !== "boolean") {
    return { valid: false, passed: null, issueCount: 0, agreesWithRecorded: null };
  }
  const recordedPassed = recordedStatus === "passed" ? true : recordedStatus === "failed" ? false : null;
  return {
    valid: true,
    passed: parsed.passed,
    issueCount: Array.isArray(parsed.issues) ? parsed.issues.length : 0,
    agreesWithRecorded: recordedPassed === null ? null : recordedPassed === parsed.passed,
  };
}

// --- web search -------------------------------------------------------------------------------------------------

export type SearchMetric = {
  sourceCount: number;
  /** Share of surfaced URLs on the allowed outlets (the request's allowed domains, when given). */
  allowedShare: number | null;
  /** Share of URLs that look like an article rather than a marketing / help / account page (host + path heuristic). */
  articleLikeShare: number | null;
  candidateCount: number | null;
};

const UTILITY_HOST = /^(?:pitch|promotion|marketing|assist|help|lei|bookplus|cdc|idrp|officepass|scoopbox|kikakubo|mercury|professional|account|nikkeitest|art|id)\./i;

export function isArticleLikeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (UTILITY_HOST.test(parsed.hostname)) return false;
    return parsed.pathname.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

export function searchMetric(result: ProviderResult, request: NeutralRequest): SearchMetric {
  const urls = result.sourceUrls;
  const domains = request.webSearch?.allowedDomains;
  const onAllowed = (url: string) => {
    try {
      const host = new URL(url).hostname;
      return (domains ?? []).some((domain) => host === domain || host.endsWith(`.${domain}`));
    } catch {
      return false;
    }
  };
  const parsed = asRecord(result.parsed);
  return {
    sourceCount: urls.length,
    allowedShare: urls.length === 0 || !domains ? null : urls.filter(onAllowed).length / urls.length,
    articleLikeShare: urls.length === 0 ? null : urls.filter(isArticleLikeUrl).length / urls.length,
    candidateCount: parsed && Array.isArray(parsed.candidates) ? parsed.candidates.length : null,
  };
}
