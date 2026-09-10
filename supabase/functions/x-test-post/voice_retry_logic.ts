export class SingleRetryExhaustedError extends Error {
  readonly firstError: unknown;
  readonly secondError: unknown;

  constructor(firstError: unknown, secondError: unknown) {
    super("VOICE_EVALUATION_RETRY_EXHAUSTED");
    this.name = "SingleRetryExhaustedError";
    this.firstError = firstError;
    this.secondError = secondError;
  }
}

export async function runWithSingleRetry<T>(
  operation: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
): Promise<{ value: T; retryCount: number; failures: unknown[] }> {
  try {
    return { value: await operation(), retryCount: 0, failures: [] };
  } catch (firstError) {
    if (!shouldRetry(firstError)) throw firstError;
    try {
      return { value: await operation(), retryCount: 1, failures: [firstError] };
    } catch (secondError) {
      throw new SingleRetryExhaustedError(firstError, secondError);
    }
  }
}
