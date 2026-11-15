// G5 SOURCE CANDIDATE (2026-11-13, Issue #587 G5-02 task 9; task 10 fixes H4 #331 task 24 P2-2 / P2-3; task 11 H4 #331 task 25 P2-1 / P2-2; task 12 H4 #331 task 26 P2-1 / P2-2; task 13 H4 #331 task 27 P2-2 / P2-3; task 14 H4 #331 task 28 P2): the POSTONA push-device client
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
//   - DEVICE_IN_USE: another account registered this phone's token last, or the installation row belongs to another phone (G5-02 #10 P2-3,
//     #11 P2-1). Never retried automatically; no delivery to this phone for this person until it is resolved. A token moves to another
//     account only on the SAME installation with its device secret (sign in to the other account in the same app installation). After a
//     reinstall / lost secure storage (a new installation id + secret): the same person registers again normally; another person stays
//     DEVICE_IN_USE until the account that holds the token is gone (a provider-side proof is not available yet). For the installation case,
//     make a new installation id + device secret and sync once.
//   - sign-out: unregisterPushDevice(...) BEFORE auth.signOut(); a failure must not block the sign-out (the server stops delivery to a
//     device whose session is gone anyway). Clear the stored version for that person; keep the installation id and the device secret.
//   - "notifications off": set the local flag off FIRST, then unregisterPushDevice(client, installationId, deviceSecret) -- always WITH the
//     device secret: before the first registration has landed it leaves an "off" row on the server, so a delayed first registration is
//     refused (G5-02 #11 P2-2). "on" again: set it on, then syncPushDevice(...) with the version the off answered (or STALE -> recovery).
//   - after any registration answer: syncPushDevice / recoverStaleRegistration read the state again and, if notifications are off NOW,
//     complete the off (unregister with the secret) instead of reporting success: an old success never silently re-enables a phone.
//   - account deletion: unregisterPushDevice(...) first, then the deletion.
//   - PUSH_DEVICES_STOPPED / PUSH_BUSY: try again later (at the next app start), never in a loop.
//   - (G5-02 #12 P2-1) 'pending_proof' (or 'unchanged' with device.status 'pending'): the phone is NOT a delivery target yet. The server's
//     push worker sends a data-only push to that token carrying { kind: 'postona_push_proof', installation_id, nonce }. On receiving it,
//     call confirmPushDevice(client, readCurrent, push): it answers only for THIS installation's id and only while notifications are on
//     now. A token nobody has proven, or another person's, always goes this way; the person's own proven token and the same installation
//     handed over with its device secret are active at once. Never answer a proof for another installation id; never show the nonce.
//   - DEVICE_LIMIT on register / 'recorded': false on unregister (G5-02 #12 P2-2): the person's history is full; nothing is delivered to a
//     new installation until old rows age out (1 day) -- try again later.
//   - (G5-02 #13 P2-2) PROOF_STALE / PROOF_EXPIRED on a proof answer: the nonce belongs to another session or generation, or the pending
//     registration expired; nothing to answer -- the next syncPushDevice registers again (a new pending registration, a new nonce).
//   - (G5-02 #14 P2) "notifications on" is an explicit act of the person, recorded by the server: ONLY when the person turns
//     notifications on (the toggle, the first permission grant, or choosing "on" for an account newly signed in on this phone) call
//     enablePushDevice(client, installationId, deviceSecret) and put the answered onGrant into the state readCurrent() returns, then
//     syncPushDevice(...). The grant is one-time, 10 minutes, bound to this installation, device secret, session and generation. A
//     registration that turns this installation on for this person -- its first, after its "off" row, after the row was pruned or never
//     recorded, after another account held it -- answers ENABLE_REQUIRED without it. Never call enablePushDevice from a background sync,
//     a retry, a session refresh or an app start: a refreshed session authorizes nothing. Any "off" deletes the grant.
//   - (G5-02 #15) "off" always lands as this person's own 'unregistered' row with a new registration_version, also when the server had
//     already revoked it for another reason (signed out, stopped, provider receipt, proof expired, ...): a sync from the version before
//     is STALE_REGISTRATION, one from the new version needs the explicit "on" (ENABLE_REQUIRED) -- never re-register silently.

export type PushPlatform = 'ios' | 'android';
export type PushDevice = {
  installation_id: string;
  platform: PushPlatform;
  status: 'active' | 'pending' | 'revoked';
  registration_version: number;
  revoked_reason: string | null;
  this_session: boolean;
  deliverable: boolean;
  created_at: string;
  updated_at: string;
};
export type PushFailureClass = 'auth' | 'forbidden' | 'workspace' | 'stale' | 'in_use' | 'limit' | 'invalid' | 'proof' | 'enable' | 'unavailable';
export type PushFailure = { ok: false; class: PushFailureClass; status: string; registration_version?: number | null; reason?: string };

// every refusal the three RPCs answer, and how the app should treat it
export const PUSH_STATUS_CLASS: Readonly<Record<string, PushFailureClass>> = {
  AUTH_REQUIRED: 'auth', SESSION_REVOKED: 'auth', SESSION_EXPIRED: 'auth', ACCOUNT_LIFECYCLE_AUTH_REQUIRED: 'auth',
  ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND: 'forbidden', ACCOUNT_LOCKED: 'forbidden', ACCOUNT_DELETION_IN_PROGRESS: 'forbidden',
  SERVICE_NOT_REGISTERED: 'forbidden', SERVICE_NOT_ACTIVE: 'forbidden', SERVICE_DELETION_IN_PROGRESS: 'forbidden',
  WORKSPACE_REQUIRED: 'workspace', OWN_WORKSPACE_CONFLICT: 'forbidden', WORKSPACE_OWNER_UNKNOWN: 'forbidden',
  STALE_REGISTRATION: 'stale', DEVICE_IN_USE: 'in_use', DEVICE_LIMIT: 'limit', INVALID_INPUT: 'invalid',
  PROOF_NOT_PENDING: 'proof', PROOF_EXPIRED: 'proof', PROOF_INVALID: 'proof', PROOF_STALE: 'proof', ENABLE_REQUIRED: 'enable',
  PUSH_DEVICES_STOPPED: 'unavailable', PUSH_BUSY: 'unavailable', ACCOUNT_LIFECYCLE_BUSY: 'unavailable', ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE: 'unavailable',
};

// the shapes the server accepts (Expo push tokens; a base64url device secret of at least 32 bytes)
export const PUSH_TOKEN_PATTERN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{16,64}\]$/;
export const DEVICE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
export const PROOF_NONCE_PATTERN = /^[0-9a-f]{64}$/;
export const ON_GRANT_PATTERN = /^[0-9a-f]{64}$/;

// a new device secret: 32 random bytes, base64url (call once per installation; keep it in secure storage)
export function newDeviceSecret(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type RpcClient = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string } | null }> };
type Answer = { status: string; device?: PushDevice; registration_version?: number | null; delivery?: string; devices?: PushDevice[]; recorded?: boolean; reason?: string; on_grant?: string; expires_at?: string };

function failure(a: Answer | null, error: { code?: string } | null): PushFailure {
  if (error) return { ok: false, class: error.code === '42501' || error.code === 'PGRST301' ? 'auth' : 'unavailable', status: `HTTP:${error.code ?? 'unknown'}` };
  const status = a?.status ?? 'UNKNOWN';
  return { ok: false, class: PUSH_STATUS_CLASS[status] ?? 'unavailable', status, ...(a && 'registration_version' in a ? { registration_version: a.registration_version ?? null } : {}),
    ...(a && typeof a.reason === 'string' ? { reason: a.reason } : {}) };
}

export type RegisterInput = { installationId: string; deviceSecret: string; platform: PushPlatform; pushToken: string; expectedVersion: number | null; proofNonce?: string; onGrant?: string };
// 'pending_proof' is not a failure, and not deliverable: see the lifecycle above
export type Registered = { ok: true; status: 'registered' | 'unchanged' | 'pending_proof'; device: PushDevice };
// the data-only push the worker sends for a pending registration
export type ProofPush = { kind: 'postona_push_proof'; installation_id: string; nonce: string };
// the app's state for this installation, read at the moment of the call (never a value captured earlier)
export type CurrentDeviceState = RegisterInput & { notificationsEnabled: boolean };
export type Skipped = { ok: true; status: 'disabled' | 'removed' };

// one registration, exactly as given (no retry of any kind)
export async function registerPushDevice(client: RpcClient, input: RegisterInput): Promise<Registered | PushFailure> {
  if (!PUSH_TOKEN_PATTERN.test(input.pushToken) || !DEVICE_SECRET_PATTERN.test(input.deviceSecret)
      || (input.proofNonce !== undefined && !PROOF_NONCE_PATTERN.test(input.proofNonce))
      || (input.onGrant !== undefined && !ON_GRANT_PATTERN.test(input.onGrant))) return { ok: false, class: 'invalid', status: 'INVALID_INPUT' };
  const r = await client.rpc('postona_push_device_register', {
    p_installation_id: input.installationId, p_device_secret: input.deviceSecret, p_platform: input.platform, p_push_token: input.pushToken,
    p_expected_version: input.expectedVersion, ...(input.proofNonce !== undefined ? { p_proof_nonce: input.proofNonce } : {}),
    ...(input.onGrant !== undefined ? { p_on_grant: input.onGrant } : {}),
  });
  const a = r.data as Answer | null;
  if (!r.error && (a?.status === 'registered' || a?.status === 'unchanged' || a?.status === 'pending_proof') && a.device) return { ok: true, status: a.status, device: a.device };
  return failure(a, r.error);
}

// (G5-02 #10 P2-2) one registration from the state read NOW. STALE_REGISTRATION (and every other refusal) goes back to the caller: nothing
// is re-sent here, so an older call can never overwrite a newer "off" or a newer token.
export async function syncPushDevice(client: RpcClient, readCurrent: () => Promise<CurrentDeviceState>): Promise<Registered | Skipped | PushFailure> {
  const s = await readCurrent();
  if (!s.notificationsEnabled) return { ok: true, status: 'disabled' };
  return keepOffAfter(client, readCurrent, await registerPushDevice(client, s));
}

// (G5-02 #11 P2-2) a registration answered while (or after) the person turned notifications off: complete the off now, in this session
async function keepOffAfter(client: RpcClient, readCurrent: () => Promise<CurrentDeviceState>, r: Registered | PushFailure): Promise<Registered | Skipped | PushFailure> {
  if (!r.ok) return r;
  const now = await readCurrent();
  if (now.notificationsEnabled) return r;
  const off = await unregisterPushDevice(client, now.installationId, now.deviceSecret);
  return off.ok ? { ok: true, status: 'disabled' } : off;
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
  return keepOffAfter(client, readCurrent, await registerPushDevice(client, { ...s, expectedVersion: row ? row.registration_version : null }));
}

// (G5-02 #12 P2-1) the proof push for a pending registration: answered only for this installation, only while notifications are on now,
// with the state read now; an old success after "off" is completed as off (as every registration answer)
export async function confirmPushDevice(client: RpcClient, readCurrent: () => Promise<CurrentDeviceState>, push: ProofPush): Promise<Registered | Skipped | PushFailure | { ok: true; status: 'ignored' }> {
  const s = await readCurrent();
  if (push.kind !== 'postona_push_proof' || push.installation_id !== s.installationId || !PROOF_NONCE_PATTERN.test(push.nonce)) return { ok: true, status: 'ignored' };
  if (!s.notificationsEnabled) return { ok: true, status: 'disabled' };
  return keepOffAfter(client, readCurrent, await registerPushDevice(client, { ...s, onGrant: undefined, proofNonce: push.nonce }));
}

// with the device secret, "off" is kept on the server even before the first registration (G5-02 #11 P2-2); without it, only an existing row
export async function unregisterPushDevice(client: RpcClient, installationId: string, deviceSecret?: string): Promise<{ ok: true; status: 'unregistered' | 'not_registered'; recorded?: boolean; device?: PushDevice } | PushFailure> {
  if (deviceSecret !== undefined && !DEVICE_SECRET_PATTERN.test(deviceSecret)) return { ok: false, class: 'invalid', status: 'INVALID_INPUT' };
  const r = await client.rpc('postona_push_device_unregister', { p_installation_id: installationId, p_device_secret: deviceSecret ?? null });
  const a = r.data as Answer | null;
  if (!r.error && (a?.status === 'unregistered' || a?.status === 'not_registered')) return { ok: true, status: a.status, ...(a.recorded !== undefined ? { recorded: a.recorded } : {}), ...(a.device ? { device: a.device } : {}) };
  return failure(a, r.error);
}

// (G5-02 #14 P2) the person's explicit "notifications on" for this installation: a one-time ON grant for its next registration. Call it
// ONLY from that user action (see the lifecycle above); keep the grant in memory for the registration that follows, never store it.
export async function enablePushDevice(client: RpcClient, installationId: string, deviceSecret: string): Promise<{ ok: true; status: 'enabled'; onGrant: string; expiresAt: string } | PushFailure> {
  if (!DEVICE_SECRET_PATTERN.test(deviceSecret)) return { ok: false, class: 'invalid', status: 'INVALID_INPUT' };
  const r = await client.rpc('postona_push_device_enable', { p_installation_id: installationId, p_device_secret: deviceSecret });
  const a = r.data as Answer | null;
  if (!r.error && a?.status === 'enabled' && typeof a.on_grant === 'string' && ON_GRANT_PATTERN.test(a.on_grant)) {
    return { ok: true, status: 'enabled', onGrant: a.on_grant, expiresAt: a.expires_at ?? '' };
  }
  return failure(a, r.error);
}

export async function listPushDevices(client: RpcClient): Promise<{ ok: true; delivery: string; devices: PushDevice[] } | PushFailure> {
  const r = await client.rpc('postona_push_device_list');
  const a = r.data as Answer | null;
  if (!r.error && a?.status === 'ok') return { ok: true, delivery: a.delivery ?? 'UNKNOWN', devices: a.devices ?? [] };
  return failure(a, r.error);
}
