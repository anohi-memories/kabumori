import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useRef, useState } from 'react';
import { base64ToBase64Url, bytesToHex, isRetryableOAuthError, parseOAuthReturn } from '@/lib/x-oauth-onboarding';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';

WebBrowser.maybeCompleteAuthSession();

export type ConnectState = 'idle' | 'connecting' | 'connected' | 'cancelled' | 'retryable_error' | 'terminal_error';

export const CONNECT_STATE_TEXT: Record<ConnectState, string> = {
  idle: 'Xアカウントを安全に接続できます。',
  connecting: 'Xの認証を確認しています…',
  connected: 'Xアカウントを接続しました。',
  cancelled: '接続をキャンセルしました。必要なら再試行できます。',
  retryable_error: '一時的な通信エラーです。もう一度お試しください。',
  terminal_error: '安全確認を完了できませんでした。最初からやり直してください。',
};

/**
 * The one X connect/reconnect flow (existing x-oauth-connect-user contract):
 * raw state and PKCE verifier live only in memory for this browser round
 * trip; the server binds the verified X identity to the caller's own account
 * using the forwarded user JWT. No ids are sent as ownership claims.
 */
export function useXConnect(onConnected?: () => void) {
  const { session } = useAuth();
  const [state, setState] = useState<ConnectState>('idle');
  const [verifiedHandle, setVerifiedHandle] = useState<string | null>(null);
  const inFlight = useRef(false);

  const connect = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState('connecting');
    setVerifiedHandle(null);
    let rawState: string | null = null;
    let codeVerifier: string | null = null;
    try {
      if (!supabase || !session?.access_token) throw new Error('AUTH_SESSION_UNAVAILABLE');
      const redirectUri = Linking.createURL('oauth-callback', { scheme: 'kabumori-social' });
      if (redirectUri !== 'kabumori-social://oauth-callback') throw new Error('OAUTH_REDIRECT_URI_INVALID');
      rawState = bytesToHex(await Crypto.getRandomBytesAsync(32));
      codeVerifier = bytesToHex(await Crypto.getRandomBytesAsync(32));
      const digestBase64 = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        codeVerifier,
        { encoding: Crypto.CryptoEncoding.BASE64 },
      );
      const codeChallenge = base64ToBase64Url(digestBase64);

      const { data: startData, error: startError } = await supabase.functions.invoke<{ authorization_url?: unknown }>(
        'x-oauth-connect-user',
        {
          body: { state: rawState, code_challenge: codeChallenge, redirect_uri: redirectUri },
          headers: { Authorization: `Bearer ${session.access_token}` },
        },
      );
      if (startError) throw startError;
      const authorizationUrl = startData?.authorization_url;
      if (typeof authorizationUrl !== 'string') throw new Error('OAUTH_AUTHORIZATION_URL_MISSING');
      const authorization = new URL(authorizationUrl);
      if (authorization.protocol !== 'https:' || authorization.hostname !== 'x.com') {
        throw new Error('OAUTH_AUTHORIZATION_URL_INVALID');
      }

      const browserResult = await WebBrowser.openAuthSessionAsync(authorizationUrl, redirectUri);
      if (browserResult.type === 'cancel' || browserResult.type === 'dismiss') {
        setState('cancelled');
        return;
      }
      if (browserResult.type !== 'success') {
        setState('retryable_error');
        return;
      }
      const callback = parseOAuthReturn(browserResult.url, redirectUri, rawState);
      if (callback.kind === 'cancelled') {
        setState('cancelled');
        return;
      }
      const { data: callbackData, error: callbackError } = await supabase.functions.invoke<{ success?: unknown; handle?: unknown }>(
        'x-oauth-connect-user/callback',
        {
          body: { code: callback.code, state: callback.state, code_verifier: codeVerifier, redirect_uri: redirectUri },
          headers: { Authorization: `Bearer ${session.access_token}` },
        },
      );
      if (callbackError) throw callbackError;
      if (callbackData?.success !== true || typeof callbackData.handle !== 'string' || !callbackData.handle) {
        throw new Error('OAUTH_CALLBACK_RESPONSE_INVALID');
      }
      setVerifiedHandle(`@${callbackData.handle.replace(/^@/u, '')}`);
      setState('connected');
      onConnected?.();
    } catch (error) {
      setState(isRetryableOAuthError(error) ? 'retryable_error' : 'terminal_error');
    } finally {
      rawState = null;
      codeVerifier = null;
      inFlight.current = false;
    }
  }, [onConnected, session]);

  return { state, verifiedHandle, connect, stateText: CONNECT_STATE_TEXT[state] };
}
