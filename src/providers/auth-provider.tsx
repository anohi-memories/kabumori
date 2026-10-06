import { Session } from '@supabase/supabase-js';
import { createContext, ReactNode, useContext, useEffect, useRef, useState } from 'react';

import { prepareSession, reenrollKabumori, resetServiceEnrollment } from '@/lib/auth';
import { ENROLLMENT_NOTICE, type EnrollmentOutcome } from '@/lib/service-enrollment';
import { supabase } from '@/lib/supabase';

/** A decided enrollment that is not "ready": the app must not open for this session. */
export type ServiceAccess = Exclude<EnrollmentOutcome, { kind: 'ready' }>;

type AuthState = {
  session: Session | null;
  loading: boolean;
  /** A startup problem that happened before any session was accepted. */
  error: string | null;
  /**
   * The session is valid but its profile row could not be prepared. The session is deliberately
   * kept so the app can show a controlled recovery screen; dropping it here used to send the user
   * back to the login form, which told them their password was the problem when it was not.
   */
  profileError: string | null;
  /**
   * The common-account lifecycle refused Kabumori for this session (deletion in progress, locked, ...)
   * or the person ended Kabumori earlier. Fail closed: there is no profile-only fallback.
   */
  serviceAccess: ServiceAccess | null;
  /** Shown once when this session added Kabumori to a common account that already used another service. */
  enrollmentNotice: string | null;
  dismissEnrollmentNotice: () => void;
  retry: () => void;
  /** Explicit user action: use Kabumori again after ending it. */
  reenroll: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [serviceAccess, setServiceAccess] = useState<ServiceAccess | null>(null);
  const [enrollmentNotice, setEnrollmentNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [reenrollRequested, setReenrollRequested] = useState(false);
  const generation = useRef(0);
  // The shared-account notice belongs to the first enrollment of a person; the remembered outcome is
  // reused by later auth events (token refresh, ...), which must not show it again.
  const noticeShownFor = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    // An explicit re-enrollment applies to the first session this run accepts; every later event
    // shares that request through the enrollment gate instead of starting the service again.
    let reenrollOnce = reenrollRequested;
    async function acceptSession(nextSession: Session | null, requestGeneration: number) {
      if (!nextSession) {
        resetServiceEnrollment();
        noticeShownFor.current = null;
        if (active && requestGeneration === generation.current) {
          setSession(null);
          setError(null);
          setProfileError(null);
          setServiceAccess(null);
          setEnrollmentNotice(null);
          setLoading(false);
        }
        return;
      }

      try {
        const useReenroll = reenrollOnce;
        reenrollOnce = false;
        const outcome = await (useReenroll ? reenrollKabumori(nextSession) : prepareSession(nextSession));
        if (active && requestGeneration === generation.current) {
          setSession(nextSession);
          setError(null);
          setProfileError(null);
          setServiceAccess(outcome.kind === 'ready' ? null : outcome);
          if (outcome.kind === 'ready' && outcome.sharedAccountNotice && noticeShownFor.current !== nextSession.user.id) {
            noticeShownFor.current = nextSession.user.id;
            setEnrollmentNotice(ENROLLMENT_NOTICE);
          }
        }
      } catch (preparationError) {
        if (active && requestGeneration === generation.current) {
          setSession(nextSession);
          setError(null);
          setServiceAccess(null);
          setProfileError(
            preparationError instanceof Error
              ? preparationError.message
              : 'サービスの利用準備を確認できませんでした。',
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
  // reenrollRequested only changes together with attempt (see reenroll below).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        error,
        profileError,
        serviceAccess,
        enrollmentNotice,
        dismissEnrollmentNotice: () => setEnrollmentNotice(null),
        retry: () => {
          resetServiceEnrollment();
          setProfileError(null);
          setServiceAccess(null);
          setReenrollRequested(false);
          setLoading(true);
          setAttempt((value) => value + 1);
        },
        reenroll: () => {
          resetServiceEnrollment();
          setProfileError(null);
          setServiceAccess(null);
          setReenrollRequested(true);
          setLoading(true);
          setAttempt((value) => value + 1);
        },
      }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
