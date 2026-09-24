import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { authErrorMessage, signOut } from '@/lib/auth';

/**
 * Shown when the session is valid but the account's profile row could not be prepared -- for
 * example when the device is offline at the moment the app accepts a restored session.
 *
 * This state used to render the login form with an error attached, which read as "your login
 * failed" for a problem that had nothing to do with the credentials. Here the user is told what
 * actually happened and is given the two actions that can resolve it.
 */
export function ProfileRecoveryScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const [signingOut, setSigningOut] = useState(false);

  async function logOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
    } catch (error) {
      Alert.alert('ログアウト失敗', authErrorMessage(error));
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.card}>
        <Text style={styles.brand}>KABUMORI</Text>
        <Text style={styles.title}>アカウント情報を準備できませんでした</Text>
        <Text style={styles.description}>
          ログインはできていますが、アカウント情報の準備が完了していません。通信状態を確認して、もう一度お試しください。
        </Text>
        <View style={styles.messageBox}>
          <Text style={styles.message}>{message}</Text>
        </View>
        <Pressable onPress={onRetry} style={styles.primaryButton} accessibilityRole="button">
          <Text style={styles.primaryText}>もう一度試す</Text>
        </Pressable>
        <Pressable
          onPress={() => void logOut()}
          disabled={signingOut}
          style={styles.switchButton}
          accessibilityRole="button">
          {signingOut ? (
            <ActivityIndicator color="#477554" />
          ) : (
            <Text style={styles.switchText}>ログアウトする</Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#eef3ed', justifyContent: 'center', padding: 22 },
  card: { width: '100%', maxWidth: 480, alignSelf: 'center', backgroundColor: '#fff', borderRadius: 24, padding: 24, borderWidth: 1, borderColor: '#dfe6df' },
  brand: { color: '#548161', fontWeight: '900', letterSpacing: 2.5, fontSize: 13 },
  title: { color: '#17211a', fontSize: 24, fontWeight: '900', marginTop: 10 },
  description: { color: '#68736b', fontSize: 15, marginTop: 10, lineHeight: 22 },
  messageBox: { backgroundColor: '#fff2f1', borderRadius: 12, padding: 13, marginTop: 16 },
  message: { color: '#9a3631', lineHeight: 20 },
  primaryButton: { minHeight: 52, marginTop: 20, borderRadius: 14, backgroundColor: '#397449', alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '900' },
  switchButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  switchText: { color: '#477554', fontWeight: '700', textAlign: 'center' },
});
