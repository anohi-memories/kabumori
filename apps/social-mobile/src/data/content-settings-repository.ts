import type { SupabaseClient } from '@supabase/supabase-js';
import {
  SOCIAL_MOBILE_CONTENT_DEFAULTS,
  type PersonaProfile,
  type SocialMobileContentSettings,
  validateSocialMobileContentSettings,
} from '@/domain/content-settings';

export type ContentSettingsResult =
  | { state: 'ready'; data: SocialMobileContentSettings; persona: PersonaProfile | null }
  | { state: 'blocked' | 'unavailable'; data: SocialMobileContentSettings; persona: PersonaProfile | null; reason: string };

type SettingsRow = {
  settings?: unknown;
  persona_profile?: unknown;
  persona_provenance?: unknown;
  persona_confirmed?: unknown;
  persona_last_analyzed_at?: unknown;
  persona_last_analyzed_count?: unknown;
};

function safePersona(value: unknown, metadata: Pick<SettingsRow, 'persona_provenance' | 'persona_confirmed' | 'persona_last_analyzed_at' | 'persona_last_analyzed_count'>): PersonaProfile | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!['conversation', 'past_post_analysis', 'manual'].includes(String(metadata.persona_provenance)) || typeof metadata.persona_confirmed !== 'boolean') return null;
  return {
    source: metadata.persona_provenance as PersonaProfile['source'],
    confirmed: metadata.persona_confirmed,
    ...(Array.isArray(input.toneSignals) ? { toneSignals: input.toneSignals.filter((item): item is string => typeof item === 'string').slice(0, 20) } : {}),
    ...(typeof input.sentenceLength === 'string' && ['short', 'mixed', 'long'].includes(input.sentenceLength) ? { sentenceLength: input.sentenceLength as PersonaProfile['sentenceLength'] } : {}),
    ...(typeof input.punctuationEmoji === 'string' ? { punctuationEmoji: input.punctuationEmoji.slice(0, 200) } : {}),
    ...(Array.isArray(input.recurringVocabulary) ? { recurringVocabulary: input.recurringVocabulary.filter((item): item is string => typeof item === 'string').slice(0, 30) } : {}),
    ...(Array.isArray(input.topicSignals) ? { topicSignals: input.topicSignals.filter((item): item is string => typeof item === 'string').slice(0, 20) } : {}),
    ...(typeof input.hashtagHabits === 'string' ? { hashtagHabits: input.hashtagHabits.slice(0, 200) } : {}),
    ...(typeof input.ctaStyle === 'string' ? { ctaStyle: input.ctaStyle.slice(0, 200) } : {}),
    ...(Array.isArray(input.openingClosingPatterns) ? { openingClosingPatterns: input.openingClosingPatterns.filter((item): item is string => typeof item === 'string').slice(0, 20) } : {}),
    ...(typeof metadata.persona_last_analyzed_count === 'number' && Number.isInteger(metadata.persona_last_analyzed_count) && metadata.persona_last_analyzed_count >= 0 && metadata.persona_last_analyzed_count <= 1000 ? { analyzedPostCount: metadata.persona_last_analyzed_count } : {}),
    ...(typeof metadata.persona_last_analyzed_at === 'string' ? { analyzedAt: metadata.persona_last_analyzed_at } : {}),
  };
}

export class SupabaseContentSettingsRepository {
  constructor(private readonly client: SupabaseClient) {}

  async read(brandId: string): Promise<ContentSettingsResult> {
    const { data, error } = await this.client
      .from('social_mobile_content_settings')
      .select('settings,persona_profile,persona_provenance,persona_confirmed,persona_last_analyzed_at,persona_last_analyzed_count')
      .eq('brand_id', brandId)
      .maybeSingle<SettingsRow>();
    if (error) {
      if (error.code === '42501') return { state: 'blocked', data: SOCIAL_MOBILE_CONTENT_DEFAULTS, persona: null, reason: '設定を読む権限が確認できません。' };
      if (error.code === '42P01' || error.code === '42703') return { state: 'unavailable', data: SOCIAL_MOBILE_CONTENT_DEFAULTS, persona: null, reason: '設定保存機能はまだ利用できません。' };
      return { state: 'unavailable', data: SOCIAL_MOBILE_CONTENT_DEFAULTS, persona: null, reason: '設定を取得できません。' };
    }
    if (!data) return { state: 'ready', data: SOCIAL_MOBILE_CONTENT_DEFAULTS, persona: null };
    const parsed = validateSocialMobileContentSettings(data.settings);
    if (!parsed.ok) return { state: 'unavailable', data: SOCIAL_MOBILE_CONTENT_DEFAULTS, persona: null, reason: '保存された設定を確認できません。' };
    return { state: 'ready', data: parsed.value, persona: safePersona(data.persona_profile, data) };
  }

  async upsert(brandId: string, settings: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    const parsed = validateSocialMobileContentSettings(settings);
    if (!parsed.ok) return parsed;
    const { error } = await this.client.from('social_mobile_content_settings').upsert({
      brand_id: brandId,
      settings: parsed.value,
      // Persona is deliberately omitted: manual settings must not erase a
      // separately confirmed conversation/history-derived profile.
    }, { onConflict: 'brand_id' });
    if (!error) return { ok: true };
    if (error.code === '42501') return { ok: false, reason: 'このワークスペースへ保存する権限がありません。' };
    if (error.code === '23514') return { ok: false, reason: '入力内容を確認してください。' };
    return { ok: false, reason: '設定を保存できません。時間をおいて再度お試しください。' };
  }

  async saveConfirmedProposal(
    brandId: string,
    settings: unknown,
    persona: PersonaProfile,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const parsed = validateSocialMobileContentSettings(settings);
    if (!parsed.ok || !persona.confirmed) return { ok: false, reason: '保存前の確認が完了していません。' };
    const profile = { ...persona };
    delete (profile as Partial<PersonaProfile> & { source?: unknown }).source;
    delete (profile as Partial<PersonaProfile> & { confirmed?: unknown }).confirmed;
    const { error } = await this.client.from('social_mobile_content_settings').upsert({
      brand_id: brandId,
      settings: parsed.value,
      persona_profile: profile,
      persona_provenance: persona.source,
      persona_confirmed: true,
      persona_last_analyzed_at: persona.analyzedAt ?? null,
      persona_last_analyzed_count: persona.analyzedPostCount ?? null,
    }, { onConflict: 'brand_id' });
    if (!error) return { ok: true };
    if (error.code === '42501') return { ok: false, reason: 'このワークスペースへ保存する権限がありません。' };
    if (error.code === '23514') return { ok: false, reason: '保存内容を確認してください。' };
    return { ok: false, reason: '設定を保存できません。時間をおいて再度お試しください。' };
  }
}
