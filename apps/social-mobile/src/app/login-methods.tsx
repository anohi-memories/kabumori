import type { UserIdentity } from '@supabase/supabase-js';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { colors } from '@/constants/theme';
import { Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { PROVIDER_LABELS, type AuthProviderId } from '@/domain/auth-flows';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';

const LINKABLE: readonly ('x' | 'apple' | 'google')[] = ['x', 'apple', 'google'];

function label(provider: string): string {
  return (PROVIDER_LABELS as Record<string, string>)[provider] ?? provider;
}

/**
 * The signed-in user's own login methods. Adding one is always an explicit,
 * authenticated linkIdentity() (never an automatic merge by name/handle).
 * Posting-account X is managed separately on the Accounts screen.
 */
export default function LoginMethodsScreen() {
  const { linkProvider, providers } = useAuth();
  const [identities, setIdentities] = useState<UserIdentity[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      const { data, error } = await client.auth.getUserIdentities();
      if (cancelled) return;
      if (error) { setIdentities([]); setMessage({ tone: 'warning', text: 'ログイン方法を読み込めませんでした。' }); return; }
      setIdentities(data.identities);
    });
    return () => { cancelled = true; };
  }, [generation]);

  async function link(provider: 'x' | 'apple' | 'google') {
    setBusy(provider); setMessage(null);
    const result = await linkProvider(provider);
    setBusy(null);
    if (result.ok) { setMessage({ tone: 'success', text: `${label(provider)}をログイン方法に追加しました。` }); reload(); }
    else if (!result.cancelled) setMessage({ tone: 'warning', text: result.message });
  }

  const linked = new Set((identities ?? []).map((identity) => identity.provider));
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <SectionTitle detail="アプリへのログインに使える方法です。自動投稿用のX接続とは別です。">ログイン方法</SectionTitle>
        <Card>
          {identities === null ? <ActivityIndicator color={colors.primary} /> : null}
          {(identities ?? []).map((identity) => (
            <View key={identity.identity_id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: colors.ink, fontWeight: '700' }}>{label(identity.provider as AuthProviderId)}</Text>
              <Pill tone="success">利用中</Pill>
            </View>
          ))}
        </Card>
        <Card>
          <Text style={{ color: colors.ink, fontWeight: '800' }}>ログイン方法を追加</Text>
          <Text style={styles.muted}>いまログインしているアカウントに追加します。別のアカウントで使われている方法は追加できません。</Text>
          {LINKABLE.filter((provider) => !linked.has(provider)).map((provider) => {
            const enabled = providers?.[provider] === true;
            return (
              <Pressable key={provider} accessibilityRole="button" disabled={!enabled || busy !== null} onPress={() => void link(provider)} style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, (!enabled || busy !== null) && { opacity: 0.5 }]}>
                {busy === provider ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{label(provider)}を追加{enabled ? '' : '（準備中）'}</Text>}
              </Pressable>
            );
          })}
          {message ? <Pill tone={message.tone}>{message.text}</Pill> : null}
        </Card>
      </ScrollView>
    </Screen>
  );
}
