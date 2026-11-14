// G5 SOURCE CANDIDATE (2026-11-13, Issue #587 G5-02 task 9; task 10 fixes H4 #331 task 24 P2-2 / P2-3): the POSTONA push-device client
// contract, dependency-free. G1 may copy this file into the app (or re-implement it to the same contract,
// docs/common-account/g5-02-09-push-device-contract.md). It needs only `client.rpc(fn, args)` from supabase-js v2. The person is whoever
// the client's session is: the app never sends a user id, a workspace id or a session id. The push token and the device secret are
// SECRETS: this module never logs them, never puts them in an error, and the server never answers them back.
//
// App lifecycle (the contract):
//   - per installation, created once and kept in secure storage ACROSS sign-ins: an installation id (random UUID) and a device secret
//     (32 random bytes, base64url, see newDeviceSecret). Both identify the PHONE, not the person; never shown, never sent anywhere else.
//   - after every sign-in and on every app start while signed in: syncPushDevice(client, readCurrent). readCurrent() must read the state
//     AT THAT MOMENT: notifications on/off, the token the OS gives now, the version stored for THIS person. Store the answered
//     registration_version per person. 'unchanged' is normal.
//   - when the OS gives a new token: the same call.
//   - STALE_REGISTRATION: never re-send the same request (G5-02 #10 P2-2). recoverStaleRegistration(client, readCurrent) is a NEW operation:
//     it reads the server's row and the app's state again, does nothing when notifications are off now or the person removed this phone,
//     and otherwise registers the CURRENT token from the server's version.
//   - DEVICE_IN_USE: another account's live registration holds this phone's token, or the installation row belongs to another phone (G5-02
//     #10 P2-3). Never retried automatically. For the token case, the other account must sign out on this phone first (its session then
//     ends and the token can move); for the installation case, make a new installation id + device secret and sync once.
//   - sign-out: unregisterPushDevice(...) BEFORE auth.signOut(); a failure must not block the sign-out (the server stops delivery to a
//     device whose session is gone anyway). Clear the stored version for that person; keep the installation id and the device secret.
//   - "notifications off": set the local flag off FIRST, then unregisterPushDevice(...); "on" again: set it on, then syncPushDevice(...).
//   - account deletion: unregisterPushDevice(...) first, then the deletion.
//   - PUSH_DEVICES_STOPPED / PUSH_BUSY: try again later (at the next app start), never in a loop.

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
export type PushFailureClass = 'auth' | 'forbidden' | 'workspace' | 'stale' | 'in_use' | 'limit' | 'invalid' | 'unavailable';
export type PushFailure = { ok: false; class: PushFailureClass; status: string; registration_version?: number | null };

// every refusal the three RPCs answer, and how the app should treat it
export const PUSH_STATUS_CLASS: Readonly<Record<string, PushFailureClass>> = {
  AUTH_REQUIRED: 'auth', SESSION_REVOKED: 'auth', SESSION_EXPIRED: 'auth', ACCOUNT_LIFECYCLE_AUTH_REQUIRED: 'auth',
  ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND: 'forbidden', ACCOUNT_LOCKED: 'forbidden', ACCOUNT_DELETION_IN_PROGRESS: 'forbidden',
  SERVICE_NOT_REGISTERED: 'forbidden', SERVICE_NOT_ACTIVE: 'forbidden', SERVICE_DELETION_IN_PROGRESS: 'forbidden',
  WORKSPACE_REQUIRED: 'workspace', OWN_WORKSPACE_CONFLICT: 'forbidden', WORKSPACE_OWNER_UNKNOWN: 'forbidden',
  STALE_REGISTRATION: 'stale', DEVICE_IN_USE: 'in_use', DEVICE_LIMIT: 'limit', INVALID_INPUT: 'invalid',
  PUSH_DEVICES_STOPPED: 'unavailable', PUSH_BUSY: 'unavailable', ACCOUNT_LIFECYCLE_BUSY: 'unavailable', ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE: 'unavailable',
};

// the shapes the server accepts (Expo push tokens; a base64url device secret of at least 32 bytes)
export const PUSH_TOKEN_PATTERN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{16,64}\]$/;
export const DEVICE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

// a new device secret: 32 random bytes, base64url (call once per installation; keep it in secure storage)
export function newDeviceSecret(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type RpcClient = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string } | null }> };
type Answer = { status: string; device?: PushDevice; registration_version?: number | null; delivery?: string; devices?: PushDevice[] };

function failure(a: Answer | null, error: { code?: string } | null): PushFailure {
  if (error) return { ok: false, class: error.code === '42501' || error.code === 'PGRST301' ? 'auth' : 'unavailable', status: `HTTP:${error.code ?? 'unknown'}` };
  const status = a?.status ?? 'UNKNOWN';
  return { ok: false, class: PUSH_STATUS_CLASS[status] ?? 'unavailable', status, ...(a && 'registration_version' in a ? { registration_version: a.registration_version ?? null } : {}) };
}

export type RegisterInput = { installationId: string; deviceSecret: string; platform: PushPlatform; pushToken: string; expectedVersion: number | null };
export type Registered = { ok: true; status: 'registered' | 'unchanged'; device: PushDevice };
// the app's state for this installation, read at the moment of the call (never a value captured earlier)
export type CurrentDeviceState = RegisterInput & { notificationsEnabled: boolean };
export type Skipped = { ok: true; status: 'disabled' | 'removed' };

// one registration, exactly as given (no retry of any kind)
export async function registerPushDevice(client: RpcClient, input: RegisterInput): Promise<Registered | PushFailure> {
  if (!PUSH_TOKEN_PATTERN.test(input.pushToken) || !DEVICE_SECRET_PATTERN.test(input.deviceSecret)) return { ok: false, class: 'invalid', status: 'INVALID_INPUT' };
  const r = await client.rpc('postona_push_device_register', {
    p_installation_id: input.installationId, p_device_secret: input.deviceSecret, p_platform: input.platform, p_push_token: input.pushToken,
    p_expected_version: input.expectedVersion,
  });
  const a = r.data as Answer | null;
  if (!r.error && (a?.status === 'registered' || a?.status === 'unchanged') && a.device) return { ok: true, status: a.status, device: a.device };
  return failure(a, r.error);
}

// (G5-02 #10 P2-2) one registration from the state read NOW. STALE_REGISTRATION (and every other refusal) goes back to the caller: nothing
// is re-sent here, so an older call can never overwrite a newer "off" or a newer token.
export async function syncPushDevice(client: RpcClient, readCurrent: () => Promise<CurrentDeviceState>): Promise<Registered | Skipped | PushFailure> {
  const s = await readCurrent();
  if (!s.notificationsEnabled) return { ok: true, status: 'disabled' };
  return registerPushDevice(client, s);
}

// after STALE_REGISTRATION, as a NEW operation: the server's row first, then the app's state AGAIN (after the list). Nothing when
// notifications are off now, or when the person removed this phone (revoked 'unregistered': their last choice wins until they turn
// notifications on again); otherwise the CURRENT token from the server's version. A STALE answer here is returned, not retried.
export async function recoverStaleRegistration(client: RpcClient, readCurrent: () => Promise<CurrentDeviceState>): Promise<Registered | Skipped | PushFailure> {
  const l = await listPushDevices(client);
  if (!l.ok) return l;
  const s = await readCurrent();
  if (!s.notificationsEnabled) return { ok: true, status: 'disabled' };
  const row = l.devices.find((d) => d.installation_id === s.installationId);
  if (row && row.status === 'revoked' && row.revoked_reason === 'unregistered') return { ok: true, status: 'removed' };
  return registerPushDevice(client, { ...s, expectedVersion: row ? row.registration_version : null });
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
