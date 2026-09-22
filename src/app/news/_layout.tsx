import { Stack } from 'expo-router';

import { KABUMORI_COLORS } from '@/constants/kabumori-theme';

const colors = KABUMORI_COLORS.light;

// The 重要ニュース tab keeps its own stack so a detail page opens on top of the
// list and the back gesture returns to it, while the bottom tabs stay in place.
export default function NewsLayout() {
  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.accent,
        headerTitleStyle: { color: colors.text, fontWeight: '800' },
        headerStyle: { backgroundColor: colors.background },
        headerShadowVisible: false,
        headerBackTitle: '一覧',
        contentStyle: { backgroundColor: colors.background },
      }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="[id]" options={{ title: 'ニュース詳細' }} />
    </Stack>
  );
}
