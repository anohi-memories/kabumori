import { AuthError, createClient } from '@supabase/supabase-js';

import {
  ACCOUNT_LIFECYCLE_FUNCTION,
  deleteCommonAccount,
  previewCommonAccountDeletion,
  REAUTH_MESSAGES,
  withdrawKabumori,
  type DeletionPreview,
  type LifecycleAction,
  type LifecycleClient,
  type Reauthentication,
} from '@/lib/account-deletion';
import { supabase, supabasePublicConfig } from '@/lib/supabase';

// The Edge Function is called directly rather than through functions.invoke() so the HTTP status reaches
// the outcome parsers: the UI must distinguish "the server confirmed it" from every other result.
async function invoke(action: LifecycleAction, payload: Record<string, unknown>, accessToken: string) {
  const response = await fetch(`${supabasePublicConfig.url}/functions/v1/${ACCOUNT_LIFECYCLE_FUNCTION}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: supabasePublicConfig.publishableKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...payload, action }),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/**
 * The recent-authentication proof: a password sign-in in a separate client that keeps nothing (memory
 * only, no refresh timer, its own storage key). The app's own session, its auth events and its service
 * gate are untouched. The password goes only to Supabase Auth, exactly as on the sign-in screen.
 */
async function reauthenticate(email: string, password: string): Promise<Reauthentication> {
  const fresh = createClient(supabasePublicConfig.url, supabasePublicConfig.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'kabumori-reauthentication' },
  });
  const { data, error } = await fresh.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    const code = error instanceof AuthError ? error.code : undefined;
    const message = error?.message.toLowerCase() ?? '';
    if (code === 'invalid_credentials' || message.includes('invalid login credentials')) return { ok: false, reason: 'invalid_credentials' };
    if (code === 'over_request_rate_limit' || message.includes('rate limit')) return { ok: false, reason: 'rate_limited' };
    return { ok: false, reason: 'failed' };
  }
  return {
    ok: true,
    accessToken: data.session.access_token,
    userId: data.session.user.id,
    // Ends only this extra session (after a deletion the server has already revoked it).
    release: async () => {
      await fresh.auth.signOut({ scope: 'local' });
    },
  };
}

const client: LifecycleClient = { invoke, reauthenticate };

async function signedInPerson() {
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  return session ? { accessToken: session.access_token, person: { email: session.user.email ?? null, userId: session.user.id } } : null;
}

/** What deleting the signed-in common account would do now (read-only). */
export async function previewSignedInDeletion() {
  return previewCommonAccountDeletion(client, (await signedInPerson())?.accessToken);
}

/** かぶモリの利用を終了 for the signed-in person, after re-entering their password. */
export async function withdrawSignedInKabumori(password: string) {
  const signed = await signedInPerson();
  if (!signed) return { ok: false as const, message: REAUTH_MESSAGES.email_missing };
  return withdrawKabumori(client, signed.person, password);
}

/** 共通アカウントを削除 for the signed-in person, bound to the preview they confirmed. */
export async function deleteSignedInCommonAccount(input: { password: string; typed: string; preview: DeletionPreview }) {
  const signed = await signedInPerson();
  if (!signed) return { ok: false as const, message: REAUTH_MESSAGES.email_missing, signedOut: false, pending: false, refreshPreview: false };
  return deleteCommonAccount(client, signed.person, input);
}
