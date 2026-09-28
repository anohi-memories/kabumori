// SOURCE CANDIDATE. Not deployed; independent review is mandatory before deploy.
// See delete_logic.ts for the security model and
// apps/social-mobile/docs/account-lifecycle-phase4.md for the architecture.
// Keep platform JWT verification ON for this function.
import { appleConfigFrom, revokeAppleGrant } from './apple_revoke.ts';
import { handleAccountDeletion, type DeletionDeps, type RpcResult } from './delete_logic.ts';

const RPC_NAMES = {
  begin: 'social_mobile_account_deletion_begin',
  credentials: 'social_mobile_account_deletion_credentials',
  purge: 'social_mobile_account_deletion_purge',
  record: 'social_mobile_account_deletion_record',
} as const;

const X_REVOKE_URL = 'https://api.x.com/2/oauth2/revoke';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return Response.json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const xClientId = Deno.env.get('X_CLIENT_ID');
  const xClientSecret = Deno.env.get('X_CLIENT_SECRET');
  if (!supabaseUrl || !anonKey || !serviceKey || !xClientId || !xClientSecret) {
    // Deliberately does not say which value is missing.
    return Response.json({ ok: false, error: 'FAILED' }, { status: 500 });
  }
  const apple = appleConfigFrom((name) => Deno.env.get(name));
  const service = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  const deps: DeletionDeps = {
    getUser: async (token) => {
      const response = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: anonKey, Authorization: `Bearer ${token}` } });
      if (!response.ok) return null;
      const user = await response.json() as { id?: unknown; identities?: { provider?: unknown; id?: unknown }[] };
      if (typeof user.id !== 'string' || !user.id) return null;
      const identities = user.identities ?? [];
      const providers = identities.map((identity) => identity.provider).filter((value): value is string => typeof value === 'string');
      const appleSubjects = identities.filter((identity) => identity.provider === 'apple' && typeof identity.id === 'string').map((identity) => identity.id as string);
      return { id: user.id, providers, appleSubjects };
    },
    rpc: async (name, args): Promise<RpcResult> => {
      const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${RPC_NAMES[name]}`, {
        method: 'POST',
        headers: { ...service, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      const payload = await response.json().catch(() => null) as { message?: unknown } | null;
      if (response.ok) return { ok: true, data: payload };
      // Only our own fixed exception codes are extracted; the rest of the message is dropped.
      const match = typeof payload?.message === 'string' ? /SOCIAL_MOBILE_DELETION_[A-Z_]+/u.exec(payload.message) : null;
      return { ok: false, code: match ? match[0] : null };
    },
    revokeX: async (token, hint) => {
      const response = await fetch(X_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${btoa(`${xClientId}:${xClientSecret}`)}` },
        body: new URLSearchParams({ token, token_type_hint: hint, client_id: xClientId }).toString(),
      });
      return response.ok;
    },
    revokeApple: apple ? (code, subjects) => revokeAppleGrant(apple, code, subjects, Math.floor(Date.now() / 1000)) : null,
    deleteAuthUser: async (userId) => {
      const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE', headers: service });
      return response.ok || response.status === 404;
    },
    nowSeconds: () => Math.floor(Date.now() / 1000),
  };

  const body = await req.json().catch(() => null);
  try {
    const result = await handleAccountDeletion({ authorization: req.headers.get('Authorization'), body }, deps);
    return Response.json(result.body, { status: result.status });
  } catch {
    return Response.json({ ok: false, error: 'FAILED' }, { status: 500 });
  }
});
