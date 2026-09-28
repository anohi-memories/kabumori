import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radius, spacing, typography } from '@/constants/theme';
import { PROVIDER_LABELS, SIGN_UP_CHECK_EMAIL_MESSAGE } from '@/domain/auth-flows';
import { useAuth } from '@/providers/auth-provider';

type SocialProvider = 'x' | 'apple' | 'google';
type EmailMode = 'sign_in' | 'sign_up' | 'reset';

export function AuthScreen() {
  const auth = useAuth();
  const { backendAvailable, error: authError, email: emailCaps, settingsKnown } = auth;
  const [busy, setBusy] = useState<SocialProvider | 'email' | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [mode, setMode] = useState<EmailMode>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Offered only when enabled on the project AND configured for this build (never "verified" by source).
  const available = (provider: SocialProvider) => backendAvailable && auth.readiness(provider).usable;
  const modeAllowed = (value: EmailMode) => backendAvailable && (value === 'sign_in' ? emailCaps.signIn : value === 'sign_up' ? emailCaps.signUp : emailCaps.reset);

  async function continueWith(provider: SocialProvider) {
    setBusy(provider); setMessage(null);
    const result = await auth.signInWithProvider(provider);
    setBusy(null);
    if (!result.ok) setMessage({ tone: result.cancelled ? 'info' : 'error', text: result.message });
  }

  async function submitEmail() {
    const trimmed = email.trim();
    if (!modeAllowed(mode)) { setMessage({ tone: 'error', text: 'この操作は現在利用できません。' }); return; }
    if (!trimmed || (mode !== 'reset' && !password)) { setMessage({ tone: 'error', text: 'メールアドレスとパスワードを入力してください。' }); return; }
    setBusy('email'); setMessage(null);
    if (mode === 'sign_in') {
      const result = await auth.signIn(trimmed, password);
      if (!result.ok) setMessage({ tone: 'error', text: result.message ?? 'ログインできませんでした。' });
    } else if (mode === 'sign_up') {
      const result = await auth.signUpWithEmail(trimmed, password);
      if (!result.ok) setMessage({ tone: 'error', text: result.message });
      // Identical for a new address and an already-registered one (no enumeration).
      else if (result.outcome === 'check_email') setMessage({ tone: 'info', text: SIGN_UP_CHECK_EMAIL_MESSAGE });
    } else {
      const result = await auth.requestPasswordReset(trimmed);
      setMessage({ tone: result.ok ? 'info' : 'error', text: result.message });
    }
    setBusy(null);
  }

  const socialButton = (provider: SocialProvider, primary = false) => {
    const enabled = available(provider);
    return (
      <Pressable
        key={provider}
        accessibilityRole="button"
        accessibilityState={{ disabled: !enabled || busy !== null }}
        disabled={!enabled || busy !== null}
        onPress={() => void continueWith(provider)}
        style={({ pressed }) => [primary ? styles.primary : styles.secondary, (pressed || busy === provider) && styles.pressed, !enabled && styles.disabled]}
      >
        {busy === provider ? <ActivityIndicator color={primary ? '#fff' : colors.primary} /> : (
          <Text style={primary ? styles.primaryText : styles.secondaryText}>
            {PROVIDER_LABELS[provider]}で続ける{enabled || !settingsKnown ? '' : '（準備中）'}
          </Text>
        )}
      </Pressable>
    );
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={typography.title}>Social Operations</Text>
          <Text style={styles.subtitle}>AI運用担当者とSNS発信を整える</Text>
          {!backendAvailable ? <View style={styles.notice}><Text style={styles.noticeText}>{authError ?? 'Supabase環境変数を設定してください。'}（現在はサインインできません）</Text></View> : null}
          {backendAvailable && authError ? <View style={styles.notice}><Text style={styles.noticeText}>{authError}</Text></View> : null}

          <Text style={styles.label}>アプリへのログイン / 新規登録</Text>
          {socialButton('x', true)}
          {socialButton('apple')}
          {socialButton('google')}
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy !== null || !emailCaps.signIn }} disabled={busy !== null || !emailCaps.signIn} onPress={() => { setEmailOpen(!emailOpen); setMessage(null); }} style={({ pressed }) => [styles.secondary, pressed && styles.pressed, !emailCaps.signIn && styles.disabled]}>
            <Text style={styles.secondaryText}>{PROVIDER_LABELS.email}で続ける{emailCaps.signIn ? '' : '（準備中）'}</Text>
          </Pressable>

          {emailOpen ? (
            <View style={styles.emailBox}>
              <View style={styles.tabs}>
                {([['sign_in', 'ログイン'], ['sign_up', '新規登録'], ['reset', 'パスワードを忘れた']] as const).map(([key, label]) => (
                  <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: mode === key, disabled: !modeAllowed(key) }} disabled={!modeAllowed(key)} onPress={() => { setMode(key); setMessage(null); }} style={[styles.tab, mode === key && styles.tabActive, !modeAllowed(key) && styles.disabled]}>
                    <Text style={[styles.tabText, mode === key && styles.tabTextActive]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
              {!emailCaps.signUp ? <Text style={styles.caption}>新規登録{emailCaps.reset ? '' : 'とパスワード再設定'}は、現在このアプリでは利用できません。</Text> : null}
              <Text style={styles.label}>メールアドレス</Text>
              <TextInput autoCapitalize="none" autoComplete="email" keyboardType="email-address" onChangeText={setEmail} placeholder="you@example.com" style={styles.input} value={email} />
              {mode !== 'reset' ? (
                <>
                  <Text style={styles.label}>パスワード{mode === 'sign_up' ? '（8文字以上）' : ''}</Text>
                  <TextInput autoCapitalize="none" autoComplete={mode === 'sign_up' ? 'new-password' : 'password'} onChangeText={setPassword} placeholder="パスワード" secureTextEntry style={styles.input} value={password} />
                </>
              ) : null}
              <Pressable accessibilityRole="button" disabled={busy !== null || !modeAllowed(mode)} onPress={() => void submitEmail()} style={({ pressed }) => [styles.primary, (pressed || busy === 'email' || !modeAllowed(mode)) && styles.disabled]}>
                {busy === 'email' ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>{mode === 'sign_in' ? 'ログイン' : mode === 'sign_up' ? '登録する' : '再設定メールを送る'}</Text>}
              </Pressable>
            </View>
          ) : null}

          {message ? <Text style={message.tone === 'error' ? styles.error : styles.info}>{message.text}</Text> : null}
          <Text style={styles.caption}>ここでのログインはアプリを使うためのものです。自動投稿に使うXアカウントは、ログイン後に別の手順で接続します。</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.md },
  card: { width: '100%', maxWidth: 440, gap: spacing.sm, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  subtitle: { color: colors.muted, ...typography.body, marginBottom: spacing.sm },
  label: { color: colors.ink, fontSize: 13, fontWeight: '700', marginTop: spacing.sm },
  input: { borderColor: colors.border, borderRadius: radius.sm, borderWidth: 1, color: colors.ink, padding: 12 },
  primary: { alignItems: 'center', backgroundColor: colors.ink, borderRadius: radius.sm, minHeight: 46, justifyContent: 'center', marginTop: spacing.xs },
  primaryText: { color: '#fff', fontWeight: '800' },
  secondary: { alignItems: 'center', backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.sm, minHeight: 46, justifyContent: 'center', marginTop: spacing.xs },
  secondaryText: { color: colors.ink, fontWeight: '700' },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.45 },
  emailBox: { gap: spacing.xs, borderTopColor: colors.border, borderTopWidth: 1, marginTop: spacing.sm, paddingTop: spacing.sm },
  tabs: { flexDirection: 'row', gap: 6 },
  tab: { flex: 1, alignItems: 'center', borderRadius: radius.sm, paddingVertical: 8, backgroundColor: colors.background },
  tabActive: { backgroundColor: colors.primarySoft },
  tabText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  tabTextActive: { color: colors.primary },
  error: { color: colors.danger, fontSize: 13 },
  info: { color: colors.primary, fontSize: 13 },
  caption: { color: colors.muted, ...typography.caption, marginTop: spacing.sm },
  notice: { backgroundColor: colors.warningSoft, borderRadius: radius.sm, padding: spacing.sm },
  noticeText: { color: colors.warning, fontSize: 13 },
});
