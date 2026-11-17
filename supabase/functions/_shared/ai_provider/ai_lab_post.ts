import { InMemoryBudgetGuard } from "./budget.ts";
import { executeAiRequest, type ExecuteDeps } from "./execute.ts";
import { AI_LAB_POST_MODELS } from "./model_catalog.ts";
import { PROVIDER_API_KEY_ENV } from "./secrets.ts";
import type { AiProvider, JsonSchema } from "./types.ts";

// Task39: the provider of both AI Lab stages is an explicit server setting. Unset keeps today's Claude
// selection; any other value than these two is refused before a key is read or a request is sent.
export const AI_LAB_TWO_STAGE_FLAG_ENV = "AI_LAB_CLAUDE_TWO_STAGE";
export const AI_LAB_TEXT_PROVIDER_ENV = "AI_LAB_TEXT_PROVIDER";
/** Each provider reads only its own dedicated AI Lab key, never the shared OPENAI_API_KEY / ANTHROPIC_API_KEY. */
export const AI_LAB_TEXT_KEY_ENV: Readonly<Record<AiProvider, string>> = Object.freeze({
  anthropic: "AI_LAB_TEXT_API_KEY",
  openai: "AI_LAB_OPENAI_TEXT_API_KEY",
});
/** Error-code prefix per provider; the Anthropic codes keep their Task15 names. */
const ERROR_PREFIX: Readonly<Record<AiProvider, string>> = {
  anthropic: "AI_LAB_OPUS",
  openai: "AI_LAB_OPENAI_TEXT",
};

/** The selected provider, or null for a value that is neither (fail closed, no fallback). */
export function resolveAiLabTextProvider(
  readEnv: (name: string) => string | undefined,
): AiProvider | null {
  const raw = readEnv(AI_LAB_TEXT_PROVIDER_ENV);
  if (raw === undefined || raw === "") return "anthropic";
  return raw === "anthropic" || raw === "openai" ? raw : null;
}

/** OpenAI answers with a dated snapshot of the requested alias (gpt-6.1-sol-2026-09-01). */
function isRequestedModel(
  provider: AiProvider,
  requested: string,
  actual: string | null,
): actual is string {
  if (actual === requested) return true;
  return provider === "openai" && actual !== null &&
    /^-\d{4}-\d{2}-\d{2}$/u.test(actual.slice(requested.length)) &&
    actual.startsWith(requested);
}

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

// Task32: the user rejected the Task31 real draft as still too polished ("もっとフランク").
// Fabrication rules come first; voice rules never license a new episode.
// Task35: nor a progress level, reason, feeling or plan the topic does not state.
const DRAFT_VOICE_INSTRUCTIONS = [
  "最優先: 題材と設定に書かれていない自己経験・日課・近況・考えの変化（『最近は〜してる』『最初はそう思ってた』『〜するようにしてる』など）や、具体的な開発場面・数値・成果を本人の実話として足さない。例が要るなら『たとえば〜とか』と仮定だとわかる形にするか、使わない。",
  "題材に書かれていない進み具合（『あと少しだった』）、決めた理由や考え（『取り消せないから』『そう考えたら迷わなかった』）、気持ち（『怖かった』『焦った』）、ねらい、次回の予定（『次回やる』）も足さない。理由は題材に書かれたものだけを使い、無ければ理由に触れず起きたことだけを書く。題材の『切り口』は話の向きで、題材にない理由を作る指示ではない。短い題材なら短く書いてよい。",
  "Xで友達に気軽につぶやくくらいの短い日本語。整った説明文・気取った導入・名言風の結論・『勉強になる話』にしない。見出し付きの解説、毎回の総括、同じ長さの段落を三つ並べる構成を避ける。",
  "前置き→解説→反例→教訓の組み立てにしない。具体的なものを最初に一つ出し、その話に必要なことだけ書く。文字数の目安を埋めるために段落を足さない。短い一行と少し長い文を混ぜてよく、途中で終わる感じでもいい。",
  "書き言葉の説明調（『〜である』『〜といえる』『〜が重要です』）や『線引き』『決まる気がする』のような抽象語を避け、声に出して言える話し言葉で一文を短く切る。最後に『つまり』『結局』で言い直したり、読者への教訓でまとめたりしない。",
  "読点は一文に最大1個。主語は省けるなら省き、一人称は本当に必要な時だけ『私』。『。笑』は禁止。『笑』『😂』『😊』は自然な所に少しだけ。無理な関西弁や馴れ馴れしすぎる言い方はしない。質問は交流の指定がある場合だけ。",
  // Task37: the Task36 real draft copied the topic's report wording and lined up
  // short noun-stop lines; the user rejected the result as still stiff.
  "語尾は常体の話し言葉でそろえ、途中で急に『〜ました』『〜です』で締めない。『安全側を優先。』『〜な状態。』のような報告書風の体言止めを並べない。題材の『運用』『進捗』『〜の確認を進めた』『あわせて』のような業務報告の言い方をそのまま写さず、友達に話すときの言い方に直す。言い換えても事実の範囲は変えない。",
  "短い文を同じ形で縦に並べるだけにしない。流れでつながる話は『〜してたら』『〜けど』『〜から』で一文にまとめてよい。説明のための『なので』『あわせて』を文頭に置き続けない。",
  // Task39: the Task38 real draft said 「手が止まった」 and the user found it unnatural.
  "普通に友達へ話すX投稿にする。『手が止まった』『頭を抱えた』のような演出した反応や題材にない気持ちを書かない。唐突に『〜し』で切れる終わり方、意味のないフィラー、内輪の手順や認証の事情の説明はしない。題材の中で読んだ人が場面を思い浮かべられる出来事か気づきを一つ選んで、それを中心に書く。そういう出来事が題材に無ければ、無理に膨らませず短く書く。",
].join("\n");

const VOICE_REWRITE_SCHEMA = {
  name: "ai_lab_voice_rewrite",
  schema: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["edited", "rewritten", "keep", "review"] },
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
  provider: AiProvider = "anthropic",
) {
  const model = AI_LAB_POST_MODELS[provider];
  const code = ERROR_PREFIX[provider];
  const scope = {
    provider,
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
  // Same prompts, schemas, caps and timeouts for both providers; the adapters absorb the wire differences.
  return async (
    request: TextRequest,
    stage: "generate" | "rewrite" = "generate",
  ) => {
    if (
      request.brandId !== "ai_salaryman_lab" ||
      request.postType !== "brand_post"
    ) {
      throw new Error(`${code}_SCOPE_MISMATCH`);
    }
    if (
      !Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 1 || request.maxOutputTokens > 3072
    ) {
      throw new Error(`${code}_OUTPUT_BUDGET_INVALID`);
    }
    const result = await executeAiRequest({
      provider,
      model,
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
        name === PROVIDER_API_KEY_ENV[provider]
          ? deps.readEnv(AI_LAB_TEXT_KEY_ENV[provider])
          : undefined,
      budget,
    });
    if (!result.ok) {
      throw new Error(`${code}_GENERATION_FAILED:${result.errorCode}`);
    }
    if (!isRequestedModel(provider, model, result.actualModel)) {
      throw new Error(`${code}_RESPONSE_MODEL_MISMATCH`);
    }
    const payload = result.parsedPayload as { text?: unknown };
    if (typeof payload.text !== "string" || !payload.text.trim()) {
      throw new Error(`${code}_EMPTY_TEXT`);
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

/**
 * The server flag selects both stages together. OFF leaves the existing generator selected.
 * Task39: AI_LAB_TEXT_PROVIDER picks the provider of BOTH stages (unset = anthropic, as before). An unknown value
 * returns stages that refuse every call before any key read or request, so the reservation is held pre-X and
 * no other provider is tried.
 */
export function createAiLabTextStages(
  deps: Pick<ExecuteDeps, "readEnv" | "fetch">,
) {
  if (deps.readEnv(AI_LAB_TWO_STAGE_FLAG_ENV) !== "enabled") return {};
  const selected = resolveAiLabTextProvider(deps.readEnv);
  if (!selected) {
    const refuse = () => Promise.reject(new Error("AI_LAB_TEXT_PROVIDER_INVALID"));
    return { provider: null, textProvider: refuse, rewriteVoice: refuse };
  }
  const provider = createAiLabTextProvider(deps, true, selected);
  return {
    provider: selected,
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

/** Kept for the existing x-test-post import; the provider is chosen by AI_LAB_TEXT_PROVIDER. */
export const createAiLabClaudeStages = createAiLabTextStages;
