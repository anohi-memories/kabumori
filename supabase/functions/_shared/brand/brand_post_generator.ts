// Phase 3E: a real (OpenAI-backed) content generator usable by any brand's BrandCodeProfile, not a
// Kabumori helper repurposed for AI Lab. It imports nothing from x-test-post/index.ts or
// kabumori_voice.ts -- the only inputs are context.codeProfile / context.operationalSettings, so a brand
// with an unconfigured or Kabumori-shaped profile can never leak Kabumori's persona, hashtags, or
// prompts into another brand's output (see brand_post_generator_test.ts for the fixture proof). Kabumori
// itself does not use this module -- its six existing post_type generators in index.ts are untouched, and
// this module never reaches "kabumori" through any of its own logic (it works from whatever
// BrandContext it is given).
import { assertBrandDryRunAllowed } from "./publish_guard.ts";
import { BrandContextError, type BrandContext } from "./brand_context.ts";

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
  if (typeof response !== "object" || response === null) return { input: 0, output: 0 };
  const usage = (response as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return { input: 0, output: 0 };
  const input = (usage as { input_tokens?: unknown }).input_tokens;
  const output = (usage as { output_tokens?: unknown }).output_tokens;
  return { input: typeof input === "number" ? input : 0, output: typeof output === "number" ? output : 0 };
}

// Same per-token rates x-test-post/index.ts uses for its default (non-Sol) model tier.
function costUsd(input: number, output: number): number {
  return Number(((input * 0.2 + output * 1.2) / 1_000_000).toFixed(6));
}

const DEFAULT_TOPIC_SEED = "AIツールを使った日々のちょっとした工夫";

export async function generateBrandPost({
  openAiApiKey,
  context,
  postType,
  topicSeed,
  fetchImpl = fetch,
}: {
  openAiApiKey: string;
  context: BrandContext;
  postType: string;
  topicSeed?: string;
  fetchImpl?: typeof fetch;
}): Promise<BrandPostDraft> {
  // Generation is allowed for dry_run and live (same rule as buildBrandDryRunPreview) -- only a
  // disabled/unknown brand is refused here. Whether the *result* may reach X is a separate question,
  // decided later by assertBrandPublishAllowed, never by this function.
  assertBrandDryRunAllowed(context);
  if (!context.codeProfile.dryRunPostTypes.includes(postType)) {
    throw new BrandContextError("BRAND_POST_TYPE_UNSUPPORTED");
  }

  const hashtagInstruction = context.operationalSettings.fixed_hashtags.length > 0
    ? `本文の末尾にこのハッシュタグをそのまま付けてください: ${context.operationalSettings.fixed_hashtags.join(" ")}`
    : "ハッシュタグは付けないでください。";
  const instructions = [
    ...context.codeProfile.voiceInstructions,
    "日本語で、200〜400文字程度の自然な一つの投稿本文だけを書いてください。見出し・箇条書き記号・前置きは不要です。",
    hashtagInstruction,
  ].join("\n");
  const topic = topicSeed?.trim() || DEFAULT_TOPIC_SEED;

  const response = await fetchImpl(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${openAiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      store: false,
      reasoning: { effort: "low" },
      max_output_tokens: 600,
      instructions,
      input: `今日のテーマ: ${topic}`,
    }),
  });
  if (!response.ok) throw new BrandContextError(`BRAND_POST_GENERATION_FAILED:${response.status}`);
  const raw = await response.json();
  const text = extractOutputText(raw);
  if (!text) throw new BrandContextError("BRAND_POST_EMPTY_OUTPUT");
  const usage = getUsage(raw);

  return {
    brandId: context.brand.id,
    postType,
    text,
    model: MODEL,
    inputTokens: usage.input,
    outputTokens: usage.output,
    apiCostUsd: costUsd(usage.input, usage.output),
  };
}
