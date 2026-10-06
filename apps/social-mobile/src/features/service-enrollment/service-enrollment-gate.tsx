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

const enrollment = createEnrollmentGate((context, signal) => startServiceAutomatically(transportFor(context), 'x_autopost', signal));

type Owner = { userId: string | null; loginId: string | null };
type GateView =
  | (Owner & { request: number; kind: 'loading' })
  | (Owner & { request: number; kind: 'error' })
  | (Owner & { request: number; kind: 'outcome'; outcome: EnrollmentOutcome; noticeAcknowledged: boolean });

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

  // Leaving the signed-in tree (sign-out, recovery) cancels pending work and forgets the outcome.
  useEffect(() => () => enrollment.reset(), []);

  useEffect(() => {
    currentOwner.current = { userId, loginId };
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

  if (selection.kind === 'mock') return <>{children}</>;
  // Everything decided is tagged with the person and login it belongs to; nobody else sees it.
  const current: GateView = isOwner(view, userId, loginId) ? view : { userId, loginId, request: 0, kind: 'loading' };
  if (loginId !== null && current.kind === 'outcome' && current.outcome.kind === 'ready'
      && (!current.outcome.sharedAccountNotice || current.noticeAcknowledged)) {
    return <>{children}</>;
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
