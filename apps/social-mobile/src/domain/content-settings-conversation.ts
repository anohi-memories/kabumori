import type { PersonaProfile, SocialMobileContentSettings } from '@/domain/content-settings';

export type ConversationalSettingsProposal = {
  changes: Partial<SocialMobileContentSettings>;
  questions: string[];
  provenance: 'conversation';
  requiresConfirmation: true;
  publishPermissionChanged: false;
};

export type PastPostLearningRequest = {
  explicitConsent: boolean;
  requestedRange: 'recent' | 'custom';
  derivedProfile: PersonaProfile | null;
};

/**
 * Small deterministic adapter for the future conversational assistant. The
 * actual LLM may propose values later, but the app keeps the proposal bounded,
 * reviewable, and separate from publishing permission.
 */
export function proposeContentSettingsFromConversation(
  message: string,
  current: SocialMobileContentSettings,
): ConversationalSettingsProposal {
  const text = message.trim();
  const changes: Partial<SocialMobileContentSettings> = {};
  const questions: string[] = [];
  if (/やわらか|親しみ|カジュアル/iu.test(text)) changes.preferredTone = '自然でやわらかく、親しみやすい';
  if (/専門的|詳しく|深掘り/iu.test(text)) changes.preferredTone = '専門性は保ちつつ、初めての人にも分かりやすく';
  const frequency = /週\s*([0-9]{1,2})\s*(?:回|本)/u.exec(text)?.[1];
  if (frequency) {
    const value = Math.max(0, Math.min(14, Number(frequency)));
    changes.frequencyTargetPerWeek = value;
  }
  if (/テーマ|話題|発信/iu.test(text) && !changes.themes) questions.push('扱いたいテーマをいくつか教えてください。');
  if (!text) questions.push('どんな雰囲気・テーマで投稿したいですか？');
  // A correction in a later turn simply replaces the previous proposal at the
  // caller boundary; this pure function never mutates `current`.
  void current;
  return { changes, questions, provenance: 'conversation', requiresConfirmation: true, publishPermissionChanged: false };
}

export function parsePastPostLearningRequest(message: string): PastPostLearningRequest {
  const explicitConsent = /過去の自分の投稿を(?:読んで|見て|分析して)|最近の投稿っぽく/iu.test(message);
  return { explicitConsent, requestedRange: 'recent', derivedProfile: null };
}
