// What the X composer and the reservations screen say about a refused X write, and when they refuse before asking (G1 TASK 32).
// Pure: no React, no network. The code -> action table is G3's; the only addition is the code below, by which a SERVER has decided
// that the X connection must be made again (G3's POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED is already 'reconnect_x' there).
import { reservationMessage } from '../schedule/server-reservations-state.ts';
import type { ReservationAction } from './reservation-ports.ts';
import { accountRefusal, actionView, REREAD_TEXT, type ActionButtonKind } from './reservation-view.ts';

/**
 * G4 PR 617's refresh writer after a service stop + restart (G5 lifecycle_version moved). No path carries this code to the app yet:
 * until one does, an account after a restart shows what the server's connection_status says. A restart alone is never taken as proof.
 */
const GENERATION_CHANGED = 'X_REFRESH_PRECHECK_SERVICE_GENERATION_CHANGED';

export const RECONNECT_REQUIRED_LABEL = '再接続が必要';
export const RECONNECT_REQUIRED_TEXT = 'Xの再接続が必要です。再接続するまで、このアカウントの予約は保存・変更できません。アカウント画面でXを接続し直してください。';
/** This person restarted the service from this app and has not connected since. Not a server's refusal, so it does not say 「再接続が必要」. */
export const RESTART_OBSERVED_LABEL = '要確認';
const RESTART_OBSERVED = 'X自動投稿を再開しました。再開前のXの接続は更新できないことがあるため、接続し直すまで、このアカウントの予約は保存・変更できません。';
export const RESTART_OBSERVED_TEXT = `${RESTART_OBSERVED}アカウント画面でXを接続し直してください。`;
export const RESTART_OBSERVED_ACCOUNTS_TEXT = `${RESTART_OBSERVED}下のボタンから接続し直してください。`;
/** The account is the person's own but not connected: what is still possible, and the way back. */
export const X_NOT_CONNECTED_TEXT = 'Xアカウントの接続を確認できないため、新しい予約と時刻の変更はできません。既存の予約の確認と取消はできます。接続し直すときは、アカウント画面を開いてください。';
export const X_NOT_CONNECTED_HOME_TEXT = 'Xアカウントの接続を確認できないため、新しい予約と時刻の変更はできません。既存の予約は「予約の管理」で確認できます。';
/** Beside a write when nothing was observed: 接続済み is the stored connection, not a promise that it can still be refreshed. */
export const CONNECTED_NOT_PROOF_TEXT = '接続済みと表示されていても、X自動投稿を終了して再開したあとは接続を更新できないことがあります。予定どおりに投稿されないときは、アカウント画面で接続し直してください。';
/** Not a statement about this account: nothing in the app can tell whether its connection predates a restart. */
export const RESTART_HELP_TEXT = 'X自動投稿を終了して再開したあとは、接続の更新が止まることがあります。投稿が失敗したり、予約で接続のエラーが出たりしたら、ここから再接続してください。';

export function xActionOf(code: string, actionOf: (code: string) => ReservationAction): ReservationAction {
  return code === GENERATION_CHANGED ? 'reconnect_x' : actionOf(code);
}

export type XAnswerView = {
  action: ReservationAction;
  text: string;
  tone: 'warning' | 'danger';
  button: ActionButtonKind;
  /** The writes stay off for this account until a read succeeds. */
  blocks: boolean;
  /** Read the rows again at once (never the same write again). */
  reread: boolean;
};

/** One refusal of an X save or edit: G3's specific wording when there is one, and always the one next step for its action. */
export function xAnswerView(code: string, actionOf: (code: string) => ReservationAction): XAnswerView {
  const action = xActionOf(code, actionOf);
  const next = actionView(action, 'x');
  const specific = reservationMessage(code);
  const known = specific !== reservationMessage(undefined);
  const text = action === 'reconnect_x' ? RECONNECT_REQUIRED_TEXT : known ? specific : next.reread ? `${next.message}${REREAD_TEXT}` : next.message;
  return { action, text, tone: action === 'check' ? 'warning' : 'danger', button: next.button, blocks: next.blocks, reread: next.reread };
}

/** A restart moves the person's own generation: another workspace's X account is not touched by it. Workspace not known yet: it may be this one. */
export function restartAppliesTo(account: { brandId?: string; platform: string }, personalId: string | null): boolean {
  return account.platform === 'x' && (personalId === null || account.brandId === personalId);
}

export type XWriteRefusal = { text: string; button: ActionButtonKind };

/** Why an X write is refused before a request is made: the same rule as the reservations screen, plus a confirmed reconnect. */
export function xWriteRefusal(input: {
  loginId: string | null;
  account: { brandId?: string; connectionStatus: string; platform: string } | null;
  personalId: string | null;
  reconnectRequired: boolean;
  restartObserved?: boolean;
}): XWriteRefusal | null {
  if (!input.loginId) return { text: 'ログインが確認できないため、予約を保存できません。ログインし直してください。', button: 'settings' };
  const refusal = accountRefusal(input.account, 'x', input.personalId);
  if (refusal) return { text: accountRefusal(input.account, 'x', input.personalId, false) === null ? X_NOT_CONNECTED_TEXT : refusal, button: 'accounts' };
  if (input.reconnectRequired) return { text: RECONNECT_REQUIRED_TEXT, button: 'accounts' };
  return input.restartObserved ? { text: RESTART_OBSERVED_TEXT, button: 'accounts' } : null;
}

/** What still stops a cancel: G3 serves cancel, get and list on the session and row ownership, so a connection never does. */
export function xOwnRefusal(input: {
  loginId: string | null;
  account: { brandId?: string; connectionStatus: string; platform: string } | null;
  personalId: string | null;
}): XWriteRefusal | null {
  if (!input.loginId) return { text: 'ログインが確認できないため、予約を操作できません。ログインし直してください。', button: 'settings' };
  const refusal = accountRefusal(input.account, 'x', input.personalId, false);
  return refusal ? { text: refusal, button: 'accounts' } : null;
}

/** The connection pill: 「再接続が必要」 only for a server's refusal; 接続済み is not shown after an observed restart; otherwise the server's connection_status, in each screen's wording. */
export function connectionPill(connectionStatus: string, reconnectRequired: boolean, otherLabel: string, restartObserved = false): { label: string; tone: 'success' | 'warning' } {
  if (reconnectRequired) return { label: RECONNECT_REQUIRED_LABEL, tone: 'warning' };
  if (restartObserved && connectionStatus === 'connected') return { label: RESTART_OBSERVED_LABEL, tone: 'warning' };
  return connectionStatus === 'connected' ? { label: '接続済み', tone: 'success' } : { label: otherLabel, tone: 'warning' };
}
