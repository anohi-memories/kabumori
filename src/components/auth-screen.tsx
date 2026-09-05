import { useState } from 'react';
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

import { authErrorMessage, signInWithEmail, signUpWithEmail } from '@/lib/auth';

type Mode = 'sign-in' | 'sign-up';

export function AuthScreen({ startupError, onRetry }: { startupError?: string | null; onRetry?: () => void }) {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function validate() {
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new Error('正しいメールアドレスを入力してください。');
    }
    if (password.length < 6) {
      throw new Error('パスワードは6文字以上で入力してください。');
    }
    return normalizedEmail;
  }

  async function submit() {
    if (loading) return;
    setLoading(true);
    setMessage(null);
    setSuccess(false);
    try {
      const normalizedEmail = validate();
      if (mode === 'sign-in') {
        await signInWithEmail(normalizedEmail, password);
      } else {
        const data = await signUpWithEmail(normalizedEmail, password);
        if (!data.session) {
          setSuccess(true);
          setMessage('確認メールを送信しました。メール内のリンクを開いたあと、ログインしてください。');
          setMode('sign-in');
        }
      }
    } catch (error) {
      setMessage(authErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  function switchMode() {
    setMode((value) => (value === 'sign-in' ? 'sign-up' : 'sign-in'));
    setMessage(null);
    setSuccess(false);
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          bounces={false}>
          <View style={styles.card}>
            <Text style={styles.brand}>KABUMORI</Text>
            <Text style={styles.title}>{mode === 'sign-in' ? 'ログイン' : '新規登録'}</Text>
            <Text style={styles.description}>
              {mode === 'sign-in'
                ? '登録した銘柄を確認しましょう。'
                : 'メールアドレスでアカウントを作成します。'}
            </Text>

            <Text style={styles.label}>メールアドレス</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="mail@example.com"
              keyboardType="email-address"
              textContentType="emailAddress"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!loading}
              style={styles.input}
            />
            <Text style={styles.label}>パスワード</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="6文字以上"
              secureTextEntry
              textContentType={mode === 'sign-in' ? 'password' : 'newPassword'}
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              autoCapitalize="none"
              editable={!loading}
              onSubmitEditing={() => void submit()}
              style={styles.input}
            />

            {!!(message ?? startupError) && (
              <View style={[styles.messageBox, (success && !startupError) && styles.successBox]}>
                <Text style={[styles.message, (success && !startupError) && styles.successMessage]}>
                  {message ?? startupError}
                </Text>
                {!!startupError && onRetry && (
                  <Pressable onPress={onRetry}><Text style={styles.retry}>もう一度試す</Text></Pressable>
                )}
              </View>
            )}

            <Pressable
              onPress={() => void submit()}
              disabled={loading}
              style={[styles.primaryButton, loading && styles.disabled]}>
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryText}>{mode === 'sign-in' ? 'ログイン' : '登録する'}</Text>
              )}
            </Pressable>
            <Pressable onPress={switchMode} disabled={loading} style={styles.switchButton}>
              <Text style={styles.switchText}>
                {mode === 'sign-in' ? '初めての方はこちら（新規登録）' : 'アカウントをお持ちの方（ログイン）'}
              </Text>
            </Pressable>
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
  title: { color: '#17211a', fontSize: 30, fontWeight: '900', marginTop: 10 },
  description: { color: '#68736b', fontSize: 15, marginTop: 8, marginBottom: 22 },
  label: { color: '#37453b', fontWeight: '700', marginBottom: 7, marginTop: 12 },
  input: { minHeight: 52, borderWidth: 1, borderColor: '#d4dcd5', borderRadius: 13, backgroundColor: '#fbfcfb', paddingHorizontal: 15, color: '#17211a', fontSize: 16 },
  messageBox: { backgroundColor: '#fff2f1', borderRadius: 12, padding: 13, marginTop: 16 },
  successBox: { backgroundColor: '#eaf4ec' },
  message: { color: '#9a3631', lineHeight: 20 },
  successMessage: { color: '#306c40' },
  retry: { color: '#397449', fontWeight: '800', marginTop: 9 },
  primaryButton: { minHeight: 52, marginTop: 20, borderRadius: 14, backgroundColor: '#397449', alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '900' },
  switchButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  switchText: { color: '#477554', fontWeight: '700', textAlign: 'center' },
  disabled: { opacity: 0.55 },
});
