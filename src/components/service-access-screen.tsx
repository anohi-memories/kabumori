import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { authErrorMessage, signOut } from '@/lib/auth';
import { enrollmentBlockedCopy, REENROLL_COPY } from '@/lib/service-enrollment';
import type { ServiceAccess } from '@/providers/auth-provider';

/**
 * Shown when the session is valid but the common-account lifecycle did not open Kabumori for it:
 * a refusal (deletion in progress, locked, ...) or a Kabumori use the person ended earlier. The app
 * stays closed -- there is no profile-only fallback -- and the person gets the actions that apply.
 */
export function ServiceAccessScreen({
  access,
  onRetry,
  onReenroll,
}: {
  access: ServiceAccess;
  onRetry: () => void;
  onReenroll: () => void;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const copy =
    access.kind === 'reenroll_required'
      ? { title: REENROLL_COPY.title, description: REENROLL_COPY.description, canRetry: false }
      : enrollmentBlockedCopy(access.reason);

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
        <Text style={styles.title}>{copy.title}</Text>
        <Text style={styles.description}>{copy.description}</Text>
        {access.kind === 'reenroll_required' ? (
          <Pressable onPress={onReenroll} style={styles.primaryButton} accessibilityRole="button">
            <Text style={styles.primaryText}>{REENROLL_COPY.action}</Text>
          </Pressable>
        ) : copy.canRetry ? (
          <Pressable onPress={onRetry} style={styles.primaryButton} accessibilityRole="button">
            <Text style={styles.primaryText}>もう一度試す</Text>
          </Pressable>
        ) : null}
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
  primaryButton: { minHeight: 52, marginTop: 20, borderRadius: 14, backgroundColor: '#397449', alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '900' },
  switchButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  switchText: { color: '#477554', fontWeight: '700', textAlign: 'center' },
});
