import { KABUMORI_VOICE } from "../kabumori_voice.ts";

export type BrandCodeProfile = {
  key: string;
  /** Shared, code-owned instructions. They intentionally remain the source of truth for Kabumori. */
  voiceInstructions: readonly string[];
  reportFixedHashtags: readonly string[];
};

export const KABUMORI_CODE_PROFILE: BrandCodeProfile = {
  key: "kabumori_v1",
  voiceInstructions: KABUMORI_VOICE,
  reportFixedHashtags: ["#日本株", "#日経平均", "#株式投資", "#かぶモリ"],
};

const CODE_PROFILES: ReadonlyMap<string, BrandCodeProfile> = new Map([
  [KABUMORI_CODE_PROFILE.key, KABUMORI_CODE_PROFILE],
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
