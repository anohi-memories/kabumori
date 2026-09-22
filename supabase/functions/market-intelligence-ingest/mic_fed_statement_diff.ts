import type { FedDecision, FedTargetRange } from "./mic_fed_statement_adapter.ts";

export const FED_STATEMENT_DIFF_PROMPT_VERSION = "fed-statement-diff-v1" as const;

export type FedStatementRecord = {
  eventId: string;
  centralBank: "Fed";
  meetingDate: string;
  documentHash: string;
  normalizedText: string;
  statementUrl: string;
  decision?: FedDecision;
  targetRange?: FedTargetRange | null;
};

export type FedStatementChangeType = "added" | "removed" | "modified";
export type FedStatementSemanticBucket =
  | "inflation" | "labor" | "growth/activity" | "policy stance"
  | "forward guidance" | "balance_sheet" | "financial_conditions" | "risks" | "other";

export type FedStatementParagraphChange = {
  type: FedStatementChangeType;
  previous: string | null;
  current: string | null;
  buckets: FedStatementSemanticBucket[];
  material: boolean;
};

export type FedStatementDeterministicDiff = {
  comparisonStatus: "baseline_only" | "compared";
  skipReason: "first_statement_no_baseline" | null;
  unchangedParagraphs: string[];
  addedParagraphs: string[];
  removedParagraphs: string[];
  modifiedParagraphs: Array<{ previous: string; current: string }>;
  changes: FedStatementParagraphChange[];
  buckets: FedStatementSemanticBucket[];
  material: boolean;
  diffHash: string;
};

export type FedStatementAiInput = {
  previous: { eventId: string; meetingDate: string; statementUrl: string; decision?: FedDecision; targetRange?: FedTargetRange | null };
  current: { eventId: string; meetingDate: string; statementUrl: string; decision?: FedDecision; targetRange?: FedTargetRange | null };
  changes: Array<{ previous: string | null; current: string | null; buckets: FedStatementSemanticBucket[] }>;
};

export type FedStatementAiDirection = "more_hawkish" | "more_dovish" | "neutral" | "unclear";
export type FedStatementAiOutput = {
  summary: string;
  changes: Array<{
    bucket: FedStatementSemanticBucket;
    direction: FedStatementAiDirection;
    previous: string;
    current: string;
    interpretation: string;
    confidence: number;
  }>;
  overall_bias_change: "more_hawkish" | "more_dovish" | "neutral" | "mixed" | "unclear";
  confidence: number;
};

export type FedStatementDiffStorageRecommendation = {
  mode: "new_table";
  table: "mic_fed_statement_diffs";
  reason: string;
  columns: readonly string[];
};

export const FED_STATEMENT_DIFF_STORAGE: FedStatementDiffStorageRecommendation = {
  mode: "new_table",
  table: "mic_fed_statement_diffs",
  reason: "market_events stores event identity and compact raw payload, but not both normalized statement bodies; mutating historical events would break immutable Fact and dedupe semantics.",
  columns: [
    "source_event_id", "previous_event_id", "meeting_date", "previous_meeting_date",
    "previous_document_hash", "current_document_hash", "deterministic_diff_hash",
    "deterministic_diff", "buckets", "material", "ai_interpretation",
    "model", "prompt_version", "generated_at",
  ],
};

const EXCLUDED_LINE = /^(header|footer|navigation|copyright|all rights reserved|board of governors|www\.|https?:\/\/|voting members?|for release at|statement on longer-run goals)/i;
const BUCKET_RULES: Array<[FedStatementSemanticBucket, RegExp]> = [
  ["inflation", /inflation|price stability|prices?|pce|consumer price|2 percent/i],
  ["labor", /employment|unemployment|payroll|job gains?|labor market|wage/i],
  ["growth/activity", /economic activity|growth|output|consumption|spending|investment|demand/i],
  ["policy stance", /federal funds|target range|restrictive|stance|policy rate|monetary policy/i],
  ["forward guidance", /expects?|anticipat|remain(s)? restrictive|data dependent|future adjustment/i],
  ["balance_sheet", /balance sheet|runoff|holdings|securities|quantitative|asset purchases|treasur/i],
  ["financial_conditions", /financial conditions|credit|yields?|lending|spread/i],
  ["risks", /risks?|uncertainty|dual mandate|outlook/i],
];

function normalizeParagraph(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalParagraph(input: string): string {
  return normalizeParagraph(input).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function splitFedStatementParagraphs(normalizedText: string): string[] {
  return normalizedText
    .split(/(?:\r?\n){1,}|(?<=\.)\s{2,}/)
    .map(normalizeParagraph)
    .filter((paragraph) => paragraph.length >= 20 && !EXCLUDED_LINE.test(paragraph));
}

export function classifyFedStatementBuckets(text: string): FedStatementSemanticBucket[] {
  const buckets = BUCKET_RULES.filter(([, pattern]) => pattern.test(text)).map(([bucket]) => bucket);
  return buckets.length > 0 ? buckets : ["other"];
}

function isInsignificant(previous: string, current: string): boolean {
  const p = canonicalParagraph(previous);
  const c = canonicalParagraph(current);
  if (p === c) return true;
  if (/voting|member|governor|president|copyright|all rights reserved/i.test(previous + " " + current)) return true;
  const withoutDates = (value: string) => value.replace(/\d{1,4}/g, "");
  return withoutDates(p) === withoutDates(c) && !classifyFedStatementBuckets(current).some((bucket) => bucket !== "other");
}

function paragraphSimilarity(previous: string, current: string): number {
  const tokens = (value: string) => new Set(normalizeParagraph(value).toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const left = tokens(previous);
  const right = tokens(current);
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / new Set([...left, ...right]).size;
}

async function hashText(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function selectPreviousFedStatement(events: readonly FedStatementRecord[], currentMeetingDate: string): FedStatementRecord | null {
  return events
    .filter((event) => event.centralBank === "Fed" && event.meetingDate < currentMeetingDate)
    .sort((a, b) => b.meetingDate.localeCompare(a.meetingDate))[0] ?? null;
}

export async function buildFedStatementDiff(previous: FedStatementRecord | null, current: FedStatementRecord): Promise<FedStatementDeterministicDiff> {
  if (!previous) {
    const diffHash = await hashText(JSON.stringify({
      comparisonStatus: "baseline_only",
      skipReason: "first_statement_no_baseline",
      currentDocumentHash: current.documentHash,
    }));
    return {
      comparisonStatus: "baseline_only",
      skipReason: "first_statement_no_baseline",
      unchangedParagraphs: [],
      addedParagraphs: [],
      removedParagraphs: [],
      modifiedParagraphs: [],
      changes: [],
      buckets: [],
      material: false,
      diffHash,
    };
  }
  const previousParagraphs = splitFedStatementParagraphs(previous.normalizedText);
  const currentParagraphs = splitFedStatementParagraphs(current.normalizedText);
  const previousByCanonical = new Map(previousParagraphs.map((value) => [canonicalParagraph(value), value]));
  const currentByCanonical = new Map(currentParagraphs.map((value) => [canonicalParagraph(value), value]));
  const unchangedParagraphs = currentParagraphs.filter((value) => previousByCanonical.has(canonicalParagraph(value)));
  const unmatchedPrevious = previousParagraphs.filter((value) => !currentByCanonical.has(canonicalParagraph(value)));
  const unmatchedCurrent = currentParagraphs.filter((value) => !previousByCanonical.has(canonicalParagraph(value)));
  const modifiedParagraphs: Array<{ previous: string; current: string }> = [];
  const changes: FedStatementParagraphChange[] = [];
  const remainingPrevious = [...unmatchedPrevious];
  const remainingCurrent = [...unmatchedCurrent];
  while (remainingPrevious.length > 0 && remainingCurrent.length > 0) {
    let bestPreviousIndex = 0;
    let bestCurrentIndex = 0;
    let bestSimilarity = 0;
    for (let previousIndex = 0; previousIndex < remainingPrevious.length; previousIndex += 1) {
      for (let currentIndex = 0; currentIndex < remainingCurrent.length; currentIndex += 1) {
        const similarity = paragraphSimilarity(remainingPrevious[previousIndex], remainingCurrent[currentIndex]);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestPreviousIndex = previousIndex;
          bestCurrentIndex = currentIndex;
        }
      }
    }
    if (bestSimilarity < 0.25) break;
    const oldText = remainingPrevious.splice(bestPreviousIndex, 1)[0];
    const newText = remainingCurrent.splice(bestCurrentIndex, 1)[0];
    modifiedParagraphs.push({ previous: oldText, current: newText });
    const buckets = [...new Set([...classifyFedStatementBuckets(oldText), ...classifyFedStatementBuckets(newText)])];
    changes.push({ type: "modified", previous: oldText, current: newText, buckets, material: !isInsignificant(oldText, newText) });
  }
  for (const value of remainingCurrent) {
    const buckets = classifyFedStatementBuckets(value);
    changes.push({ type: "added", previous: null, current: value, buckets, material: buckets.some((bucket) => bucket !== "other") });
  }
  for (const value of remainingPrevious) {
    const buckets = classifyFedStatementBuckets(value);
    changes.push({ type: "removed", previous: value, current: null, buckets, material: buckets.some((bucket) => bucket !== "other") });
  }
  const buckets = [...new Set(changes.flatMap((change) => change.buckets))];
  const material = changes.some((change) => change.material);
  const addedParagraphs = remainingCurrent;
  const removedParagraphs = remainingPrevious;
  const diffHash = await hashText(JSON.stringify({ comparisonStatus: "compared", unchangedParagraphs, addedParagraphs, removedParagraphs, modifiedParagraphs }));
  return {
    comparisonStatus: "compared",
    skipReason: null,
    unchangedParagraphs,
    addedParagraphs,
    removedParagraphs,
    modifiedParagraphs,
    changes,
    buckets,
    material,
    diffHash,
  };
}

export function buildFedStatementAiInput(previous: FedStatementRecord, current: FedStatementRecord, diff: FedStatementDeterministicDiff): FedStatementAiInput | null {
  if (!diff.material) return null;
  return {
    previous: { eventId: previous.eventId, meetingDate: previous.meetingDate, statementUrl: previous.statementUrl, decision: previous.decision, targetRange: previous.targetRange },
    current: { eventId: current.eventId, meetingDate: current.meetingDate, statementUrl: current.statementUrl, decision: current.decision, targetRange: current.targetRange },
    changes: diff.changes.filter((change) => change.material).map(({ previous: oldText, current: newText, buckets }) => ({ previous: oldText, current: newText, buckets })),
  };
}

export function validateFedStatementAiOutput(value: unknown): value is FedStatementAiOutput {
  if (!value || typeof value !== "object") return false;
  const output = value as Record<string, unknown>;
  const directions = new Set(["more_hawkish", "more_dovish", "neutral", "unclear"]);
  const overall = new Set(["more_hawkish", "more_dovish", "neutral", "mixed", "unclear"]);
  if (typeof output.summary !== "string" || !overall.has(String(output.overall_bias_change)) || typeof output.confidence !== "number" || output.confidence < 0 || output.confidence > 1 || !Array.isArray(output.changes)) return false;
  return output.changes.every((change) => {
    if (!change || typeof change !== "object") return false;
    const item = change as Record<string, unknown>;
    return typeof item.bucket === "string" && directions.has(String(item.direction)) && typeof item.previous === "string" && typeof item.current === "string" && typeof item.interpretation === "string" && typeof item.confidence === "number" && item.confidence >= 0 && item.confidence <= 1;
  });
}

export async function buildFedStatementDiffIdentity(previous: FedStatementRecord | null, current: FedStatementRecord, diff: FedStatementDeterministicDiff, promptVersion = FED_STATEMENT_DIFF_PROMPT_VERSION): Promise<string> {
  return await hashText(JSON.stringify({ previousEventId: previous?.eventId ?? null, previousDocumentHash: previous?.documentHash ?? null, currentEventId: current.eventId, currentDocumentHash: current.documentHash, diffHash: diff.diffHash, promptVersion }));
}

export function shouldRunFedStatementAi(diffIdentity: string, alreadyProcessed: readonly string[]): boolean {
  return !alreadyProcessed.includes(diffIdentity);
}
