/**
 * Posting-X connection state as shown next to the X login method. Pure (type
 * imports only). Only real, loaded data counts: a mock preview or unloaded data
 * is "unknown", never "connected".
 */
import type { SocialAccount } from './types.ts';

export type PostingXStatus = 'connected' | 'needs_reconnect' | 'not_connected' | 'unknown';

export function postingXStatus(dataStatus: string, accounts: readonly Pick<SocialAccount, 'platform' | 'connectionStatus'>[]): PostingXStatus {
  if (dataStatus !== 'ready') return 'unknown';
  const x = accounts.find((account) => account.platform === 'x');
  if (!x || x.connectionStatus === 'not_connected') return 'not_connected';
  return x.connectionStatus === 'connected' ? 'connected' : 'needs_reconnect';
}

export const POSTING_X_STATUS_LABELS: Record<PostingXStatus, string> = {
  connected: '接続済み',
  needs_reconnect: '要再接続',
  not_connected: '未接続',
  unknown: '確認できません',
};
