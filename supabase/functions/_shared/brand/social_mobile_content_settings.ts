/** Code-owned first-run defaults for preview planning; this contract does not enable live publishing. */
export type SocialMobileContentSettings = {
  preferredTone: string;
  locale: "ja-JP";
  themes: readonly string[];
  objective: string;
  frequencyTargetPerWeek: number;
  approvalMode: "manual_review" | "auto_post_preference";
  generationWindow: {
    timezone: "Asia/Tokyo";
    startLocal: "09:00";
    endLocal: "24:00";
    defaultGenerationLocal: "17:00";
    generationDayOffset: -1;
  };
  optionalNgWords: readonly string[];
  notes: string;
  livePublishingEnabled: false;
  personaProfile?: SocialMobilePersonaProfile;
};

export type SocialMobilePersonaProfile = {
  toneSignals?: readonly string[];
  sentenceLength?: "short" | "mixed" | "long";
  punctuationEmoji?: string;
  recurringVocabulary?: readonly string[];
  topicSignals?: readonly string[];
  hashtagHabits?: string;
  ctaStyle?: string;
  openingClosingPatterns?: readonly string[];
  source: "conversation" | "past_post_analysis" | "manual";
  confirmed: boolean;
  analyzedPostCount?: number;
  analyzedAt?: string;
};

export const SOCIAL_MOBILE_USER_DEFAULTS: SocialMobileContentSettings = {
  preferredTone: "自然で親しみやすく、押しつけない",
  locale: "ja-JP",
  themes: ["日々の生活や仕事に役立つ小さな工夫"],
  objective: "読者にひとつの実用的な気づきを届ける",
  frequencyTargetPerWeek: 3,
  approvalMode: "manual_review",
  generationWindow: {
    timezone: "Asia/Tokyo",
    startLocal: "09:00",
    endLocal: "24:00",
    defaultGenerationLocal: "17:00",
    generationDayOffset: -1,
  },
  optionalNgWords: [],
  notes: "",
  livePublishingEnabled: false,
};

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const END_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d|24:00$/u;

export function isSocialMobileContentSettings(value: unknown): value is SocialMobileContentSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const window = input.generationWindow;
  if (typeof window !== "object" || window === null || Array.isArray(window)) return false;
  const generationWindow = window as Record<string, unknown>;
  if (
    input.livePublishingEnabled === true ||
    input.locale !== "ja-JP" ||
    typeof input.preferredTone !== "string" || input.preferredTone.length < 1 || input.preferredTone.length > 120 ||
    !Array.isArray(input.themes) || input.themes.length > 8 || input.themes.some((item) => typeof item !== "string" || item.length > 100) ||
    typeof input.objective !== "string" || input.objective.length < 1 || input.objective.length > 160 ||
    typeof input.frequencyTargetPerWeek !== "number" || !Number.isInteger(input.frequencyTargetPerWeek) || input.frequencyTargetPerWeek < 0 || input.frequencyTargetPerWeek > 14 ||
    input.approvalMode !== "manual_review" && input.approvalMode !== "auto_post_preference" ||
    generationWindow.timezone !== "Asia/Tokyo" ||
    typeof generationWindow.startLocal !== "string" || !TIME_RE.test(generationWindow.startLocal) ||
    typeof generationWindow.endLocal !== "string" || !END_TIME_RE.test(generationWindow.endLocal) ||
    typeof generationWindow.defaultGenerationLocal !== "string" || !TIME_RE.test(generationWindow.defaultGenerationLocal) ||
    generationWindow.generationDayOffset !== -1 && generationWindow.generationDayOffset !== 0 ||
    !Array.isArray(input.optionalNgWords) || input.optionalNgWords.length > 20 || input.optionalNgWords.some((item) => typeof item !== "string" || item.length > 60) ||
    typeof input.notes !== "string" || input.notes.length > 1000
  ) return false;
  return true;
}

/**
 * Converts an untrusted row/request into the safe preview contract. This is
 * deliberately conservative: invalid persisted values fall back to defaults,
 * and no setting can carry the publish permission.
 */
export function normalizeSocialMobileContentSettings(value: unknown): SocialMobileContentSettings {
  if (!isSocialMobileContentSettings(value)) return SOCIAL_MOBILE_USER_DEFAULTS;
  return {
    ...value,
    livePublishingEnabled: false,
    themes: bounded(value.themes, 8, 100),
    optionalNgWords: bounded(value.optionalNgWords, 20, 60),
    preferredTone: value.preferredTone.trim().slice(0, 120),
    objective: value.objective.trim().slice(0, 160),
    notes: value.notes.trim().slice(0, 1000),
  };
}

export function isSocialMobilePersonaProfile(value: unknown): value is SocialMobilePersonaProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    ["conversation", "past_post_analysis", "manual"].includes(String(input.source)) &&
    typeof input.confirmed === "boolean" &&
    !Object.keys(input).some((key) => /token|secret|refresh|access|posts?/iu.test(key))
  );
}

function bounded(
  values: readonly string[],
  maxCount: number,
  maxLength: number,
): string[] {
  return values.slice(0, maxCount).map((value) =>
    value.trim().slice(0, maxLength)
  ).filter(Boolean);
}

/** Converts the bounded settings contract into generation guidance, never into a publish command. */
export function socialMobileGenerationGuidance(
  settings: SocialMobileContentSettings,
): string[] {
  const guidance = [
    `希望するトーン: ${settings.preferredTone.slice(0, 120)}`,
    `投稿の目的: ${settings.objective.slice(0, 160)}`,
    `言語・地域: ${settings.locale}`,
  ];
  const themes = bounded(settings.themes, 8, 100);
  const ngWords = bounded(settings.optionalNgWords, 20, 60);
  if (themes.length) guidance.push(`扱うテーマ候補: ${themes.join("、")}`);
  if (ngWords.length) guidance.push(`避ける語句: ${ngWords.join("、")}`);
  const notes = settings.notes.trim().slice(0, 300);
  if (notes) {
    guidance.push(`利用者メモ（事実として未確認の内容は採用しない）: ${notes}`);
  }
  const persona = settings.personaProfile;
  if (persona && persona.confirmed) {
    if (persona.sentenceLength) guidance.push(`確認済みの文体傾向: ${persona.sentenceLength}`);
    if (persona.punctuationEmoji) guidance.push(`確認済みの記号・絵文字傾向: ${persona.punctuationEmoji.slice(0, 120)}`);
    const vocabulary = bounded(persona.recurringVocabulary ?? [], 10, 50);
    if (vocabulary.length) guidance.push(`確認済みの語彙傾向: ${vocabulary.join("、")}`);
  }
  return guidance;
}
