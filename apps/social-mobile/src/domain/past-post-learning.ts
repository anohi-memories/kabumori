import type { PersonaProfile } from './content-settings';

export const MAX_HISTORY_POSTS = 50;
export const MAX_HISTORY_PAGES = 2;

export type OwnedHistoryPost = {
  id: string;
  text: string;
  createdAt: string;
  isReply?: boolean;
  isRetweet?: boolean;
  hashtags?: string[];
};

export type HistoryAccount = {
  id: string;
  platform: 'x';
  connectionStatus: string;
  platformUserId: string | null;
};

export type HistoryFetchRequest = {
  authenticatedUserId: string;
  workspaceOwnerUserId: string;
  requestedWorkspaceId: string;
  ownedWorkspaceId: string;
  verifiedAccounts: HistoryAccount[];
  explicitConsent: boolean;
};

export type HistoryPage = { posts: OwnedHistoryPost[]; nextCursor?: string | null };
export type HistoryPageFetcher = (cursor?: string) => Promise<HistoryPage>;

export class HistoryLearningGuardError extends Error {
  readonly code: 'HISTORY_CONSENT_REQUIRED' | 'HISTORY_WORKSPACE_FORBIDDEN' | 'HISTORY_ACCOUNT_NOT_CONFIGURED';
  constructor(code: 'HISTORY_CONSENT_REQUIRED' | 'HISTORY_WORKSPACE_FORBIDDEN' | 'HISTORY_ACCOUNT_NOT_CONFIGURED') {
    super(code);
    this.code = code;
    this.name = 'HistoryLearningGuardError';
  }
}

function assertHistoryFetchAllowed(request: HistoryFetchRequest): HistoryAccount {
  if (!request.explicitConsent) throw new HistoryLearningGuardError('HISTORY_CONSENT_REQUIRED');
  if (!request.authenticatedUserId || request.authenticatedUserId !== request.workspaceOwnerUserId || request.requestedWorkspaceId !== request.ownedWorkspaceId) {
    throw new HistoryLearningGuardError('HISTORY_WORKSPACE_FORBIDDEN');
  }
  const accounts = request.verifiedAccounts.filter((account) => account.platform === 'x' && account.connectionStatus === 'identity_verified' && account.platformUserId);
  if (accounts.length !== 1) throw new HistoryLearningGuardError('HISTORY_ACCOUNT_NOT_CONFIGURED');
  return accounts[0];
}

/**
 * Testable history boundary. The real X fetcher belongs outside the mobile
 * client; this candidate accepts an injected page source and never receives a
 * token. Only after all owner/account/consent guards pass is it called.
 */
export async function learnPersonaFromOwnedPostHistory(
  request: HistoryFetchRequest,
  fetchPage: HistoryPageFetcher,
  now = new Date().toISOString(),
): Promise<{ persona: PersonaProfile; analyzedPostCount: number; accountId: string; platformUserId: string }> {
  const account = assertHistoryFetchAllowed(request);
  const posts: OwnedHistoryPost[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES && posts.length < MAX_HISTORY_POSTS; page += 1) {
    const result = await fetchPage(cursor);
    for (const post of result.posts) {
      if (post.isReply || post.isRetweet || !post.id || !post.text.trim()) continue;
      posts.push({ ...post, text: post.text.slice(0, 4000) });
      if (posts.length >= MAX_HISTORY_POSTS) break;
    }
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  const persona = derivePersonaFromPosts(posts, now);
  return { persona, analyzedPostCount: posts.length, accountId: account.id, platformUserId: account.platformUserId! };
}

/** Derives bounded signals only; raw post text is not returned or persisted. */
export function derivePersonaFromPosts(posts: readonly OwnedHistoryPost[], analyzedAt = new Date().toISOString()): PersonaProfile {
  const texts = posts.map((post) => post.text.trim()).filter(Boolean).slice(0, MAX_HISTORY_POSTS);
  const averageLength = texts.length ? texts.reduce((sum, text) => sum + text.length, 0) / texts.length : 0;
  const punctuationEmoji = [/[！!]/u.test(texts.join(' ') ?? '') ? '感嘆符' : '', /[？?]/u.test(texts.join(' ') ?? '') ? '疑問符' : '', /[☀️🌱😊✨]/u.test(texts.join(' ') ?? '') ? '絵文字' : ''].filter(Boolean).join('・') || '標準的な句読点';
  const vocabulary = [...new Set(texts.join(' ').match(/[ぁ-んァ-ヶ一-龠A-Za-z]{3,}/gu) ?? [])].slice(0, 20);
  const hashtags = [...new Set(texts.flatMap((text) => text.match(/#[\p{L}\p{N}_-]+/gu) ?? []))].slice(0, 20);
  const cta = texts.some((text) => /ぜひ|参考|チェック|教えて|どう思/iu.test(text)) ? '読者への問いかけ・行動提案あり' : '強いCTAは目立たない';
  return {
    source: 'past_post_analysis',
    confirmed: false,
    sentenceLength: averageLength < 70 ? 'short' : averageLength > 180 ? 'long' : 'mixed',
    punctuationEmoji,
    recurringVocabulary: vocabulary,
    topicSignals: [],
    hashtagHabits: hashtags.length ? hashtags.join(' ') : 'ハッシュタグ少なめ',
    ctaStyle: cta,
    openingClosingPatterns: texts.slice(0, 3).map((text) => text.slice(0, 24)),
    analyzedPostCount: texts.length,
    analyzedAt,
  };
}

export function personaCanBeUsedForPreview(persona: PersonaProfile | null): boolean {
  return Boolean(persona?.confirmed);
}
