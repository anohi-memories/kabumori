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
  return guidance;
}
