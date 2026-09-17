import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { getSupabaseConfig, supabase } from '@/lib/supabase';

type AuthContextValue = {
  session: Session | null;
  loading: boolean;
  error: string | null;
  backendAvailable: boolean;
  signIn: (email: string, password: string) => Promise<{ ok: boolean; message?: string }>;
  signOut: () => Promise<{ ok: boolean; message?: string }>;
};
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const config = getSupabaseConfig();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(Boolean(supabase));
  const [error, setError] = useState<string | null>(config.ok ? null : config.reason);

  useEffect(() => {
    if (!supabase) return;
    let mounted = true;
    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!mounted) return;
      setSession(data.session);
      if (sessionError) setError('認証セッションを復元できませんでした。');
      setLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setError(null);
      setLoading(false);
    });
    return () => { mounted = false; listener.subscription.unsubscribe(); };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    session, loading, error, backendAvailable: Boolean(supabase),
    signIn: async (email, password) => {
      if (!supabase) return { ok: false, message: error ?? 'Supabase接続設定がありません。' };
      setError(null);
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) { setError('メールアドレスまたはパスワードを確認してください。'); return { ok: false, message: 'メールアドレスまたはパスワードを確認してください。' }; }
      return { ok: true };
    },
    signOut: async () => {
      if (!supabase) return { ok: true };
      const { error: signOutError } = await supabase.auth.signOut();
      if (signOutError) return { ok: false, message: 'ログアウトできませんでした。' };
      setSession(null);
      return { ok: true };
    },
  }), [error, loading, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
