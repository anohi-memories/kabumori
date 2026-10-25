import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { sessionIdOf } from '@/domain/recovery-binding';
import { xConnectAuthSessionOptions } from '@/features/x-connect/auth-session-options';
import {
  base64ToBase64Url,
  bytesToHex,
  classifyXConnectFailure,
  classifyXDisconnectFailure,
  parseOAuthReturn,
  type XConnectFailure,
} from '@/lib/x-oauth-onboarding';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';

WebBrowser.maybeCompleteAuthSession();

export type ConnectState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'cancelled'
  | 'session_changed'
  | 'retryable_error'
  | 'terminal_error'
  | 'session_required'
  | 'workspace_blocked'
  | 'disconnecting'
  | 'disconnected';

// G4-41: session_required / workspace_blocked / disconnect* copy is provisional until the G1/G2 screen owners settle it.
export const CONNECT_STATE_TEXT: Record<ConnectState, string> = {
  idle: 'Xアカウントを安全に接続できます。',
  connecting: 'Xの認証を確認しています…',
  connected: 'Xアカウントを接続しました。',
  cancelled: '接続をキャンセルしました。必要なら再試行できます。',
  session_changed: 'ログイン中のアカウントが変わったため、この接続は続けられません。必要なら、もう一度お試しください。',
  retryable_error: '一時的な通信エラーです。もう一度お試しください。',
  terminal_error: '安全確認を完了できませんでした。最初からやり直してください。',
  session_required: 'ログインの有効期限が切れました。もう一度ログインしてから接続してください。',
  workspace_blocked: 'このアカウントでは、まだXを接続できません。サポートにお問い合わせください。',
  disconnecting: 'Xアカウントの接続を解除しています…',
  disconnected: 'Xアカウントの接続を解除しました。',
};

const FAILURE_STATE: Record<XConnectFailure, ConnectState> = {
  retryable: 'retryable_error',
  session_required: 'session_required',
  workspace_blocked: 'workspace_blocked',
  restart: 'terminal_error',
};

type ConnectOwner = { userId: string; sessionId: string };
type CurrentSession = { access_token: string; user: { id: string } };

/** The signed-in person and Supabase session now: the SDK's stored session, not a copy taken at render time. */
async function currentSession(): Promise<CurrentSession | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.auth.getSession();
    return error ? null : data.session;
  } catch {
    return null;
  }
}

/**
 * The connect belongs to the exact user AND Supabase session that started it (the session_id claim). A user id alone
 * is not enough: A -> B -> A is a new session of A after another person used the device, and a stale screen of A
 * may still be mounted. A refreshed access token of the same session keeps its session_id and stays the owner.
 */
function connectOwnerOf(session: CurrentSession | null): ConnectOwner | null {
  const sessionId = sessionIdOf(session);
  return session?.user.id && sessionId ? { userId: session.user.id, sessionId } : null;
}

function isConnectOwner(owner: ConnectOwner, session: CurrentSession | null): session is CurrentSession {
  return !!session && session.user.id === owner.userId && sessionIdOf(session) === owner.sessionId;
}

/**
 * The one X connect/reconnect flow (existing x-oauth-connect-user contract):
 * raw state and PKCE verifier live only in memory for this browser round
 * trip; the server binds the verified X identity to the caller's own account
 * using the forwarded user JWT. No ids are sent as ownership claims.
 * G2-CB5: the person and session that started the connect are re-checked against the CURRENT session right before
 * the code exchange and again right before the success is shown; another person, a sign-out, a new session or an
 * unreadable session stops it (no exchange / no success, no onConnected).
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
      const startSession = await currentSession();
      const owner = connectOwnerOf(startSession);
      // The screen's person must be the session's person (a screen left over from another person starts nothing).
      if (!owner || !startSession || owner.userId !== session.user.id) {
        setState('session_changed');
        return;
      }
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
          headers: { Authorization: `Bearer ${startSession.access_token}` },
        },
      );
      if (startError) throw startError;
      const authorizationUrl = startData?.authorization_url;
      if (typeof authorizationUrl !== 'string') throw new Error('OAUTH_AUTHORIZATION_URL_MISSING');
      const authorization = new URL(authorizationUrl);
      if (authorization.protocol !== 'https:' || authorization.hostname !== 'x.com') {
        throw new Error('OAUTH_AUTHORIZATION_URL_INVALID');
      }

      // iOS: private auth session so a previously logged-in X account is not silently reused and the
      // person can pick the account to connect (see auth-session-options.ts). Other platforms unchanged.
      const browserResult = await WebBrowser.openAuthSessionAsync(authorizationUrl, redirectUri, xConnectAuthSessionOptions(Platform.OS));
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
      // Right before the exchange: still the same person and session (its current, possibly refreshed, token).
      const exchangeSession = await currentSession();
      if (!isConnectOwner(owner, exchangeSession)) {
        setState('session_changed');
        return;
      }
      const { data: callbackData, error: callbackError } = await supabase.functions.invoke<{ success?: unknown; handle?: unknown }>(
        'x-oauth-connect-user/callback',
        {
          body: { code: callback.code, state: callback.state, code_verifier: codeVerifier, redirect_uri: redirectUri },
          headers: { Authorization: `Bearer ${exchangeSession.access_token}` },
        },
      );
      if (callbackError) throw callbackError;
      if (callbackData?.success !== true || typeof callbackData.handle !== 'string' || !callbackData.handle) {
        throw new Error('OAUTH_CALLBACK_RESPONSE_INVALID');
      }
      // Right before the success is shown and onConnected reloads data: still the same person and session. The server
      // bound the account to the starter; another person on this screen sees no success and triggers no reload.
      if (!isConnectOwner(owner, await currentSession())) {
        setState('session_changed');
        return;
      }
      setVerifiedHandle(`@${callbackData.handle.replace(/^@/u, '')}`);
      setState('connected');
      onConnected?.();
    } catch (error) {
      setState(FAILURE_STATE[classifyXConnectFailure(error)]);
    } finally {
      rawState = null;
      codeVerifier = null;
      inFlight.current = false;
    }
  }, [onConnected, session]);

  // The caller's own X connection only (the RPC derives everything from the forwarded JWT; no ids are sent).
  // Server side it stays refused (X_DISCONNECT_NOT_ENABLED -> terminal_error) until the operator opens its gate.
  // As connect (G4-18): a screen left over from another person disconnects nothing.
  const disconnect = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState('disconnecting');
    try {
      if (!supabase || !session?.access_token) throw new Error('AUTH_SESSION_UNAVAILABLE');
      const current = await currentSession();
      if (!current || current.user.id !== session.user.id) {
        setState('session_changed');
        return;
      }
      const { error, status } = await supabase.rpc('disconnect_social_mobile_x_connection');
      if (error) {
        setState(FAILURE_STATE[classifyXDisconnectFailure(error.message, status)]);
        return;
      }
      setVerifiedHandle(null);
      setState('disconnected');
      onConnected?.();
    } catch (error) {
      setState(FAILURE_STATE[classifyXConnectFailure(error)]);
    } finally {
      inFlight.current = false;
    }
  }, [onConnected, session]);

  return { state, verifiedHandle, connect, disconnect, stateText: CONNECT_STATE_TEXT[state] };
}
