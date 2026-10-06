import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radius, spacing, typography } from '@/constants/theme';
import { useAuth } from '@/providers/auth-provider';
import { SignOutButton } from '@/components/sign-out-button';

/** Shown while a password-recovery session is active, before any other screen. */
export function NewPasswordScreen() {
  const { completePasswordRecovery } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setMessage(null);
    const result = await completePasswordRecovery(password, confirmation);
    setBusy(false);
    if (!result.ok) setMessage(result.message ?? 'パスワードを変更できませんでした。');
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
      <View style={styles.card}>
        <Text style={typography.title}>新しいパスワード</Text>
        <Text style={styles.muted}>再設定のリンクを確認しました。新しいパスワードを設定してください。</Text>
        <Text style={styles.label}>新しいパスワード（8文字以上）</Text>
        <TextInput autoCapitalize="none" autoComplete="new-password" secureTextEntry value={password} onChangeText={setPassword} style={styles.input} />
        <Text style={styles.label}>確認のためもう一度</Text>
        <TextInput autoCapitalize="none" autoComplete="new-password" secureTextEntry value={confirmation} onChangeText={setConfirmation} style={styles.input} />
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void submit()} style={({ pressed }) => [styles.button, (pressed || busy) && { opacity: 0.6 }]}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>パスワードを変更</Text>}
        </Pressable>
        {message ? <Text style={styles.error}>{message}</Text> : null}
        <SignOutButton />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, padding: spacing.md },
  card: { width: '100%', maxWidth: 440, gap: spacing.sm, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  muted: { color: colors.muted, ...typography.body },
  label: { color: colors.ink, fontSize: 13, fontWeight: '700', marginTop: spacing.sm },
  input: { borderColor: colors.border, borderRadius: radius.sm, borderWidth: 1, color: colors.ink, padding: 12 },
  button: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: radius.sm, minHeight: 46, justifyContent: 'center', marginTop: spacing.sm },
  buttonText: { color: '#fff', fontWeight: '800' },
  error: { color: colors.danger, fontSize: 13 },
});
