import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { colors, typography } from '@/constants/theme';
import { ActionButton, Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { SignOutButton } from '@/components/sign-out-button';
import { selectDataSource } from '@/data/repository-selection';
import { SupabaseOnboardingRepository } from '@/data/onboarding-repository';
import { deriveOnboardingStep, inputForCurrentUser, onboardingStorageKey, type OnboardingInput } from '@/domain/onboarding';
import { shouldShowNewAccountNotice } from '@/domain/auth-flows';
import { useAuth } from '@/providers/auth-provider';
import { useXConnect } from '@/features/x-connect/use-x-connect';
import AccountDeletionScreen from '@/app/account-deletion';
import { supabase } from '@/lib/supabase';
import { useDataStatus } from '@/providers/data-provider';

type LocalProgress = { settingsDeferred?: boolean; newAccountAcknowledged?: boolean };

async function readProgress(userId: string): Promise<LocalProgress> {
  try {
    const raw = await AsyncStorage.getItem(onboardingStorageKey(userId));
    const parsed = raw === null ? {} : JSON.parse(raw) as Record<string, unknown>;
    return { settingsDeferred: parsed.settingsDeferred === true, newAccountAcknowledged: parsed.newAccountAcknowledged === true };
  } catch {
    return {};
  }
}

async function writeProgress(userId: string, patch: LocalProgress): Promise<void> {
  try {
    await AsyncStorage.setItem(onboardingStorageKey(userId), JSON.stringify({ ...await readProgress(userId), ...patch }));
  } catch { /* the gate still re-checks the server on the next launch */ }
}

async function readDeferred(userId: string): Promise<boolean> {
  return (await readProgress(userId)).settingsDeferred === true;
}

/**
 * Secondary action shown on every unfinished onboarding screen. Account deletion
 * must stay reachable before Home (App Review 5.1.1(v)); the destination is the
 * same screen as the /account-deletion route, so recent-auth, the typed
 * confirmation and the user/session pinning are unchanged.
 */
function DeletionEntry({ onOpen }: { onOpen: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onOpen} style={({ pressed }) => [{ alignItems: 'center', paddingVertical: 10 }, pressed && styles.buttonPressed]}>
      <Text style={[styles.muted, { textDecorationLine: 'underline' }]}>アカウントの削除について</Text>
    </Pressable>
  );
}

const STEPS = ['ログイン', 'Xを接続', '接続を確認', '投稿の好み'] as const;

function Progress({ current }: { current: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {STEPS.map((label, index) => (
        <View key={label} style={{ flex: 1, gap: 4 }}>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: index <= current ? colors.primary : colors.border }} />
          <Text style={[styles.muted, index === current && { color: colors.primary, fontWeight: '700' }]}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Real-data first-run gate: signed-in users without a verified X account (or
 * without a settings decision) see the onboarding journey instead of Home.
 * The local mock preview is never gated.
 */
export function OnboardingGate({ children }: PropsWithChildren) {
  const { reload: reloadData } = useDataStatus();
  const { session } = useAuth();
  const currentUserId = session?.user.id ?? null;
  const selection = useMemo(() => selectDataSource(), []);
  const repository = useMemo(() => (supabase ? new SupabaseOnboardingRepository(supabase) : null), []);
  // Everything loaded is tagged with the user it belongs to; another user never sees it.
  const [loaded, setLoaded] = useState<{ userId: string | null; input: OnboardingInput; acknowledged: boolean }>(
    { userId: null, input: selection.kind === 'mock' ? { kind: 'mock' } : { kind: 'loading' }, acknowledged: false },
  );
  const [generation, setGeneration] = useState(0);
  // The deletion view is opened for one user only; another user never inherits it.
  const [deletionOpenFor, setDeletionOpenFor] = useState<string | null>(null);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    if (selection.kind === 'mock') return;
    let cancelled = false;
    // All state updates happen asynchronously (same pattern as DataProvider).
    void Promise.resolve().then(async () => {
      if (selection.kind === 'blocked' || !repository) {
        if (!cancelled) setLoaded({ userId: currentUserId, input: { kind: 'error', reason: selection.kind === 'blocked' ? selection.reason : 'Supabase clientを作成できません。' }, acknowledged: false });
        return;
      }
      try {
        const result = await repository.read(readDeferred);
        if (cancelled) return;
        const acknowledged = result.userId ? (await readProgress(result.userId)).newAccountAcknowledged === true : false;
        if (!cancelled) setLoaded({ userId: result.userId, input: result.input, acknowledged });
      } catch {
        if (!cancelled) setLoaded({ userId: currentUserId, input: { kind: 'error', reason: '初期設定の状態を確認できません。' }, acknowledged: false });
      }
    });
    return () => { cancelled = true; };
  }, [currentUserId, generation, repository, selection]);
  const input = inputForCurrentUser({ userId: loaded.userId, input: loaded.input }, currentUserId);
  const userId = loaded.userId === currentUserId ? currentUserId : null;

  const onConnected = useCallback(() => { refresh(); reloadData(); }, [refresh, reloadData]);
  const { state: connectState, stateText, verifiedHandle, connect } = useXConnect(onConnected);

  const deferSettings = useCallback(async () => {
    if (userId) await writeProgress(userId, { settingsDeferred: true });
    refresh();
  }, [refresh, userId]);
  const acknowledgeNewAccount = useCallback(async () => {
    if (!userId) return;
    await writeProgress(userId, { newAccountAcknowledged: true });
    setLoaded((current) => (current.userId === userId ? { ...current, acknowledged: true } : current));
  }, [userId]);

  const step = deriveOnboardingStep(input);
  if (step.step === 'preview' || step.step === 'done') return <>{children}</>;
  if (currentUserId !== null && deletionOpenFor === currentUserId) {
    return (
      <View style={{ flex: 1 }}>
        <Pressable accessibilityRole="button" onPress={() => setDeletionOpenFor(null)} style={{ padding: 16, paddingBottom: 0 }}>
          <Text style={{ color: colors.primary, fontWeight: '700' }}>‹ 戻る</Text>
        </Pressable>
        <AccountDeletionScreen />
      </View>
    );
  }
  const openDeletion = () => setDeletionOpenFor(currentUserId);
  const identities = (session?.user.identities ?? []).map((identity) => ({ provider: identity.provider }));
  // Display only (never authorization): how this session signed in.
  const signedInWithX = identities.some((identity) => identity.provider === 'x');
  const showNewAccountNotice = input.kind === 'loaded' && shouldShowNewAccountNotice({
    identities,
    hasWorkspace: input.brandIds.length > 0,
    acknowledged: loaded.acknowledged,
  });
  if (showNewAccountNotice) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={{ gap: 16 }}>
          <Card>
            <SectionTitle detail="新しいアカウントでこのアプリを始めます。">新しいアカウントを作成しました</SectionTitle>
            <Text style={styles.muted}>以前にメールアドレスなど別の方法で登録していた場合は、いったんログアウトして元の方法でログインし、「アカウント → ログイン方法」からこの方法を追加してください。別々のアカウントは自動ではまとめられません。</Text>
            <ActionButton label="このまま新しく始める" onPress={() => void acknowledgeNewAccount()} />
          </Card>
          <SignOutButton />
          <DeletionEntry onOpen={openDeletion} />
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <View style={{ gap: 6 }}>
          <Text style={typography.caption}>はじめての設定</Text>
          <Text style={typography.title}>Xアカウントとつなげましょう</Text>
        </View>
        {step.step === 'loading' ? (
          <Card><View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><ActivityIndicator color={colors.primary} /><Text style={styles.muted}>状態を確認しています…</Text></View></Card>
        ) : null}
        {step.step === 'error' || step.step === 'ambiguous' ? (
          <Card>
            <Pill tone="warning">{step.reason}</Pill>
            <Text style={styles.muted}>{step.step === 'ambiguous' ? '安全のため、どのアカウントも自動では選びません。サポートへご連絡ください。' : '通信状態を確認して、もう一度お試しください。'}</Text>
            {step.step === 'error' ? <ActionButton label="再読み込み" onPress={refresh} /> : null}
          </Card>
        ) : null}
        {step.step === 'connect_x' || step.step === 'reconnect_x' ? (
          <Card>
            <Progress current={1} />
            <SectionTitle detail="ログイン中のあなた本人のXアカウントだけを接続します。">
              {step.step === 'reconnect_x' ? 'Xアカウントを再接続' : 'Xアカウントを接続'}
            </SectionTitle>
            {step.step === 'reconnect_x' ? <Pill tone="warning">{step.reason}</Pill> : null}
            {step.step === 'connect_x' && step.resume ? <Text style={styles.muted}>前回の接続が完了していません。もう一度接続してください。</Text> : null}
            {signedInWithX ? <Text style={styles.muted}>Xでログインしました。このXアカウントを自動投稿にも使う場合は、下のボタンから投稿用の接続を行ってください（ログインとは別の許可です）。</Text> : null}
            <Text style={styles.muted}>{stateText}</Text>
            <Text style={styles.muted}>接続時に、Xのログイン画面で接続したいアカウントを選んで（またはログインして）ください。ブラウザの状態によっては、以前ログインしたアカウントが表示される場合があります。</Text>
            {connectState === 'connecting' ? <ActivityIndicator color={colors.primary} /> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: connectState === 'connecting' }}
              disabled={connectState === 'connecting'}
              onPress={() => void connect()}
              style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, connectState === 'connecting' && { opacity: 0.55 }]}
            >
              <Text style={styles.buttonText}>{step.step === 'reconnect_x' ? 'Xアカウントを再接続' : 'Xで認証する'}</Text>
            </Pressable>
            <Text style={styles.muted}>接続しても、投稿が勝手に始まることはありません。</Text>
          </Card>
        ) : null}
        {step.step === 'settings' ? (
          <Card>
            <Progress current={3} />
            <SectionTitle detail="接続したアカウントを確認してください。">接続できました</SectionTitle>
            <Pill tone="success">確認済み @{(verifiedHandle ?? step.account.handle).replace(/^@/u, '')}</Pill>
            <Text style={styles.muted}>
              {step.backendAvailable
                ? '次に、投稿のトーンやテーマを「設定」タブで登録すると、あなたらしい投稿案を作れるようになります。'
                : '投稿の好みを保存する機能は準備中です。準備ができたら「設定」タブから登録できます。'}
            </Text>
            <ActionButton label="ホームへ進む（投稿の好みはあとで設定）" onPress={() => void deferSettings()} />
          </Card>
        ) : null}
        <SignOutButton />
        <DeletionEntry onOpen={openDeletion} />
      </ScrollView>
    </Screen>
  );
}
