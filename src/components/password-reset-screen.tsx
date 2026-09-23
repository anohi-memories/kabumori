import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { applyNewPassword, startRecoverySession, type RecoveryLink } from '@/lib/password-recovery';
import { supabase } from '@/lib/supabase';

type Phase = 'checking' | 'ready' | 'saving' | 'done' | 'failed';

/**
 * Shown when the app is opened from a password reset email. It runs above the auth gate, so it
 * appears whether or not a session already exists.
 */
export function PasswordResetScreen({ link, onClose }: { link: RecoveryLink; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [message, setMessage] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');

  useEffect(() => {
    let active = true;
    void startRecoverySession(supabase, link).then((issue) => {
      if (!active) return;
      setMessage(issue);
      setPhase(issue ? 'failed' : 'ready');
    });
    return () => {
      active = false;
    };
  }, [link]);

  async function save() {
    if (phase === 'saving') return;
    setPhase('saving');
    setMessage(null);
    const issue = await applyNewPassword(supabase, password, confirmation);
    if (issue) {
      setMessage(issue);
      setPhase('ready');
      return;
    }
    setPassword('');
    setConfirmation('');
    setPhase('done');
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" bounces={false}>
          <View style={styles.card}>
            <Text style={styles.brand}>KABUMORI</Text>
            <Text style={styles.title}>パスワードの再設定</Text>

            {phase === 'checking' ? (
              <>
                <Text style={styles.description}>リンクを確認しています。</Text>
                <ActivityIndicator color="#397449" style={styles.spinner} />
              </>
            ) : null}

            {phase === 'failed' ? (
              <>
                <View style={styles.messageBox}>
                  <Text style={styles.message}>{message}</Text>
                </View>
                <Pressable onPress={onClose} style={styles.primaryButton} accessibilityRole="button">
                  <Text style={styles.primaryText}>ログイン画面に戻る</Text>
                </Pressable>
              </>
            ) : null}

            {phase === 'done' ? (
              <>
                <View style={[styles.messageBox, styles.successBox]}>
                  <Text style={[styles.message, styles.successMessage]}>
                    新しいパスワードを設定しました。
                  </Text>
                </View>
                <Pressable onPress={onClose} style={styles.primaryButton} accessibilityRole="button">
                  <Text style={styles.primaryText}>かぶモリを開く</Text>
                </Pressable>
              </>
            ) : null}

            {phase === 'ready' || phase === 'saving' ? (
              <>
                <Text style={styles.description}>新しいパスワードを入力してください。</Text>
                <Text style={styles.label}>新しいパスワード</Text>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder="6文字以上"
                  secureTextEntry
                  textContentType="newPassword"
                  autoComplete="new-password"
                  autoCapitalize="none"
                  editable={phase === 'ready'}
                  style={styles.input}
                  accessibilityLabel="新しいパスワード"
                />
                <Text style={styles.label}>新しいパスワード（確認）</Text>
                <TextInput
                  value={confirmation}
                  onChangeText={setConfirmation}
                  placeholder="もう一度入力"
                  secureTextEntry
                  textContentType="newPassword"
                  autoComplete="new-password"
                  autoCapitalize="none"
                  editable={phase === 'ready'}
                  onSubmitEditing={() => void save()}
                  style={styles.input}
                  accessibilityLabel="新しいパスワード（確認）"
                />
                {!!message ? (
                  <View style={styles.messageBox}>
                    <Text style={styles.message}>{message}</Text>
                  </View>
                ) : null}
                <Pressable
                  onPress={() => void save()}
                  disabled={phase === 'saving'}
                  style={[styles.primaryButton, phase === 'saving' && styles.disabled]}
                  accessibilityRole="button">
                  {phase === 'saving' ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.primaryText}>パスワードを変更する</Text>
                  )}
                </Pressable>
                <Pressable onPress={onClose} style={styles.switchButton} accessibilityRole="button">
                  <Text style={styles.switchText}>あとで設定する</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: '#eef3ed' },
  scrollContent: { flexGrow: 1, justifyContent: 'center', padding: 22 },
  card: { width: '100%', maxWidth: 480, alignSelf: 'center', backgroundColor: '#fff', borderRadius: 24, padding: 24, borderWidth: 1, borderColor: '#dfe6df' },
  brand: { color: '#548161', fontWeight: '900', letterSpacing: 2.5, fontSize: 13 },
  title: { color: '#17211a', fontSize: 28, fontWeight: '900', marginTop: 10 },
  description: { color: '#68736b', fontSize: 15, marginTop: 8, marginBottom: 12 },
  label: { color: '#37453b', fontWeight: '700', marginBottom: 7, marginTop: 12 },
  input: { minHeight: 52, borderWidth: 1, borderColor: '#d4dcd5', borderRadius: 13, backgroundColor: '#fbfcfb', paddingHorizontal: 15, color: '#17211a', fontSize: 16 },
  messageBox: { backgroundColor: '#fff2f1', borderRadius: 12, padding: 13, marginTop: 16 },
  successBox: { backgroundColor: '#eaf4ec' },
  message: { color: '#9a3631', lineHeight: 20 },
  successMessage: { color: '#306c40' },
  spinner: { marginTop: 14 },
  primaryButton: { minHeight: 52, marginTop: 20, borderRadius: 14, backgroundColor: '#397449', alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '900' },
  switchButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  switchText: { color: '#477554', fontWeight: '700', textAlign: 'center' },
  disabled: { opacity: 0.55 },
});
