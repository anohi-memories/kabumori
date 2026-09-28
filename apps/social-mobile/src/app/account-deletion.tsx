import type { UserIdentity } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { colors } from '@/constants/theme';
import { Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { PROVIDER_LABELS } from '@/domain/auth-flows';
import {
  ACCOUNT_DELETION_CONFIRM_PHRASE,
  DELETED_ITEMS,
  DELETION_TIMING,
  deletionErrorMessage,
  reauthMethods,
  RETAINED_ITEMS,
  type ReauthMethod,
} from '@/domain/account-deletion';
import { LEGAL_LINK_LABELS } from '@/domain/legal-links';
import { LEGAL_LINKS } from '@/lib/legal-config';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';

const inputStyle = { borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, color: colors.ink, backgroundColor: '#FFFFFF' };

/**
 * Self-service account deletion. Explains what is deleted and kept, requires a
 * fresh sign-in with one of the user's own methods plus a typed confirmation,
 * and reports success only when the server confirmed the deletion.
 */
export default function AccountDeletionScreen() {
  const { session, accountDeletion, readiness, email, reauthenticate, deleteAccount } = useAuth();
  const [providers, setProviders] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [reauthed, setReauthed] = useState<{ appleAuthorizationCode?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const userId = session?.user.id ?? null;
  const support = LEGAL_LINKS.support;

  useEffect(() => {
    if (!supabase || !userId) return;
    const client = supabase;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      const { data, error } = await client.auth.getUserIdentities();
      if (!cancelled) setProviders(error ? [] : (data.identities as UserIdentity[]).map((identity) => identity.provider));
    });
    return () => { cancelled = true; };
  }, [userId]);

  const methods = reauthMethods(providers ?? [], (method) => (method === 'email' ? email.signIn : readiness(method).usableNow));

  async function confirmIdentity(method: ReauthMethod) {
    setBusy(method); setMessage(null);
    const result = await reauthenticate(method, method === 'email' ? password : undefined);
    setBusy(null);
    setPassword('');
    if (result.ok) setReauthed({ appleAuthorizationCode: result.appleAuthorizationCode });
    else if (!result.cancelled) setMessage(result.message);
  }

  async function submit() {
    if (!reauthed || phrase.trim() !== ACCOUNT_DELETION_CONFIRM_PHRASE) return;
    setBusy('delete'); setMessage(null);
    const outcome = await deleteAccount(reauthed.appleAuthorizationCode);
    setBusy(null);
    if (outcome.ok) {
      Alert.alert('アカウントを削除しました', 'ご利用ありがとうございました。');
      return;
    }
    if (outcome.code === 'REAUTH_REQUIRED' || outcome.code === 'APPLE_REAUTH_REQUIRED') setReauthed(null);
    setMessage(deletionErrorMessage(outcome.code));
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <SectionTitle detail={DELETION_TIMING}>アカウントの削除</SectionTitle>
        <Card>
          <Text style={{ color: colors.ink, fontWeight: '800' }}>削除されるもの</Text>
          {DELETED_ITEMS.map((item) => <Text key={item} style={styles.muted}>・{item}</Text>)}
          <Text style={{ color: colors.ink, fontWeight: '800', marginTop: 8 }}>削除されないもの</Text>
          {RETAINED_ITEMS.map((item) => <Text key={item} style={styles.muted}>・{item}</Text>)}
        </Card>

        {accountDeletion !== 'available' ? (
          <Card>
            <Pill tone="warning">準備中</Pill>
            <Text style={styles.muted}>アプリ内でのアカウント削除は、現在準備中です。</Text>
            {support.href ? (
              <Pressable accessibilityRole="link" onPress={() => { if (support.href) void Linking.openURL(support.href); }} style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}>
                <Text style={styles.buttonText}>{LEGAL_LINK_LABELS.support}</Text>
              </Pressable>
            ) : null}
          </Card>
        ) : (
          <>
            <Card>
              <Text style={{ color: colors.ink, fontWeight: '800' }}>1. 本人確認</Text>
              {reauthed ? <Pill tone="success">本人確認が済みました（10分以内に削除してください）</Pill> : null}
              {!reauthed && providers === null ? <ActivityIndicator color={colors.primary} /> : null}
              {!reauthed && providers !== null && methods.length === 0 ? <Text style={styles.muted}>本人確認に使えるログイン方法が現在準備中のため、削除できません。</Text> : null}
              {!reauthed ? methods.map((method) => (
                <View key={method} style={{ gap: 6 }}>
                  {method === 'email' ? (
                    <TextInput value={password} onChangeText={setPassword} placeholder="パスワード" secureTextEntry autoCapitalize="none" autoComplete="current-password" style={inputStyle} />
                  ) : null}
                  <Pressable accessibilityRole="button" disabled={busy !== null || (method === 'email' && !password)} onPress={() => void confirmIdentity(method)} style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, (busy !== null || (method === 'email' && !password)) && { opacity: 0.5 }]}>
                    {busy === method ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{PROVIDER_LABELS[method]}で本人確認</Text>}
                  </Pressable>
                </View>
              )) : null}
            </Card>
            <Card>
              <Text style={{ color: colors.ink, fontWeight: '800' }}>2. 確認の入力</Text>
              <Text style={styles.muted}>削除する場合は「{ACCOUNT_DELETION_CONFIRM_PHRASE}」と入力してください。</Text>
              <TextInput value={phrase} onChangeText={setPhrase} autoCapitalize="none" style={inputStyle} />
              <Pressable
                accessibilityRole="button"
                disabled={busy !== null || !reauthed || phrase.trim() !== ACCOUNT_DELETION_CONFIRM_PHRASE}
                onPress={() => void submit()}
                style={({ pressed }) => [styles.button, { backgroundColor: colors.danger }, pressed && styles.buttonPressed, (busy !== null || !reauthed || phrase.trim() !== ACCOUNT_DELETION_CONFIRM_PHRASE) && { opacity: 0.5 }]}
              >
                {busy === 'delete' ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>アカウントを完全に削除</Text>}
              </Pressable>
            </Card>
          </>
        )}
        {message ? <Pill tone="warning">{message}</Pill> : null}
      </ScrollView>
    </Screen>
  );
}
