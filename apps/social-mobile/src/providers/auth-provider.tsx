import type { Session } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { Platform } from 'react-native';
import { getSupabaseConfig, getSupabaseHost, supabase } from '@/lib/supabase';
import { signInErrorMessage } from '@/lib/auth-errors';
import { stripProviderCredentials } from '@/lib/session-storage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  completeAuthCallbackUrl,
  isNativeAppleAvailable,
  linkAppleNative,
  linkOAuthProvider,
  reauthWithAppleNative,
  reauthWithOAuthProvider,
  signInWithAppleNative,
  signInWithOAuthProvider,
  type AuthFlowResult,
} from '@/lib/auth-client-flows';
import {
  ACCOUNT_DELETION_CONFIRMATION,
  ACCOUNT_DELETION_FUNCTION,
  deletionAvailability,
  parseDeletionPreview,
  parseDeletionResponse,
  sameDeletionContext,
  type DeletionAvailability,
  type DeletionContext,
  type DeletionOutcome,
  type DeletionPreview,
  type DeletionScope,
  type ReauthMethod,
} from '@/domain/account-deletion';
import { onboardingStorageKey } from '@/domain/onboarding';
import {
  applePath,
  AUTH_CALLBACK_URL,
  authFlowMessage,
  classifySignUp,
  parseAuthSettings,
  parseConfiguredProviders,
  signUpErrorIsNeutral,
  validateNewPassword,
  type AuthProviderId,
  type BuildAuthConfig,
  type ProviderSettings,
  type SignUpOutcome,
  type SocialProviderId,
} from '@/domain/auth-flows';
import { authReleaseReadiness, type AppAuthConfig, type AuthReleaseReport, type ProviderReleaseReadiness } from '@/domain/auth-release-readiness';
import { nextRecoveryBinding, recoveryMatches, sessionIdOf, type RecoveryBinding } from '@/domain/recovery-binding';

type AuthContextValue = {
  /** The app session without provider OAuth credentials. */
  session: Session | null;
  loading: boolean;
  error: string | null;
  backendAvailable: boolean;
  /** Per provider: enabled in Supabase, build config, source path, never claimed E2E-verified; usableNow is fail-closed. */
  readiness: (provider: AuthProviderId) => ProviderReleaseReadiness;
  email: { signIn: boolean; signUp: boolean; reset: boolean };
  settingsKnown: boolean;
  /** Full report for developer/operator diagnostics (no secrets, booleans and codes only). */
  releaseReport: AuthReleaseReport;
  /** A password-recovery session bound to one user/session is active: set a new password first. */
  recoveryMode: boolean;
  signIn: (email: string, password: string) => Promise<{ ok: boolean; message?: string }>;
  signUpWithEmail: (email: string, password: string) => Promise<{ ok: true; outcome: SignUpOutcome } | { ok: false; message: string }>;
  requestPasswordReset: (email: string) => Promise<{ ok: boolean; message: string }>;
  completePasswordRecovery: (password: string, confirmation: string) => Promise<{ ok: boolean; message?: string }>;
  signInWithProvider: (provider: SocialProviderId) => Promise<AuthFlowResult>;
  linkProvider: (provider: SocialProviderId) => Promise<AuthFlowResult>;
  signOut: () => Promise<{ ok: boolean; message?: string }>;
  /** Account deletion is offered only when enabled for this build (backend reviewed + deployed). */
  accountDeletion: DeletionAvailability;
  /** A fresh sign-in with one of the user's own methods; must end as the same user. */
  /** On success: the exact user + session the confirmation belongs to (deletion is pinned to it). */
  reauthenticate: (method: ReauthMethod, password?: string) => Promise<{ ok: true; context: DeletionContext; appleAuthorizationCode?: string } | { ok: false; cancelled?: boolean; message: string }>;
  /** Read-only: the scope and Apple needs the server would apply now. */
  previewDeletion: () => Promise<DeletionPreview>;
  /** Server-side deletion of the signed-in account; success only when the server confirmed it. */
  deleteAccount: (input: { context: DeletionContext; scope: DeletionScope; appleAuthorizationCode?: string }) => Promise<DeletionOutcome>;
};
const AuthContext = createContext<AuthContextValue | null>(null);
const NO_BACKEND = { ok: false as const, message: 'Supabase接続設定がありません。' };
// Build-time declaration of the providers configured for this build (static reference for Expo inlining).
const DECLARED_PROVIDERS = process.env.EXPO_PUBLIC_AUTH_PROVIDERS;
const ACCOUNT_DELETION_ENABLED = process.env.EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED;
const CONFIGURED_PROVIDERS = parseConfiguredProviders(DECLARED_PROVIDERS);

function appAuthConfig(config: ReturnType<typeof getSupabaseConfig>): AppAuthConfig {
  const expo = Constants.expoConfig;
  return {
    supabase: config.ok ? 'ok' : config.kind,
    scheme: expo?.scheme,
    iosBundleIdentifier: expo?.ios?.bundleIdentifier,
    usesAppleSignIn: expo?.ios?.usesAppleSignIn === true,
    plugins: expo?.plugins ?? [],
    declaredProviders: DECLARED_PROVIDERS,
  };
}

function appSession(session: Session | null): Session | null {
  return session ? stripProviderCredentials(session) : null;
}

export function AuthProvider({ children }: PropsWithChildren) {
  const config = useMemo(() => getSupabaseConfig(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(Boolean(supabase));
  const [error, setError] = useState<string | null>(config.ok ? null : config.reason);
  const [settings, setSettings] = useState<ProviderSettings>(null);
  const [nativeApple, setNativeApple] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryBinding>(null);
  const recoveryRef = useRef<RecoveryBinding>(null);

  useEffect(() => {
    if (!supabase) return;
    let mounted = true;
    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!mounted) return;
      setSession(appSession(data.session));
      if (sessionError) setError('認証セッションを復元できませんでした。');
      setLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(appSession(nextSession));
      setError(null);
      setLoading(false);
      // Recovery is bound to the exact user + session of the recovery link; any other
      // session (another user, a new sign-in, sign-out) ends it.
      const next = nextRecoveryBinding(recoveryRef.current, event, nextSession);
      recoveryRef.current = next;
      setRecovery(next);
    });
    return () => { mounted = false; listener.subscription.unsubscribe(); };
  }, []);

  // What the project really offers (public endpoint, publishable key only).
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(async () => {
      const available = await isNativeAppleAvailable();
      if (!cancelled) setNativeApple(available);
      if (!config.ok) return;
      try {
        const response = await fetch(`${config.config.url.replace(/\/$/u, '')}/auth/v1/settings`, {
          headers: { apikey: config.config.publishableKey },
        });
        const body = response.ok ? await response.json() : null;
        if (!cancelled) setSettings(parseAuthSettings(body));
      } catch {
        if (!cancelled) setSettings(null);
      }
    });
    return () => { cancelled = true; };
  // Config comes from build-time constants.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // E-mail confirmation / recovery links can arrive as deep links while signed out.
  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    const handle = (url: string | null) => {
      if (!url) return;
      void completeAuthCallbackUrl(client, url).then((result) => {
        if (result && !result.ok && !result.cancelled) setError(result.message);
      });
    };
    void Linking.getInitialURL().then(handle);
    const subscription = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => subscription.remove();
  }, []);

  const build = useMemo<BuildAuthConfig>(() => ({
    configured: CONFIGURED_PROVIDERS,
    platform: Platform.OS,
    nativeAppleAvailable: nativeApple,
    iosBundleIdentifier: Constants.expoConfig?.ios?.bundleIdentifier ?? null,
  }), [nativeApple]);
  const releaseReport = useMemo(() => authReleaseReadiness({ settings, build, app: appAuthConfig(config) }), [build, config, settings]);
  const readiness = useCallback((provider: AuthProviderId) => releaseReport.providers[provider], [releaseReport]);
  const email = releaseReport.email;

  const signInWithProvider = useCallback(async (provider: SocialProviderId): Promise<AuthFlowResult> => {
    const host = getSupabaseHost();
    if (!supabase || !host) return NO_BACKEND;
    if (!readiness(provider).usableNow) return { ok: false, message: authFlowMessage('provider_disabled') };
    setError(null);
    if (provider === 'apple' && applePath(build) === 'native') return signInWithAppleNative(supabase);
    return signInWithOAuthProvider(supabase, host, provider);
  }, [build, readiness]);

  const linkProvider = useCallback(async (provider: SocialProviderId): Promise<AuthFlowResult> => {
    const host = getSupabaseHost();
    const userId = session?.user.id;
    if (!supabase || !host || !userId) return NO_BACKEND;
    if (!readiness(provider).usableNow) return { ok: false, message: authFlowMessage('provider_disabled') };
    if (provider === 'apple' && applePath(build) === 'native') return linkAppleNative(supabase, userId);
    return linkOAuthProvider(supabase, host, provider, userId);
  }, [build, readiness, session?.user.id]);

  const reauthenticate = useCallback<AuthContextValue['reauthenticate']>(async (method, password) => {
    const host = getSupabaseHost();
    const userId = session?.user.id;
    const address = session?.user.email;
    if (!supabase || !host || !userId) return NO_BACKEND;
    let appleAuthorizationCode: string | undefined;
    if (method === 'email') {
      if (!address || !password || !email.signIn) return { ok: false, message: authFlowMessage('provider_disabled') };
      const { data, error: reauthError } = await supabase.auth.signInWithPassword({ email: address, password });
      if (reauthError) return { ok: false, message: signInErrorMessage(reauthError) };
      if (data.user?.id !== userId) { await supabase.auth.signOut(); return { ok: false, message: authFlowMessage('link_user_mismatch') }; }
    } else {
      if (!readiness(method).usableNow) return { ok: false, message: authFlowMessage('provider_disabled') };
      if (method === 'apple' && applePath(build) === 'native') {
        const result = await reauthWithAppleNative(supabase, userId);
        if (!result.ok) return result;
        appleAuthorizationCode = result.appleAuthorizationCode;
      } else {
        const result = await reauthWithOAuthProvider(supabase, host, method, userId);
        if (!result.ok) return result;
      }
    }
    // Pin the confirmation to the exact user + session this sign-in produced.
    const { data } = await supabase.auth.getSession();
    const sessionId = sessionIdOf(data.session);
    if (data.session?.user.id !== userId || !sessionId) return { ok: false, message: authFlowMessage('link_user_mismatch') };
    return { ok: true, context: { userId, sessionId }, appleAuthorizationCode };
  }, [build, email.signIn, readiness, session?.user.email, session?.user.id]);

  const callDeletion = useCallback(async (payload: Record<string, unknown>, accessToken: string) => {
    if (!config.ok) throw new Error('no backend');
    const response = await fetch(`${config.config.url.replace(/\/$/u, '')}/functions/v1/${ACCOUNT_DELETION_FUNCTION}`, {
      method: 'POST',
      headers: { apikey: config.config.publishableKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json().catch(() => null) as unknown };
  }, [config]);

  const previewDeletion = useCallback<AuthContextValue['previewDeletion']>(async () => {
    if (!supabase || !config.ok) return { ok: false, code: 'FAILED' };
    const { data } = await supabase.auth.getSession();
    if (!data.session) return { ok: false, code: 'AUTH_REQUIRED' };
    try {
      const { status, body } = await callDeletion({ action: 'preview' }, data.session.access_token);
      return parseDeletionPreview(status, body);
    } catch {
      return { ok: false, code: 'FAILED' };
    }
  }, [callDeletion, config.ok]);

  const deleteAccount = useCallback<AuthContextValue['deleteAccount']>(async ({ context, scope, appleAuthorizationCode }) => {
    if (!supabase || !config.ok) return { ok: false, code: 'FAILED' };
    const { data } = await supabase.auth.getSession();
    const current = data.session;
    if (!current) return { ok: false, code: 'AUTH_REQUIRED' };
    // The confirmation belongs to one user + session; any switch cancels it.
    if (!sameDeletionContext(context, { userId: current.user.id, sessionId: sessionIdOf(current) })) return { ok: false, code: 'SESSION_CHANGED' };
    let outcome: DeletionOutcome;
    try {
      const { status, body } = await callDeletion({
        action: 'delete',
        confirmation: ACCOUNT_DELETION_CONFIRMATION,
        expected_scope: scope,
        ...(appleAuthorizationCode ? { apple_authorization_code: appleAuthorizationCode } : {}),
      }, current.access_token);
      outcome = parseDeletionResponse(status, body);
    } catch {
      outcome = { ok: false, code: 'FAILED' };
    }
    if (!outcome.ok) return outcome;
    // The server confirmed: forget this device's session and per-user state.
    try { await AsyncStorage.removeItem(onboardingStorageKey(current.user.id)); } catch { /* best effort */ }
    await supabase.auth.signOut({ scope: 'local' });
    setSession(null);
    recoveryRef.current = null;
    setRecovery(null);
    return outcome;
  }, [callDeletion, config.ok]);

  const value = useMemo<AuthContextValue>(() => ({
    session, loading, error, backendAvailable: Boolean(supabase), readiness, email,
    settingsKnown: settings !== null, releaseReport, recoveryMode: recovery !== null,
    signIn: async (address, password) => {
      if (!supabase) return { ok: false, message: error ?? 'Supabase接続設定がありません。' };
      if (!email.signIn) return { ok: false, message: authFlowMessage('provider_disabled') };
      setError(null);
      const { error: signInError } = await supabase.auth.signInWithPassword({ email: address, password });
      if (signInError) { const message = signInErrorMessage(signInError); setError(message); return { ok: false, message }; }
      return { ok: true };
    },
    signUpWithEmail: async (address, password) => {
      if (!supabase) return NO_BACKEND;
      if (!email.signUp) return { ok: false, message: authFlowMessage('signup_disabled') };
      const { data, error: signUpError } = await supabase.auth.signUp({ email: address, password, options: { emailRedirectTo: AUTH_CALLBACK_URL } });
      // An "already registered" answer is shown exactly like a fresh sign-up (no enumeration).
      if (signUpError) return signUpErrorIsNeutral(signUpError.code) ? { ok: true, outcome: 'check_email' } : { ok: false, message: authFlowMessage(signUpError.code ?? null) };
      return { ok: true, outcome: classifySignUp({ session: data.session, user: data.user }) };
    },
    requestPasswordReset: async (address) => {
      if (!supabase) return NO_BACKEND;
      if (!email.reset) return { ok: false, message: authFlowMessage('provider_disabled') };
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(address, { redirectTo: AUTH_CALLBACK_URL });
      if (resetError?.code === 'over_email_send_rate_limit' || resetError?.status === 429) return { ok: false, message: authFlowMessage('over_email_send_rate_limit') };
      // Same answer whether or not the address exists (no account enumeration).
      return { ok: true, message: '登録済みのメールアドレスであれば、再設定用のメールを送りました。メール内のリンクをこの端末で開いてください。' };
    },
    completePasswordRecovery: async (password, confirmation) => {
      if (!supabase || !recoveryRef.current) return { ok: false, message: authFlowMessage('recovery_context_lost') };
      const startedRecovery = recoveryRef.current;
      const valid = validateNewPassword(password, confirmation);
      if (!valid.ok) return valid;
      // Re-check the exact recovery user/session immediately before changing the password.
      const { data } = await supabase.auth.getSession();
      if (recoveryRef.current !== startedRecovery || !recoveryMatches(startedRecovery, data.session)) {
        // A newer recovery link must not retarget this password action, nor be
        // discarded merely because an older action finished its session check.
        if (recoveryRef.current === startedRecovery) {
          recoveryRef.current = null;
          setRecovery(null);
        }
        return { ok: false, message: authFlowMessage('recovery_context_lost') };
      }
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) return { ok: false, message: authFlowMessage(updateError.code ?? null) };
      recoveryRef.current = null;
      setRecovery(null);
      return { ok: true };
    },
    signInWithProvider,
    linkProvider,
    signOut: async () => {
      if (!supabase) return { ok: true };
      const { error: signOutError } = await supabase.auth.signOut();
      if (signOutError) return { ok: false, message: 'ログアウトできませんでした。' };
      setSession(null);
      recoveryRef.current = null;
      setRecovery(null);
      return { ok: true };
    },
    accountDeletion: deletionAvailability({ enabledFlag: ACCOUNT_DELETION_ENABLED, backendAvailable: Boolean(supabase) }),
    reauthenticate,
    previewDeletion,
    deleteAccount,
  }), [deleteAccount, email, error, linkProvider, loading, previewDeletion, readiness, reauthenticate, recovery, releaseReport, session, settings, signInWithProvider]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
