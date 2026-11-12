import { useCallback, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { colors, typography } from '@/constants/theme';
import { ActionButton, Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { SignOutButton } from '@/components/sign-out-button';
import { selectDataSource } from '@/data/repository-selection';
import {
  createEnrollmentGate,
  createSessionBoundTransport,
  ENROLLMENT_NOTICE,
  enrollmentBlockedCopy,
  EnrollmentCancelledError,
  EnrollmentUnavailableError,
  loginSessionIdOf,
  reactivateServiceExplicitly,
  REENROLL_COPY,
  startServiceAutomatically,
  type EnrollmentContext,
  type EnrollmentOutcome,
} from '@/domain/service-enrollment';
import { POSTONA_APPROVAL_UI_ENABLED } from '@/features/approvals/approval-gate';
import { EndedHistory } from '@/features/approvals/ended-history';
import { markXServiceRestarted } from '@/features/reservations/x-reconnect-signal';
import { type LifecycleCheck, type ServiceLifecycle, ServiceLifecycleContext } from '@/features/service-enrollment/service-lifecycle';
import { getSupabaseConfig } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';
import AccountDeletionScreen from '@/app/account-deletion';

// Each request carries the access token of the session it was started for -- never a shared client's
// later token -- and the gate cancels it (unsent) when the person signs out, or another person or another
// login of the same person starts, first. Everything is tagged with the person and the login (the token's
// session id: a refresh keeps it, a new sign-in changes it). The client only calls the reviewed RPCs; it
// never writes a common-account table.
function transportFor(context: EnrollmentContext) {
  const config = getSupabaseConfig();
  if (!config.ok) throw new EnrollmentUnavailableError();
  return createSessionBoundTransport({ url: config.config.url, apiKey: config.config.publishableKey, accessToken: context.accessToken });
}

// The automatic start: at sign-in through the gate below, and (G1 TASK 47) as the fresh check a screen asks for before it writes.
const startX = (context: EnrollmentContext, signal: AbortSignal) => startServiceAutomatically(transportFor(context), 'x_autopost', signal);
const enrollment = createEnrollmentGate(startX);

type Owner = { userId: string | null; loginId: string | null };
type GateView =
  | (Owner & { request: number; kind: 'loading' })
  | (Owner & { request: number; kind: 'error' })
  | (Owner & { request: number; kind: 'outcome'; outcome: EnrollmentOutcome; noticeAcknowledged: boolean });

/** The one way into the ended service's history: it reads, it never writes. */
export const ENDED_HISTORY_ACTION = 'これまでの承認とお知らせを見る（閲覧のみ）';

const isOwner = (owner: Owner, userId: string | null, loginId: string | null) => owner.userId === userId && owner.loginId === loginId;

/**
 * Real-data sessions are enrolled in X autopost (common-account `x_autopost` entitlement) before the
 * app loads any workspace data. Login alone creates no workspace, social account, OAuth state or
 * credential and enables no publishing; "Xを接続" remains the separate posting authorization. A refused
 * or ended enrollment keeps the app closed; an ended one is restarted only by the person's own click,
 * sent at once for that person and login. The local mock preview is never gated.
 */
export function ServiceEnrollmentGate({ children }: PropsWithChildren) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const accessToken = session?.access_token ?? null;
  // The login of this session; null when the token cannot be identified (never enrolled, never ready).
  const loginId = userId && accessToken ? loginSessionIdOf(userId, accessToken) : null;
  const selection = useMemo(() => selectDataSource(), []);
  const [view, setView] = useState<GateView>({ userId: null, loginId: null, request: 0, kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // Every automatic run and every click is one request; only the latest may change the view.
  const request = useRef(0);
  // The person and login the gate shows now; queued work and answers only apply while they are unchanged.
  const currentOwner = useRef<Owner>({ userId, loginId });
  const explicitInFlight = useRef(false);
  // The deletion view is opened for one user only; another user never inherits it.
  const [deletionOpenFor, setDeletionOpenFor] = useState<string | null>(null);
  // G1 TASK 46: the read-only history of an ended service, opened for one person and login only.
  const [historyOpenFor, setHistoryOpenFor] = useState<string | null>(null);

  // Leaving the signed-in tree (sign-out, recovery) cancels pending work and forgets the outcome.
  useEffect(() => () => enrollment.reset(), []);

  // G1 TASK 47: the fresh lifecycle checks under way; another person or login (or leaving the tree) cancels them unanswered.
  const checks = useRef<AbortController[]>([]);

  useEffect(() => {
    currentOwner.current = { userId, loginId };
    return () => { for (const controller of checks.current) controller.abort(); checks.current = []; };
  }, [userId, loginId]);

  // Automatic enrollment for the current login (first render, another person, another login of the same
  // person, an explicit retry). A token refresh of the same login does not re-enroll.
  useEffect(() => {
    if (selection.kind === 'mock' || !userId || !accessToken) return;
    const mine = ++request.current;
    let cancelled = false;
    // All state updates happen asynchronously (same pattern as DataProvider). The queued work is checked
    // before anything is sent: a cleanup since it was queued (unmount on sign-out or recovery, another
    // person or login, a retry) or a newer request cancels it unsent, so it cannot recreate gate state.
    void Promise.resolve().then(async () => {
      if (cancelled || mine !== request.current || !isOwner(currentOwner.current, userId, loginId)) return;
      try {
        const outcome = await enrollment.ensure({ userId, accessToken });
        if (!cancelled && mine === request.current) setView({ userId, loginId, request: mine, kind: 'outcome', outcome, noticeAcknowledged: false });
      } catch (failure) {
        if (failure instanceof EnrollmentCancelledError) return;
        if (!cancelled && mine === request.current) setView({ userId, loginId, request: mine, kind: 'error' });
      }
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, selection, userId, loginId]);

  const retry = useCallback(() => {
    enrollment.reset();
    setView({ userId, loginId, request: ++request.current, kind: 'loading' });
    setAttempt((value) => value + 1);
  }, [userId, loginId]);

  // The person's own click: sent now, once, for exactly this person and login, at the version the server
  // reported. Nothing is remembered for later, so another person or a later login never inherits it.
  const reenroll = useCallback(() => {
    if (explicitInFlight.current || !userId || !accessToken || !loginId) return;
    if (view.kind !== 'outcome' || !isOwner(view, userId, loginId) || view.outcome.kind !== 'reenroll_required') return;
    const lifecycleVersion = view.outcome.lifecycleVersion;
    const clicked: Owner = { userId, loginId };
    const mine = ++request.current;
    explicitInFlight.current = true;
    setView({ ...clicked, request: mine, kind: 'loading' });
    enrollment
      .explicit({ userId, accessToken }, (context, signal) =>
        reactivateServiceExplicitly(transportFor(context), 'x_autopost', lifecycleVersion, signal))
      .then(
        (outcome) => {
          if (outcome.kind === 'ready' && clicked.userId) markXServiceRestarted(clicked.userId);
          if (mine === request.current && isOwner(currentOwner.current, clicked.userId, clicked.loginId)) {
            setView({ ...clicked, request: mine, kind: 'outcome', outcome, noticeAcknowledged: false });
          }
        },
        (failure: unknown) => {
          if (failure instanceof EnrollmentCancelledError) return;
          if (mine === request.current && isOwner(currentOwner.current, clicked.userId, clicked.loginId)) {
            setView({ ...clicked, request: mine, kind: 'error' });
          }
        },
      )
      .finally(() => { explicitInFlight.current = false; });
  }, [accessToken, loginId, userId, view]);

  // G1 TASK 47 (G2 #11 P3): a screen asks before it writes. The same start RPC as at sign-in, with this login's token; it never
  // restarts an ended service. Only 'ready' for the same person and login is 'active'. An ended (or definitely refused) service closes
  // the app to this gate's own screen for that login, where the read-only history is; no answer changes nothing and confirms nothing.
  const confirmActive = useCallback((): Promise<LifecycleCheck> => {
    if (selection.kind === 'mock' || !userId || !accessToken || !loginId) return Promise.resolve('unknown');
    const asked: Owner = { userId, loginId };
    const controller = new AbortController();
    checks.current = [...checks.current, controller];
    // transportFor throws when the server is not configured: that is no answer, not a crash.
    return Promise.resolve().then(() => startX({ userId, accessToken }, controller.signal)).then(
      (outcome): LifecycleCheck => {
        if (controller.signal.aborted || !isOwner(currentOwner.current, asked.userId, asked.loginId)) return 'unknown';
        if (outcome.kind === 'ready') return 'active';
        if (outcome.kind === 'blocked' && outcome.reason === 'UNKNOWN') return 'unknown';
        // Decided by the server: the next automatic run for this login asks again rather than reusing the earlier 'ready'.
        enrollment.reset();
        setView({ ...asked, request: ++request.current, kind: 'outcome', outcome, noticeAcknowledged: false });
        return outcome.kind === 'reenroll_required' ? 'ended' : 'unknown';
      },
      (): LifecycleCheck => 'unknown',
    ).finally(() => { checks.current = checks.current.filter((running) => running !== controller); });
  }, [accessToken, loginId, selection, userId]);
  const lifecycle = useMemo<ServiceLifecycle>(() => ({ userId, confirmActive }), [confirmActive, userId]);

  if (selection.kind === 'mock') return <>{children}</>;
  // Everything decided is tagged with the person and login it belongs to; nobody else sees it.
  const current: GateView = isOwner(view, userId, loginId) ? view : { userId, loginId, request: 0, kind: 'loading' };
  if (loginId !== null && current.kind === 'outcome' && current.outcome.kind === 'ready'
      && (!current.outcome.sharedAccountNotice || current.noticeAcknowledged)) {
    return <ServiceLifecycleContext.Provider value={lifecycle}>{children}</ServiceLifecycleContext.Provider>;
  }

  if (userId !== null && deletionOpenFor === userId) {
    return (
      <View style={{ flex: 1 }}>
        <Pressable accessibilityRole="button" onPress={() => setDeletionOpenFor(null)} style={{ padding: 16, paddingBottom: 0 }}>
          <Text style={{ color: colors.primary, fontWeight: '700' }}>‹ 戻る</Text>
        </Pressable>
        <AccountDeletionScreen />
      </View>
    );
  }

  const historyKey = userId && loginId ? `${userId}\n${loginId}` : null;
  const ended = current.kind === 'outcome' && current.outcome.kind === 'reenroll_required';
  if (POSTONA_APPROVAL_UI_ENABLED && ended && historyKey !== null && historyOpenFor === historyKey) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={{ gap: 16 }}>
          <Pressable accessibilityRole="button" onPress={() => setHistoryOpenFor(null)} style={{ paddingBottom: 0 }}>
            <Text style={{ color: colors.primary, fontWeight: '700' }}>‹ 戻る</Text>
          </Pressable>
          <EndedHistory userId={userId} />
        </ScrollView>
      </Screen>
    );
  }

  let body;
  if (current.kind === 'loading') {
    body = (
      <Card>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.muted}>サービスの利用準備を確認しています…</Text>
        </View>
      </Card>
    );
  } else if (current.kind === 'error') {
    body = (
      <Card>
        <Pill tone="warning">サービスの利用準備を確認できませんでした。</Pill>
        <Text style={styles.muted}>通信状態を確認して、もう一度お試しください。</Text>
        <ActionButton label="再読み込み" onPress={retry} />
      </Card>
    );
  } else if (current.outcome.kind === 'ready') {
    // Only reached for the one-time shared-account notice.
    body = (
      <Card>
        <SectionTitle detail={ENROLLMENT_NOTICE}>利用登録が完了しました</SectionTitle>
        <ActionButton
          label="はじめる"
          onPress={() => setView((previous) => (previous.kind === 'outcome' ? { ...previous, noticeAcknowledged: true } : previous))}
        />
      </Card>
    );
  } else if (current.outcome.kind === 'reenroll_required') {
    body = (
      <Card>
        <SectionTitle detail={REENROLL_COPY.description}>{REENROLL_COPY.title}</SectionTitle>
        <ActionButton label={REENROLL_COPY.action} onPress={reenroll} />
        {POSTONA_APPROVAL_UI_ENABLED && historyKey !== null
          ? <ActionButton label={ENDED_HISTORY_ACTION} onPress={() => setHistoryOpenFor(historyKey)} />
          : null}
      </Card>
    );
  } else {
    const copy = enrollmentBlockedCopy(current.outcome.reason);
    body = (
      <Card>
        <SectionTitle detail={copy.description}>{copy.title}</SectionTitle>
        {copy.canRetry ? <ActionButton label="再読み込み" onPress={retry} /> : null}
      </Card>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <View style={{ gap: 6 }}>
          <Text style={typography.caption}>ご利用の準備</Text>
          <Text style={typography.title}>X自動投稿</Text>
        </View>
        {body}
        <SignOutButton />
        <Pressable
          accessibilityRole="button"
          onPress={() => setDeletionOpenFor(userId)}
          style={({ pressed }) => [{ alignItems: 'center', paddingVertical: 10 }, pressed && styles.buttonPressed]}
        >
          <Text style={[styles.muted, { textDecorationLine: 'underline' }]}>アカウントの削除について</Text>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}
