import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { colors, radius } from '@/constants/theme';
import { useAuth } from '@/providers/auth-provider';

export function SignOutButton() {
  const { signOut } = useAuth(); const [busy, setBusy] = useState(false);
  async function handleSignOut() { setBusy(true); await signOut(); setBusy(false); }
  return <Pressable accessibilityRole="button" disabled={busy} onPress={() => void handleSignOut()} style={styles.button}>{busy ? <ActivityIndicator color={colors.danger} /> : <Text style={styles.text}>ログアウト</Text>}</Pressable>;
}
const styles = StyleSheet.create({ button: { alignItems: 'center', borderColor: '#FECACA', borderRadius: radius.sm, borderWidth: 1, paddingVertical: 12 }, text: { color: colors.danger, fontWeight: '700' } });
