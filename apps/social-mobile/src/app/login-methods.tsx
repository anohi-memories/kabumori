import type { UserIdentity } from '@supabase/supabase-js';
import { Link } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { colors } from '@/constants/theme';
import { Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { PROVIDER_LABELS, type SocialProviderId } from '@/domain/auth-flows';
import { formatAuthDiagnostics, RELEASE_PROVIDERS, USER_PROVIDER_STATUS_LABELS, userProviderStatus } from '@/domain/auth-release-readiness';
import { postingXStatus, POSTING_X_STATUS_LABELS } from '@/domain/account-security';
import { supabase } from '@/lib/supabase';
import { useActiveAccount } from '@/providers/active-account-provider';
import { useAuth } from '@/providers/auth-provider';
import { useDataStatus } from '@/providers/data-provider';

function label(provider: string): string {
  return (PROVIDER_LABELS as Record<string, string>)[provider] ?? provider;
}

const statusTone = { linked: 'success', available: 'neutral', setup_pending: 'warning' } as const;

/**
 * The signed-in user's account and login methods. Identities come from the
 * authenticated Supabase user only (no profile metadata, no provider tokens).
 * Adding a method is the explicit Phase 2 linkIdentity() path; there is no
 * unlink. Posting-account X is a separate connection managed on Accounts.
 */
export default function LoginMethodsScreen() {
  const { session, linkProvider, readiness, email, requestPasswordReset, releaseReport } = useAuth();
  const { accounts } = useActiveAccount();
  const { status: dataStatus } = useDataStatus();
  const [identities, setIdentities] = useState<UserIdentity[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  const userId = session?.user.id ?? null;
  const address = session?.user.email || null;
  const emailConfirmed = Boolean(session?.user.email_confirmed_at);

  useEffect(() => {
    if (!supabase || !userId) return;
    const client = supabase;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (!cancelled) setIdentities(null);
      const { data, error } = await client.auth.getUserIdentities();
      if (cancelled) return;
      if (error) { setIdentities([]); setMessage({ tone: 'warning', text: 'ログイン方法を読み込めませんでした。' }); return; }
      setIdentities(data.identities);
    });
    return () => { cancelled = true; };
  }, [generation, userId]);

  async function link(provider: SocialProviderId) {
    setBusy(provider); setMessage(null);
    const result = await linkProvider(provider);
    setBusy(null);
    if (result.ok) { setMessage({ tone: 'success', text: `${label(provider)}をログイン方法に追加しました。` }); reload(); }
    else if (!result.cancelled) setMessage({ tone: 'warning', text: result.message });
  }

  async function sendReset() {
    if (!address) return;
    setBusy('reset'); setMessage(null);
    const result = await requestPasswordReset(address);
    setBusy(null);
    setMessage({ tone: result.ok ? 'success' : 'warning', text: result.message });
  }

  const linked = new Set((identities ?? []).map((identity) => identity.provider));
  const extra = (identities ?? []).filter((identity) => !(RELEASE_PROVIDERS as readonly string[]).includes(identity.provider));
  const postingX = postingXStatus(dataStatus, accounts);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <SectionTitle detail="アプリへのログインに使う方法と、パスワードの再設定を確認できます。">ログイン方法</SectionTitle>

        <Card>
          <Text style={{ color: colors.ink, fontWeight: '800' }}>ログイン中のアカウント</Text>
          <Text style={styles.muted}>メールアドレス</Text>
          <Text style={{ color: colors.ink }}>{address ?? 'メールアドレスは登録されていません'}</Text>
          {address ? <Pill tone={emailConfirmed ? 'success' : 'warning'}>{emailConfirmed ? '確認済み' : '未確認'}</Pill> : null}
        </Card>

        <Card>
          <Text style={{ color: colors.ink, fontWeight: '800' }}>ログイン方法</Text>
          <Text style={styles.muted}>追加は、いまログインしているアカウントに対してのみ行えます。別のアカウントで使われている方法は追加できません。ログイン方法の削除は、現在このアプリではできません。</Text>
          {identities === null ? <ActivityIndicator color={colors.primary} /> : RELEASE_PROVIDERS.map((provider) => {
            const state = userProviderStatus(readiness(provider), linked.has(provider));
            const canAdd = provider !== 'email' && state === 'available';
            return (
              <View key={provider} style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={{ color: colors.ink, fontWeight: '700' }}>{label(provider)}</Text>
                  <Pill tone={statusTone[state]}>{USER_PROVIDER_STATUS_LABELS[state]}</Pill>
                </View>
                {provider === 'email' && state !== 'linked' ? <Text style={styles.muted}>メールアドレスでのログインの追加は、現在このアプリでは準備中です。</Text> : null}
                {provider !== 'email' && state === 'setup_pending' ? <Text style={styles.muted}>このログイン方法は現在準備中です。準備ができると追加できるようになります。</Text> : null}
                {canAdd ? (
                  <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => void link(provider)} style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, busy !== null && { opacity: 0.5 }]}>
                    {busy === provider ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{label(provider)}を追加</Text>}
                  </Pressable>
                ) : null}
              </View>
            );
          })}
          {extra.map((identity) => (
            <View key={identity.identity_id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: colors.ink, fontWeight: '700' }}>{label(identity.provider)}</Text>
              <Pill tone="success">{USER_PROVIDER_STATUS_LABELS.linked}</Pill>
            </View>
          ))}
        </Card>

        <Card>
          <Text style={{ color: colors.ink, fontWeight: '800' }}>パスワード</Text>
          {address && linked.has('email') ? (
            <>
              <Text style={styles.muted}>パスワードを忘れたときや変えたいときは、登録済みのメールアドレスに再設定用のメールを送ります。メール内のリンクをこの端末で開いてください。</Text>
              <Pressable accessibilityRole="button" disabled={busy !== null || !email.reset} onPress={() => void sendReset()} style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, (busy !== null || !email.reset) && { opacity: 0.5 }]}>
                {busy === 'reset' ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>再設定メールを送る{email.reset ? '' : '（準備中）'}</Text>}
              </Pressable>
            </>
          ) : (
            <Text style={styles.muted}>メールアドレスでのログインを使っていないため、パスワードはありません。上のログイン方法でログインしてください。</Text>
          )}
        </Card>

        <Card>
          <Text style={{ color: colors.ink, fontWeight: '800' }}>XでのログインとX投稿の接続は別です</Text>
          <Text style={styles.muted}>Xでログインしても、投稿の権限はアプリに渡りません。投稿するには、アカウント画面で投稿用のXアカウントを接続してください。</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ color: colors.ink }}>Xでログイン</Text>
            <Pill tone={linked.has('x') ? 'success' : 'neutral'}>{linked.has('x') ? '利用中' : '未設定'}</Pill>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ color: colors.ink }}>投稿用のX接続</Text>
            <Pill tone={postingX === 'connected' ? 'success' : postingX === 'needs_reconnect' ? 'warning' : 'neutral'}>{POSTING_X_STATUS_LABELS[postingX]}</Pill>
          </View>
          <Link href="/accounts" asChild>
            <Pressable accessibilityRole="button" style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}>
              <Text style={styles.buttonText}>投稿用のX接続を確認する</Text>
            </Pressable>
          </Link>
        </Card>

        {message ? <Pill tone={message.tone}>{message.text}</Pill> : null}

        {__DEV__ ? (
          <Card>
            <Text style={{ color: colors.ink, fontWeight: '800' }}>開発者向け: ログイン準備状況</Text>
            {formatAuthDiagnostics(releaseReport).map((line) => <Text key={line} style={styles.muted}>{line}</Text>)}
          </Card>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
