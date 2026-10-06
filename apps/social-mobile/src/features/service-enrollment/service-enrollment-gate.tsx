import { useCallback, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { colors, typography } from '@/constants/theme';
import { ActionButton, Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { SignOutButton } from '@/components/sign-out-button';
import { selectDataSource } from '@/data/repository-selection';
import {
  createEnrollmentGate,
  ENROLLMENT_NOTICE,
  enrollmentBlockedCopy,
  enrollService,
  REENROLL_COPY,
  type EnrollmentClient,
  type EnrollmentOutcome,
} from '@/domain/service-enrollment';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';
import AccountDeletionScreen from '@/app/account-deletion';

// One enrollment per signed-in person for the life of the app process. The client only calls the
// reviewed RPC and reads its own entitlement rows (RLS); it never writes a common-account table.
const enrollment = createEnrollmentGate((allowReenroll) => {
  if (!supabase) return Promise.reject(new Error('Supabase接続設定がありません。'));
  const client = supabase;
  const xEnrollment: EnrollmentClient = {
    readOwnEntitlements: () => client.from('service_entitlements').select('service_key,status'),
    startService: () => client.rpc('start_x_autopost_service'),
  };
  return enrollService(xEnrollment, 'x_autopost', { allowReenroll });
});

type View_ =
  | { userId: string | null; kind: 'loading' }
  | { userId: string | null; kind: 'error' }
  | { userId: string | null; kind: 'outcome'; outcome: EnrollmentOutcome; noticeAcknowledged: boolean };

/**
 * Real-data sessions are enrolled in X autopost (common-account `x_autopost` entitlement) before the
 * app loads any workspace data. Login alone creates no workspace, social account, OAuth state or
 * credential and enables no publishing; "Xを接続" remains the separate posting authorization. A refused
 * or ended enrollment keeps the app closed. The local mock preview is never gated.
 */
export function ServiceEnrollmentGate({ children }: PropsWithChildren) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const selection = useMemo(() => selectDataSource(), []);
  const [view, setView] = useState<View_>({ userId: null, kind: 'loading' });
  const [attempt, setAttempt] = useState<{ n: number; reenroll: boolean }>({ n: 0, reenroll: false });
  // The deletion view is opened for one user only; another user never inherits it.
  const [deletionOpenFor, setDeletionOpenFor] = useState<string | null>(null);

  // Leaving the signed-in tree (sign-out, recovery) forgets the remembered outcome.
  useEffect(() => () => enrollment.reset(), []);

  useEffect(() => {
    if (selection.kind === 'mock' || !userId) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      try {
        const outcome = await (attempt.reenroll ? enrollment.reenroll(userId) : enrollment.ensure(userId));
        if (!cancelled) setView({ userId, kind: 'outcome', outcome, noticeAcknowledged: false });
      } catch {
        if (!cancelled) setView({ userId, kind: 'error' });
      }
    });
    return () => { cancelled = true; };
  }, [attempt, selection, userId]);

  const retry = useCallback(() => {
    enrollment.reset();
    setView({ userId, kind: 'loading' });
    setAttempt((current) => ({ n: current.n + 1, reenroll: false }));
  }, [userId]);
  const reenroll = useCallback(() => {
    enrollment.reset();
    setView({ userId, kind: 'loading' });
    setAttempt((current) => ({ n: current.n + 1, reenroll: true }));
  }, [userId]);

  if (selection.kind === 'mock') return <>{children}</>;
  // Everything decided is tagged with the person it belongs to; another person never sees it.
  const current: View_ = view.userId === userId ? view : { userId, kind: 'loading' };
  if (current.kind === 'outcome' && current.outcome.kind === 'ready' && (!current.outcome.sharedAccountNotice || current.noticeAcknowledged)) {
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
