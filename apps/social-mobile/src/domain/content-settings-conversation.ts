import { validateSocialMobileContentSettings, type PersonaProfile, type SocialMobileContentSettings } from './content-settings.ts';

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

/**
 * The only settings a conversation may propose. Posting controls (approval mode, generation window,
 * locale) are not here on purpose: a chat can describe them but never change them.
 */
export type ConversationalSettingsDelta = Partial<Pick<
  SocialMobileContentSettings,
  'preferredTone' | 'themes' | 'objective' | 'frequencyTargetPerWeek' | 'optionalNgWords' | 'notes'
>>;

/** chat = just an answer, question = the assistant needs more, proposal = something to confirm. */
export type ConversationalKind = 'chat' | 'question' | 'proposal';

export type ConversationalAssistantResult = {
  kind: ConversationalKind;
  assistantReply: string;
  proposedSettingsDelta: ConversationalSettingsDelta;
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

const CONTROL_KEY = /publish|account|oauth|token|secret|schedule|cron/iu;
const SETTINGS_DELTA_KEYS = new Set(['preferredTone', 'themes', 'objective', 'frequencyTargetPerWeek', 'optionalNgWords', 'notes']);
const PERSONA_DELTA_KEYS = new Set(['toneSignals', 'sentenceLength', 'punctuationEmoji', 'recurringVocabulary', 'topicSignals', 'hashtagHabits', 'ctaStyle', 'openingClosingPatterns']);

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Allowlisted, type-checked settings delta; null when anything outside the contract is present. */
function safeSettingsDelta(value: Record<string, unknown>): ConversationalSettingsDelta | null {
  if (Object.keys(value).some((key) => !SETTINGS_DELTA_KEYS.has(key))) return null;
  const delta: ConversationalSettingsDelta = {};
  if (value.preferredTone !== undefined) {
    if (typeof value.preferredTone !== 'string' || !value.preferredTone.trim()) return null;
    delta.preferredTone = value.preferredTone.trim().slice(0, 120);
  }
  if (value.themes !== undefined) {
    if (!stringList(value.themes)) return null;
    delta.themes = boundedStrings(value.themes, 8, 100);
  }
  if (value.objective !== undefined) {
    if (typeof value.objective !== 'string' || !value.objective.trim()) return null;
    delta.objective = value.objective.trim().slice(0, 160);
  }
  if (value.frequencyTargetPerWeek !== undefined) {
    const n = value.frequencyTargetPerWeek;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 14) return null;
    delta.frequencyTargetPerWeek = n;
  }
  if (value.optionalNgWords !== undefined) {
    if (!stringList(value.optionalNgWords)) return null;
    delta.optionalNgWords = boundedStrings(value.optionalNgWords, 20, 60);
  }
  if (value.notes !== undefined) {
    if (typeof value.notes !== 'string') return null;
    delta.notes = value.notes.trim().slice(0, 1000);
  }
  return delta;
}

/**
 * Treats an LLM response as untrusted data. This validator is also used by the
 * deterministic local candidate, so a model cannot smuggle publish, account,
 * OAuth, token, or scheduler controls into a proposal: control-like keys are
 * refused and the settings/persona deltas are allowlists.
 */
export function validateConversationalAssistantResult(value: unknown): ConversationalAssistantResult | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'publishPermissionChanged' && CONTROL_KEY.test(key))) return null;
  if (value.requiresConfirmation !== true || value.publishPermissionChanged !== false) return null;
  if (typeof value.assistantReply !== 'string' || value.assistantReply.trim().length === 0) return null;
  if (!isRecord(value.proposedSettingsDelta) || !isRecord(value.proposedPersonaDelta)) return null;
  if (!Array.isArray(value.followUpQuestions) || !Array.isArray(value.uncertainty)) return null;
  if (value.kind !== undefined && value.kind !== 'chat' && value.kind !== 'question' && value.kind !== 'proposal') return null;
  const provenance = value.provenance === 'conversation' || value.provenance === 'past_post_analysis' ? value.provenance : null;
  const confidence = value.confidence === 'low' || value.confidence === 'medium' || value.confidence === 'high' ? value.confidence : null;
  const history = value.historyLearningIntent;
  if (!provenance || !confidence || !isRecord(history) || typeof history.explicitConsent !== 'boolean') return null;
  const safeSettings = safeSettingsDelta(value.proposedSettingsDelta);
  if (!safeSettings) return null;
  const persona = value.proposedPersonaDelta as Record<string, unknown>;
  if (Object.keys(persona).some((key) => !PERSONA_DELTA_KEYS.has(key))) return null;
  const safePersona: PersonaDelta = {
    ...(Array.isArray(persona.toneSignals) ? { toneSignals: boundedStrings(persona.toneSignals, 20, 80) } : {}),
    ...(persona.sentenceLength === 'short' || persona.sentenceLength === 'mixed' || persona.sentenceLength === 'long' ? { sentenceLength: persona.sentenceLength } : {}),
    ...(typeof persona.punctuationEmoji === 'string' && persona.punctuationEmoji.trim() ? { punctuationEmoji: persona.punctuationEmoji.trim().slice(0, 200) } : {}),
    ...(Array.isArray(persona.recurringVocabulary) ? { recurringVocabulary: boundedStrings(persona.recurringVocabulary, 30, 50) } : {}),
    ...(Array.isArray(persona.topicSignals) ? { topicSignals: boundedStrings(persona.topicSignals, 20, 80) } : {}),
    ...(typeof persona.hashtagHabits === 'string' && persona.hashtagHabits.trim() ? { hashtagHabits: persona.hashtagHabits.trim().slice(0, 200) } : {}),
    ...(typeof persona.ctaStyle === 'string' && persona.ctaStyle.trim() ? { ctaStyle: persona.ctaStyle.trim().slice(0, 200) } : {}),
    ...(Array.isArray(persona.openingClosingPatterns) ? { openingClosingPatterns: boundedStrings(persona.openingClosingPatterns, 20, 100) } : {}),
  };
  const followUpQuestions = boundedStrings(value.followUpQuestions, 5, 160);
  const hasChange = Object.keys(safeSettings).length > 0 || Object.keys(safePersona).length > 0;
  // A chat/question answer never carries a proposal, whatever else the payload contains.
  const declared = value.kind as ConversationalKind | undefined;
  const carries = hasChange && declared !== 'chat' && declared !== 'question';
  const kind: ConversationalKind = carries ? 'proposal' : declared === 'question' || (declared !== 'chat' && followUpQuestions.length) ? 'question' : 'chat';
  return {
    kind,
    assistantReply: value.assistantReply.trim().slice(0, 1200),
    proposedSettingsDelta: carries ? safeSettings : {},
    proposedPersonaDelta: carries ? safePersona : {},
    followUpQuestions,
    provenance,
    confidence,
    uncertainty: boundedStrings(value.uncertainty, 5, 160),
    requiresConfirmation: true,
    historyLearningIntent: { explicitConsent: history.explicitConsent, requestedRange: history.requestedRange === 'custom' ? 'custom' : 'recent', derivedProfile: null },
    publishPermissionChanged: false,
  };
}

/**
 * Deterministic local stand-in used only in the sample-data preview (no backend) and in tests. The
 * real conversation goes through the authenticated `social-mobile-consult` endpoint. It has no network
 * or persistence side effects.
 */
export function createConversationalAssistantProposal(input: ConversationalAssistantInput): ConversationalAssistantResult {
  const settingsProposal = proposeContentSettingsFromConversation(input.userUtterance, input.currentSettings);
  const historyLearningIntent = parsePastPostLearningRequest(input.userUtterance);
  const proposedPersonaDelta: PersonaDelta = /絵文字|記号/iu.test(input.userUtterance)
    ? { punctuationEmoji: '会話で指定された記号・絵文字の傾向を確認する' }
    : {};
  const changes = Object.keys(settingsProposal.changes).length ? '希望する設定案をまとめました。' : '投稿の雰囲気をもう少し教えてください。';
  const hasChange = Object.keys(settingsProposal.changes).length > 0 || Object.keys(proposedPersonaDelta).length > 0;
  return {
    kind: hasChange ? 'proposal' : 'question',
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

/**
 * Applies only an explicitly confirmed proposal, as a delta onto the given
 * state. It never changes publishing permission, and a settings-only
 * confirmation leaves an existing persona (and its provenance) untouched.
 */
export function applyConfirmedConversationProposal(
  currentSettings: SocialMobileContentSettings,
  currentPersona: PersonaProfile | null,
  result: ConversationalAssistantResult,
): { settings: SocialMobileContentSettings; persona: PersonaProfile | null; personaChanged: boolean } {
  const settingsCandidate = { ...currentSettings, ...result.proposedSettingsDelta };
  const settingsResult = validateSocialMobileContentSettings(settingsCandidate);
  const settings = settingsResult.ok ? settingsResult.value : currentSettings;
  const personaChanged = Object.keys(result.proposedPersonaDelta).length > 0;
  const persona = personaChanged
    ? ({ ...(currentPersona ?? {}), ...result.proposedPersonaDelta, source: result.provenance, confirmed: true } as PersonaProfile)
    : currentPersona;
  return { settings, persona, personaChanged };
}
