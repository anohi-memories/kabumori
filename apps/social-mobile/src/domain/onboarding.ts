/**
 * First-run journey for general users: sign in → connect X → confirm the
 * connected account → minimum content settings → Home.
 *
 * Pure and server-derived: every step is computed from what the signed-in
 * user can read through RLS (own memberships, own brand's X account, own
 * content-settings row) plus one per-user local flag ("settings later").
 * No step is inferred from a client-supplied brand/account id, and more than
 * one owned workspace or X account fails closed instead of picking the first.
 */

export type OnboardingXAccount = {
  id: string;
  brandId: string;
  handle: string;
  /** social_accounts.connection_status */
  connectionStatus: string;
  lastConnectionErrorCode: string | null;
};

export type OnboardingSettingsState = 'saved' | 'not_saved' | 'unavailable' | 'blocked';

export type OnboardingInput =
  | { kind: 'mock' }
  | { kind: 'loading' }
  | { kind: 'error'; reason: string }
  | {
    kind: 'loaded';
    brandIds: readonly string[];
    xAccounts: readonly OnboardingXAccount[];
    settings: OnboardingSettingsState;
    settingsDeferred: boolean;
  };

export type OnboardingStep =
  | { step: 'preview' }
  | { step: 'loading' }
  | { step: 'error'; reason: string }
  | { step: 'ambiguous'; reason: string }
  | { step: 'connect_x'; resume: boolean }
  | { step: 'reconnect_x'; account: OnboardingXAccount; reason: string }
  | { step: 'settings'; account: OnboardingXAccount; backendAvailable: boolean }
  | { step: 'done'; account: OnboardingXAccount };

const RECONNECT_REASONS: Record<string, string> = {
  X_REFRESH_GRANT_REJECTED: 'Xとの接続期限が切れたか、連携が解除されました。',
  X_ACCESS_TOKEN_REJECTED_AFTER_REFRESH: 'Xが接続を受け付けなくなりました。',
  X_ACCOUNT_ALREADY_CONNECTED: 'このXアカウントは別のワークスペースに接続済みです。',
};

export function reconnectReason(code: string | null): string {
  return (code && RECONNECT_REASONS[code]) ?? 'Xとの接続を確認できませんでした。';
}

export function deriveOnboardingStep(input: OnboardingInput): OnboardingStep {
  if (input.kind === 'mock') return { step: 'preview' };
  if (input.kind === 'loading') return { step: 'loading' };
  if (input.kind === 'error') return { step: 'error', reason: input.reason };

  const brandIds = [...new Set(input.brandIds)];
  if (brandIds.length === 0) return { step: 'connect_x', resume: false };
  if (brandIds.length > 1) {
    return { step: 'ambiguous', reason: '複数のワークスペースに所属しています。この画面ではまだ扱えません。' };
  }
  const brandId = brandIds[0];
  const accounts = input.xAccounts.filter((account) => account.brandId === brandId);
  if (accounts.length === 0) return { step: 'connect_x', resume: false };
  if (accounts.length > 1) {
    return { step: 'ambiguous', reason: 'ワークスペースに複数のXアカウントがあります。この画面ではまだ扱えません。' };
  }
  const account = accounts[0];
  if (account.connectionStatus === 'failed') {
    return { step: 'reconnect_x', account, reason: reconnectReason(account.lastConnectionErrorCode) };
  }
  if (account.connectionStatus !== 'identity_verified') return { step: 'connect_x', resume: true };

  if (input.settings === 'saved' || input.settingsDeferred) return { step: 'done', account };
  return { step: 'settings', account, backendAvailable: input.settings === 'not_saved' };
}

/** Local "settings later" flag, scoped to one signed-in user id. */
export function onboardingStorageKey(userId: string): string {
  if (!/^[0-9a-f-]{36}$/u.test(userId)) throw new Error('ONBOARDING_USER_ID_INVALID');
  return `social-mobile:onboarding:v1:${userId}`;
}
