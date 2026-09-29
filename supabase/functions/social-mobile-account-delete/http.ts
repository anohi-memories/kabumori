// HTTP layer for social-mobile-account-delete: CORS, routing and the real
// dependencies. SOURCE CANDIDATE. Keep platform JWT verification ON.
// Supported callers: the iOS/Android app (native) and the Expo web build
// (CORS below). Sign in with Apple users need a native Apple authorization
// code for a login deletion, which only the iOS app can obtain.
import { appleConfigFrom, revokeAppleGrant } from './apple_revoke.ts';
import { handleAccountDeletion, handlePreview, type DeletionDeps, type RpcName, type RpcResult } from './delete_logic.ts';

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '600',
};

const RPC_NAMES: Record<RpcName, string> = {
  preview: 'social_mobile_account_deletion_preview',
  acquire: 'social_mobile_account_deletion_acquire',
  release: 'social_mobile_account_deletion_release',
  credentials: 'social_mobile_account_deletion_credentials',
  mark_x_revoked: 'social_mobile_account_deletion_mark_x_revoked',
  mark_apple_revoked: 'social_mobile_account_deletion_mark_apple_revoked',
  purge: 'social_mobile_account_deletion_purge',
  finalize: 'social_mobile_account_deletion_finalize',
  record: 'social_mobile_account_deletion_record',
};

const X_REVOKE_URL = 'https://api.x.com/2/oauth2/revoke';
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const json = (body: unknown, status: number) => Response.json(body, { status, headers: CORS_HEADERS });

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createHandler(env: { get: (name: string) => string | undefined }, fetchImpl: FetchLike = fetch) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
    const supabaseUrl = env.get('SUPABASE_URL');
    const anonKey = env.get('SUPABASE_ANON_KEY');
    const serviceKey = env.get('SUPABASE_SERVICE_ROLE_KEY');
    const xClientId = env.get('X_CLIENT_ID');
    const xClientSecret = env.get('X_CLIENT_SECRET');
    if (!supabaseUrl || !anonKey || !serviceKey || !xClientId || !xClientSecret) {
      // Deliberately does not say which value is missing.
      return json({ ok: false, error: 'FAILED' }, 500);
    }
    const apple = appleConfigFrom((name) => env.get(name));
    const service = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

    const deps: DeletionDeps = {
      getUser: async (token) => {
        const response = await fetchImpl(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: anonKey, Authorization: `Bearer ${token}` } });
        if (!response.ok) return null;
        const user = await response.json() as { id?: unknown; identities?: { provider?: unknown; id?: unknown }[] };
        if (typeof user.id !== 'string' || !user.id) return null;
        const identities = user.identities ?? [];
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
        const payload = await response.json().catch(() => null) as { message?: unknown } | null;
        if (response.ok) return { ok: true, data: payload };
        // Only our own fixed exception codes are extracted; the rest of the message is dropped.
        const match = typeof payload?.message === 'string' ? /SOCIAL_MOBILE_DELETION_[A-Z_]+/u.exec(payload.message) : null;
        return { ok: false, code: match ? match[0] : null };
      },
      revokeX: async (token, hint) => {
        const response = await fetchImpl(X_REVOKE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${btoa(`${xClientId}:${xClientSecret}`)}` },
          body: new URLSearchParams({ token, token_type_hint: hint, client_id: xClientId }).toString(),
        });
        return response.ok;
      },
      revokeApple: apple ? (code, subjects) => revokeAppleGrant(apple, code, subjects, Math.floor(Date.now() / 1000), fetchImpl) : null,
      sha256Hex,
      nowSeconds: () => Math.floor(Date.now() / 1000),
    };

    const body = await req.json().catch(() => null) as { action?: unknown } | null;
    const authorization = req.headers.get('Authorization');
    try {
      const result = body?.action === 'preview'
        ? await handlePreview({ authorization }, deps)
        : body?.action === 'delete'
          ? await handleAccountDeletion({ authorization, body }, deps)
          : { status: 400, body: { ok: false, error: 'ACTION_REQUIRED' } };
      return json(result.body, result.status);
    } catch {
      return json({ ok: false, error: 'FAILED' }, 500);
    }
  };
}
