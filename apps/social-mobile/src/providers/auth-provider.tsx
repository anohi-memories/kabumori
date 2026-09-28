import type { Session } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { getSupabaseConfig, getSupabaseHost, supabase } from '@/lib/supabase';
import { signInErrorMessage } from '@/lib/auth-errors';
import {
  completeAuthCallbackUrl,
  isNativeAppleAvailable,
  linkOAuthProvider,
  signInWithAppleNative,
  signInWithOAuthProvider,
  type AuthFlowResult,
} from '@/lib/auth-client-flows';
import {
  AUTH_CALLBACK_URL,
  authFlowMessage,
  classifySignUp,
  providerAvailability,
  validateNewPassword,
  type ProviderAvailability,
  type SignUpOutcome,
} from '@/domain/auth-flows';

type SocialProvider = 'x' | 'google' | 'apple';

type AuthContextValue = {
  session: Session | null;
  loading: boolean;
  error: string | null;
  backendAvailable: boolean;
  /** Providers really enabled on the project (GET /auth/v1/settings); null while unknown. */
  providers: ProviderAvailability | null;
  nativeApple: boolean;
  /** A password-recovery session is active: the app must ask for a new password first. */
  recoveryMode: boolean;
  signIn: (email: string, password: string) => Promise<{ ok: boolean; message?: string }>;
  signUpWithEmail: (email: string, password: string) => Promise<{ ok: true; outcome: SignUpOutcome } | { ok: false; message: string }>;
  requestPasswordReset: (email: string) => Promise<{ ok: boolean; message: string }>;
  completePasswordRecovery: (password: string, confirmation: string) => Promise<{ ok: boolean; message?: string }>;
  signInWithProvider: (provider: SocialProvider) => Promise<AuthFlowResult>;
  linkProvider: (provider: SocialProvider) => Promise<AuthFlowResult>;
  signOut: () => Promise<{ ok: boolean; message?: string }>;
};
const AuthContext = createContext<AuthContextValue | null>(null);
const NO_BACKEND = { ok: false as const, message: 'Supabase接続設定がありません。' };

export function AuthProvider({ children }: PropsWithChildren) {
  const config = getSupabaseConfig();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(Boolean(supabase));
  const [error, setError] = useState<string | null>(config.ok ? null : config.reason);
  const [providers, setProviders] = useState<ProviderAvailability | null>(null);
  const [nativeApple, setNativeApple] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    let mounted = true;
    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!mounted) return;
      setSession(data.session);
      if (sessionError) setError('認証セッションを復元できませんでした。');
      setLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      setError(null);
      setLoading(false);
      if (event === 'PASSWORD_RECOVERY') setRecoveryMode(true);
      if (event === 'SIGNED_OUT') setRecoveryMode(false);
    });
    return () => { mounted = false; listener.subscription.unsubscribe(); };
  }, []);

  // Which sign-in methods the project really offers (public endpoint, publishable key only).
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(async () => {
      setNativeApple(await isNativeAppleAvailable());
      if (!config.ok) return;
      try {
        const response = await fetch(`${config.config.url.replace(/\/$/u, '')}/auth/v1/settings`, {
          headers: { apikey: config.config.publishableKey },
        });
        const body = response.ok ? await response.json() : null;
        if (!cancelled) setProviders(providerAvailability(body));
      } catch {
        if (!cancelled) setProviders(providerAvailability(null));
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

  const signInWithProvider = useCallback(async (provider: SocialProvider): Promise<AuthFlowResult> => {
    const host = getSupabaseHost();
    if (!supabase || !host) return NO_BACKEND;
    setError(null);
    if (provider === 'apple' && nativeApple) return signInWithAppleNative(supabase);
    return signInWithOAuthProvider(supabase, host, provider);
  }, [nativeApple]);

  const linkProvider = useCallback(async (provider: SocialProvider): Promise<AuthFlowResult> => {
    const host = getSupabaseHost();
    if (!supabase || !host) return NO_BACKEND;
    return linkOAuthProvider(supabase, host, provider);
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    session, loading, error, backendAvailable: Boolean(supabase), providers, nativeApple, recoveryMode,
    signIn: async (email, password) => {
      if (!supabase) return { ok: false, message: error ?? 'Supabase接続設定がありません。' };
      setError(null);
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) { const message = signInErrorMessage(signInError); setError(message); return { ok: false, message }; }
      return { ok: true };
    },
    signUpWithEmail: async (email, password) => {
      if (!supabase) return NO_BACKEND;
      const { data, error: signUpError } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: AUTH_CALLBACK_URL } });
      if (signUpError) return { ok: false, message: authFlowMessage(signUpError.code ?? null) };
      return { ok: true, outcome: classifySignUp({ session: data.session, user: data.user }) };
    },
    requestPasswordReset: async (email) => {
      if (!supabase) return NO_BACKEND;
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: AUTH_CALLBACK_URL });
      if (resetError?.code === 'over_email_send_rate_limit' || resetError?.status === 429) return { ok: false, message: authFlowMessage('over_email_send_rate_limit') };
      // Same answer whether or not the address exists (no account enumeration).
      return { ok: true, message: '登録済みのメールアドレスであれば、再設定用のメールを送りました。メール内のリンクをこの端末で開いてください。' };
    },
    completePasswordRecovery: async (password, confirmation) => {
      if (!supabase || !recoveryMode) return { ok: false, message: '再設定のリンクからやり直してください。' };
      const valid = validateNewPassword(password, confirmation);
      if (!valid.ok) return valid;
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) return { ok: false, message: authFlowMessage(updateError.code ?? null) };
      setRecoveryMode(false);
      return { ok: true };
    },
    signInWithProvider,
    linkProvider,
    signOut: async () => {
      if (!supabase) return { ok: true };
      const { error: signOutError } = await supabase.auth.signOut();
      if (signOutError) return { ok: false, message: 'ログアウトできませんでした。' };
      setSession(null);
      setRecoveryMode(false);
      return { ok: true };
    },
  }), [error, linkProvider, loading, nativeApple, providers, recoveryMode, session, signInWithProvider]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
