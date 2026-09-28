import type { SupabaseClient } from '@supabase/supabase-js';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import {
  AUTH_CALLBACK_URL,
  authFlowMessage,
  classifyBrowserResult,
  completeAuthCallback,
  FLOW_ID_PATTERN,
  isAllowedLinkUrl,
  isAllowedSignInUrl,
  isAppleCancel,
  parseAuthCallbackUrl,
  type AuthFlowResult,
  type CallbackAuthClient,
  type SocialProviderId,
} from '@/domain/auth-flows';
import { bytesToHex } from '@/lib/x-oauth-onboarding';

export type { AuthFlowResult } from '@/domain/auth-flows';

const FAILED: AuthFlowResult = { ok: false, message: authFlowMessage(null) };
const CANCELLED: AuthFlowResult = { ok: false, cancelled: true, message: 'ログインをキャンセルしました。' };

function errorCode(error: unknown): string | null {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : null;
  return typeof code === 'string' ? code : null;
}

const callbackClient = (client: SupabaseClient) => client as unknown as CallbackAuthClient;

/** A delivered deep link: completes it only if it is an exact auth callback (never the posting one). */
export async function completeAuthCallbackUrl(client: SupabaseClient, url: string): Promise<AuthFlowResult | null> {
  const callback = parseAuthCallbackUrl(url);
  if (callback.kind === 'invalid') return null;
  return completeAuthCallback(callbackClient(client), callback);
}

/** Runs one browser round trip for a flow this process started, and completes exactly that flow. */
async function roundTrip(client: SupabaseClient, authorizeUrl: string, flowId: string): Promise<AuthFlowResult> {
  const outcome = classifyBrowserResult(await WebBrowser.openAuthSessionAsync(authorizeUrl, AUTH_CALLBACK_URL));
  if (outcome.kind === 'cancelled') return CANCELLED;
  if (outcome.kind === 'failed') return FAILED;
  return completeAuthCallback(callbackClient(client), parseAuthCallbackUrl(outcome.url), { flowId });
}

function startedFlow(data: unknown): { url: string; flowId: string } | null {
  const record = (data ?? {}) as { url?: unknown; flowId?: unknown };
  return typeof record.url === 'string' && typeof record.flowId === 'string' && FLOW_ID_PATTERN.test(record.flowId)
    ? { url: record.url, flowId: record.flowId }
    : null;
}

/** X / Google / Apple (browser) sign-in: Supabase Auth OAuth + PKCE, opened only at the project's authorize endpoint. */
export async function signInWithOAuthProvider(client: SupabaseClient, supabaseHost: string, provider: SocialProviderId): Promise<AuthFlowResult> {
  try {
    const { data, error } = await client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true },
    });
    if (error) return { ok: false, message: authFlowMessage(errorCode(error)) };
    const flow = startedFlow(data);
    if (!flow || !isAllowedSignInUrl(flow.url, supabaseHost)) return FAILED;
    return await roundTrip(client, flow.url, flow.flowId);
  } catch {
    return FAILED;
  }
}

async function sameUserAfter(client: SupabaseClient, result: AuthFlowResult, expectedUserId: string): Promise<AuthFlowResult> {
  if (!result.ok) return result;
  const { data } = await client.auth.getSession();
  if (result.userId === expectedUserId && data.session?.user.id === expectedUserId) return result;
  // Never continue as someone else after a linking attempt.
  await client.auth.signOut();
  return { ok: false, message: authFlowMessage('link_user_mismatch') };
}

/**
 * Explicit, authenticated linking for the signed-in user. The URL Supabase
 * returns is the provider's own authorize URL: accepted only for that provider
 * and only when it redirects to this project's Supabase callback. The result
 * must be the same user.
 */
export async function linkOAuthProvider(client: SupabaseClient, supabaseHost: string, provider: SocialProviderId, userId: string): Promise<AuthFlowResult> {
  try {
    const { data, error } = await client.auth.linkIdentity({
      provider,
      options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true },
    });
    if (error) return { ok: false, message: authFlowMessage(errorCode(error)) };
    const flow = startedFlow(data);
    if (!flow || !isAllowedLinkUrl(flow.url, provider, supabaseHost)) return FAILED;
    return await sameUserAfter(client, await roundTrip(client, flow.url, flow.flowId), userId);
  } catch {
    return FAILED;
  }
}

export async function isNativeAppleAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

async function appleCredential(): Promise<{ identityToken: string; rawNonce: string; authorizationCode: string | null } | 'cancelled' | null> {
  try {
    // Fresh random nonce: its SHA-256 goes to Apple, the raw value to Supabase.
    const rawNonce = bytesToHex(await Crypto.getRandomBytesAsync(32));
    const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce: hashedNonce,
    });
    return credential.identityToken ? { identityToken: credential.identityToken, rawNonce, authorizationCode: credential.authorizationCode ?? null } : null;
  } catch (error) {
    return isAppleCancel(error) ? 'cancelled' : null;
  }
}

/** iOS native Sign in with Apple → signInWithIdToken. */
export async function signInWithAppleNative(client: SupabaseClient): Promise<AuthFlowResult> {
  const credential = await appleCredential();
  if (credential === 'cancelled') return CANCELLED;
  if (!credential) return FAILED;
  try {
    const { data, error } = await client.auth.signInWithIdToken({ provider: 'apple', token: credential.identityToken, nonce: credential.rawNonce });
    return error ? { ok: false, message: authFlowMessage(errorCode(error)) } : { ok: true, userId: data.user?.id ?? null };
  } catch {
    return FAILED;
  }
}

/**
 * iOS native Apple linking: linkIdentity with the Apple ID token, sent with
 * the signed-in user's own session (auth-js `link_identity`), so it is the
 * same explicit, authenticated linking — no browser/Services ID involved.
 */
export async function linkAppleNative(client: SupabaseClient, userId: string): Promise<AuthFlowResult> {
  const credential = await appleCredential();
  if (credential === 'cancelled') return CANCELLED;
  if (!credential) return FAILED;
  try {
    const { data, error } = await client.auth.linkIdentity({ provider: 'apple', token: credential.identityToken, nonce: credential.rawNonce });
    if (error) return { ok: false, message: authFlowMessage(errorCode(error)) };
    const linkedUser = (data as { user?: { id?: unknown } | null } | null)?.user?.id;
    return await sameUserAfter(client, { ok: true, userId: typeof linkedUser === 'string' ? linkedUser : null }, userId);
  } catch {
    return FAILED;
  }
}

/**
 * Re-authentication with native Apple before account deletion: a fresh
 * sign-in (recent-auth for the server) that must be the same user. Its
 * one-time authorization code lets the server revoke the Apple grant.
 */
export async function reauthWithAppleNative(client: SupabaseClient, expectedUserId: string): Promise<AuthFlowResult & { appleAuthorizationCode?: string }> {
  const credential = await appleCredential();
  if (credential === 'cancelled') return CANCELLED;
  if (!credential || !credential.authorizationCode) return FAILED;
  try {
    const { data, error } = await client.auth.signInWithIdToken({ provider: 'apple', token: credential.identityToken, nonce: credential.rawNonce });
    if (error) return { ok: false, message: authFlowMessage(errorCode(error)) };
    const result = await sameUserAfter(client, { ok: true, userId: data.user?.id ?? null }, expectedUserId);
    return result.ok ? { ...result, appleAuthorizationCode: credential.authorizationCode } : result;
  } catch {
    return FAILED;
  }
}

/** Browser OAuth re-authentication (X / Google / Apple web) that must end as the same user. */
export async function reauthWithOAuthProvider(client: SupabaseClient, supabaseHost: string, provider: SocialProviderId, expectedUserId: string): Promise<AuthFlowResult> {
  return sameUserAfter(client, await signInWithOAuthProvider(client, supabaseHost, provider), expectedUserId);
}
