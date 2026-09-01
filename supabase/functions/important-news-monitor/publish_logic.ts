import { hasMatchingRequiredNewsLabel } from "./post_generation_logic.ts";
import {
  evaluateImportantNewsRateControl,
  type ImportantNewsRateControlDecision,
} from "./rate_control_logic.ts";
import {
  evaluateImportantNewsOvernightHold,
  type ImportantNewsOvernightHoldDecision,
} from "./overnight_hold_logic.ts";

export type PublishCandidate = {
  id: string;
  importance: string;
  status: string;
  generatedText: string | null;
  generationFactStatus: string | null;
  generationVoiceStatus: string | null;
  sourceUrl: string | null;
  xPostId: string | null;
  publishedAt: string | null;
  publishAttempts: number;
};

export type PrePublishCheck = {
  passed: boolean;
  wouldPublish: boolean;
  blockReason: string | null;
  checks: Record<string, boolean>;
};

export type PublishRepository = {
  read(candidateId: string): Promise<PublishCandidate | null>;
  latestPublishedAt(): Promise<string | null>;
  claim(candidateId: string): Promise<PublishCandidate | null>;
  markPublished(candidateId: string, xPostId: string, httpStatus: number): Promise<void>;
  markFailed(candidateId: string, errorCode: string, httpStatus: number | null): Promise<void>;
};

export type XPublisher = (text: string) => Promise<{
  id: string;
  httpStatus: number;
  refreshExecuted: boolean;
}>;

export type PublishResult = {
  candidateId: string;
  importance: string | null;
  status: string | null;
  generatedText: string | null;
  sourceUrl: string | null;
  prePublishCheck: PrePublishCheck;
  wouldPublish: boolean;
  published: boolean;
  xPostId: string | null;
  httpStatus: number | null;
  refreshExecuted: boolean;
  blockReason: string | null;
  rateControl: ImportantNewsRateControlDecision | null;
  overnightHold: ImportantNewsOvernightHoldDecision | null;
};

export function checkPublishCandidate(
  candidate: PublishCandidate | null,
  expectedStatus = "ready_for_publish",
): PrePublishCheck {
  if (!candidate) {
    return {
      passed: false,
      wouldPublish: false,
      blockReason: "NEWS_PUBLISH_CANDIDATE_NOT_FOUND",
      checks: {},
    };
  }
  let validSourceUrl = false;
  try { validSourceUrl = new URL(candidate.sourceUrl ?? "").protocol === "https:"; }
  catch { validSourceUrl = false; }
  const checks = {
    status: candidate.status === expectedStatus,
    importance: candidate.importance === "important" || candidate.importance === "most_important",
    generatedText: typeof candidate.generatedText === "string" && candidate.generatedText.trim().length > 0,
    factPassed: candidate.generationFactStatus === "passed",
    voicePassed: candidate.generationVoiceStatus === "passed",
    sourceUrl: validSourceUrl,
    sourceUrlInText: typeof candidate.generatedText === "string" &&
      typeof candidate.sourceUrl === "string" && candidate.generatedText.includes(candidate.sourceUrl),
    labelMatchesImportance: typeof candidate.generatedText === "string" &&
      hasMatchingRequiredNewsLabel(candidate.generatedText, candidate.importance),
    notPublished: candidate.publishedAt === null,
    xPostIdMissing: candidate.xPostId === null,
  };
  const failed = Object.entries(checks).find(([, passed]) => !passed)?.[0] ?? null;
  return {
    passed: failed === null,
    wouldPublish: failed === null,
    blockReason: failed ? `NEWS_PUBLISH_BLOCKED:${failed}` : null,
    checks,
  };
}

function blockedResult(
  candidateId: string,
  candidate: PublishCandidate | null,
  check: PrePublishCheck,
  rateControl: ImportantNewsRateControlDecision | null = null,
  overnightHold: ImportantNewsOvernightHoldDecision | null = null,
): PublishResult {
  return {
    candidateId,
    importance: candidate?.importance ?? null,
    status: candidate?.status ?? null,
    generatedText: candidate?.generatedText ?? null,
    sourceUrl: candidate?.sourceUrl ?? null,
    prePublishCheck: check,
    wouldPublish: false,
    published: false,
    xPostId: candidate?.xPostId ?? null,
    httpStatus: null,
    refreshExecuted: false,
    blockReason: check.blockReason,
    rateControl,
    overnightHold,
  };
}

function rateLimitedResult(
  candidateId: string,
  candidate: PublishCandidate,
  check: PrePublishCheck,
  rateControl: ImportantNewsRateControlDecision,
  overnightHold: ImportantNewsOvernightHoldDecision,
): PublishResult {
  return {
    ...blockedResult(candidateId, candidate, check, rateControl, overnightHold),
    blockReason: rateControl.reason,
  };
}

function overnightHeldResult(
  candidateId: string,
  candidate: PublishCandidate,
  check: PrePublishCheck,
  overnightHold: ImportantNewsOvernightHoldDecision,
): PublishResult {
  return {
    ...blockedResult(candidateId, candidate, check, null, overnightHold),
    blockReason: overnightHold.reason,
  };
}

export async function publishImportantNewsCandidate(
  candidateId: string,
  dryRun: boolean,
  repository: PublishRepository,
  publisher: XPublisher,
  now = new Date(),
): Promise<PublishResult> {
  const candidate = await repository.read(candidateId);
  const initialCheck = checkPublishCandidate(candidate);
  if (!candidate || candidate.status !== "ready_for_publish" ||
    (candidate.importance !== "important" && candidate.importance !== "most_important")) {
    return blockedResult(candidateId, candidate, initialCheck);
  }
  const overnightHold = evaluateImportantNewsOvernightHold(candidate.importance, now);
  if (overnightHold.held) {
    return overnightHeldResult(candidateId, candidate, initialCheck, overnightHold);
  }
  const rateControl = evaluateImportantNewsRateControl(
    candidate.importance,
    await repository.latestPublishedAt(),
    now,
  );
  if (!rateControl.allowed) {
    return rateLimitedResult(candidateId, candidate, initialCheck, rateControl, overnightHold);
  }
  if (!initialCheck.passed) {
    return blockedResult(candidateId, candidate, initialCheck, rateControl, overnightHold);
  }
  if (dryRun) {
    return {
      ...blockedResult(candidateId, candidate, initialCheck, rateControl, overnightHold),
      wouldPublish: true,
      blockReason: null,
    };
  }

  const claimed = await repository.claim(candidateId);
  if (!claimed) {
    const current = await repository.read(candidateId);
    return blockedResult(candidateId, current, checkPublishCandidate(current));
  }
  const check = checkPublishCandidate(claimed, "publishing");
  if (!check.passed || !claimed.generatedText) {
    const reason = check.blockReason ?? "NEWS_PUBLISH_BLOCKED";
    await repository.markFailed(candidateId, reason, null);
    return blockedResult(candidateId, claimed, check);
  }

  let posted: Awaited<ReturnType<XPublisher>>;
  try {
    posted = await publisher(claimed.generatedText);
  } catch (error) {
    const code = error instanceof Error ? error.message : "X_REQUEST_FAILED";
    const httpStatus = typeof error === "object" && error !== null &&
        typeof (error as { httpStatus?: unknown }).httpStatus === "number"
      ? (error as { httpStatus: number }).httpStatus
      : null;
    await repository.markFailed(candidateId, code, httpStatus);
    return {
      ...blockedResult(candidateId, { ...claimed, status: "publish_failed" }, {
        ...check,
        passed: false,
        wouldPublish: false,
        blockReason: code,
      }, rateControl, overnightHold),
      httpStatus,
    };
  }

  // If this database write fails, the row intentionally remains `publishing`.
  // That prevents an automatic retry from creating a duplicate X post.
  await repository.markPublished(candidateId, posted.id, posted.httpStatus);
  return {
    candidateId,
    importance: claimed.importance,
    status: "published",
    generatedText: claimed.generatedText,
    sourceUrl: claimed.sourceUrl,
    prePublishCheck: check,
    wouldPublish: true,
    published: true,
    xPostId: posted.id,
    httpStatus: posted.httpStatus,
    refreshExecuted: posted.refreshExecuted,
    blockReason: null,
    rateControl,
    overnightHold,
  };
}
