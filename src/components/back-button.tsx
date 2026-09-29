import { router } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { KABUMORI_COLORS } from '@/constants/kabumori-theme';

const palette = KABUMORI_COLORS.light;

// In-app back control for screens pushed on top of the tabs (settings, ai,
// portfolio, topics, topic-detail). iOS' edge-swipe still works, but it is not
// discoverable, so every such screen shows this at the top of its own
// SafeAreaView content. Falls back to Home when there is nothing to go back to
// (e.g. opened from a cold deep link).
export function BackButton({ label = 'もどる', onPress }: { label?: string; onPress?: () => void }) {
  return (
    <Pressable
      onPress={onPress ?? (() => (router.canGoBack() ? router.back() : router.replace('/')))}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={styles.button}>
      <Text style={styles.text}>‹ {label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  text: { color: palette.accent, fontWeight: '800', fontSize: 15 },
});
