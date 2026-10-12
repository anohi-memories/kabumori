/**
 * Server-side reservations on the schedule screen (pure helpers; no React, network or storage).
 *
 * Server rows and local preview drafts are separate things and are never merged: a preview becomes a server row
 * only after the store's independent read-back confirmed every post of the batch. The list shown for an account
 * is always the last answer read FOR THAT account; anything else is shown as loading.
 */
import type { PostConfirmation, SaveOutcome, SaveRequest, ServerReservation } from '../../domain/reservation-flow.ts';
import { jstToUtcMs, parseClock } from '../../domain/schedule-planner.ts';
import type { ConfirmationMap } from './confirmation-state.ts';

/** The store's code for an outcome it could not confirm (see remote-reservation-store.ts). */
export const UNCERTAIN_CODE = 'UNCERTAIN';

export type ServerList =
  | { state: 'loading' }
  | { state: 'ready'; rows: ServerReservation[] }
  | { state: 'error'; code: string };

/** The last list answer, bound to the account and the load it was read for. */
export type ServerListSnapshot = { accountId: string; loadId: number; list: ServerList };

/** What the screen shows for the selected account: a snapshot for another account is never shown. */
export function serverListFor(snapshot: ServerListSnapshot | null, accountId: string | null): ServerList {
  if (!snapshot || !accountId || snapshot.accountId !== accountId) return { state: 'loading' };
  return snapshot.list;
}

/**
 * Applies a list answer unless a LATER load (of any account; load ids are one screen-wide counter) is already
 * shown: a late answer -- e.g. for the account the user just left -- never replaces a newer list.
 */
export function applyListAnswer(current: ServerListSnapshot | null, accountId: string, loadId: number,
  answer: { ok: true; value: ServerReservation[] } | { ok: false; code: string }): ServerListSnapshot | null {
  if (current && current.loadId > loadId) return current;
  const sorted = answer.ok ? [...answer.value].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.reservationId.localeCompare(b.reservationId)) : [];
  return { accountId, loadId, list: answer.ok ? { state: 'ready', rows: sorted } : { state: 'error', code: answer.code } };
}

/** Replaces one row (after its own read-back) in the snapshot of its account. */
export function replaceRow(current: ServerListSnapshot | null, accountId: string, row: ServerReservation): ServerListSnapshot | null {
  if (!current || current.accountId !== accountId || current.list.state !== 'ready') return current;
  return { ...current, list: { state: 'ready', rows: current.list.rows.map((existing) => (existing.reservationId === row.reservationId ? row : existing)) } };
}

/** The domain confirmations (what the save request is built from) out of the screen's confirmation map. */
export function domainConfirmations(confirmations: ConfirmationMap): Record<string, PostConfirmation> {
  return Object.fromEntries(Object.values(confirmations).map((confirmed) => [confirmed.confirmation.draftId, confirmed.confirmation]));
}

/** A batch being saved: the exact request is kept so a retry re-sends the same idempotency key. */
export type PendingSave = { request: SaveRequest; phase: 'saving' | 'uncertain' | 'failed'; code?: string };

export function pendingAfter(request: SaveRequest, outcome: SaveOutcome): PendingSave | null {
  if (outcome.kind === 'saved') return null;
  if (outcome.kind === 'uncertain') return { request, phase: 'uncertain', code: outcome.code };
  if (outcome.kind === 'not_available') return { request, phase: 'failed', code: 'NOT_AVAILABLE' };
  return { request, phase: 'failed', code: outcome.code };
}

/** JST date + time fields -> UTC ISO instant, or null when the fields are not a valid date / time. */
export function isoFromJstFields(fields: { date: string; time: string }): string | null {
  const minutes = parseClock(fields.time);
  const ms = minutes === null ? null : jstToUtcMs(fields.date.trim(), minutes);
  return ms === null ? null : new Date(ms).toISOString();
}

const MESSAGES: Record<string, string> = {
  NOT_AVAILABLE: '予約の保存は、まだ利用できません。',
  AUTH_REQUIRED: 'ログインを確認できませんでした。もう一度ログインしてください。',
  UNCERTAIN: '保存・変更できたかを確認できませんでした。まだ確定していません。',
  POSTONA_RESV_SERVICE_NOT_ACTIVE: 'X自動投稿の利用登録が有効ではないため、保存・変更できません。',
  POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED: 'このXアカウントの本人確認が済んでいないため、保存・変更できません。',
  POSTONA_RESV_ACCOUNT_NOT_FOUND: 'このアカウントは見つかりません。',
  POSTONA_RESV_NOT_FOUND: 'この予約は見つかりません。',
  POSTONA_RESV_BRAND_NOT_ELIGIBLE: 'このワークスペースでは使えません。',
  POSTONA_RESV_AI_NOT_OPTED_IN: 'AI自動投稿は、設定画面で自動投稿を選んだ場合だけ保存できます。AI相談の「これで覚えて」は同意になりません。',
  POSTONA_RESV_STALE_REVISION: 'ほかの操作で予約が変わっていました。一覧を読み込み直しました。',
  POSTONA_RESV_IDEMPOTENCY_CONFLICT: '同じ保存が別の内容で行われています。プレビューを作り直してください。',
  POSTONA_RESV_SLOT_CONFLICT: '近い時刻にほかの予約があります（60分以上あけてください）。',
  POSTONA_RESV_DAILY_CAPACITY: '1日の上限（10件）を超えます。',
  POSTONA_RESV_MONTHLY_CAPACITY: '1か月の上限（300件）を超えます。',
  POSTONA_RESV_CANCEL_TOO_LATE: '投稿の処理が始まっているため、取り消せません。',
  POSTONA_RESV_NOT_PLANNED: 'この予約は、もう変更できません。',
  POSTONA_RESV_ALREADY_FINAL: 'この予約は、もう変更できません。',
  POSTONA_RESV_TIME_OUT_OF_RANGE: '日時は5分以上先、90日以内にしてください。',
  POSTONA_RESV_OUTSIDE_BAND: '決めた期間と時間帯の外です。',
  POSTONA_RESV_CONSENT_REQUIRED: '内容の確認が必要です。',
  POSTONA_RESV_TEXT_INVALID: '本文が空か、長すぎます。',
  POSTONA_RESV_INTERVAL_INVALID: '指定した間隔の情報が正しくありません。プレビューを作り直してください。',
  POSTONA_RESV_INTERVAL_MISMATCH: '日時が指定した間隔と合っていません。プレビューを作り直してください。',
};

export function reservationMessage(code: string | undefined): string {
  return (code && MESSAGES[code]) || '保存・変更できませんでした。時間をおいて、もう一度お試しください。';
}
