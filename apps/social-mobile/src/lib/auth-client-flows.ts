import type { SupabaseClient } from '@supabase/supabase-js';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import {
  AUTH_CALLBACK_URL,
  authFlowMessage,
  classifyBrowserResult,
  isAppleCancel,
  parseAuthCallbackUrl,
  type AuthCallback,
} from '@/domain/auth-flows';
import { bytesToHex } from '@/lib/x-oauth-onboarding';

export type AuthFlowResult = { ok: true } | { ok: false; cancelled?: boolean; message: string };
type OAuthProvider = 'x' | 'google' | 'apple';

const FAILED: AuthFlowResult = { ok: false, message: authFlowMessage(null) };
const handledCodes = new Set<string>();

function errorCode(error: unknown): string | null {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : null;
  return typeof code === 'string' ? code : null;
}

/**
 * Completes one Supabase Auth return (PKCE code or e-mail token hash). A code
 * is exchanged at most once per app process (the in-app browser result and a
 * delivered deep link can both carry it). Only the session is kept; provider
 * tokens are never read.
 */
export async function completeAuthCallback(client: SupabaseClient, callback: AuthCallback): Promise<AuthFlowResult> {
  if (callback.kind === 'invalid') return FAILED;
  if (callback.kind === 'error') return { ok: false, cancelled: callback.errorCode === 'access_denied', message: authFlowMessage(callback.errorCode) };
  if (callback.kind === 'code') {
    if (handledCodes.has(callback.code)) return { ok: true };
    handledCodes.add(callback.code);
    const { error } = await client.auth.exchangeCodeForSession(callback.code);
    return error ? { ok: false, message: authFlowMessage(errorCode(error)) } : { ok: true };
  }
  const { error } = await client.auth.verifyOtp({ token_hash: callback.tokenHash, type: callback.type });
  return error ? { ok: false, message: authFlowMessage(errorCode(error)) } : { ok: true };
}

export async function completeAuthCallbackUrl(client: SupabaseClient, url: string): Promise<AuthFlowResult | null> {
  const callback = parseAuthCallbackUrl(url);
  if (callback.kind === 'invalid') return null;  // not an auth return (e.g. the posting-account callback)
  return completeAuthCallback(client, callback);
}

async function viaBrowser(authorizeUrl: string | undefined, client: SupabaseClient, supabaseHost: string): Promise<AuthFlowResult> {
  if (typeof authorizeUrl !== 'string') return FAILED;
  let target: URL;
  try {
    target = new URL(authorizeUrl);
  } catch {
    return FAILED;
  }
  // Only the project's own Supabase Auth authorize endpoint may be opened.
  if (target.protocol !== 'https:' || target.host !== supabaseHost || !target.pathname.startsWith('/auth/v1/')) return FAILED;
  const outcome = classifyBrowserResult(await WebBrowser.openAuthSessionAsync(authorizeUrl, AUTH_CALLBACK_URL));
  if (outcome.kind === 'cancelled') return { ok: false, cancelled: true, message: 'ログインをキャンセルしました。' };
  if (outcome.kind === 'failed') return FAILED;
  return (await completeAuthCallbackUrl(client, outcome.url)) ?? FAILED;
}

/** X / Google / Apple (non-iOS) sign-in via Supabase Auth OAuth + PKCE in the in-app browser. */
export async function signInWithOAuthProvider(client: SupabaseClient, supabaseHost: string, provider: OAuthProvider): Promise<AuthFlowResult> {
  try {
    const { data, error } = await client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true },
    });
    if (error) return { ok: false, message: authFlowMessage(errorCode(error)) };
    return await viaBrowser(data?.url, client, supabaseHost);
  } catch {
    return FAILED;
  }
}

/** Explicit, authenticated linking of one more login method to the current user. */
export async function linkOAuthProvider(client: SupabaseClient, supabaseHost: string, provider: OAuthProvider): Promise<AuthFlowResult> {
  try {
    const { data, error } = await client.auth.linkIdentity({
      provider,
      options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true },
    });
    if (error) return { ok: false, message: authFlowMessage(errorCode(error)) };
    return await viaBrowser(data?.url, client, supabaseHost);
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

/**
 * iOS native Sign in with Apple → signInWithIdToken. A fresh random nonce is
 * sent hashed to Apple and raw to Supabase, which checks it against the token.
 */
export async function signInWithAppleNative(client: SupabaseClient): Promise<AuthFlowResult> {
  try {
    const rawNonce = bytesToHex(await Crypto.getRandomBytesAsync(32));
    const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce: hashedNonce,
    });
    if (!credential.identityToken) return FAILED;
    const { error } = await client.auth.signInWithIdToken({ provider: 'apple', token: credential.identityToken, nonce: rawNonce });
    return error ? { ok: false, message: authFlowMessage(errorCode(error)) } : { ok: true };
  } catch (error) {
    if (isAppleCancel(error)) return { ok: false, cancelled: true, message: 'ログインをキャンセルしました。' };
    return FAILED;
  }
}
