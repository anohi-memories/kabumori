// Phase 3E: a real (OpenAI-backed) content generator usable by any brand's BrandCodeProfile, not a
// Kabumori helper repurposed for AI Lab. It imports nothing from x-test-post/index.ts or
// kabumori_voice.ts -- the only inputs are context.codeProfile / context.operationalSettings, so a brand
// with an unconfigured or Kabumori-shaped profile can never leak Kabumori's persona, hashtags, or
// prompts into another brand's output (see brand_post_generator_test.ts for the fixture proof). Kabumori
// itself does not use this module -- its six existing post_type generators in index.ts are untouched, and
// this module never reaches "kabumori" through any of its own logic (it works from whatever
// BrandContext it is given).
import { assertBrandDryRunAllowed } from "./publish_guard.ts";
import { type BrandContext, BrandContextError } from "./brand_context.ts";
import type { DailyContentPlanItem } from "./daily_content_plan.ts";
import {
  assertPostWithinLengthPolicy,
  postCharacterCount,
  postLengthInstruction,
} from "./post_length_policy.ts";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODEL = "gpt-5.6-luna";

export type BrandPostDraft = {
  brandId: string;
  postType: string;
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  apiCostUsd: number;
  characterCount: number;
};

// Local, brand-agnostic copies of the same three mechanical helpers x-test-post/index.ts defines for its
// own (Kabumori-only) generators. Duplicated rather than imported so this module has zero dependency on
// index.ts -- there is no import path by which a future change to Kabumori's dispatcher could alter this
// module's behavior, or vice versa.
function extractOutputText(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;
  const text = output.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const content = (item as { content?: unknown }).content;
    return Array.isArray(content) ? content : [];
  }).filter((item) =>
    typeof item === "object" && item !== null &&
    (item as { type?: unknown }).type === "output_text" &&
    typeof (item as { text?: unknown }).text === "string"
  ).map((item) => (item as { text: string }).text).join("").trim();
  return text.length > 0 ? text : null;
}

function getUsage(response: unknown): { input: number; output: number } {
  if (typeof response !== "object" || response === null) {
    return { input: 0, output: 0 };
  }
  const usage = (response as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) {
    return { input: 0, output: 0 };
  }
  const input = (usage as { input_tokens?: unknown }).input_tokens;
  const output = (usage as { output_tokens?: unknown }).output_tokens;
  return {
    input: typeof input === "number" ? input : 0,
    output: typeof output === "number" ? output : 0,
  };
}

// Same per-token rates x-test-post/index.ts uses for its default (non-Sol) model tier.
function costUsd(input: number, output: number): number {
  return Number(((input * 0.2 + output * 1.2) / 1_000_000).toFixed(6));
}

const DEFAULT_TOPIC_SEED =
  "個人開発や副業に取り組む会社員が、AIとの試行錯誤を一歩だけ記録する日記";

export async function generateBrandPost({
  openAiApiKey,
  context,
  postType,
  topicSeed,
  contentPlan,
  fetchImpl = fetch,
}: {
  openAiApiKey: string;
  context: BrandContext;
  postType: string;
  topicSeed?: string;
  contentPlan?: DailyContentPlanItem;
  fetchImpl?: typeof fetch;
}): Promise<BrandPostDraft> {
  // Generation is allowed for dry_run and live (same rule as buildBrandDryRunPreview) -- only a
  // disabled/unknown brand is refused here. Whether the *result* may reach X is a separate question,
  // decided later by assertBrandPublishAllowed, never by this function.
  assertBrandDryRunAllowed(context);
  if (!context.codeProfile.dryRunPostTypes.includes(postType)) {
    throw new BrandContextError("BRAND_POST_TYPE_UNSUPPORTED");
  }
  if (contentPlan && context.brand.id !== "ai_salaryman_lab") {
    throw new BrandContextError("AI_LAB_CONTENT_PLAN_BRAND_MISMATCH");
  }

  const hashtagInstruction =
    context.operationalSettings.fixed_hashtags.length > 0
      ? `本文の末尾にこのハッシュタグをそのまま付けてください: ${
        context.operationalSettings.fixed_hashtags.join(" ")
      }`
      : "ハッシュタグは付けないでください。";
  const lengthPolicy = context.codeProfile.postLengthPolicy;
  const fallbackInstruction =
    !contentPlan && context.brand.id === "ai_salaryman_lab"
      ? [
        "具体的な編集計画がないfallbackです。会社員AIラボの主題である個人開発・副業・AIとの試行錯誤の日記に寄せてください。",
        "一般的なAI便利Tips、仕事術の紹介、教科書的なノウハウ記事へ変換しないでください。",
        "架空の進捗、成果、感情、勤務先、個人体験は追加しないでください。",
      ]
      : null;
  const contentPlanInstruction = contentPlan
    ? [
      "以下の編集計画を、この投稿の唯一のテーマと事実上の範囲として扱ってください。",
      "計画にないテーマ、一般論、AI活用のコツ、成果、体験談、背景を追加しないでください。",
      "計画の素材を自然な日本語の一つの投稿本文に編集するだけにしてください。",
      `テーマ: ${contentPlan.topic}`,
      `日全体のテーマ: ${contentPlan.dayTheme || "指定なし"}`,
      `流れ: ${contentPlan.narrativeArc || "指定なし"}`,
      `背景・文脈: ${contentPlan.context || "指定なし"}`,
      `表現上のトーン指定（テーマを変更しない）: ${
        contentPlan.toneOverride || "既存プロフィール"
      }`,
      `必ず触れる要点: ${contentPlan.keyPoints.join(" / ") || "指定なし"}`,
      `必ず含める要素: ${contentPlan.mustInclude.join(" / ") || "指定なし"}`,
      `避ける要素: ${contentPlan.mustAvoid.join(" / ") || "指定なし"}`,
    ].join("\n")
    : null;
  const instructions = [
    ...context.codeProfile.voiceInstructions,
    lengthPolicy
      ? "日本語で、自然な一つの投稿本文だけを書いてください。見出し・箇条書き記号・前置きは不要です。"
      : "日本語で、200〜400文字程度の自然な一つの投稿本文だけを書いてください。見出し・箇条書き記号・前置きは不要です。",
    ...(lengthPolicy ? [postLengthInstruction(lengthPolicy)] : []),
    ...(fallbackInstruction ?? []),
    ...(contentPlanInstruction ? [contentPlanInstruction] : []),
    hashtagInstruction,
  ].join("\n");
  const topic = topicSeed?.trim() || DEFAULT_TOPIC_SEED;
  const input = contentPlan
    ? `今日の編集計画（計画外の内容を補わない）:\n${
      JSON.stringify({
        id: contentPlan.id,
        day_theme: contentPlan.dayTheme,
        narrative_arc: contentPlan.narrativeArc,
        topic: contentPlan.topic,
        context: contentPlan.context,
        tone_override: contentPlan.toneOverride,
        key_points: contentPlan.keyPoints,
        must_include: contentPlan.mustInclude,
        must_avoid: contentPlan.mustAvoid,
      })
    }`
    : `今日のテーマ: ${topic}`;

  const response = await fetchImpl(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      store: false,
      reasoning: { effort: "low" },
      max_output_tokens: 600,
      instructions,
      input,
    }),
  });
  if (!response.ok) {
    throw new BrandContextError(
      `BRAND_POST_GENERATION_FAILED:${response.status}`,
    );
  }
  const raw = await response.json();
  const text = extractOutputText(raw);
  if (!text) throw new BrandContextError("BRAND_POST_EMPTY_OUTPUT");
  let characterCount = postCharacterCount(text);
  if (lengthPolicy) {
    try {
      characterCount = assertPostWithinLengthPolicy(lengthPolicy, text);
    } catch (error) {
      if (
        error instanceof Error && error.message === "POST_LENGTH_LIMIT_EXCEEDED"
      ) {
        throw new BrandContextError("BRAND_POST_LENGTH_LIMIT_EXCEEDED");
      }
      throw error;
    }
  }
  const usage = getUsage(raw);

  return {
    brandId: context.brand.id,
    postType,
    text,
    model: MODEL,
    inputTokens: usage.input,
    outputTokens: usage.output,
    apiCostUsd: costUsd(usage.input, usage.output),
    characterCount,
  };
}
