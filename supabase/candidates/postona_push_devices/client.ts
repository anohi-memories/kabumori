// G5 SOURCE CANDIDATE (2026-11-13, Issue #587 G5-02 task 9): the POSTONA push-device client contract, dependency-free.
// G1 may copy this file into the app (or re-implement it to the same contract, docs/common-account/g5-02-09-push-device-contract.md).
// It needs only `client.rpc(fn, args)` from supabase-js v2. The person is whoever the client's session is: the app never sends a user id,
// a workspace id or a session id. The push token is a SECRET: this module never logs it, never puts it in an error, and the server never
// answers it back.
//
// App lifecycle (the contract):
//   - installation id: one random UUID per app installation, kept in secure storage; never shown, never sent anywhere else.
//   - after every sign-in and on every app start while signed in: syncPushDevice(client, { installationId, platform, pushToken: <the token
//     the OS gives NOW>, expectedVersion: <the version stored for THIS person, or null> }); store the answered registration_version per
//     person. The answer 'unchanged' is normal (nothing to do).
//   - when the OS gives a new token: the same call with the new token.
//   - sign-out: unregisterPushDevice(...) BEFORE auth.signOut(); a failure must not block the sign-out (the server stops delivery to a
//     device whose session is gone anyway). Clear the stored version for that person.
//   - "notifications off" in the app: unregisterPushDevice(...); "on" again: syncPushDevice(...) with the stored version.
//   - account deletion: unregisterPushDevice(...) first, then the deletion.
//   - never queue a register request for later: a request built before a sign-out / restart is refused by the server (its session or
//     version is stale); build a new one from the current token instead.

export type PushPlatform = 'ios' | 'android';
export type PushDevice = {
  installation_id: string;
  platform: PushPlatform;
  status: 'active' | 'revoked';
  registration_version: number;
  revoked_reason: string | null;
  this_session: boolean;
  deliverable: boolean;
  created_at: string;
  updated_at: string;
};
export type PushFailureClass = 'auth' | 'forbidden' | 'workspace' | 'stale' | 'limit' | 'invalid' | 'unavailable';
export type PushFailure = { ok: false; class: PushFailureClass; status: string; registration_version?: number | null };

// every refusal the three RPCs answer, and how the app should treat it
export const PUSH_STATUS_CLASS: Readonly<Record<string, PushFailureClass>> = {
  AUTH_REQUIRED: 'auth', SESSION_REVOKED: 'auth', SESSION_EXPIRED: 'auth', ACCOUNT_LIFECYCLE_AUTH_REQUIRED: 'auth',
  ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND: 'forbidden', ACCOUNT_LOCKED: 'forbidden', ACCOUNT_DELETION_IN_PROGRESS: 'forbidden',
  SERVICE_NOT_REGISTERED: 'forbidden', SERVICE_NOT_ACTIVE: 'forbidden', SERVICE_DELETION_IN_PROGRESS: 'forbidden',
  WORKSPACE_REQUIRED: 'workspace', OWN_WORKSPACE_CONFLICT: 'forbidden', WORKSPACE_OWNER_UNKNOWN: 'forbidden',
  STALE_REGISTRATION: 'stale', DEVICE_LIMIT: 'limit', INVALID_INPUT: 'invalid',
  ACCOUNT_LIFECYCLE_BUSY: 'unavailable', ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE: 'unavailable',
};

// the token shape the server accepts (Expo push tokens)
export const PUSH_TOKEN_PATTERN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{16,64}\]$/;

type RpcClient = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string } | null }> };
type Answer = { status: string; device?: PushDevice; registration_version?: number | null; delivery?: string; devices?: PushDevice[] };

function failure(a: Answer | null, error: { code?: string } | null): PushFailure {
  if (error) return { ok: false, class: error.code === '42501' || error.code === 'PGRST301' ? 'auth' : 'unavailable', status: `HTTP:${error.code ?? 'unknown'}` };
  const status = a?.status ?? 'UNKNOWN';
  return { ok: false, class: PUSH_STATUS_CLASS[status] ?? 'unavailable', status, ...(a && 'registration_version' in a ? { registration_version: a.registration_version ?? null } : {}) };
}

export type RegisterInput = { installationId: string; platform: PushPlatform; pushToken: string; expectedVersion: number | null };
export type Registered = { ok: true; status: 'registered' | 'unchanged'; device: PushDevice };

export async function registerPushDevice(client: RpcClient, input: RegisterInput): Promise<Registered | PushFailure> {
  if (!PUSH_TOKEN_PATTERN.test(input.pushToken)) return { ok: false, class: 'invalid', status: 'INVALID_INPUT' };
  const r = await client.rpc('postona_push_device_register', {
    p_installation_id: input.installationId, p_platform: input.platform, p_push_token: input.pushToken, p_expected_version: input.expectedVersion,
  });
  const a = r.data as Answer | null;
  if (!r.error && (a?.status === 'registered' || a?.status === 'unchanged') && a.device) return { ok: true, status: a.status, device: a.device };
  return failure(a, r.error);
}

// register with the version stored for this person; when the server says the app's version is not the row's (the app lost or never had
// it), retry ONCE with the server's version -- only ever call this with the token the OS gives now, never with a queued one
export async function syncPushDevice(client: RpcClient, input: RegisterInput): Promise<Registered | PushFailure> {
  const first = await registerPushDevice(client, input);
  if (first.ok || first.status !== 'STALE_REGISTRATION' || first.registration_version === undefined) return first;
  return registerPushDevice(client, { ...input, expectedVersion: first.registration_version ?? null });
}

export async function unregisterPushDevice(client: RpcClient, installationId: string): Promise<{ ok: true; status: 'unregistered' | 'not_registered' } | PushFailure> {
  const r = await client.rpc('postona_push_device_unregister', { p_installation_id: installationId });
  const a = r.data as Answer | null;
  if (!r.error && (a?.status === 'unregistered' || a?.status === 'not_registered')) return { ok: true, status: a.status };
  return failure(a, r.error);
}

export async function listPushDevices(client: RpcClient): Promise<{ ok: true; delivery: string; devices: PushDevice[] } | PushFailure> {
  const r = await client.rpc('postona_push_device_list');
  const a = r.data as Answer | null;
  if (!r.error && a?.status === 'ok') return { ok: true, delivery: a.delivery ?? 'UNKNOWN', devices: a.devices ?? [] };
  return failure(a, r.error);
}
