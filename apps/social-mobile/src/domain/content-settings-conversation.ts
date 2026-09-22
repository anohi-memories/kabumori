import { validateSocialMobileContentSettings, type PersonaProfile, type SocialMobileContentSettings } from './content-settings';

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

export type PersonaDelta = Partial<Omit<PersonaProfile, 'source' | 'confirmed'>>;

export type ConversationalAssistantInput = {
  currentSettings: SocialMobileContentSettings;
  currentPersona: PersonaProfile | null;
  userUtterance: string;
};

export type ConversationalAssistantResult = {
  assistantReply: string;
  proposedSettingsDelta: Partial<SocialMobileContentSettings>;
  proposedPersonaDelta: PersonaDelta;
  followUpQuestions: string[];
  provenance: 'conversation' | 'past_post_analysis';
  confidence: 'low' | 'medium' | 'high';
  uncertainty: string[];
  requiresConfirmation: true;
  historyLearningIntent: PastPostLearningRequest;
  publishPermissionChanged: false;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedStrings(value: unknown, max: number, maxLength: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, maxLength)).filter(Boolean).slice(0, max)
    : [];
}

/**
 * Treats an eventual LLM response as untrusted data. This validator is also
 * used by the deterministic source candidate, so a future model cannot smuggle
 * publish, account, OAuth, token, or scheduler controls into a proposal.
 */
export function validateConversationalAssistantResult(value: unknown): ConversationalAssistantResult | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'publishPermissionChanged' && /publish|account|oauth|token|secret|schedule|cron/iu.test(key))) return null;
  if (value.requiresConfirmation !== true || value.publishPermissionChanged !== false) return null;
  if (typeof value.assistantReply !== 'string' || value.assistantReply.trim().length === 0) return null;
  if (!isRecord(value.proposedSettingsDelta) || !isRecord(value.proposedPersonaDelta)) return null;
  if (Object.keys(value.proposedSettingsDelta).some((key) => /publish|account|oauth|token|secret|schedule|cron/iu.test(key))) return null;
  if (!Array.isArray(value.followUpQuestions) || !Array.isArray(value.uncertainty)) return null;
  const provenance = value.provenance === 'conversation' || value.provenance === 'past_post_analysis' ? value.provenance : null;
  const confidence = value.confidence === 'low' || value.confidence === 'medium' || value.confidence === 'high' ? value.confidence : null;
  const history = value.historyLearningIntent;
  if (!provenance || !confidence || !isRecord(history) || typeof history.explicitConsent !== 'boolean') return null;
  const persona = value.proposedPersonaDelta as Record<string, unknown>;
  if ('source' in persona || 'confirmed' in persona || Object.keys(persona).some((key) => /publish|account|oauth|token|secret|posts?/iu.test(key))) return null;
  const safePersona: PersonaDelta = {
    ...(boundedStrings(persona.toneSignals, 20, 80).length ? { toneSignals: boundedStrings(persona.toneSignals, 20, 80) } : {}),
    ...(persona.sentenceLength === 'short' || persona.sentenceLength === 'mixed' || persona.sentenceLength === 'long' ? { sentenceLength: persona.sentenceLength } : {}),
    ...(typeof persona.punctuationEmoji === 'string' ? { punctuationEmoji: persona.punctuationEmoji.slice(0, 200) } : {}),
    ...(boundedStrings(persona.recurringVocabulary, 30, 50).length ? { recurringVocabulary: boundedStrings(persona.recurringVocabulary, 30, 50) } : {}),
    ...(boundedStrings(persona.topicSignals, 20, 80).length ? { topicSignals: boundedStrings(persona.topicSignals, 20, 80) } : {}),
    ...(typeof persona.hashtagHabits === 'string' ? { hashtagHabits: persona.hashtagHabits.slice(0, 200) } : {}),
    ...(typeof persona.ctaStyle === 'string' ? { ctaStyle: persona.ctaStyle.slice(0, 200) } : {}),
    ...(boundedStrings(persona.openingClosingPatterns, 20, 100).length ? { openingClosingPatterns: boundedStrings(persona.openingClosingPatterns, 20, 100) } : {}),
  };
  return {
    assistantReply: value.assistantReply.trim().slice(0, 500),
    proposedSettingsDelta: value.proposedSettingsDelta as Partial<SocialMobileContentSettings>,
    proposedPersonaDelta: safePersona,
    followUpQuestions: boundedStrings(value.followUpQuestions, 5, 160),
    provenance,
    confidence,
    uncertainty: boundedStrings(value.uncertainty, 5, 160),
    requiresConfirmation: true,
    historyLearningIntent: { explicitConsent: history.explicitConsent, requestedRange: history.requestedRange === 'custom' ? 'custom' : 'recent', derivedProfile: null },
    publishPermissionChanged: false,
  };
}

/** Source candidate for a future LLM boundary; it has no network or persistence side effects. */
export function createConversationalAssistantProposal(input: ConversationalAssistantInput): ConversationalAssistantResult {
  const settingsProposal = proposeContentSettingsFromConversation(input.userUtterance, input.currentSettings);
  const historyLearningIntent = parsePastPostLearningRequest(input.userUtterance);
  const proposedPersonaDelta: PersonaDelta = /絵文字|記号/iu.test(input.userUtterance)
    ? { punctuationEmoji: '会話で指定された記号・絵文字の傾向を確認する' }
    : {};
  const changes = Object.keys(settingsProposal.changes).length ? '希望する設定案をまとめました。' : '投稿の雰囲気をもう少し教えてください。';
  return {
    assistantReply: historyLearningIntent.explicitConsent
      ? `${changes}過去の投稿を読む前に、対象アカウントと取得範囲を確認します。`
      : `${changes}保存前に内容を確認してください。`,
    proposedSettingsDelta: settingsProposal.changes,
    proposedPersonaDelta,
    followUpQuestions: settingsProposal.questions,
    provenance: historyLearningIntent.explicitConsent ? 'past_post_analysis' : 'conversation',
    confidence: Object.keys(settingsProposal.changes).length ? 'medium' : 'low',
    uncertainty: settingsProposal.questions,
    requiresConfirmation: true,
    historyLearningIntent,
    publishPermissionChanged: false,
  };
}

/** Applies only an explicitly confirmed proposal. It never changes publishing permission. */
export function applyConfirmedConversationProposal(
  currentSettings: SocialMobileContentSettings,
  currentPersona: PersonaProfile | null,
  result: ConversationalAssistantResult,
): { settings: SocialMobileContentSettings; persona: PersonaProfile | null } {
  const settingsCandidate = { ...currentSettings, ...result.proposedSettingsDelta };
  const settingsResult = validateSocialMobileContentSettings(settingsCandidate);
  const settings = settingsResult.ok ? settingsResult.value : currentSettings;
  const persona = Object.keys(result.proposedPersonaDelta).length || currentPersona
    ? { ...(currentPersona ?? {}), ...result.proposedPersonaDelta, source: result.provenance, confirmed: true }
    : null;
  return { settings, persona: persona as PersonaProfile | null };
}
