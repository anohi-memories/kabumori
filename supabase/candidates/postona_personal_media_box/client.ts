// G5 SOURCE CANDIDATE (2026-11-04, Issue #587 G5-02 task 5): the media box ("素材BOX") client contract, dependency-free.
// G1 may copy this file into the app (or re-implement it to the same contract, docs/common-account/g5-02-05-personal-media-box-contract.md).
// It needs only what supabase-js v2 already gives the app: `client.rpc(fn, args)` and `client.storage.from(bucket)`. The person is whoever the
// client's session is: no workspace id, brand id, user id or object path is ever sent by the app except the path the server chose.

export type MediaKind = 'image' | 'video';
export type MediaStatus = 'pending' | 'ready' | 'deleted';
export type MediaAsset = {
  id: string;
  kind: MediaKind;
  content_type: string;
  display_name: string;
  bytes: number;
  status: MediaStatus;
  created_at: string;
  ready_at: string | null;
  bucket: string;
  object_path: string;
};
export type MediaCursor = { before_created_at: string; before_id: string };
// how the app should treat a refusal (the HTTP class it corresponds to)
export type MediaFailureClass = 'auth' | 'forbidden' | 'workspace' | 'not_found' | 'conflict' | 'too_large' | 'unsupported' | 'invalid' | 'unavailable';
export type MediaFailure = { ok: false; class: MediaFailureClass; status: string };

export const MEDIA_BUCKET = 'postona-media';
export const MEDIA_TYPES: Readonly<Record<string, { kind: MediaKind; maxBytes: number }>> = {
  'image/jpeg': { kind: 'image', maxBytes: 20971520 },
  'image/png': { kind: 'image', maxBytes: 20971520 },
  'image/webp': { kind: 'image', maxBytes: 20971520 },
  'image/heic': { kind: 'image', maxBytes: 20971520 },
  'video/mp4': { kind: 'video', maxBytes: 52428800 },
  'video/quicktime': { kind: 'video', maxBytes: 52428800 },
};
// a signed read URL lives this long at most (the app asks again when it needs the file again)
export const MEDIA_READ_SECONDS_MAX = 300;

// every status the four RPCs answer, and its class (HTTP-equivalent in the contract: 401 / 403 / 404 / 409 / 413 / 415 / 400 / 503)
export const MEDIA_STATUS_CLASS: Readonly<Record<string, MediaFailureClass>> = {
  AUTH_REQUIRED: 'auth', SESSION_REVOKED: 'auth', SESSION_EXPIRED: 'auth', ACCOUNT_LIFECYCLE_AUTH_REQUIRED: 'auth',
  ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND: 'forbidden', ACCOUNT_LOCKED: 'forbidden', ACCOUNT_DELETION_IN_PROGRESS: 'forbidden',
  SERVICE_NOT_REGISTERED: 'forbidden', SERVICE_NOT_ACTIVE: 'forbidden', SERVICE_DELETION_IN_PROGRESS: 'forbidden',
  WORKSPACE_REQUIRED: 'workspace', OWN_WORKSPACE_CONFLICT: 'forbidden', WORKSPACE_OWNER_UNKNOWN: 'forbidden',
  MEDIA_NOT_FOUND: 'not_found', MEDIA_REQUEST_CONFLICT: 'conflict', MEDIA_QUOTA_EXCEEDED: 'conflict', MEDIA_UPLOAD_EXPIRED: 'conflict',
  MEDIA_OBJECT_MISSING: 'conflict', MEDIA_OBJECT_MISMATCH: 'conflict', MEDIA_TOO_LARGE: 'too_large', MEDIA_TYPE_UNSUPPORTED: 'unsupported',
  MEDIA_INPUT_INVALID: 'invalid', ACCOUNT_LIFECYCLE_BUSY: 'unavailable', ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE: 'unavailable',
};

// the part of supabase-js the contract uses (structural: the app's own client fits)
type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };
type StorageError = { message?: string; statusCode?: string | number; status?: number } | null;
export interface MediaBoxClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
  storage: {
    from(bucket: string): {
      upload(path: string, body: Blob | ArrayBuffer | Uint8Array, options?: { contentType?: string; upsert?: boolean }): PromiseLike<{ data: unknown; error: StorageError }>;
      createSignedUrl(path: string, expiresIn: number): PromiseLike<{ data: { signedUrl: string } | null; error: StorageError }>;
      remove(paths: string[]): PromiseLike<{ data: unknown[] | null; error: StorageError }>;
    };
  };
}

const fail = (status: string, cls?: MediaFailureClass): MediaFailure => ({ ok: false, class: cls ?? MEDIA_STATUS_CLASS[status] ?? 'unavailable', status });
// PostgREST's own refusals (no EXECUTE: the box is stopped or the person is anonymous) and network failures
function rpcFailure(error: { message?: string; code?: string }): MediaFailure {
  if (error.code === '42501') return fail(`RPC_${error.code}`, 'forbidden');
  if (error.code === 'PGRST202' || error.code === '42883') return fail(`RPC_${error.code}`, 'unavailable');
  return fail(`RPC_${error.code ?? 'ERROR'}`, 'unavailable');
}
function storageFailure(error: NonNullable<StorageError>): MediaFailure {
  const code = String(error.statusCode ?? error.status ?? '');
  const cls: MediaFailureClass = code === '403' || code === '401' ? 'forbidden' : code === '404' ? 'not_found' : code === '409' ? 'conflict'
    : code === '413' ? 'too_large' : code === '415' ? 'unsupported' : code === '400' ? 'invalid' : 'unavailable';
  return fail(`STORAGE_${code || 'ERROR'}`, cls);
}
async function call(client: MediaBoxClient, fn: string, args: Record<string, unknown>): Promise<Record<string, unknown> | MediaFailure> {
  let r: RpcResult;
  try {
    r = await client.rpc(fn, args);
  } catch {
    return fail('NETWORK', 'unavailable');
  }
  if (r.error) return rpcFailure(r.error);
  const body = r.data as Record<string, unknown> | null;
  if (!body || typeof body.status !== 'string') return fail('MALFORMED', 'unavailable');
  return body;
}
const isFailure = (x: unknown): x is MediaFailure => typeof x === 'object' && x !== null && (x as MediaFailure).ok === false;

export type AddMediaInput = { name: string; contentType: string; body: Blob | ArrayBuffer | Uint8Array; size: number };
// one press of 素材を追加: begin (the server chooses the path) -> upload the bytes -> complete (the server checks what was stored).
// requestId: one per chosen file, kept until it is ready; a retry with the same requestId never makes a second asset.
export async function addMedia(client: MediaBoxClient, input: AddMediaInput, requestId: string): Promise<{ ok: true; asset: MediaAsset } | MediaFailure> {
  const begun = await call(client, 'postona_media_begin_upload', { p_request_id: requestId, p_file_name: input.name, p_content_type: input.contentType, p_size_bytes: input.size });
  if (isFailure(begun)) return begun;
  if (begun.status === 'ready') return { ok: true, asset: begun.asset as MediaAsset };
  if (begun.status !== 'upload') return fail(String(begun.status));
  const target = begun.upload as { bucket: string; object_path: string; content_type: string };
  let up;
  try {
    up = await client.storage.from(target.bucket).upload(target.object_path, input.body, { contentType: target.content_type, upsert: false });
  } catch {
    return fail('NETWORK', 'unavailable');
  }
  // 409 = the bytes are already there (an earlier try uploaded them): complete decides
  if (up.error && String(up.error.statusCode ?? up.error.status) !== '409') return storageFailure(up.error);
  const done = await call(client, 'postona_media_complete_upload', { p_asset_id: (begun.asset as MediaAsset).id });
  if (isFailure(done)) return done;
  return done.status === 'ready' ? { ok: true, asset: done.asset as MediaAsset } : fail(String(done.status));
}

export async function listMedia(client: MediaBoxClient, limit = 30, cursor: MediaCursor | null = null): Promise<{ ok: true; items: MediaAsset[]; next: MediaCursor | null } | MediaFailure> {
  const r = await call(client, 'postona_media_list', { p_limit: limit, p_before_created_at: cursor?.before_created_at ?? null, p_before_id: cursor?.before_id ?? null });
  if (isFailure(r)) return r;
  if (r.status !== 'ok') return fail(String(r.status));
  return { ok: true, items: r.items as MediaAsset[], next: (r.next as MediaCursor | null) ?? null };
}

// a short-lived URL for <Image> / the video player; never stored, never shared
export async function mediaReadUrl(client: MediaBoxClient, asset: Pick<MediaAsset, 'bucket' | 'object_path'>, seconds = 120): Promise<{ ok: true; url: string } | MediaFailure> {
  const r = await client.storage.from(asset.bucket).createSignedUrl(asset.object_path, Math.max(1, Math.min(seconds, MEDIA_READ_SECONDS_MAX)));
  if (r.error || !r.data) return storageFailure(r.error ?? { statusCode: 404 });
  return { ok: true, url: r.data.signedUrl };
}

// delete: the row first (the asset leaves the list at once), then the object through storage-api; both are safe to retry
export async function deleteMedia(client: MediaBoxClient, assetId: string): Promise<{ ok: true; already: boolean } | MediaFailure> {
  const r = await call(client, 'postona_media_delete', { p_asset_id: assetId });
  if (isFailure(r)) return r;
  if (r.status !== 'deleted') return fail(String(r.status));
  const target = r.remove as { bucket: string; object_path: string };
  const removed = await client.storage.from(target.bucket).remove([target.object_path]);
  if (removed.error) return storageFailure(removed.error);
  return { ok: true, already: r.already === true };
}
