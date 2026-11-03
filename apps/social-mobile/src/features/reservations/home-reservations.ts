// What the home says about the X reservations of the selected account (G1 TASK 38). Pure: no React, no network.
// The rows are G3's list as read for this person and account; a count is never filled in, so anything but an answer shows no number.
import type { ServerReservation } from '../../domain/reservation-flow.ts';
import type { ServerList } from '../schedule/server-reservations-state.ts';
import type { ReservationAction } from './reservation-ports.ts';
import { isSendNowRow, xRowViewOf } from './reservation-view.ts';
import { rowRefusalOf } from './x-row-generation.ts';

export const HOME_LOGIN_TEXT = 'ログインを確認できないため、予約の件数を表示できません。ログインし直してください。';
export const HOME_NO_ACCESS_TEXT = 'このアカウントの予約は確認できないため、件数を表示していません。';
export const HOME_ERROR_TEXT = '予約を読み込めなかったため、予約があるかどうかを確認できていません。';
export const HOME_NEEDS_CHECK_TEXT = '投稿の対象になっている予約を確認できません。「予約の管理」で状態を確認してください。';
export const HOME_RESERVATION_NOTE = '保存済みの予約です。投稿を保証するものではありません。';

export type HomeReservations =
  /** Gate OFF, the sample data or another platform: the reservations are not part of the home's answer. */
  | { kind: 'not_applicable' }
  | { kind: 'loading' }
  | { kind: 'no_access'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'ready'; total: number; upcomingCount: number; attentionCount: number; next: ServerReservation | null };

export function homeReservationsOf(list: ServerList, isNotEditable: (reservationId: string) => boolean, nowMs: number, actionOf: (code: string) => ReservationAction): HomeReservations {
  if (list.state === 'loading') return { kind: 'loading' };
  if (list.state === 'error') {
    const action = actionOf(list.code);
    if (action === 'sign_in') return { kind: 'no_access', text: HOME_LOGIN_TEXT };
    if (action === 'not_found' || action === 'not_available') return { kind: 'no_access', text: HOME_NO_ACCESS_TEXT };
    return { kind: 'error', text: HOME_ERROR_TEXT };
  }
  // A "post now" row is not a reservation (as on the schedule tab).
  const rows = list.rows.filter((row) => !isSendNowRow(row));
  let upcomingCount = 0;
  let attentionCount = 0;
  let next: ServerReservation | null = null;
  for (const row of rows) {
    const notEditable = rowRefusalOf(row, isNotEditable(row.reservationId)) !== null;
    const { tone } = xRowViewOf(row, notEditable, '', '');
    const ahead = new Date(row.scheduledAt).getTime() >= nowMs;
    if (row.status === 'claimed' || (row.status === 'planned' && ahead)) upcomingCount += 1;
    // A planned row past its time did not go as planned, and the app does not say why.
    if (tone === 'warning' || tone === 'danger' || (row.status === 'planned' && !ahead)) attentionCount += 1;
    // Only a confirmed row can be next: a row awaiting a reconfirmation, refused an edit or of an earlier generation is not, nor is an AI slot.
    if (row.status === 'planned' && ahead && !notEditable && row.consentState === 'confirmed' && (!next || row.scheduledAt < next.scheduledAt)) next = row;
  }
  return { kind: 'ready', total: rows.length, upcomingCount, attentionCount, next };
}

/** A number only when every source of it answered: null shows no number. */
export function homeCount(fromPosts: number | null, reservations: HomeReservations, field: 'upcomingCount' | 'attentionCount'): number | null {
  if (fromPosts === null) return null;
  if (reservations.kind === 'not_applicable') return fromPosts;
  return reservations.kind === 'ready' ? fromPosts + reservations[field] : null;
}

export function homeHasNoReservations(reservations: HomeReservations): boolean {
  return reservations.kind === 'not_applicable' || (reservations.kind === 'ready' && reservations.total === 0);
}

/** 「接続済みデータ」 is about the data source: not in green beside an X connection the home asks to check. */
export function homeHeadline<T extends { label: string; tone: string }>(headline: T, connectionTone: 'success' | 'warning'): T | { label: string; tone: 'loading' } {
  return headline.tone === 'ready' && connectionTone === 'warning' ? { label: 'データは読み込み済みです（Xの接続は要確認）', tone: 'loading' } : headline;
}
