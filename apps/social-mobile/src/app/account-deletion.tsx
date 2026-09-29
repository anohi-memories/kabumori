import type { UserIdentity } from '@supabase/supabase-js';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { colors } from '@/constants/theme';
import { Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { PROVIDER_LABELS } from '@/domain/auth-flows';
import {
  ACCOUNT_DELETION_CONFIRM_PHRASE,
  DELETION_TIMING,
  deletionErrorMessage,
  deletionItems,
  deletionNeedsFreshReauth,
  deletionPlatformSupport,
  deletionResultMessage,
  reauthMethods,
  sameDeletionContext,
  type DeletionContext,
  type DeletionPreview,
  type ReauthMethod,
} from '@/domain/account-deletion';
import { LEGAL_LINK_LABELS } from '@/domain/legal-links';
import { sessionIdOf } from '@/domain/recovery-binding';
import { LEGAL_LINKS } from '@/lib/legal-config';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';

const inputStyle = { borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, color: colors.ink, backgroundColor: '#FFFFFF' };

/**
 * Self-service account deletion. Shows exactly what the server will delete
 * (scope from the server preview), requires a fresh sign-in with one of the
 * user's own methods plus a typed confirmation, pins both to that exact
 * user + session, and reports success only when the server confirmed it.
 */
export default function AccountDeletionScreen() {
  const { session, accountDeletion, readiness, email, reauthenticate, previewDeletion, deleteAccount } = useAuth();
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [providers, setProviders] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [reauthed, setReauthed] = useState<{ context: DeletionContext; appleAuthorizationCode?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const userId = session?.user.id ?? null;
  const sessionId = sessionIdOf(session);
  const support = LEGAL_LINKS.support;
  const enabled = accountDeletion === 'available';

  const loadPreview = useCallback(async () => {
    setPreview(null);
    setPreview(await previewDeletion());
  }, [previewDeletion]);

  useEffect(() => {
    if (!enabled || !userId) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      const result = await previewDeletion();
      if (!cancelled) setPreview(result);
    });
    return () => { cancelled = true; };
  }, [enabled, previewDeletion, userId]);

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

  // A confirmation only counts for the exact user + session it was made in.
  const pinned = reauthed && sameDeletionContext(reauthed.context, { userId, sessionId }) ? reauthed : null;
  const ready = preview?.ok ? preview : null;
  const platform = ready
    ? deletionPlatformSupport({ appleCodeRequired: ready.appleCodeRequired, appleSupported: ready.appleSupported, nativeAppleAvailable: Platform.OS === 'ios' && readiness('apple').usableNow })
    : null;
  // A login deletion of a Sign in with Apple user needs the native Apple re-authentication (it yields the code).
  const methods = ready?.appleCodeRequired
    ? (['apple'] as ReauthMethod[])
    : reauthMethods(providers ?? [], (method) => (method === 'email' ? email.signIn : readiness(method).usableNow));
  const items = ready ? deletionItems(ready.scope) : null;
  const canSubmit = Boolean(pinned && ready && platform === 'supported' && phrase.trim() === ACCOUNT_DELETION_CONFIRM_PHRASE && busy === null);

  async function confirmIdentity(method: ReauthMethod) {
    setBusy(method); setMessage(null);
    const result = await reauthenticate(method, method === 'email' ? password : undefined);
    setBusy(null);
    setPassword('');
    if (result.ok) setReauthed({ context: result.context, appleAuthorizationCode: result.appleAuthorizationCode });
    else if (!result.cancelled) setMessage(result.message);
  }

  async function submit() {
    if (!pinned || !ready || !canSubmit) return;
    setBusy('delete'); setMessage(null);
    const outcome = await deleteAccount({ context: pinned.context, scope: ready.scope, appleAuthorizationCode: pinned.appleAuthorizationCode });
    setBusy(null);
    // An Apple authorization code is single-use: never keep it for another attempt.
    setReauthed((current) => (current ? { context: current.context } : null));
    if (outcome.ok) {
      Alert.alert('削除しました', deletionResultMessage(outcome));
      return;
    }
    if (deletionNeedsFreshReauth(outcome.code)) { setReauthed(null); setPhrase(''); }
    if (outcome.code === 'SCOPE_CHANGED') void loadPreview();
    setMessage(deletionErrorMessage(outcome.code));
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <SectionTitle detail={DELETION_TIMING}>アカウントの削除</SectionTitle>

        {!enabled ? (
          <Card>
            <Pill tone="warning">準備中</Pill>
            <Text style={styles.muted}>アプリ内でのアカウント削除は、現在準備中です。</Text>
            {support.href ? (
              <Pressable accessibilityRole="link" onPress={() => { if (support.href) void Linking.openURL(support.href); }} style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}>
                <Text style={styles.buttonText}>{LEGAL_LINK_LABELS.support}</Text>
              </Pressable>
            ) : null}
          </Card>
        ) : preview === null ? (
          <Card><ActivityIndicator color={colors.primary} /></Card>
        ) : !preview.ok ? (
          <Card>
            <Text style={styles.muted}>{deletionErrorMessage(preview.code)}</Text>
            <Pressable accessibilityRole="button" onPress={() => void loadPreview()} style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}>
              <Text style={styles.buttonText}>もう一度読み込む</Text>
            </Pressable>
          </Card>
        ) : (
          <>
            <Card>
              <Text style={{ color: colors.ink, fontWeight: '800' }}>削除されるもの</Text>
              {items?.deleted.map((item) => <Text key={item} style={styles.muted}>・{item}</Text>)}
              <Text style={{ color: colors.ink, fontWeight: '800', marginTop: 8 }}>削除されないもの</Text>
              {items?.kept.map((item) => <Text key={item} style={styles.muted}>・{item}</Text>)}
            </Card>

            {platform === 'apple_native_required' ? (
              <Card><Text style={styles.muted}>Appleでログインしているアカウントの削除は、iPhoneアプリから行ってください。</Text></Card>
            ) : platform === 'apple_unavailable' ? (
              <Card><Text style={styles.muted}>{deletionErrorMessage('APPLE_REVOCATION_UNAVAILABLE')}</Text></Card>
            ) : (
              <>
                <Card>
                  <Text style={{ color: colors.ink, fontWeight: '800' }}>1. 本人確認</Text>
                  {pinned ? <Pill tone="success">本人確認が済みました（10分以内に削除してください）</Pill> : null}
                  {!pinned && providers === null ? <ActivityIndicator color={colors.primary} /> : null}
                  {!pinned && providers !== null && methods.length === 0 ? <Text style={styles.muted}>本人確認に使えるログイン方法が現在準備中のため、削除できません。</Text> : null}
                  {!pinned ? methods.map((method) => (
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
                    disabled={!canSubmit}
                    onPress={() => void submit()}
                    style={({ pressed }) => [styles.button, { backgroundColor: colors.danger }, pressed && styles.buttonPressed, !canSubmit && { opacity: 0.5 }]}
                  >
                    {busy === 'delete' ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{ready?.scope === 'social_and_login' ? 'アカウントを完全に削除' : 'このアプリのデータを削除'}</Text>}
                  </Pressable>
                </Card>
              </>
            )}
          </>
        )}
        {message ? <Pill tone="warning">{message}</Pill> : null}
      </ScrollView>
    </Screen>
  );
}
