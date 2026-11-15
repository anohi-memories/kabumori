import { InMemoryBudgetGuard } from "./budget.ts";
import { executeAiRequest, type ExecuteDeps } from "./execute.ts";
import { AI_LAB_POST_MODEL } from "./model_catalog.ts";
import { PROVIDER_API_KEY_ENV } from "./secrets.ts";
import type { JsonSchema } from "./types.ts";

type TextRequest = {
  brandId: string;
  postType: string;
  instructions: string;
  input: string;
  maxOutputTokens: number;
  outputSchema?: { name: string; schema: Record<string, unknown> };
};

const TEXT_SCHEMA: JsonSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

/** One factory per dispatch: the same cap covers every business content retry. */
export function createAiLabTextProvider(
  deps: Pick<ExecuteDeps, "readEnv" | "fetch">,
) {
  // Invocation budget only. This does not replace an account's monthly spending limit or credit balance.
  const budget = new InMemoryBudgetGuard([{
    id: "ai_lab_brand_post",
    scope: {
      provider: "anthropic",
      application: "ai_salaryman_lab",
      feature: "brand_post",
    },
    maxCalls: 3,
    maxEstimatedUsd: 0.45,
    maxUsdPerCall: 0.15,
  }]);
  return async (request: TextRequest) => {
    if (
      request.brandId !== "ai_salaryman_lab" ||
      request.postType !== "brand_post"
    ) {
      throw new Error("AI_LAB_OPUS_SCOPE_MISMATCH");
    }
    if (
      !Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 1 || request.maxOutputTokens > 3072
    ) {
      throw new Error("AI_LAB_OPUS_OUTPUT_BUDGET_INVALID");
    }
    const result = await executeAiRequest({
      provider: "anthropic",
      model: AI_LAB_POST_MODEL,
      logicalRole: "ai_salaryman_lab.brand_post.generate",
      systemInstructions: request.instructions +
        (request.outputSchema
          ? ""
          : "\n返却形式のみJSONとし、完成した投稿本文をtextフィールドに入れてください。文章の内容・長さの指示はそのまま適用してください。"),
      userContent: request.input,
      jsonSchema: request.outputSchema ??
        { name: "ai_lab_post_text", schema: TEXT_SCHEMA },
      reasoningEffort: "low",
      maxOutputTokens: request.maxOutputTokens,
      timeoutMs: 60_000,
      transport: { maxAttempts: 1, retryOnTimeout: false },
      usageContext: {
        application: "ai_salaryman_lab",
        feature: "brand_post",
        subject: { kind: "system" },
      },
    }, {
      ...deps,
      // Keep the shared credential untouched; only this workload uses its verified key alias.
      readEnv: (name) =>
        name === PROVIDER_API_KEY_ENV.anthropic
          ? deps.readEnv("AI_LAB_TEXT_API_KEY")
          : undefined,
      budget,
    });
    if (!result.ok) {
      throw new Error(`AI_LAB_OPUS_GENERATION_FAILED:${result.errorCode}`);
    }
    if (result.actualModel !== AI_LAB_POST_MODEL) {
      throw new Error("AI_LAB_OPUS_RESPONSE_MODEL_MISMATCH");
    }
    const payload = result.parsedPayload as { text?: unknown };
    if (typeof payload.text !== "string" || !payload.text.trim()) {
      throw new Error("AI_LAB_OPUS_EMPTY_TEXT");
    }
    return {
      text: request.outputSchema
        ? JSON.stringify(result.parsedPayload)
        : payload.text.trim(),
      model: result.actualModel,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      apiCostUsd: result.estimatedCostUsd,
    };
  };
}
