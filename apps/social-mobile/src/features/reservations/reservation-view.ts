// What the reservations screen shows and offers, decided from the store answers only (G1 TASK 30). Pure: no React, no
// network. The rules come from G3's handoff (6536788017):
//   * 「予約済み」 only for a row read back as planned + confirmed (X) or a receipt that reads pending (Threads);
//   * uncertain is "check X / Threads", never a retry and never success;
//   * an edit always carries the revision last read; after a reschedule the row needs a reconfirm;
//   * every refusal maps to one action, and an unknown code is 'check' (read again).
import type { ReservationAction, ServerReservation, ThreadsReceiptState } from './reservation-ports.ts';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger';
export type RowView = { label: string; tone: Tone; detail: string | null; canReschedule: boolean; needsReconfirm: boolean; canCancel: boolean };

export function xRowView(row: ServerReservation): RowView {
  const edit = { canReschedule: false, needsReconfirm: false, canCancel: false };
  switch (row.status) {
    case 'planned':
      if (row.consentState === 'confirmed') return { label: '予約済み', tone: 'success', detail: null, canReschedule: true, needsReconfirm: false, canCancel: true };
      if (row.consentState === 'needs_reconfirm') {
        return { label: '再確認が必要', tone: 'warning', detail: '時刻を変えたため、この本文で投稿してよいか、もう一度確認してください。確認するまで投稿されません。', canReschedule: true, needsReconfirm: true, canCancel: true };
      }
      return { label: 'AI自動予約', tone: 'neutral', detail: 'AIが作った予約です。', canReschedule: false, needsReconfirm: false, canCancel: true };
    case 'claimed':
      return { label: '送信処理中', tone: 'neutral', detail: '投稿の処理が始まっているため、変更・取消はできません。', ...edit };
    case 'published':
      return { label: '投稿済み', tone: 'success', detail: null, ...edit };
    case 'failed':
      return { label: '投稿できませんでした', tone: 'danger', detail: null, ...edit };
    case 'uncertain':
      return { label: 'Xで確認してください', tone: 'warning', detail: '投稿されたかどうか分かりません。Xで確認してください。自動で送り直すことはありません。', ...edit };
    case 'cancelled':
      return { label: '取消済み', tone: 'neutral', detail: null, ...edit };
    case 'expired':
      return { label: '期限切れ', tone: 'neutral', detail: '予定の時刻を過ぎたため、投稿されませんでした。', ...edit };
    default:
      return { label: '状態を確認できません', tone: 'warning', detail: null, ...edit };
  }
}

export type ReceiptView = { label: string; tone: Tone; detail: string | null; canCancel: boolean };

export function threadsReceiptView(state: ThreadsReceiptState | null): ReceiptView {
  switch (state) {
    case 'pending':
      return { label: '予約済み', tone: 'success', detail: null, canCancel: true };
    case 'sent':
      return { label: '投稿済み', tone: 'success', detail: null, canCancel: false };
    case 'failed':
      return { label: '投稿できませんでした', tone: 'danger', detail: null, canCancel: false };
    case 'cancelled':
      return { label: '取消済み', tone: 'neutral', detail: null, canCancel: false };
    case 'uncertain':
      return { label: 'Threadsで確認してください', tone: 'warning', detail: 'Threadsに届いた可能性があります。Threadsで確認してください。この予約を作り直すことはありません。', canCancel: false };
    default:
      return { label: '受領票を確認中', tone: 'warning', detail: '予約されたかどうか、まだ分かりません。「受領票を確認」で確かめてください。作り直すことはありません。', canCancel: false };
  }
}

export type ActionButtonKind = 'settings' | 'accounts' | null;
/** `blocks`: the writes stay off (for this token / this answer); `reread`: read the rows / receipt again at once (the screen then adds REREAD_TEXT). */
export type ActionView = { message: string; button: ActionButtonKind; blocks: boolean; reread: boolean };

export function actionView(action: ReservationAction, platform: 'x' | 'threads'): ActionView {
  const name = platform === 'x' ? 'X' : 'Threads';
  switch (action) {
    case 'sign_in':
      return { message: 'ログインの有効期限が切れたため、ログインし直すまで予約を操作できません（設定画面からログアウトして、もう一度ログインしてください）。', button: 'settings', blocks: true, reread: false };
    case 'start_service':
      return { message: 'X自動投稿の利用登録が有効でないため、予約を操作できません。ログインし直すと利用登録を確認できます。', button: 'settings', blocks: true, reread: false };
    case 'reconnect_x':
      return { message: 'Xアカウントの接続を確認できないため、予約を操作できません。アカウント画面でXを接続し直してください。', button: 'accounts', blocks: true, reread: false };
    case 'reconnect_threads':
      return { message: 'Threadsアカウントの接続を確認できないため、予約を操作できません。アカウント画面で接続を確認してください。', button: 'accounts', blocks: true, reread: false };
    case 'not_available':
      return { message: `${name}の予約は、いまは使えません（公開前の準備中です）。予約済みにはなっていません。`, button: null, blocks: true, reread: false };
    case 'reload':
      return { message: '予約の内容が更新されていました。内容を確かめてから、もう一度操作してください。', button: null, blocks: false, reread: true };
    case 'final':
      return { message: 'この予約はすでに確定しているため、変更・取消はできません。', button: null, blocks: false, reread: true };
    case 'not_found':
      return { message: 'この予約は見つかりませんでした（取り消されたか、このアカウントの予約ではありません）。', button: null, blocks: false, reread: true };
    case 'fix_input':
      return { message: 'この内容では予約できません。時刻や本文を見直してください。', button: null, blocks: false, reread: false };
    case 'retry_later':
      return { message: 'いまは混み合っているため、何も変更されていません。時間をおいて、もう一度お試しください。', button: null, blocks: false, reread: false };
    default:
      return { message: '結果を確認できませんでした。同じ操作を自動で送り直すことはありません。', button: null, blocks: false, reread: true };
  }
}

export const REREAD_TEXT = '最新の状態を読み込みます。';

export const GATE_OFF_TEXT = {
  x: 'Xの予約の保存・変更・取消は、公開前の準備中のため、まだ使えません。ここで「予約済み」と表示されることはありません。',
  threads: 'Threadsの予約は、公開前の準備中のため、まだ使えません。ここで「予約済み」と表示されることはありません。',
} as const;

const JST_INPUT = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/u;

/** 'YYYY-MM-DD HH:mm' in Japan time -> ISO with +09:00; only a real date in the future. */
export function parseJstInput(text: string, now: Date): { ok: true; iso: string } | { ok: false; message: string } {
  const match = JST_INPUT.exec(text.trim());
  if (!match) return { ok: false, message: '日時は「2026-11-01 09:30」の形で入力してください（日本時間）。' };
  const [, y, mo, d, h, mi] = match;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:00+09:00`;
  const at = new Date(iso);
  const check = new Date(at.getTime() + 9 * 3600 * 1000);
  if (Number.isNaN(at.getTime()) || check.getUTCFullYear() !== Number(y) || check.getUTCMonth() + 1 !== Number(mo)
      || check.getUTCDate() !== Number(d) || check.getUTCHours() !== Number(h) || check.getUTCMinutes() !== Number(mi)) {
    return { ok: false, message: 'その日時はありません。' };
  }
  if (at.getTime() <= now.getTime()) return { ok: false, message: 'これからの日時を入力してください。' };
  return { ok: true, iso };
}

/** An ISO time as 'YYYY-MM-DD HH:mm' in Japan time ('' when it cannot be read). */
export function formatJst(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const j = new Date(at.getTime() + 9 * 3600 * 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${j.getUTCFullYear()}-${two(j.getUTCMonth() + 1)}-${two(j.getUTCDate())} ${two(j.getUTCHours())}:${two(j.getUTCMinutes())}`;
}

/**
 * Whether reservations of this account may be touched from this screen. Shared brands' authorization is a G5 source
 * candidate that is not applied, so only an account of the person's own personal workspace (W0 ready, the snapshot
 * showing it) that is connected qualifies; anything else is refused before a request is made.
 */
export function accountRefusal(
  account: { brandId?: string; connectionStatus: string; platform: string } | null,
  platform: 'x' | 'threads',
  personalWorkspaceId: string | null,
): string | null {
  const name = platform === 'x' ? 'X' : 'Threads';
  if (!account) return `${name}アカウントがまだ接続されていません。アカウント画面から接続してください。`;
  if (account.platform !== platform) return `${name}アカウントを選んでください。`;
  if (!personalWorkspaceId || !account.brandId || account.brandId !== personalWorkspaceId) {
    return 'ご自身の個人ワークスペースのアカウントだけ、予約を操作できます（このアカウントのワークスペースは確認できません）。';
  }
  if (account.connectionStatus !== 'connected') return `${name}アカウントの接続を確認できません。アカウント画面で接続し直してください。`;
  return null;
}
