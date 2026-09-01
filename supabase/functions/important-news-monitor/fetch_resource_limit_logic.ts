import type { ImportantNewsCandidateGroup } from "./important_news_grouping_logic.ts";

export const MAX_IMPORTANT_NEWS_FETCH_GROUPS = 3;
export const MAX_IMPORTANT_NEWS_PDF_ENRICHMENTS = 3;
export const MAX_IMPORTANT_NEWS_LIGHTWEIGHT_CANDIDATES = 100;

export type ImportantNewsCandidateBatchPlan<T> = {
  selectedCandidates: T[];
  deferredCandidates: T[];
  fetchedCandidateCount: number;
  lightweightProcessedCount: number;
  deferredCandidateCount: number;
};

export function planImportantNewsCandidateBatch<T>(
  candidates: T[],
  maxCandidates = MAX_IMPORTANT_NEWS_LIGHTWEIGHT_CANDIDATES,
): ImportantNewsCandidateBatchPlan<T> {
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
    throw new Error("IMPORTANT_NEWS_CANDIDATE_BATCH_LIMIT_INVALID");
  }
  const boundary = Math.min(candidates.length, maxCandidates);
  return {
    selectedCandidates: candidates.slice(0, boundary),
    deferredCandidates: candidates.slice(boundary),
    fetchedCandidateCount: candidates.length,
    lightweightProcessedCount: boundary,
    deferredCandidateCount: candidates.length - boundary,
  };
}

export type ImportantNewsFetchPlan = {
  selectedGroups: ImportantNewsCandidateGroup[];
  deferredGroups: ImportantNewsCandidateGroup[];
  selectedCandidateCount: number;
  deferredCandidateCount: number;
  selectedPdfCount: number;
};

function pdfCount(group: ImportantNewsCandidateGroup): number {
  return group.members.filter((candidate) =>
    candidate.sourceType === "tdnet" && !candidate.bodySummary
  ).length;
}

export function planImportantNewsFetchGroups(
  groups: ImportantNewsCandidateGroup[],
  limits: { maxGroups?: number; maxPdfEnrichments?: number } = {},
): ImportantNewsFetchPlan {
  const maxGroups = limits.maxGroups ?? MAX_IMPORTANT_NEWS_FETCH_GROUPS;
  const maxPdfEnrichments = limits.maxPdfEnrichments ?? MAX_IMPORTANT_NEWS_PDF_ENRICHMENTS;
  if (!Number.isInteger(maxGroups) || maxGroups < 1 ||
    !Number.isInteger(maxPdfEnrichments) || maxPdfEnrichments < 1) {
    throw new Error("IMPORTANT_NEWS_FETCH_LIMIT_INVALID");
  }

  const selectedGroups: ImportantNewsCandidateGroup[] = [];
  let selectedPdfCount = 0;
  let boundary = groups.length;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const groupPdfCount = pdfCount(group);
    const groupLimitReached = selectedGroups.length >= maxGroups;
    const pdfLimitReached = selectedGroups.length > 0 &&
      selectedPdfCount + groupPdfCount > maxPdfEnrichments;
    if (groupLimitReached || pdfLimitReached) {
      boundary = index;
      break;
    }
    // The first event group is atomic even when it alone exceeds the PDF target.
    selectedGroups.push(group);
    selectedPdfCount += groupPdfCount;
  }

  const deferredGroups = groups.slice(boundary);
  return {
    selectedGroups,
    deferredGroups,
    selectedCandidateCount: selectedGroups.reduce((sum, group) => sum + group.members.length, 0),
    deferredCandidateCount: deferredGroups.reduce((sum, group) => sum + group.members.length, 0),
    selectedPdfCount,
  };
}
