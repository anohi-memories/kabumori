import type { NeutralRequest, Usage } from "./types.ts";
import type { LedgerAverages } from "./providers/recorded.ts";

// Pre-call estimates used by dry-run reports and by the cost simulation. They are ASSUMPTIONS until the first
// small live run replaces them with measured usage; every number here is labelled that way in the reports.

/**
 * Fallback only (a task with no ledger entry): prompt tokens per character of a Japanese-heavy JSON request. This is a
 * rough guess, NOT a measurement; replace it by `messages.count_tokens` once a key is available. Claude's tokenizer
 * differs from OpenAI's (the pricing docs say models since Opus 4.7 produce ~30% more tokens for the same text), which
 * is why every Claude estimate also carries a tokenizerFactor.
 */
export const TOKENS_PER_CHAR = 0.6;

export type ThinkingSetting = "default" | "off";

/** Extra OUTPUT tokens per call spent on thinking, by Claude model and effort. UNMEASURED assumptions. */
export const THINKING_OVERHEAD_TOKENS: Readonly<Record<string, Readonly<Record<"low" | "medium" | "high", number>>>> = {
  "claude-haiku-5-5": { low: 150, medium: 400, high: 900 },
  "claude-sonnet-5-5": { low: 250, medium: 600, high: 1400 },
  "claude-opus-5-5": { low: 300, medium: 800, high: 1800 },
};

export function thinkingOverhead(model: string, effort: "low" | "medium" | "high", thinking: ThinkingSetting): number {
  const row = THINKING_OVERHEAD_TOKENS[model];
  if (!row) return 0; // OpenAI models: reasoning tokens are already inside the ledger's average output
  // Haiku 5.5 and Sonnet 5.5 can turn thinking off; Opus 5.5 cannot, so "off" still pays its overhead.
  if (thinking === "off" && model !== "claude-opus-5-5") return 0;
  return row[effort];
}

export type EstimateSpec = {
  model: string;
  effort?: "low" | "medium" | "high";
  thinking?: ThinkingSetting;
  /** 1.0 = same token count as the OpenAI ledger; 1.3 = Claude counts 30% more for the same text. */
  tokenizerFactor?: number;
};

const LEDGER_FEATURE_FOR_TASK: Readonly<Record<string, string>> = {
  judgement_primary: "judgement_luna",
  judgement_detail: "judgement_sol",
  generation_draft: "generation_draft",
  generation_fact: "generation_fact",
  generation_voice: "generation_voice",
  web_search: "breaking_search",
};

export function estimateUsage(
  request: NeutralRequest,
  spec: EstimateSpec,
  averages: LedgerAverages,
): Usage {
  const factor = spec.tokenizerFactor ?? 1;
  const ledger = averages[LEDGER_FEATURE_FOR_TASK[request.taskId] ?? ""];
  const baseOutput = ledger?.avgOutputTokens ?? Math.min(request.maxOutputTokens, 300);
  // The ledger's task-level average is the common base for every provider, so an estimate never makes one vendor look
  // cheaper just because of a different guess about the prompt size. Only without a ledger entry is the size guessed.
  const inputTokens = ledger?.avgInputTokens ??
    Math.ceil((request.system.length + request.user.length) * TOKENS_PER_CHAR);
  const overhead = thinkingOverhead(spec.model, spec.effort ?? request.effort ?? "low", spec.thinking ?? "default");
  return {
    inputTokens: Math.ceil(inputTokens * factor),
    outputTokens: Math.ceil((baseOutput + overhead) * factor),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearchRequests: request.taskId === "web_search" ? 1 : 0,
  };
}
