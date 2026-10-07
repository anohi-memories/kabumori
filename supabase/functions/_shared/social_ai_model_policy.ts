/**
 * The one source-controlled text-model policy for X / social auto-post AI:
 *   - POSTONA (social-mobile): AI consultation, preview and live scheduled-user post generation;
 *   - 会社員AIらぼ (AI Lab) scheduled brand posts;
 *   - かぶモリ X auto-post (x-test-post and its direct helpers).
 *
 * A future model release normally changes ONLY this file (the catalog ids/prices, or a workload's tier),
 * followed by a reviewed redeploy of the Edge Functions that import it. There is deliberately no
 * environment-variable override: a live model change is always a reviewed source change.
 *
 * Out of scope (owned elsewhere, never imported from here): the Kabumori app's market-report-analysis /
 * personalized-reports, important-news monitoring, MIC, and image generation (gpt-image-2).
 *
 * Prices are the official standard API rates per 1M tokens (verified 2026-10-07). Hosted-tool fees (for
 * example web-search calls) are separate and stay with their callers.
 */

/** Model catalog: each text tier owns its API id and token rates. */
export const SOCIAL_TEXT_MODELS = {
  /** Routine / high-volume text. */
  fast: { id: "gpt-6-luna", inputUsdPer1M: 0.10, outputUsdPer1M: 0.50 },
  /** Quality escalation (Sol). */
  quality: { id: "gpt-6.1-sol", inputUsdPer1M: 2.00, outputUsdPer1M: 10.00 },
} as const;

export type SocialTextTier = keyof typeof SOCIAL_TEXT_MODELS;
export type SocialTextModelId = (typeof SOCIAL_TEXT_MODELS)[SocialTextTier]["id"];

/**
 * Workload -> tier. Callers name WHAT they do, never a raw model id. Workloads that share a tier are
 * listed separately on purpose, so one of them can move without touching the others.
 */
export const SOCIAL_AI_WORKLOADS = {
  /** POSTONA AI consultation (social-mobile-consult). */
  postonaConsult: "fast",
  /**
   * The shared brand generator (brand_post_generator.ts): POSTONA preview (social-mobile-brand-dry-run),
   * POSTONA live scheduled-user posts (vault_account_brand_post.ts), brand-post-dry-run and AI Lab
   * scheduled brand posts all generate through it.
   */
  brandPostGeneration: "fast",
  /** かぶモリ X: regular/interaction posts, report writing and future-post previews. */
  kabumoriXText: "fast",
  /** かぶモリ X: web-search material collection for the morning / close / US-premarket reports. */
  kabumoriXWebSearchCollection: "fast",
  /** かぶモリ X: the shared Kabumori voice evaluation. */
  kabumoriXVoiceEvaluation: "fast",
  /** かぶモリ X: the single morning/close report voice rewrite. */
  kabumoriXVoiceRewrite: "fast",
  /** かぶモリ X: morning greeting text. */
  kabumoriXMorningGreeting: "fast",
  /** かぶモリ X useful tips: first attempts. */
  usefulTipBase: "fast",
  /** かぶモリ X useful tips: the existing Sol escalation after Luna attempts fail. */
  usefulTipQualityEscalation: "quality",
  /** かぶモリ X US premarket: writing when the verified packet does not require Sol. */
  usPremarketBase: "fast",
  /** かぶモリ X US premarket: writing when the verified packet requires Sol (existing condition). */
  usPremarketQualityEscalation: "quality",
} as const satisfies Record<string, SocialTextTier>;

export type SocialAiWorkload = keyof typeof SOCIAL_AI_WORKLOADS;

/** The API model id a workload must use. */
export function socialTextModel(workload: SocialAiWorkload): SocialTextModelId {
  return SOCIAL_TEXT_MODELS[SOCIAL_AI_WORKLOADS[workload]].id;
}

function catalogEntry(model: string) {
  const entry = Object.values(SOCIAL_TEXT_MODELS).find((candidate) => candidate.id === model);
  if (!entry) throw new Error("SOCIAL_TEXT_MODEL_UNKNOWN");
  return entry;
}

/** True only for the quality (Sol) tier -- what "escalated to Sol" means in diagnostics. */
export function isSocialQualityTextModel(model: string): boolean {
  return model === SOCIAL_TEXT_MODELS.quality.id;
}

/** Unrounded token cost in USD for a catalog model, from its own centralized rates (for summing parts). */
export function socialTextModelTokenCostUsd(model: SocialTextModelId, inputTokens: number, outputTokens: number): number {
  const rates = catalogEntry(model);
  return (inputTokens * rates.inputUsdPer1M + outputTokens * rates.outputUsdPer1M) / 1_000_000;
}

/** Token cost in USD for a catalog model, rounded to 6 decimals. */
export function socialTextModelCostUsd(model: SocialTextModelId, inputTokens: number, outputTokens: number): number {
  return Number(socialTextModelTokenCostUsd(model, inputTokens, outputTokens).toFixed(6));
}
