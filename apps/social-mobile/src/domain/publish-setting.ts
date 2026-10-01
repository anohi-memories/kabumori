import type { SocialAccount } from './types.ts';

/** The one Edge Function that may change an account's automatic-publishing switch (server decides everything). */
export const PUBLISH_SETTING_FUNCTION = 'social-mobile-publish-setting';

export const PUBLISH_ENABLE_CONFIRMATION = 'ONにすると、条件を満たした投稿予定は自動でXへ投稿される可能性があります。';
export const PUBLISH_DISABLE_NOTE = 'OFFにすると、このアカウントへの自動投稿は行われなくなります。接続・下書き・投稿予定・履歴は削除されず、いつでもONに戻せます。';

export type PublishSettingRequest = {
  social_account_id: string;
  desired_enabled: boolean;
  expected_current_enabled: boolean;
};

export type PublishSettingView = {
  /** Whether the account is currently set to publish automatically (the real server-side value). */
  enabled: boolean;
  statusLabel: string;
  statusTone: 'success' | 'neutral';
  /** ON can be requested (the server still re-checks every condition). */
  canTurnOn: boolean;
  /** OFF is available whenever it is currently ON, regardless of connection state. */
  canTurnOff: boolean;
  /** Why the missing action is unavailable, if there is something to explain. */
  note: string | null;
};

/**
 * What the screen may offer. `preview` is the explicit local mock preview: nothing is real there, so no
 * change can be requested. Only a real, connected X account can be switched ON; switching OFF is never
 * blocked by connection state, so a degraded account that is ON can always be stopped.
 */
export function publishSettingView(account: Pick<SocialAccount, 'platform' | 'connectionStatus' | 'postingState'>, preview = false): PublishSettingView {
  const enabled = account.postingState === 'active';
  const statusLabel = enabled ? '自動投稿: ON' : '自動投稿: OFF';
  const statusTone = enabled ? 'success' : 'neutral';
  if (preview) {
    return { enabled, statusLabel, statusTone, canTurnOn: false, canTurnOff: false, note: 'プレビュー表示のため、設定は切り替えられません。' };
  }
  if (account.platform !== 'x') {
    return { enabled, statusLabel, statusTone, canTurnOn: false, canTurnOff: enabled, note: 'このプラットフォームの自動投稿はまだ利用できません。' };
  }
  const connected = account.connectionStatus === 'connected';
  if (enabled) {
    return {
      enabled, statusLabel, statusTone, canTurnOn: false, canTurnOff: true,
      note: connected ? null : 'Xとの接続に確認が必要です。安全のため、自動投稿をOFFにできます。',
    };
  }
  return {
    enabled, statusLabel, statusTone, canTurnOff: false,
    canTurnOn: connected,
    note: connected ? null : 'Xとの接続を確認できるまで、自動投稿はONにできません。先にXアカウントを接続してください。',
  };
}

export function buildPublishSettingRequest(account: Pick<SocialAccount, 'id' | 'postingState'>, desiredEnabled: boolean): PublishSettingRequest {
  return {
    social_account_id: account.id,
    desired_enabled: desiredEnabled,
    expected_current_enabled: account.postingState === 'active',
  };
}

export type PublishSettingFailure = {
  code: string;
  message: string;
  /** The shown state may be out of date; reload the shared data. */
  reload: boolean;
};

const KNOWN_FAILURES: Record<string, { message: string; reload: boolean }> = {
  AUTH_REQUIRED: { message: 'ログインの有効期限が切れました。もう一度ログインしてください。', reload: false },
  REQUEST_INVALID: { message: '設定を変更できませんでした。アプリを再読み込みしてください。', reload: true },
  ACCOUNT_NOT_FOUND: { message: 'このアカウントの設定を変更できません。アカウント一覧を確認してください。', reload: true },
  PUBLISH_CONTROL_FORBIDDEN: { message: '自動投稿の切り替えは、ワークスペースのオーナーまたは管理者のみ行えます。', reload: false },
  STALE_STATE: { message: '他の操作で設定がすでに変更されていました。最新の状態を読み込み直しました。', reload: true },
  PLATFORM_NOT_SUPPORTED: { message: 'このプラットフォームの自動投稿はまだ利用できません。', reload: false },
  BRAND_INACTIVE: { message: 'このワークスペースは現在、自動投稿をONにできない状態です。', reload: true },
  BRAND_PUBLISHING_NOT_LIVE: { message: 'このワークスペースでは、まだ本番の自動投稿が有効になっていません。', reload: true },
  CONNECTION_NOT_VERIFIED: { message: 'Xとの接続を確認できませんでした。Xアカウントを接続し直してから、もう一度お試しください。', reload: true },
  CONNECTION_DEGRADED: { message: 'Xとの接続に確認が必要です。Xアカウントを接続し直してから、もう一度お試しください。', reload: true },
  CREDENTIALS_MISSING: { message: 'Xの接続情報が不足しています。Xアカウントを接続し直してから、もう一度お試しください。', reload: true },
  ACCOUNT_BUSY: { message: 'このアカウントは現在変更できません。しばらくしてからもう一度お試しください。', reload: true },
  PUBLISH_SETTING_UNAVAILABLE: { message: '設定を変更できませんでした。時間をおいてもう一度お試しください。', reload: false },
};

const GENERIC_FAILURE: PublishSettingFailure = {
  code: 'PUBLISH_SETTING_UNAVAILABLE',
  message: '設定を変更できませんでした。通信状況を確認して、もう一度お試しください。',
  reload: false,
};

/** Bounded server error code -> safe Japanese copy. Unknown or malformed responses never surface raw text. */
export function publishSettingFailure(payload: unknown): PublishSettingFailure {
  if (typeof payload !== 'object' || payload === null) return GENERIC_FAILURE;
  const code = (payload as { error?: unknown }).error;
  if (typeof code !== 'string' || !Object.hasOwn(KNOWN_FAILURES, code)) return GENERIC_FAILURE;
  return { code, ...KNOWN_FAILURES[code] };
}

export type PublishSettingSuccess = { status: 'updated' | 'unchanged'; accountId: string; enabled: boolean };

/** Success only when the server confirms exactly this account and exactly the requested value. */
export function parsePublishSettingSuccess(payload: unknown, request: PublishSettingRequest): PublishSettingSuccess | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const body = payload as { success?: unknown; status?: unknown; account?: unknown };
  if (body.success !== true || (body.status !== 'updated' && body.status !== 'unchanged')) return null;
  const account = body.account as { id?: unknown; publish_enabled?: unknown } | null | undefined;
  if (!account || account.id !== request.social_account_id || account.publish_enabled !== request.desired_enabled) return null;
  return { status: body.status, accountId: account.id, enabled: account.publish_enabled };
}

export function publishSettingSuccessMessage(enabled: boolean): string {
  return enabled ? '自動投稿をONにしました。' : '自動投稿をOFFにしました。';
}
