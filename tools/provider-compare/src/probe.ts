import Anthropic from "npm:@anthropic-ai/sdk@0.132.1";
import type { NeutralRequest } from "./types.ts";
import { sanitizeSchemaForClaude } from "./schema.ts";
import { redactSecrets } from "./redact.ts";

// The zero-cost preflight. Both calls below are free according to the Anthropic docs (retrieved 2026-10-09):
//   GET  /v1/models                  lists models with a `capabilities` object
//   POST /v1/messages/count_tokens   "free to use", only rate limited (5,000 requests/min on the Start tier)
// It answers, before any paid call: does the key work, which models does THIS organization see, does each model accept
// web search / structured outputs / thinking:disabled, and how many tokens do our real prompts take on Claude
// (replacing the tokenizer assumption in the cost simulation). It never calls /v1/messages.

export type ModelCapabilitySummary = {
  id: string;
  lifecycle: string | null;
  maxInputTokens: number | null;
  maxTokens: number | null;
  webSearch: boolean | null;
  structuredOutputs: boolean | null;
  thinkingCanBeDisabled: boolean | null;
  effortLevels: string[];
};

export type TokenCount = {
  model: string;
  taskId: string;
  caseId: string;
  inputTokens: number;
  /** false when the endpoint rejected the structured-output schema and the count covers system + user only. */
  includesSchema: boolean;
};

export type ProbeReport = {
  keyWorks: boolean;
  error: string | null;
  models: ModelCapabilitySummary[];
  tokenCounts: TokenCount[];
  /** per model and task: mean Claude tokens, mean OpenAI-ledger tokens, and their ratio (the measured tokenizerFactor). */
  factors: Array<{ model: string; taskId: string; n: number; meanClaudeTokens: number; ledgerMeanTokens: number | null; factor: number | null }>;
};

type ModelRow = {
  id?: string;
  lifecycle?: string;
  max_input_tokens?: number | null;
  max_tokens?: number | null;
  capabilities?: {
    server_tools?: { web_search?: { supported?: boolean } };
    structured_outputs?: { supported?: boolean };
    thinking?: { types?: { disabled?: { supported?: boolean } } };
    effort?: Record<string, { supported?: boolean } | boolean | undefined>;
  } | null;
};

function summarise(row: ModelRow): ModelCapabilitySummary {
  const effort = row.capabilities?.effort ?? {};
  return {
    id: String(row.id),
    lifecycle: row.lifecycle ?? null,
    maxInputTokens: row.max_input_tokens ?? null,
    maxTokens: row.max_tokens ?? null,
    webSearch: row.capabilities?.server_tools?.web_search?.supported ?? null,
    structuredOutputs: row.capabilities?.structured_outputs?.supported ?? null,
    thinkingCanBeDisabled: row.capabilities?.thinking?.types?.disabled?.supported ?? null,
    effortLevels: ["low", "medium", "high", "xhigh", "max"].filter((level) => {
      const entry = effort[level];
      return typeof entry === "object" && entry !== null && entry.supported === true;
    }),
  };
}

export async function runProbe(options: {
  apiKey: string;
  models: readonly string[];
  requests: readonly NeutralRequest[];
  /** task id -> mean OpenAI-ledger input tokens, for the ratio. */
  ledgerInputTokens: Readonly<Record<string, number>>;
  fetch?: typeof fetch;
}): Promise<ProbeReport> {
  const secrets = [options.apiKey];
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: 1, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const report: ProbeReport = { keyWorks: false, error: null, models: [], tokenCounts: [], factors: [] };

  try {
    const rows: ModelRow[] = [];
    for await (const row of client.models.list({ limit: 1000 })) rows.push(row as unknown as ModelRow);
    report.keyWorks = true;
    report.models = rows.filter((row) => options.models.includes(String(row.id))).map(summarise)
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    report.error = redactSecrets(String((error as Error)?.message ?? error), secrets).slice(0, 300);
    return report;
  }

  for (const model of options.models) {
    for (const request of options.requests) {
      if (request.webSearch) continue; // the count endpoint rejects server tools
      const base = { model, system: request.system, messages: [{ role: "user", content: request.user }] };
      let includesSchema = false;
      let inputTokens: number;
      try {
        const withSchema = request.schema
          ? { ...base, output_config: { format: { type: "json_schema", schema: sanitizeSchemaForClaude(request.schema.schema).schema } } }
          : base;
        // deno-lint-ignore no-explicit-any
        inputTokens = (await client.messages.countTokens(withSchema as any)).input_tokens;
        includesSchema = request.schema !== undefined;
      } catch {
        try {
          // deno-lint-ignore no-explicit-any
          inputTokens = (await client.messages.countTokens(base as any)).input_tokens;
        } catch (error) {
          report.error = redactSecrets(String((error as Error)?.message ?? error), secrets).slice(0, 300);
          continue;
        }
      }
      report.tokenCounts.push({ model, taskId: request.taskId, caseId: request.caseId, inputTokens, includesSchema });
    }
  }

  const groups = new Map<string, TokenCount[]>();
  for (const count of report.tokenCounts) {
    const key = `${count.model}\u0000${count.taskId}`;
    groups.set(key, [...(groups.get(key) ?? []), count]);
  }
  for (const [, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const mean = group.reduce((sum, count) => sum + count.inputTokens, 0) / group.length;
    const ledger = options.ledgerInputTokens[group[0].taskId] ?? null;
    report.factors.push({
      model: group[0].model,
      taskId: group[0].taskId,
      n: group.length,
      meanClaudeTokens: Math.round(mean),
      ledgerMeanTokens: ledger,
      // The ledger mean covers ALL production calls while the fixtures are a sample, so this ratio is only indicative:
      // the clean comparison is the same request counted on two models (see README, "tokenizer factor").
      factor: ledger ? Math.round((mean / ledger) * 1000) / 1000 : null,
    });
  }
  return report;
}
