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

const GENERATE_ROLE = "ai_salaryman_lab.brand_post.generate";
const REWRITE_ROLE = "ai_salaryman_lab.brand_post.rewrite_voice";

const DRAFT_VOICE_INSTRUCTIONS = [
  "友達との会話くらいの短い日本語。具体的なものや場面を最初に一つ出し、その話に必要なことだけ書く。文字数の目安を埋めるために段落を足さない。",
  "前置き→解説→反例→教訓の組み立てにしない。『線引き』『決まる気がする』のような抽象語や遠回しな締めに頼らず、普段使う動詞と短い文で言い切れるところまで。一般論のまとめや格言を足さず、具体的なところで終えてよい。",
  "読点は一文に最大1個。不要な主語は省く。必要な一人称は『私』。事実や体験を作らず、質問は交流の指定がある場合だけ。『。笑』を使わず、笑や絵文字は話に合う場合だけ。",
].join("\n");

const VOICE_REWRITE_SCHEMA = {
  name: "ai_lab_voice_rewrite",
  schema: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["edited", "keep", "review"] },
      text: { type: "string" },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "integer" }, option: { type: "integer" } },
          required: ["id", "option"],
          additionalProperties: false,
        },
      },
    },
    required: ["decision", "text", "edits"],
    additionalProperties: false,
  } satisfies JsonSchema,
};

/** One factory per dispatch: the same cap covers every business content retry. */
export function createAiLabTextProvider(
  deps: Pick<ExecuteDeps, "readEnv" | "fetch">,
  twoStage = false,
) {
  const scope = {
    provider: "anthropic",
    application: "ai_salaryman_lab",
    feature: "brand_post",
  } as const;
  // Invocation budget only. This does not replace an account's monthly spending limit or credit balance.
  const budget = new InMemoryBudgetGuard([{
    id: "ai_lab_brand_post",
    scope,
    maxCalls: twoStage ? 4 : 3,
    maxEstimatedUsd: twoStage ? 0.60 : 0.45,
    maxUsdPerCall: 0.15,
  }, {
    id: "ai_lab_brand_post_generate",
    scope: { ...scope, logicalRole: GENERATE_ROLE },
    maxCalls: 3,
    maxEstimatedUsd: 0.45,
  }, {
    id: "ai_lab_brand_post_rewrite",
    scope: { ...scope, logicalRole: REWRITE_ROLE },
    maxCalls: twoStage ? 1 : 0,
  }]);
  return async (
    request: TextRequest,
    stage: "generate" | "rewrite" = "generate",
  ) => {
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
      logicalRole: stage === "rewrite" ? REWRITE_ROLE : GENERATE_ROLE,
      systemInstructions: request.instructions +
        (twoStage && stage === "generate"
          ? "\n" + DRAFT_VOICE_INSTRUCTIONS
          : "") +
        (request.outputSchema || stage === "rewrite"
          ? ""
          : "\n返却形式のみJSONとし、完成した投稿本文をtextフィールドに入れてください。文章の内容・長さの指示はそのまま適用してください。"),
      userContent: request.input,
      jsonSchema: request.outputSchema ?? {
        name: stage === "rewrite" ? "ai_lab_voice_rewrite" : "ai_lab_post_text",
        schema: TEXT_SCHEMA,
      },
      reasoningEffort: "low",
      maxOutputTokens: request.maxOutputTokens,
      timeoutMs: stage === "rewrite" ? 20_000 : twoStage ? 25_000 : 60_000,
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
        : stage === "rewrite"
        ? payload.text
        : payload.text.trim(),
      model: result.actualModel,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      apiCostUsd: result.estimatedCostUsd,
    };
  };
}

/** The server flag selects both stages together. OFF leaves the existing generator selected. */
export function createAiLabClaudeStages(
  deps: Pick<ExecuteDeps, "readEnv" | "fetch">,
) {
  if (deps.readEnv("AI_LAB_CLAUDE_TWO_STAGE") !== "enabled") return {};
  const provider = createAiLabTextProvider(deps, true);
  return {
    textProvider: (request: TextRequest) => provider(request),
    rewriteVoice: async (
      { brandId, postType, instructions, input }: Omit<
        TextRequest,
        "maxOutputTokens" | "outputSchema"
      >,
    ) => {
      const result = await provider({
        brandId,
        postType,
        instructions,
        input,
        maxOutputTokens: 3072,
        outputSchema: VOICE_REWRITE_SCHEMA,
      }, "rewrite");
      return JSON.parse(result.text) as unknown;
    },
  };
}
