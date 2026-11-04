// G5 SOURCE CANDIDATE (2026-11-04, Issue #587 G5-02 tasks 5 / 6): the media box ("素材BOX") client contract, dependency-free.
// G5-02 #6: an add is begin -> upload to the STAGING key -> storage-api's move onto the FINAL key -> complete; a read is the person's own
// authenticated download (their JWT, checked again on every request); there are no signed URLs (the server refuses to sign).
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

// every status the four RPCs answer, and its class (HTTP-equivalent in the contract: 401 / 403 / 404 / 409 / 413 / 415 / 400 / 503)
export const MEDIA_STATUS_CLASS: Readonly<Record<string, MediaFailureClass>> = {
  AUTH_REQUIRED: 'auth', SESSION_REVOKED: 'auth', SESSION_EXPIRED: 'auth', ACCOUNT_LIFECYCLE_AUTH_REQUIRED: 'auth',
  ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND: 'forbidden', ACCOUNT_LOCKED: 'forbidden', ACCOUNT_DELETION_IN_PROGRESS: 'forbidden',
  SERVICE_NOT_REGISTERED: 'forbidden', SERVICE_NOT_ACTIVE: 'forbidden', SERVICE_DELETION_IN_PROGRESS: 'forbidden',
  WORKSPACE_REQUIRED: 'workspace', OWN_WORKSPACE_CONFLICT: 'forbidden', WORKSPACE_OWNER_UNKNOWN: 'forbidden',
  MEDIA_NOT_FOUND: 'not_found', MEDIA_REQUEST_CONFLICT: 'conflict', MEDIA_QUOTA_EXCEEDED: 'conflict', MEDIA_UPLOAD_EXPIRED: 'conflict',
  MEDIA_OBJECT_MISSING: 'conflict', MEDIA_OBJECT_MISMATCH: 'conflict', MEDIA_MOVE_REQUIRED: 'conflict', MEDIA_TOO_LARGE: 'too_large', MEDIA_TYPE_UNSUPPORTED: 'unsupported',
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
      move(from: string, to: string): PromiseLike<{ data: unknown; error: StorageError }>;
      download(path: string): PromiseLike<{ data: Blob | null; error: StorageError }>;
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
// one press of 素材を追加: begin (the server chooses both keys) -> upload the bytes to the staging key -> move them onto the final key ->
// complete (the server checks what was stored and pins its version).
// requestId: one per chosen file, kept until it is ready; a retry with the same requestId never makes a second asset.
export async function addMedia(client: MediaBoxClient, input: AddMediaInput, requestId: string): Promise<{ ok: true; asset: MediaAsset } | MediaFailure> {
  const begun = await call(client, 'postona_media_begin_upload', { p_request_id: requestId, p_file_name: input.name, p_content_type: input.contentType, p_size_bytes: input.size });
  if (isFailure(begun)) return begun;
  if (begun.status === 'ready') return { ok: true, asset: begun.asset as MediaAsset };
  if (begun.status !== 'upload') return fail(String(begun.status));
  const target = begun.upload as { bucket: string; object_path: string; final_path: string; content_type: string; moved: boolean };
  const code = (e: StorageError) => String(e?.statusCode ?? e?.status ?? '');
  if (!target.moved) {
    try {
      const up = await client.storage.from(target.bucket).upload(target.object_path, input.body, { contentType: target.content_type, upsert: false });
      // 409 = already uploaded to the staging key by an earlier try: the move goes on
      if (up.error && code(up.error) !== '409') return storageFailure(up.error);
      const mv = await client.storage.from(target.bucket).move(target.object_path, target.final_path);
      // 409 = the final key exists already: complete decides
      if (mv.error && code(mv.error) !== '409') return storageFailure(mv.error);
    } catch {
      return fail('NETWORK', 'unavailable');
    }
  }
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

// the bytes, with the person's own session (storage-api's authenticated download; refused the moment the session, the service, the
// workspace or the asset is gone)
export async function mediaDownload(client: MediaBoxClient, asset: Pick<MediaAsset, 'bucket' | 'object_path'>): Promise<{ ok: true; blob: Blob } | MediaFailure> {
  let r;
  try {
    r = await client.storage.from(asset.bucket).download(asset.object_path);
  } catch {
    return fail('NETWORK', 'unavailable');
  }
  if (r.error || !r.data) return storageFailure(r.error ?? { statusCode: 404 });
  return { ok: true, blob: r.data };
}
// for <Image source> / a video player that takes request headers: the same authenticated download, as a URI plus the person's current access
// token (never stored; take a fresh token from the session for each source). storageUrl = `${SUPABASE_URL}/storage/v1`.
export function mediaReadSource(storageUrl: string, accessToken: string, asset: Pick<MediaAsset, 'bucket' | 'object_path'>): { uri: string; headers: Record<string, string> } {
  const path = asset.object_path.split('/').map(encodeURIComponent).join('/');
  return { uri: `${storageUrl}/object/authenticated/${encodeURIComponent(asset.bucket)}/${path}`, headers: { Authorization: `Bearer ${accessToken}` } };
}

// delete: the row first (the asset leaves the list at once), then the object through storage-api; both are safe to retry
export async function deleteMedia(client: MediaBoxClient, assetId: string): Promise<{ ok: true; already: boolean } | MediaFailure> {
  const r = await call(client, 'postona_media_delete', { p_asset_id: assetId });
  if (isFailure(r)) return r;
  if (r.status !== 'deleted') return fail(String(r.status));
  const target = r.remove as { bucket: string; object_paths: string[] };
  const removed = await client.storage.from(target.bucket).remove(target.object_paths);
  if (removed.error) return storageFailure(removed.error);
  return { ok: true, already: r.already === true };
}
