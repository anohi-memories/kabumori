// HTTP layer of `account-delete`: routing and the real adapters of the common-account lifecycle boundary
// (lifecycle_logic.ts). SOURCE CANDIDATE -- not deployed. Keep platform JWT verification ON.
//
// Routes (POST, JSON body {action}):
//   preview                -> read-only state for the confirmation screens
//   withdraw_kabumori      -> かぶモリの利用を終了 (the login and other services stay)
//   delete_common_account  -> 共通アカウントを削除 (the whole person, lifecycle-ordered)
// Anything else -- including the legacy call with no body, which used to hard-delete the login -- is
// refused with ACTION_REQUIRED before any request leaves this function.
//
// Who sees what: the person's own token goes only to Auth's /user and /logout and to the X saga's own
// function (which re-verifies it). The service role key goes only to PostgREST RPCs, the Storage API and
// the Auth Admin API. Nothing is logged.
import { appleConfigFrom, revokeAppleGrant } from '../social-mobile-account-delete/apple_revoke.ts';
import { CONFIRMATION as X_DELETE_CONFIRMATION } from '../social-mobile-account-delete/delete_logic.ts';
import {
  handleDeleteCommonAccount,
  handlePreview,
  handleWithdrawKabumori,
  type LifecycleDeps,
  type LifecycleRpcName,
  type RpcResult,
  type XCleanupOutcome,
} from './lifecycle_logic.ts';

const RPC_NAMES: Record<LifecycleRpcName, string> = {
  release_gate: 'common_account_deletion_release_gate',
  eligibility: 'common_account_deletion_eligibility',
  withdraw_kabumori: 'withdraw_kabumori_service',
  begin_service_deletion: 'begin_service_deletion',
  finish_service_deletion: 'finish_service_deletion',
  begin_account_deletion: 'begin_common_account_deletion',
  claim: 'claim_common_account_deletion',
  renew: 'renew_common_account_deletion_claim',
  release: 'release_common_account_deletion_claim',
  owned_checkpoint: 'set_owned_common_account_deletion_checkpoint',
  owned_prepare: 'prepare_owned_common_account_auth_delete',
  begin_external_step: 'begin_common_account_deletion_external_step',
  settle_external_step: 'settle_common_account_deletion_external_step',
  storage_objects: 'common_account_deletion_storage_objects',
  complete: 'complete_common_account_deletion',
  record_error: 'record_common_account_deletion_error',
};

/** The existing X deletion saga, reached as the X app reaches it. */
export const X_DELETION_FUNCTION = 'social-mobile-account-delete';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const json = (body: unknown, status: number) => Response.json(body, { status });

/** Maps the X saga's fixed error codes onto the adapter's outcomes; anything unknown is a failure. */
export function xOutcomeOf(status: number, body: unknown): XCleanupOutcome {
  const data = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  if (status >= 200 && status < 300 && data.ok === true) {
    return data.login_deleted === false ? 'done' : data.login_deleted === true ? 'login_deleted' : 'failed';
  }
  const error = typeof data.error === 'string' ? data.error : '';
  if (error === 'DELETION_IN_PROGRESS') return 'in_progress';
  if (error === 'SCOPE_CHANGED' || error === 'SCOPE_REQUIRED') return 'scope_refused';
  if (error.startsWith('DELETION_BLOCKED_') || error === 'DELETION_OPERATOR_REQUIRED') return 'blocked';
  return 'failed';
}

export function createHandler(env: { get: (name: string) => string | undefined }, fetchImpl: FetchLike = fetch) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
    const body = await req.json().catch(() => null) as { action?: unknown } | null;
    const action = body?.action;
    if (action !== 'preview' && action !== 'withdraw_kabumori' && action !== 'delete_common_account') {
      return json({ ok: false, error: 'ACTION_REQUIRED' }, 400);
    }
    const supabaseUrl = env.get('SUPABASE_URL');
    const anonKey = env.get('SUPABASE_ANON_KEY');
    const serviceKey = env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !anonKey || !serviceKey) {
      // Deliberately does not say which value is missing.
      return json({ ok: false, error: 'FAILED' }, 500);
    }
    const apple = appleConfigFrom((name) => env.get(name));
    const service = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
    const asPerson = (token: string) => ({ apikey: anonKey, Authorization: `Bearer ${token}` });
    const adminUser = (userId: string) => `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`;
    const callX = async (token: string, payload: Record<string, unknown>) => {
      const response = await fetchImpl(`${supabaseUrl}/functions/v1/${X_DELETION_FUNCTION}`, {
        method: 'POST',
        headers: { ...asPerson(token), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };

    const deps: LifecycleDeps = {
      getUser: async (token) => {
        const response = await fetchImpl(`${supabaseUrl}/auth/v1/user`, { headers: asPerson(token) });
        if (!response.ok) return null;
        const user = await response.json() as { id?: unknown; identities?: { provider?: unknown; id?: unknown }[] };
        if (typeof user.id !== 'string' || !user.id) return null;
        const identities = Array.isArray(user.identities) ? user.identities : [];
        const providers = identities.map((identity) => identity.provider).filter((value): value is string => typeof value === 'string');
        const appleSubjects = identities.filter((identity) => identity.provider === 'apple' && typeof identity.id === 'string').map((identity) => identity.id as string);
        return { id: user.id, providers, appleSubjects };
      },
      rpc: async (name, args): Promise<RpcResult> => {
        const response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${RPC_NAMES[name]}`, {
          method: 'POST',
          headers: { ...service, 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        });
        // A database error message is never read: only the answer of a successful call is.
        if (!response.ok) return { ok: false };
        return { ok: true, data: await response.json().catch(() => null) };
      },
      revokeSessions: async (token) => {
        const response = await fetchImpl(`${supabaseUrl}/auth/v1/logout?scope=global`, { method: 'POST', headers: asPerson(token) });
        return response.status === 204 || response.status === 200;
      },
      removeStorageObjects: async (bucketId, names) => {
        const response = await fetchImpl(`${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucketId)}`, {
          method: 'DELETE',
          headers: { ...service, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: names }),
        });
        // The caller lists again: this only has to say whether Storage accepted the request.
        return response.ok;
      },
      revokeApple: apple ? (code, subjects) => revokeAppleGrant(apple, code, subjects, Math.floor(Date.now() / 1000), fetchImpl) : null,
      x: {
        preview: async (token) => {
          const { status, body: answer } = await callX(token, { action: 'preview' });
          const data = typeof answer === 'object' && answer !== null ? answer as Record<string, unknown> : {};
          if (status !== 200 || data.ok !== true || typeof data.scope !== 'string') return null;
          return { scope: data.scope, state: typeof data.state === 'string' ? data.state : 'none' };
        },
        run: async (token) => {
          const { status, body: answer } = await callX(token, {
            action: 'delete', confirmation: X_DELETE_CONFIRMATION, expected_scope: 'social_only',
          });
          return xOutcomeOf(status, answer);
        },
      },
      deleteLogin: async (userId) => {
        const response = await fetchImpl(adminUser(userId), { method: 'DELETE', headers: service });
        await response.body?.cancel();
        if (response.ok) return 'deleted';
        return response.status === 404 ? 'not_found' : 'failed';
      },
      loginState: async (userId) => {
        const response = await fetchImpl(adminUser(userId), { headers: service });
        await response.body?.cancel();
        if (response.ok) return 'present';
        return response.status === 404 ? 'absent' : 'unknown';
      },
      nowSeconds: () => Math.floor(Date.now() / 1000),
    };

    const authorization = req.headers.get('Authorization');
    try {
      const result = action === 'preview'
        ? await handlePreview({ authorization }, deps)
        : action === 'withdraw_kabumori'
          ? await handleWithdrawKabumori({ authorization, body }, deps)
          : await handleDeleteCommonAccount({ authorization, body }, deps);
      return json(result.body, result.status);
    } catch {
      return json({ ok: false, error: 'FAILED' }, 500);
    }
  };
}
