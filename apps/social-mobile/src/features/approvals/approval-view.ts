// G1 TASK 44: what the approval and notification screens say, and what each of G3's answers asks the person to do (contract §4).
// Pure: the hook keeps the state; approval-client.ts talks to the server.
import type { ApprovalNotification, Candidate, CandidateState } from './approval-client.ts';
import { AUTH_REQUIRED, UNCERTAIN } from './approval-client.ts';

export const POSTONA_APPROVAL_UI_GATE_TEXT = '投稿の承認とお知らせは、まだ使えません。準備ができるまで、ここからは何も送られません。';

export type ApprovalBlock = 'off' | 'preview' | 'unconfigured' | 'signed_out' | 'relogin' | 'workspace_preparing' | 'workspace_unavailable' | 'service_inactive' | 'not_available' | 'no_x_account' | 'other_workspace';
export const APPROVAL_BLOCK_TEXT: Record<ApprovalBlock, string> = {
  off: POSTONA_APPROVAL_UI_GATE_TEXT,
  preview: 'サンプル表示では、投稿の承認とお知らせは使えません。',
  unconfigured: 'サーバーの設定を確認できないため、投稿の承認とお知らせは使えません。',
  signed_out: 'ログインが確認できないため、投稿の承認とお知らせは使えません。ログインし直してください。',
  relogin: 'ログインの有効期限が切れました。設定画面からログアウトして、もう一度ログインしてください。',
  workspace_preparing: 'ご自身の個人ワークスペースを準備しています。準備ができると使えます。',
  workspace_unavailable: 'いまは個人ワークスペースを確認できないため、使えません。時間をおいてもう一度開いてください。',
  service_inactive: 'X自動投稿の利用登録が有効でないため、使えません。',
  not_available: 'このアカウントでは使えません。',
  no_x_account: '投稿先のXアカウントが選ばれていません。アカウント画面でXアカウントを選んでください。',
  other_workspace: 'このXアカウントはご自身の個人ワークスペースのものではないため、ここでは承認できません。',
};

/** The personal workspace view (personal-workspace-provider.tsx): only 'ready' opens the screens. */
export function workspaceBlockOf(kind: string): ApprovalBlock | null {
  if (kind === 'ready') return null;
  if (kind === 'idle' || kind === 'preparing') return 'workspace_preparing';
  if (kind === 'relogin') return 'relogin';
  if (kind === 'service_inactive') return 'service_inactive';
  if (kind === 'not_available' || kind === 'off' || kind === 'support') return 'not_available';
  return 'workspace_unavailable';
}

export const STATE_LABEL: Record<CandidateState, string> = {
  pending_approval: '承認待ち',
  approved: '承認済み（予約に登録済み）',
  rejected: '却下',
};
export const stateTone = (state: CandidateState): 'warning' | 'success' | 'neutral' => (state === 'pending_approval' ? 'warning' : state === 'approved' ? 'success' : 'neutral');

/** What an answer asks for. Only `sign_in` / `forbidden` end what the screen holds for the person. */
export type ApprovalAction = 'sign_in' | 'forbidden' | 'reconnect_x' | 'not_found' | 'reread' | 'generation_changed' | 'change_time' | 'show_again' | 'fix_input' | 'later' | 'uncertain';
const CODE_ACTION: Readonly<Record<string, ApprovalAction>> = {
  AUTH_REQUIRED: 'sign_in', POSTONA_RESV_AUTH_REQUIRED: 'sign_in',
  POSTONA_RESV_SERVICE_NOT_ACTIVE: 'forbidden',
  POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED: 'reconnect_x',
  POSTONA_RESV_NOT_FOUND: 'not_found', POSTONA_RESV_ACCOUNT_NOT_FOUND: 'not_found',
  POSTONA_RESV_STALE_REVISION: 'reread', POSTONA_RESV_APPROVAL_NOT_PENDING: 'reread',
  POSTONA_RESV_APPROVAL_GENERATION_CHANGED: 'generation_changed',
  POSTONA_RESV_SLOT_CONFLICT: 'change_time', POSTONA_RESV_DAILY_CAPACITY: 'change_time', POSTONA_RESV_MONTHLY_CAPACITY: 'change_time', POSTONA_RESV_APPROVAL_CAPACITY: 'change_time',
  POSTONA_RESV_CONSENT_REQUIRED: 'show_again',
  POSTONA_RESV_TEXT_INVALID: 'fix_input', POSTONA_RESV_TIME_OUT_OF_RANGE: 'fix_input', POSTONA_RESV_REQUEST_INVALID: 'fix_input', REQUEST_INVALID: 'fix_input',
  POSTONA_RESV_IDEMPOTENCY_CONFLICT: 'fix_input',
  NOT_AVAILABLE: 'later', STORE_UNAVAILABLE: 'later', AUTH_UNAVAILABLE: 'later', POSTONA_RESV_SERVICE_BUSY: 'later', NOT_CONFIGURED: 'later',
};
export function actionOf(code: string, definite: boolean): ApprovalAction {
  if (code === AUTH_REQUIRED) return 'sign_in';
  if (!definite || code === UNCERTAIN) return CODE_ACTION[code] === 'later' ? 'later' : 'uncertain';
  return CODE_ACTION[code] ?? 'uncertain';
}
/** Re-read the candidate before saying anything: a conflict, a refusal of the shown text or time, or an answer that cannot be trusted. */
export const rereads = (action: ApprovalAction) => action === 'reread' || action === 'generation_changed' || action === 'show_again' || action === 'uncertain' || action === 'later' || action === 'change_time';

export const ACTION_TEXT: Record<ApprovalAction, string> = {
  sign_in: 'ログインを確認できませんでした。ログインし直してください。表示していた内容は閉じました。',
  forbidden: 'X自動投稿の利用登録が有効でないため、使えません。表示していた内容は閉じました。',
  reconnect_x: 'Xアカウントの接続を確認できないため、承認できません。アカウント画面でXを接続し直してください。',
  not_found: 'この投稿候補は見つかりませんでした。',
  reread: 'ほかの操作で内容が変わっていました。最新の内容を読み込みました。確認してからもう一度操作してください。',
  generation_changed: 'この投稿候補は、X自動投稿の再開またはXの再接続より前に作られたため、このままでは承認できません。「修正して承認に回し直す」で今の接続の候補にしてから、もう一度承認してください。',
  change_time: '同じ時間帯の投稿が多すぎるか、上限に達しています。日時を変えてください。',
  show_again: '表示していた本文から変わっていたため、承認していません。最新の本文を確認してください。',
  fix_input: '入力内容を確認してください（本文は280文字相当まで、日時は5分後から90日後まで）。',
  later: 'いまはサーバーが応答できません。最新の内容を読み込みました。時間をおいてもう一度お試しください。',
  uncertain: '結果を確認できませんでした。最新の内容を読み込みました。表示が変わっていなければ、もう一度お試しください（同じ操作として扱われ、二重には作られません）。',
};
/** G1 TASK 45 (G2 #9 A17 / A18): an unknown outcome is told apart by what the read back did. */
export const UNCERTAIN_REREAD_OK_TEXT = ACTION_TEXT.uncertain;
export const REREAD_FAILED_TEXT = '結果を確認できず、最新の内容も読み込めませんでした。表示は古いままの可能性があります。「最新の状態を読み込む」で確かめてから操作してください（同じ操作として扱われ、二重には作られません）。';
/** A list that could not be read: it says so, and nothing else (no claim of a read). */
export function readFailedText(action: ApprovalAction): string {
  if (action === 'sign_in' || action === 'forbidden' || action === 'reconnect_x' || action === 'not_found') return ACTION_TEXT[action];
  return 'サーバーに接続できないか、答えを確認できませんでした。時間をおいて「もう一度読み込む」を押してください。';
}
export const MARK_READ_FAILED_TEXT = 'お知らせを既読にできませんでした。時間をおいてもう一度開いてください。';

export const SUBMITTED_TEXT = '承認待ちにしました。承認するまで予約には登録されず、投稿されません。';
export const REVISED_TEXT = '修正しました。もう一度確認してから承認してください。';
export const APPROVED_TEXT = '承認しました。予約に登録しました（「予約の管理」で確認できます。投稿を保証するものではありません）。';
export const REJECTED_TEXT = '却下しました。この候補は投稿されません。';
export const HASH_MISMATCH_TEXT = '表示中の本文を確認できなかったため、承認していません。最新の内容を読み込んでください。';
export const SUBMIT_CONFIRMED_TEXT = '承認に回せていました（サーバーで確認済み）。承認するまで予約には登録されず、投稿されません。';
export const SUBMIT_PENDING_TEXT = '承認に回せたか確認できませんでした。もう一度「承認に回す」を押すと、同じ内容として確認します（二重には作られません）。';

// ---- notifications ------------------------------------------------------------------------------------------------------------
export const NOTIFICATION_KIND_TEXT: Readonly<Record<string, string>> = {
  approval_requested: '投稿候補が承認待ちになりました',
  approval_approved: '投稿候補を承認し、予約に登録しました',
  approval_rejected: '投稿候補を却下しました',
  reservation_changed: '承認した予約の状態が変わりました',
};
export const notificationText = (n: ApprovalNotification) => NOTIFICATION_KIND_TEXT[n.kind] ?? 'お知らせがあります';
export const RESERVATION_STATE_TEXT: Readonly<Record<string, string>> = {
  planned: '予約済み', rescheduled: '日時を変更', published: '投稿済み', failed: '投稿できませんでした', uncertain: '投稿できたか確認できません', cancelled: '取り消し', expired: '期限切れ',
};
/** The badge: rows the person has not opened. Nothing here says a push was delivered. */
export const unreadCount = (rows: readonly ApprovalNotification[]) => rows.filter((n) => n.readAt === null).length;
export const PUSH_NOTE = 'お知らせはアプリを開いたときに表示されます。端末への通知（プッシュ）はまだ送られません。';

export function shortHash(candidate: Pick<Candidate, 'contentSha256'>): string {
  return candidate.contentSha256.slice(0, 8);
}
