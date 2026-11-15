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
  "Xで気軽につぶやく友達口調の短い日本語。整いすぎた説明文、気取った導入、名言風の結論、勉強になる話のまとめにしない。文字数の目安を埋めるために段落を足さない。",
  "見出し付きの解説、毎回の総括、導入→説明→まとめの三段構成を避ける。短い行と少し長い行を混ぜてよい。『線引き』『決まる気がする』のような抽象語や遠回しな締めに頼らず、普段使う動詞で言い切れるところまで。具体的なところで終えてよい。",
  "書き言葉の説明調（『〜である』『〜といえる』『〜が重要です』）を避け、声に出して言える話し言葉で、一文を短く切る。最後に『つまり』『結局』で言い直したり、読者への教訓でまとめたりしない。",
  "題材に書かれていることから書き始める。題材に無い自分の習慣・日課・近況・回想（『最近は〜してる』『最初はそう思ってた』『毎回〜してる』）や開発の場面を、本人の実話として書かない。数値・成果・体験を作らない。例が要るときは『たとえば』で仮定だとわかる形にするか、使わない。",
  "読点は一文に最大1個。不要な主語は省き、一人称『私』は本当に必要な時だけ。『。笑』は使わない。😂😊や笑は自然な場合だけ少量。無理な関西弁や過度な馴れ馴れしさは避ける。質問は交流の指定がある場合だけ。",
].join("\n");

const VOICE_REWRITE_SCHEMA = {
  name: "ai_lab_voice_rewrite",
  schema: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["rewritten", "edited", "review"] },
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
