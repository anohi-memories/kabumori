export type UsefulTipModel = "gpt-5.6-luna" | "gpt-5.6-sol";

export type UsefulTipAttemptDiagnostic = {
  model: UsefulTipModel;
  attempt: number;
  maxOutputTokens: number;
  responseStatus: string | null;
  incompleteReason: string | null;
  truncated: boolean;
};

export type UsefulTipGenerationDiagnostics = {
  attemptCount: number;
  retryCount: number;
  truncated: boolean;
  attempts: UsefulTipAttemptDiagnostic[];
  xApiCalled: 0;
};

export type UsefulTipStoredDiagnostics = {
  useful_tip_id: string;
  title: string;
  attempt_count: number;
  retry_count: number;
  truncated: boolean;
  attempts: Array<{
    model: UsefulTipModel;
    attempt: number;
    max_output_tokens: number;
    response_status: string | null;
    incomplete_reason: string | null;
    truncated: boolean;
  }>;
  failure_code?: string;
  x_api_called: 0;
};

export type UsefulTipAttemptSuccess<T> = {
  value: T;
  diagnostic: UsefulTipAttemptDiagnostic;
};

export class UsefulTipAttemptError extends Error {
  readonly diagnostic: UsefulTipAttemptDiagnostic;

  constructor(message: string, diagnostic: UsefulTipAttemptDiagnostic) {
    super(message);
    this.name = "UsefulTipAttemptError";
    this.diagnostic = diagnostic;
  }
}

export class UsefulTipGenerationError extends Error {
  readonly diagnostics: UsefulTipGenerationDiagnostics;

  constructor(message: string, diagnostics: UsefulTipGenerationDiagnostics) {
    super(message);
    this.name = "UsefulTipGenerationError";
    this.diagnostics = diagnostics;
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : "USEFUL_TIP_GENERATION_FAILED";
}

function asGenerationError(
  error: unknown,
  attempts: UsefulTipAttemptDiagnostic[],
  retryCount: number,
): UsefulTipGenerationError {
  const diagnostic = error instanceof UsefulTipAttemptError ? error.diagnostic : null;
  const completedAttempts = diagnostic ? [...attempts, diagnostic] : attempts;
  return new UsefulTipGenerationError(errorCode(error), {
    attemptCount: completedAttempts.length,
    retryCount,
    truncated: completedAttempts.some((item) => item.truncated),
    attempts: completedAttempts,
    xApiCalled: 0,
  });
}

export async function runUsefulTipLunaWithTruncationRetry<T>(
  attempt: (maxOutputTokens: number, attemptNumber: number) => Promise<UsefulTipAttemptSuccess<T>>,
): Promise<{ value: T; diagnostics: UsefulTipGenerationDiagnostics }> {
  const attempts: UsefulTipAttemptDiagnostic[] = [];
  try {
    const first = await attempt(2400, 1);
    attempts.push(first.diagnostic);
    return {
      value: first.value,
      diagnostics: { attemptCount: 1, retryCount: 0, truncated: false, attempts, xApiCalled: 0 },
    };
  } catch (error) {
    if (!(error instanceof UsefulTipAttemptError) || !error.diagnostic.truncated) {
      throw asGenerationError(error, attempts, 0);
    }
    attempts.push(error.diagnostic);
  }

  try {
    const retry = await attempt(3400, 2);
    attempts.push(retry.diagnostic);
    return {
      value: retry.value,
      diagnostics: { attemptCount: 2, retryCount: 1, truncated: true, attempts, xApiCalled: 0 },
    };
  } catch (error) {
    throw asGenerationError(error, attempts, 1);
  }
}

export function appendUsefulTipAttempt(
  diagnostics: UsefulTipGenerationDiagnostics,
  diagnostic: UsefulTipAttemptDiagnostic,
): UsefulTipGenerationDiagnostics {
  const attempts = [...diagnostics.attempts, diagnostic];
  return {
    attemptCount: attempts.length,
    retryCount: diagnostics.retryCount,
    truncated: attempts.some((item) => item.truncated),
    attempts,
    xApiCalled: 0,
  };
}

export function shouldEscalateUsefulTipToSol(
  needsSol: boolean,
  factCheckStatus: "passed" | "failed",
): boolean {
  return needsSol || factCheckStatus !== "passed";
}

export function usefulTipStoredDiagnostics(
  usefulTipId: string,
  title: string,
  diagnostics: UsefulTipGenerationDiagnostics,
  failureCode?: string,
): UsefulTipStoredDiagnostics {
  return {
    useful_tip_id: usefulTipId,
    title,
    attempt_count: diagnostics.attemptCount,
    retry_count: diagnostics.retryCount,
    truncated: diagnostics.truncated,
    attempts: diagnostics.attempts.map((attempt) => ({
      model: attempt.model,
      attempt: attempt.attempt,
      max_output_tokens: attempt.maxOutputTokens,
      response_status: attempt.responseStatus,
      incomplete_reason: attempt.incompleteReason,
      truncated: attempt.truncated,
    })),
    ...(failureCode ? { failure_code: failureCode } : {}),
    x_api_called: 0,
  };
}

export async function runUsefulTipVoiceGatedPublish<TVoice extends { passed: boolean }, TPublish>(args: {
  factCheckStatus: "passed" | "failed";
  text: string;
  evaluateVoice: () => Promise<TVoice>;
  publish: () => Promise<TPublish>;
}): Promise<{ voice: TVoice; publishResult: TPublish }> {
  if (args.factCheckStatus !== "passed" || !args.text) {
    throw new Error("USEFUL_TIP_FACT_CHECK_FAILED");
  }
  const voice = await args.evaluateVoice();
  if (!voice.passed) throw new Error("USEFUL_TIP_VOICE_CHECK_FAILED");
  return { voice, publishResult: await args.publish() };
}
