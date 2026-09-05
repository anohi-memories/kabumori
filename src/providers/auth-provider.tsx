import { Session } from '@supabase/supabase-js';
import { createContext, ReactNode, useContext, useEffect, useRef, useState } from 'react';

import { prepareSession } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

type AuthState = {
  session: Session | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    async function acceptSession(nextSession: Session | null, requestGeneration: number) {
      if (!nextSession) {
        if (active && requestGeneration === generation.current) {
          setSession(null);
          setError(null);
          setLoading(false);
        }
        return;
      }

      try {
        await prepareSession(nextSession);
        if (active && requestGeneration === generation.current) {
          setSession(nextSession);
          setError(null);
        }
      } catch (profileError) {
        if (active && requestGeneration === generation.current) {
          setSession(null);
          setError(
            profileError instanceof Error
              ? profileError.message
              : 'プロフィールを準備できませんでした。',
          );
        }
      } finally {
        if (active && requestGeneration === generation.current) setLoading(false);
      }
    }

    supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (sessionError) {
        if (active) {
          setError('ログイン状態を確認できませんでした。');
          setLoading(false);
        }
        return;
      }
      const requestGeneration = ++generation.current;
      void acceptSession(data.session, requestGeneration);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      // Supabaseの内部ロック中に別のAuth/Data APIをawaitしないよう、次のタスクで処理する。
      setTimeout(() => {
        if (!active) return;
        const requestGeneration = ++generation.current;
        setLoading(!!nextSession);
        void acceptSession(nextSession, requestGeneration);
      }, 0);
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [attempt]);

  return (
    <AuthContext.Provider
      value={{ session, loading, error, retry: () => { setLoading(true); setAttempt((value) => value + 1); } }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
