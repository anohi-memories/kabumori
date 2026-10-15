/** Client mapper for F5 PR193 account-delete, never a direct lifecycle RPC.
 * Source-only: runtime release stays closed until an independently reviewed,
 * managed server contract and legacy-server containment are proven.
 */
import { ERROR_NOTICES, UNKNOWN_CODE_NOTICE, X_REASON_NOTICES, REMOTE_UNVERIFIED, resultLines, xPostsUnconfirmedLine } from './postona-end-notices.ts';

export const POSTONA_END_SOURCE_ENABLED = false;
export const POSTONA_END_FUNCTION = 'account-delete';
export const POSTONA_END_CONFIRMATION = 'END_POSTONA_SERVICE';
export const POSTONA_END_CONFIRM_PHRASE = 'POSTONAの利用を終了';
export const COMMON_DELETE_CONFIRM_PHRASE = '共通IDを完全削除';
export type EndFailure = { ok: false; code: string; lines: string[]; retryable: boolean };
export type ServiceState = { service: 'kabumori' | 'x_autopost'; status: 'active' | 'deleting' | 'ended' };
export type EndPreview = {
  ok: true; accountStatus: string; lifecycleVersion: number; services: ServiceState[];
  acknowledgementRequired: string[]; postonaAvailable: boolean; deletionInProgress: boolean;
};
export type EndResult = {
  ok: true; outcome: 'ended' | 'already_ended' | 'not_registered';
  remoteUnverified: string[]; xPostsUnconfirmed: number; lines: string[];
};
const record = (v: unknown): Record<string, unknown> | null => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
const strings = (v: unknown): string[] | null => Array.isArray(v) && v.every((x) => typeof x === 'string') && new Set(v).size === v.length ? v : null;
const countOf = (v: unknown) => v === undefined ? 0 : typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
const own = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

export function endFailure(code: string, body?: unknown): EndFailure {
  const data = record(body);
  const notice = own(ERROR_NOTICES, code) ? ERROR_NOTICES[code as keyof typeof ERROR_NOTICES] : UNKNOWN_CODE_NOTICE;
  const clientNotice: Record<string, string> = {
    LEGACY_DELETION_DISABLED: 'この操作は現在利用できません。利用終了の画面から内容をご確認ください。',
    POSTONA_END_UNAVAILABLE: 'POSTONAの利用終了は現在準備中です。お手数ですがお問い合わせください。',
    SESSION_CHANGED: 'ログイン状態が変わったため中止しました。もう一度本人確認からやり直してください。',
    RESULT_UNCONFIRMED: '手続きの結果を確認できませんでした。完了したものとして扱わず、運営にお問い合わせください。',
  };
  const lines = (own(clientNotice, code) ? clientNotice[code] : notice.ja).split('\n');
  if ((code === 'X_CLEANUP_BLOCKED' || code === 'X_CLEANUP_FAILED') && data) {
    for (const reason of strings(data.reasons) ?? []) if (own(X_REASON_NOTICES, reason)) lines.push(X_REASON_NOTICES[reason]);
  }
  const count = countOf(data?.x_posts_unconfirmed);
  if (count) lines.push(xPostsUnconfirmedLine(count));
  return { ok: false, code, lines, retryable: !own(clientNotice, code) && notice.retryable };
}
const failureOf = (body: unknown) => {
  const data = record(body);
  return endFailure(typeof data?.error === 'string' && own(ERROR_NOTICES, data.error) ? data.error : 'RESULT_UNCONFIRMED', body);
};

export function parseEndPreview(status: number, body: unknown): EndPreview | EndFailure {
  const d = record(body);
  if (status !== 200 || d?.ok !== true) return failureOf(body);
  const required = strings(d.acknowledgement_required);
  const blockers = strings(d.blockers);
  const services = Array.isArray(d.services) ? d.services.map(record) : null;
  const providers = Array.isArray(d.providers) ? d.providers.map(record) : null;
  if (!required || required.some((p) => !own(REMOTE_UNVERIFIED, p)) || !blockers || !services || !providers
    || !Number.isSafeInteger(d.lifecycle_version) || (d.lifecycle_version as number) < 0
    || !['active', 'deleting', 'locked', 'none'].includes(d.account_status as string)
    || typeof d.postona_end_available !== 'boolean' || typeof d.deletion_in_progress !== 'boolean'
    || !['supported', 'unsupported', 'not_needed'].includes(d.x_cleanup as string)
    || services.some((s) => !s || !['kabumori', 'x_autopost'].includes(s.service as string) || !['active', 'deleting', 'ended'].includes(s.status as string))
    || new Set(services.map((s) => s?.service)).size !== services.length
    || providers.some((p) => !p || !(p.provider === 'x' || p.provider === 'threads'))
    || new Set(providers.map((p) => p?.provider)).size !== providers.length) return endFailure('RESULT_UNCONFIRMED');
  const needsAck: string[] = [];
  let adaptersReady = true;
  for (const p of providers) {
    if (p?.provider === 'x') {
      if (p.adapter !== 'saga' || p.remote_revoke !== 'saga') return endFailure('RESULT_UNCONFIRMED');
    } else if (p) {
      if (!['registered', 'missing'].includes(p.adapter as string) || !['supported', 'unsupported'].includes(p.remote_revoke as string)) return endFailure('RESULT_UNCONFIRMED');
      if (p.adapter === 'missing') adaptersReady = false;
      if (p.adapter === 'registered' && p.remote_revoke !== 'supported') needsAck.push(p.provider as string);
    }
  }
  if (required.slice().sort().join() !== needsAck.sort().join()) return endFailure('RESULT_UNCONFIRMED');
  return {
    ok: true, accountStatus: d.account_status as string, lifecycleVersion: d.lifecycle_version as number,
    services: services as ServiceState[], acknowledgementRequired: required,
    postonaAvailable: d.postona_end_available && adaptersReady && d.x_cleanup !== 'unsupported' && blockers.length === 0 && d.account_status === 'active' && !d.deletion_in_progress,
    deletionInProgress: d.deletion_in_progress,
  };
}

export function parseEndResult(status: number, body: unknown, acknowledged: readonly string[]): EndResult | EndFailure {
  const d = record(body);
  if (status !== 200 || d?.ok !== true) return failureOf(body);
  const remote = d.remote_unverified === undefined ? [] : strings(d.remote_unverified);
  const providers = d.providers === undefined ? {} : record(d.providers);
  const count = countOf(d.x_posts_unconfirmed);
  if (!['ended', 'already_ended', 'not_registered'].includes(d.outcome as string) || d.login_deleted === true
    || !remote || remote.some((p) => !own(REMOTE_UNVERIFIED, p) || (d.outcome === 'ended' && !acknowledged.includes(p))) || !providers || count === null
    || Object.entries(providers).some(([p, r]) => p === 'x' ? r !== 'done' : p !== 'threads' || !['not_connected', 'confirmed_remote_revoked', 'local_removed_remote_unverified'].includes(r as string))
    || Object.entries(providers).some(([p, r]) => (r === 'local_removed_remote_unverified') !== remote.includes(p))) return endFailure('RESULT_UNCONFIRMED', body);
  return { ok: true, outcome: d.outcome as EndResult['outcome'], remoteUnverified: remote, xPostsUnconfirmed: count, lines: resultLines(d, 'postona_end') };
}
