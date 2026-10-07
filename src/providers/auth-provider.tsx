import { Session } from '@supabase/supabase-js';
import { createContext, ReactNode, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { prepareSession, reactivateKabumori, resetServiceEnrollment } from '@/lib/auth';
import { ENROLLMENT_NOTICE, EnrollmentCancelledError, loginSessionIdOf, type EnrollmentOutcome } from '@/lib/service-enrollment';
import {
  serviceAccessOf,
  serviceFailureOf,
  serviceReadySession,
  type ServiceAccess,
  type ServiceState,
} from '@/lib/service-session';
import { supabase } from '@/lib/supabase';

export type { ServiceAccess } from '@/lib/service-session';

type AuthState = {
  session: Session | null;
  loading: boolean;
  /** A startup problem that happened before any session was accepted. */
  error: string | null;
  /**
   * The session is valid but its Kabumori service could not be prepared (a transient failure). The
   * session is deliberately kept so the app can show a controlled recovery screen; dropping it here used
   * to send the user back to the login form, which told them their password was the problem when it was not.
   */
  profileError: string | null;
  /**
   * The common-account lifecycle refused Kabumori for this session (deletion in progress, locked, ...)
   * or the person ended Kabumori earlier. Fail closed: there is no profile-only fallback.
   */
  serviceAccess: ServiceAccess | null;
  /**
   * The session only once its enrollment is positively ready for this exact person and login (a new
   * sign-in of the same person needs its own) and no request is pending; null otherwise. The app and its
   * side effects (push, notification routing) use this.
   */
  serviceSession: Session | null;
  /** Shown once when this session added Kabumori to a common account that already used another service. */
  enrollmentNotice: string | null;
  dismissEnrollmentNotice: () => void;
  retry: () => void;
  /** Explicit user action on the "ended" screen: restart Kabumori at the version the server reported. */
  reenroll: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

type Settled = { outcome: EnrollmentOutcome } | { failure: unknown };

/** The login a session belongs to: its token's session id, kept by a refresh, new for every sign-in. */
function loginOf(session: Session) {
  return loginSessionIdOf(session.user.id, session.access_token);
}

/** Person + login of a session ('' when signed out). In memory only. */
function ownerOf(session: Session | null) {
  return session ? `${session.user.id}/${loginOf(session) ?? ''}` : '';
}

/**
 * The owner the Supabase SDK announced last, recorded synchronously in its auth callback (undefined before
 * the first announcement). Readiness is computed against it, so once another person or login (or a
 * sign-out) is announced nothing of the previous owner can be ready -- even before the deferred handling
 * of that event has run.
 */
function createAnnouncedOwner() {
  let owner: string | undefined;
  let listeners: (() => void)[] = [];
  return {
    current: () => owner,
    subscribe: (listener: () => void) => {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((other) => other !== listener);
      };
    },
    /** Records the announced session's owner; true when it is another person or login, or a sign-out. */
    announce(session: Session | null) {
      const next = ownerOf(session);
      if (next === owner) return false;
      owner = next;
      listeners.forEach((listener) => listener());
      return true;
    },
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [service, setService] = useState<ServiceState>({ phase: 'signed_out' });
  const [enrollmentNotice, setEnrollmentNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Every accepted session and every explicit action is one request; only the latest may settle.
  const generation = useRef(0);
  const mounted = useRef(true);
  // The shared-account notice belongs to the first enrollment of a person; the remembered outcome is
  // reused by later auth events (token refresh, ...), which must not show it again.
  const noticeShownFor = useRef<string | null>(null);
  // One explicit restart at a time: a second tap before the first settles sends nothing.
  const explicitInFlight = useRef(false);
  const [announced] = useState(createAnnouncedOwner);
  const announcedOwner = useSyncExternalStore(announced.subscribe, announced.current);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function settle(nextSession: Session, request: number, settled: Settled) {
    if (!mounted.current || request !== generation.current) return;
    const owner = { userId: nextSession.user.id, sessionId: loginOf(nextSession), request };
    if ('failure' in settled) {
      // Superseded by a newer request (sign-out, another person, an explicit action); that one settles.
      if (settled.failure instanceof EnrollmentCancelledError) return;
      setSession(nextSession);
      setError(null);
      setService({
        phase: 'failed',
        ...owner,
        message: settled.failure instanceof Error ? settled.failure.message : 'サービスの利用準備を確認できませんでした。',
      });
    } else if (settled.outcome.kind === 'ready') {
      setSession(nextSession);
      setError(null);
      setService({ phase: 'ready', ...owner });
      if (settled.outcome.sharedAccountNotice && noticeShownFor.current !== nextSession.user.id) {
        noticeShownFor.current = nextSession.user.id;
        setEnrollmentNotice(ENROLLMENT_NOTICE);
      }
    } else {
      setSession(nextSession);
      setError(null);
      setService({ phase: 'refused', ...owner, access: settled.outcome });
    }
    setLoading(false);
  }
  const settleRef = useRef(settle);
  settleRef.current = settle;

  useEffect(() => {
    let active = true;
    function acceptSession(nextSession: Session | null, request: number) {
      if (!nextSession) {
        resetServiceEnrollment();
        noticeShownFor.current = null;
        if (active && request === generation.current) {
          setSession(null);
          setError(null);
          setService({ phase: 'signed_out' });
          setEnrollmentNotice(null);
          setLoading(false);
        }
        return;
      }
      // Pending until this request settles: nothing may act on the session meanwhile.
      if (active && request === generation.current) {
        setService({ phase: 'pending', userId: nextSession.user.id, sessionId: loginOf(nextSession), request });
      }
      prepareSession(nextSession).then(
        (outcome) => {
          if (active) settleRef.current(nextSession, request, { outcome });
        },
        (failure: unknown) => {
          if (active) settleRef.current(nextSession, request, { failure });
        },
      );
    }

    supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (sessionError) {
        if (active) {
          setError('ログイン状態を確認できませんでした。');
          setLoading(false);
        }
        return;
      }
      // The SDK's own announcements are newer than this read; it only fills the gap before the first one.
      if (announced.current() === undefined) announced.announce(data.session);
      if (announced.current() !== ownerOf(data.session)) return;
      acceptSession(data.session, ++generation.current);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      // Synchronously, before any pending answer can settle: another person or login, or a sign-out, fences
      // every older request (generation) and cancels its unsent work. Nothing here calls Auth/Data APIs; a
      // token refresh of the same login changes nothing here and keeps its pending request.
      if (active && announced.announce(nextSession)) {
        ++generation.current;
        resetServiceEnrollment();
      }
      // Supabaseの内部ロック中に別のAuth/Data APIをawaitしないよう、次のタスクで処理する。
      setTimeout(() => {
        if (!active) return;
        const request = ++generation.current;
        setLoading(!!nextSession);
        acceptSession(nextSession, request);
      }, 0);
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [attempt]);

  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        error,
        profileError: serviceFailureOf(service),
        serviceAccess: serviceAccessOf(service),
        serviceSession:
          session && announcedOwner === ownerOf(session)
            ? serviceReadySession(session, loginOf(session), loading, service)
            : null,
        enrollmentNotice,
        dismissEnrollmentNotice: () => setEnrollmentNotice(null),
        retry: () => {
          resetServiceEnrollment();
          ++generation.current;
          setService((previous) =>
            previous.phase === 'signed_out'
              ? previous
              : { phase: 'pending', userId: previous.userId, sessionId: previous.sessionId, request: generation.current },
          );
          setLoading(true);
          setAttempt((value) => value + 1);
        },
        reenroll: () => {
          const current = session;
          const sessionId = current ? loginOf(current) : null;
          // Only the login that was shown the restart screen, while it is still the announced one, may confirm it.
          if (
            explicitInFlight.current ||
            !current ||
            sessionId === null ||
            announced.current() !== ownerOf(current) ||
            service.phase !== 'refused' ||
            service.access.kind !== 'reenroll_required' ||
            service.userId !== current.user.id ||
            service.sessionId !== sessionId
          ) {
            return;
          }
          const lifecycleVersion = service.access.lifecycleVersion;
          const request = ++generation.current;
          explicitInFlight.current = true;
          setService({ phase: 'pending', userId: current.user.id, sessionId, request });
          setLoading(true);
          // Sent now, once, with this session's own token. A newer request, another login (whose automatic
          // start aborts it) or sign-out supersedes it; an answer that still arrives is never settled.
          reactivateKabumori(current, lifecycleVersion)
            .then(
              (outcome) => settleRef.current(current, request, { outcome }),
              (failure: unknown) => settleRef.current(current, request, { failure }),
            )
            .finally(() => {
              explicitInFlight.current = false;
            });
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
