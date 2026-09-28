import type { SocialMobileContentSettings } from './content-settings';
import type { PostStatus, SocialAccount } from './types';

/**
 * What the post-detail screen may offer for edit/regenerate/approve/retry.
 * Every one of these currently has no client-callable backend action --
 * see docs referenced in posts/[id].tsx and the Phase 2 report -- so each
 * function below returns `available: false` today. They exist as functions
 * (not booleans) so the screen has one truthful reason to show per action,
 * and so a later phase can flip exactly one of these once its contract is
 * real, without touching the screen's rendering logic.
 */
export type ActionAvailability = { available: false; reason: string } | { available: true };

export function editAvailability(): ActionAvailability {
  return { available: false, reason: 'この投稿の本文を保存する仕組みはまだありません。' };
}

export function regenerateAvailability(): ActionAvailability {
  return {
    available: false,
    reason: 'この投稿だけを再生成する仕組みはまだありません。ワークスペース全体のプレビュー生成はHome画面から利用できます。',
  };
}

export function approveAvailability(): ActionAvailability {
  return { available: false, reason: 'この画面から承認・投稿予定への追加はまだできません。' };
}

export function retryAvailability(status: PostStatus): ActionAvailability {
  if (status !== 'failed') return { available: false, reason: '失敗した投稿だけが再試行の対象です。' };
  return { available: false, reason: '再試行の仕組みはまだこのアプリから利用できません。' };
}

/**
 * Only `failed` gets a reason slot at all, and even then it is always
 * "unavailable" today -- the execution log this would come from has no
 * client-readable contract yet (see Phase 2 report). Returning null for any
 * other status keeps a non-failed post from ever showing failure wording.
 */
export function failureReasonText(status: PostStatus): string | null {
  if (status !== 'failed') return null;
  return '失敗理由はまだこのアプリから確認できません。';
}

/** True when any connected X account needs the user to reconnect. */
export function hasXReconnectNeeded(accounts: SocialAccount[]): boolean {
  return accounts.some((account) => account.platform === 'x' && account.connectionStatus === 'needs_attention');
}

export type PostingModeSummary = {
  // null = no account selected / unknown, never a guessed on/off.
  autoPostEnabled: boolean | null;
  // null = content settings not loaded/available (e.g. mock/blocked/unavailable
  // before the read resolves), distinct from a real 'manual_review' value.
  approvalMode: SocialMobileContentSettings['approvalMode'] | null;
};

/**
 * Two separate axes, deliberately not collapsed into one: whether the
 * dispatcher is allowed to post automatically at all (`autoPostEnabled`,
 * per-account) and whether AI-generated drafts require a human's manual
 * review before that happens (`approvalMode`, per-workspace content
 * settings). A paused account with `auto_post_preference` still means
 * nothing posts; an active account with `manual_review` still requires a
 * human step before an otherwise-eligible post is sent.
 */
export function summarizePostingMode(
  account: SocialAccount | null,
  settings: SocialMobileContentSettings | null,
): PostingModeSummary {
  return {
    autoPostEnabled: account ? account.postingState === 'active' : null,
    approvalMode: settings?.approvalMode ?? null,
  };
}
