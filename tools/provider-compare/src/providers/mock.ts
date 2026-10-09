import type { CallContext, NeutralRequest, Provider, ProviderName, ProviderResult, Usage } from "../types.ts";
import { costUsd } from "../pricing.ts";
import { ProviderFailure, type RetryOptions, toProviderError, withRetry, DEFAULT_RETRY } from "../retry.ts";
import { emptyResult, parseJsonText } from "./common.ts";

// A scripted provider for tests and for `--mode mock` runs: no network, no key, fully deterministic. The responder
// decides what each request returns (text or a ProviderFailure), so retry, budget and parse handling can be driven
// through the same code path the real providers use.

export type MockReply = { text: string; usage?: Partial<Usage>; stopReason?: string };

export type MockResponder = (request: NeutralRequest, attempt: number) => MockReply | ProviderFailure;

export type MockProviderOptions = {
  name?: ProviderName;
  model: string;
  label?: string;
  responder: MockResponder;
  retry?: RetryOptions;
  /** Cost estimate reported to the budget guard before each attempt. */
  estimateUsd?: number;
};

const FAST_RETRY: RetryOptions = { ...DEFAULT_RETRY, baseDelayMs: 0, maxDelayMs: 0, sleep: () => Promise.resolve() };

export function createMockProvider(options: MockProviderOptions): Provider {
  const label = options.label ?? options.model;
  const retry = options.retry ?? FAST_RETRY;
  return {
    name: options.name ?? "mock",
    model: options.model,
    label,
    async run(request: NeutralRequest, context: CallContext = {}): Promise<ProviderResult> {
      const result = emptyResult(options.name ?? "mock", options.model, label);
      // deno-lint-ignore require-await
      const outcome = await withRetry(async (attempt) => {
        context.beforeAttempt?.(options.estimateUsd ?? 0);
        const reply = options.responder(request, attempt);
        if (reply instanceof ProviderFailure) {
          context.afterAttempt?.(0);
          throw reply;
        }
        const usage: Usage = {
          inputTokens: reply.usage?.inputTokens ?? 0,
          outputTokens: reply.usage?.outputTokens ?? 0,
          cacheReadTokens: reply.usage?.cacheReadTokens ?? 0,
          cacheWriteTokens: reply.usage?.cacheWriteTokens ?? 0,
          webSearchRequests: reply.usage?.webSearchRequests ?? 0,
        };
        let priced = 0;
        try {
          priced = costUsd(options.model, usage);
        } catch {
          priced = 0; // an unpriced mock model is allowed; its cost is simply 0
        }
        context.afterAttempt?.(priced);
        return { reply, usage, priced };
      }, retry);
      result.attempts = outcome.attempts;
      if (!outcome.ok) {
        result.error = toProviderError(outcome.failure);
        return result;
      }
      const { reply, usage, priced } = outcome.value;
      const { parsed, parseError } = parseJsonText(reply.text, request.schema !== undefined);
      return { ...result, ok: true, text: reply.text, parsed, parseError, usage, costUsd: priced, stopReason: reply.stopReason ?? "end_turn" };
    },
  };
}
