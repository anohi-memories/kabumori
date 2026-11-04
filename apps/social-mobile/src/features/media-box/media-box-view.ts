// G1 TASK 43: what the media box (素材BOX) screen says and checks before anything is sent. Pure: the hook keeps the state, G5's
// client (media-box-client.ts, a copy of supabase/candidates/postona_personal_media_box/client.ts) talks to the server.
import { MEDIA_TYPES, type MediaFailure, type MediaFailureClass, type MediaKind } from './media-box-client.ts';

/** Why the screen offers nothing: each is decided before any request. */
export type MediaBlock =
  | 'off' | 'preview' | 'unconfigured' | 'signed_out' | 'relogin'
  | 'workspace_preparing' | 'workspace_unavailable' | 'service_inactive' | 'not_available';

export const MEDIA_BLOCK_TEXT: Record<MediaBlock, string> = {
  off: '素材BOXはまだ使えません。準備ができるまで、画像や動画は保存されません。',
  preview: 'サンプル表示では素材BOXは使えません。ログインすると、ご自身の素材を保存できます。',
  unconfigured: 'サーバーの設定を確認できないため、素材BOXは使えません。',
  signed_out: 'ログインが確認できないため、素材BOXは使えません。ログインし直してください。',
  relogin: 'ログインの有効期限が切れたため、素材BOXは使えません。設定画面からログアウトして、もう一度ログインしてください。',
  workspace_preparing: 'ご自身の個人ワークスペースを準備しています。準備ができると素材BOXを使えます。',
  workspace_unavailable: 'いまは個人ワークスペースを確認できないため、素材BOXは使えません。時間をおいてもう一度開いてください。',
  service_inactive: 'X自動投稿の利用登録が有効でないため、素材BOXは使えません。',
  not_available: 'このアカウントでは素材BOXは使えません。',
};

/** The personal workspace view (personal-workspace-provider.tsx) as the box sees it: only 'ready' opens it. */
export function workspaceBlock(kind: string): MediaBlock | null {
  if (kind === 'ready') return null;
  if (kind === 'idle' || kind === 'preparing') return 'workspace_preparing';
  if (kind === 'relogin') return 'relogin';
  if (kind === 'service_inactive') return 'service_inactive';
  if (kind === 'not_available' || kind === 'off' || kind === 'support') return 'not_available';
  return 'workspace_unavailable';
}

const MIB = 1024 * 1024;
const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', mp4: 'video/mp4', mov: 'video/quicktime',
};
export const UNSUPPORTED_TEXT = 'この形式の素材は保存できません（JPEG・PNG・WebP・HEIC の画像、MP4・MOV の動画に対応しています）。';
export const SIZE_UNKNOWN_TEXT = 'ファイルの大きさを確認できないため、保存できません。';
export const sizeLimitText = (kind: MediaKind) => (kind === 'image' ? '画像は 20MB まで保存できます。' : '動画は 50MB まで保存できます。');

/**
 * A picked file, checked as G5's server will check it. The type is the server's exact string: the picker's own when it names one the
 * server takes, else the file name's extension; anything else is refused here, before a request.
 */
export function checkPicked(file: { name: string; mimeType: string | null; size: number | null }): { ok: true; contentType: string; kind: MediaKind } | { ok: false; text: string } {
  const named = file.mimeType?.trim().toLowerCase() ?? '';
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const contentType = MEDIA_TYPES[named] ? named : named === '' || named === 'application/octet-stream' ? (EXTENSION_TYPES[extension] ?? '') : '';
  const type = MEDIA_TYPES[contentType];
  if (!type) return { ok: false, text: UNSUPPORTED_TEXT };
  if (file.size === null || !Number.isSafeInteger(file.size) || file.size <= 0) return { ok: false, text: SIZE_UNKNOWN_TEXT };
  if (file.size > type.maxBytes) return { ok: false, text: sizeLimitText(type.kind) };
  return { ok: true, contentType, kind: type.kind };
}

export function sizeLabel(bytes: number): string {
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${bytes}B`;
}

/** These answers drop everything the screen holds for the person (G5 contract §4.6): the list, the pending adds and their bytes. */
export function dropsCache(failure: MediaFailure): boolean {
  return failure.class === 'auth' || failure.class === 'forbidden' || failure.class === 'workspace';
}

/** Only these may be asked again with the same request id (G5 contract §4.2); every other answer is final for that file. */
export function isRetryable(failure: MediaFailure): boolean {
  return failure.class === 'unavailable';
}

const CLASS_TEXT: Record<MediaFailureClass, string> = {
  auth: 'ログインを確認できませんでした。ログインし直してください。',
  forbidden: 'いまは素材BOXを使えません（利用登録またはアカウントの状態を確認してください）。表示していた素材は閉じました。',
  workspace: 'ご自身の個人ワークスペースを準備しています。準備ができてから、もう一度お試しください。',
  not_found: 'この素材は見つかりませんでした。すでに削除されている可能性があります。',
  conflict: '保存の途中で状態が変わったため、完了できませんでした。',
  too_large: '素材が大きすぎるため保存できません（画像は 20MB、動画は 50MB まで）。',
  unsupported: UNSUPPORTED_TEXT,
  invalid: 'ファイルの内容を確認できないため、保存できませんでした。',
  unavailable: 'サーバーに接続できませんでした。',
};
const STATUS_TEXT: Readonly<Record<string, string>> = {
  MEDIA_QUOTA_EXCEEDED: '素材BOXの上限（200件、合計 2GB、同時に 10 件まで）に達しているため保存できません。不要な素材を削除してからお試しください。',
  MEDIA_UPLOAD_EXPIRED: '保存の受付時間が過ぎました。もう一度素材を選んでください。',
  MEDIA_OBJECT_MISMATCH: '送ったファイルが、選んだファイルの情報と一致しませんでした。もう一度素材を選んでください。',
  MEDIA_TOO_LARGE: CLASS_TEXT.too_large,
  MEDIA_TYPE_UNSUPPORTED: UNSUPPORTED_TEXT,
  WORKSPACE_REQUIRED: CLASS_TEXT.workspace,
};

/** What the screen says for an answer; a retryable one adds what the retry button does. */
export function failureText(failure: MediaFailure): string {
  const text = STATUS_TEXT[failure.status] ?? CLASS_TEXT[failure.class];
  return isRetryable(failure) ? `${text}「もう一度送る」で、同じ素材として続きから送り直します（二重には保存されません）。` : text;
}

export const ADDED_TEXT = '素材を保存しました（サーバーで確認済み）。';
export const DELETED_TEXT = '素材を削除しました（保存領域の解放もサーバーで確認済み）。';
export const AWAITING_PURGE_TEXT = '素材を削除しました。保存領域の解放はまだ確認できていません（解放されるまで上限に数えられます）。しばらくしてから「解放を確認する」を押してください。';
export const DELETE_FAILED_TEXT = '削除を完了できませんでした。';
