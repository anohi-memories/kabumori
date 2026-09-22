export type SocialMobileContentSettings = {
  locale: 'ja-JP';
  preferredTone: string;
  themes: string[];
  objective: string;
  frequencyTargetPerWeek: number;
  approvalMode: 'manual_review' | 'auto_post_preference';
  generationWindow: {
    timezone: 'Asia/Tokyo';
    startLocal: string;
    endLocal: string;
    defaultGenerationLocal: string;
    generationDayOffset: -1 | 0;
  };
  optionalNgWords: string[];
  notes: string;
};

export const SOCIAL_MOBILE_CONTENT_DEFAULTS: SocialMobileContentSettings = {
  locale: 'ja-JP',
  preferredTone: '自然で親しみやすく、押しつけない',
  themes: ['日々の生活や仕事に役立つ小さな工夫'],
  objective: '読者にひとつの実用的な気づきを届ける',
  frequencyTargetPerWeek: 3,
  approvalMode: 'manual_review',
  generationWindow: {
    timezone: 'Asia/Tokyo',
    startLocal: '09:00',
    endLocal: '24:00',
    defaultGenerationLocal: '17:00',
    generationDayOffset: -1,
  },
  optionalNgWords: [],
  notes: '',
};

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export function validateSocialMobileContentSettings(
  input: unknown,
): { ok: true; value: SocialMobileContentSettings } | { ok: false; reason: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, reason: '設定の形式を確認してください。' };
  const value = input as Record<string, unknown>;
  const window = value.generationWindow;
  if (typeof window !== 'object' || window === null || Array.isArray(window)) return { ok: false, reason: '生成時間帯を確認してください。' };
  const generationWindow = window as Record<string, unknown>;
  if (value.locale !== 'ja-JP' || typeof value.preferredTone !== 'string' || value.preferredTone.trim().length === 0 || value.preferredTone.length > 120) return { ok: false, reason: 'トーンを確認してください。' };
  if (!Array.isArray(value.themes) || value.themes.length > 8 || value.themes.some((item) => typeof item !== 'string' || item.trim().length === 0 || item.length > 100)) return { ok: false, reason: 'テーマを確認してください。' };
  if (typeof value.objective !== 'string' || value.objective.trim().length === 0 || value.objective.length > 160) return { ok: false, reason: '目的を確認してください。' };
  if (typeof value.frequencyTargetPerWeek !== 'number' || !Number.isInteger(value.frequencyTargetPerWeek) || value.frequencyTargetPerWeek < 0 || value.frequencyTargetPerWeek > 14) return { ok: false, reason: '週あたりの回数は0〜14で指定してください。' };
  if (value.approvalMode !== 'manual_review' && value.approvalMode !== 'auto_post_preference') return { ok: false, reason: '確認モードを確認してください。' };
  if (generationWindow.timezone !== 'Asia/Tokyo' || typeof generationWindow.startLocal !== 'string' || !timePattern.test(generationWindow.startLocal) || typeof generationWindow.endLocal !== 'string' || !timePattern.test(generationWindow.endLocal) || typeof generationWindow.defaultGenerationLocal !== 'string' || !timePattern.test(generationWindow.defaultGenerationLocal) || (generationWindow.generationDayOffset !== -1 && generationWindow.generationDayOffset !== 0)) return { ok: false, reason: '生成時間帯を確認してください。' };
  if (!Array.isArray(value.optionalNgWords) || value.optionalNgWords.length > 20 || value.optionalNgWords.some((item) => typeof item !== 'string' || item.length > 60)) return { ok: false, reason: '避けたい語句を確認してください。' };
  if (typeof value.notes !== 'string' || value.notes.length > 1000) return { ok: false, reason: 'メモは1000文字以内で入力してください。' };
  if (Object.keys(value).some((key) => /publish|token|secret|oauth/iu.test(key))) return { ok: false, reason: '投稿権限はこの設定から変更できません。' };
  return {
    ok: true,
    value: {
      locale: 'ja-JP',
      preferredTone: value.preferredTone.trim(),
      themes: value.themes.map((item) => String(item).trim()).filter(Boolean),
      objective: value.objective.trim(),
      frequencyTargetPerWeek: value.frequencyTargetPerWeek,
      approvalMode: value.approvalMode,
      generationWindow: {
        timezone: 'Asia/Tokyo',
        startLocal: generationWindow.startLocal,
        endLocal: generationWindow.endLocal,
        defaultGenerationLocal: generationWindow.defaultGenerationLocal,
        generationDayOffset: generationWindow.generationDayOffset,
      },
      optionalNgWords: value.optionalNgWords.map((item) => String(item).trim()).filter(Boolean),
      notes: value.notes.trim(),
    },
  };
}

export type PersonaProfile = {
  source: 'conversation' | 'past_post_analysis' | 'manual';
  confirmed: boolean;
  toneSignals?: string[];
  sentenceLength?: 'short' | 'mixed' | 'long';
  punctuationEmoji?: string;
  recurringVocabulary?: string[];
  topicSignals?: string[];
  hashtagHabits?: string;
  ctaStyle?: string;
  openingClosingPatterns?: string[];
  analyzedPostCount?: number;
  analyzedAt?: string;
};
