import { KABUMORI_VOICE } from "../kabumori_voice.ts";

export type BrandCodeProfile = {
  key: string;
  /** Shared, code-owned instructions. They intentionally remain the source of truth for Kabumori. */
  voiceInstructions: readonly string[];
  reportFixedHashtags: readonly string[];
  dryRunPostTypes: readonly string[];
  dryRunPromptPreamble: string;
};

export const KABUMORI_CODE_PROFILE: BrandCodeProfile = {
  key: "kabumori_v1",
  voiceInstructions: KABUMORI_VOICE,
  reportFixedHashtags: ["#日本株", "#日経平均", "#株式投資", "#かぶモリ"],
  dryRunPostTypes: ["tip", "interaction", "useful_tip", "morning", "market_close"],
  dryRunPromptPreamble: "かぶモリ既存の生成ルールを使う。",
};

// Phase 3A intentionally defines only the minimum identity needed to exercise
// an isolated dry-run. It is not a finished persona or publishing strategy.
// In particular, it never imports Kabumori's voice, tags, or prompt fragments.
export const AI_SALARYMAN_LAB_CODE_PROFILE: BrandCodeProfile = {
  key: "ai_salaryman_lab_v1",
  voiceInstructions: [
    "会社員AIラボの dry-run 用プロファイルです。未確認の人物像、実績、勤務先、投資経験は作らないでください。",
  ],
  reportFixedHashtags: [],
  dryRunPostTypes: ["profile_preview"],
  dryRunPromptPreamble: "会社員AIラボの独立した dry-run。事実を追加せず、公開用本文や投稿戦略を完成させない。",
};

const CODE_PROFILES: ReadonlyMap<string, BrandCodeProfile> = new Map([
  [KABUMORI_CODE_PROFILE.key, KABUMORI_CODE_PROFILE],
  [AI_SALARYMAN_LAB_CODE_PROFILE.key, AI_SALARYMAN_LAB_CODE_PROFILE],
]);

/**
 * A new brand must bring an explicitly reviewed code profile in a later phase.
 * Returning null here is deliberate: callers fail closed rather than inheriting
 * Kabumori's voice, hashtags, or prompts by accident.
 */
export function resolveBrandCodeProfile(key: string): BrandCodeProfile | null {
  return CODE_PROFILES.get(key) ?? null;
}

export function appendProfileReportFixedHashtags(
  profile: BrandCodeProfile,
  text: string,
): string {
  return `${text.trim()}\n\n${profile.reportFixedHashtags.join(" ")}`;
}
