import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { colors, typography } from '@/constants/theme';
import { ActionButton, Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { SignOutButton } from '@/components/sign-out-button';
import { selectDataSource } from '@/data/repository-selection';
import { SupabaseOnboardingRepository } from '@/data/onboarding-repository';
import { deriveOnboardingStep, onboardingStorageKey, type OnboardingInput } from '@/domain/onboarding';
import { useXConnect } from '@/features/x-connect/use-x-connect';
import { supabase } from '@/lib/supabase';
import { useDataStatus } from '@/providers/data-provider';

async function readDeferred(userId: string): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(onboardingStorageKey(userId));
    return raw !== null && (JSON.parse(raw) as { settingsDeferred?: unknown }).settingsDeferred === true;
  } catch {
    return false;
  }
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
  const selection = useMemo(() => selectDataSource(), []);
  const repository = useMemo(() => (supabase ? new SupabaseOnboardingRepository(supabase) : null), []);
  const [input, setInput] = useState<OnboardingInput>(selection.kind === 'mock' ? { kind: 'mock' } : { kind: 'loading' });
  const [userId, setUserId] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    if (selection.kind === 'mock') return;
    let cancelled = false;
    // All state updates happen asynchronously (same pattern as DataProvider).
    void Promise.resolve().then(async () => {
      if (selection.kind === 'blocked' || !repository) {
        if (!cancelled) setInput({ kind: 'error', reason: selection.kind === 'blocked' ? selection.reason : 'Supabase clientを作成できません。' });
        return;
      }
      if (!cancelled) setInput({ kind: 'loading' });
      try {
        const result = await repository.read(readDeferred);
        if (cancelled) return;
        setUserId(result.userId);
        setInput(result.input);
      } catch {
        if (!cancelled) setInput({ kind: 'error', reason: '初期設定の状態を確認できません。' });
      }
    });
    return () => { cancelled = true; };
  }, [generation, repository, selection]);

  const onConnected = useCallback(() => { refresh(); reloadData(); }, [refresh, reloadData]);
  const { state: connectState, stateText, verifiedHandle, connect } = useXConnect(onConnected);

  const deferSettings = useCallback(async () => {
    if (userId) {
      try {
        await AsyncStorage.setItem(onboardingStorageKey(userId), JSON.stringify({ settingsDeferred: true }));
      } catch { /* the gate still re-checks the server on the next launch */ }
    }
    refresh();
  }, [refresh, userId]);

  const step = deriveOnboardingStep(input);
  if (step.step === 'preview' || step.step === 'done') return <>{children}</>;

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
            <Text style={styles.muted}>{stateText}</Text>
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
      </ScrollView>
    </Screen>
  );
}
