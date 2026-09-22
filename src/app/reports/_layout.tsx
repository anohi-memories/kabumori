import { Stack } from 'expo-router';

import { KABUMORI_COLORS } from '@/constants/kabumori-theme';

const colors = KABUMORI_COLORS.light;

// The レポート tab keeps its own stack (like 重要ニュース) so a report opens on
// top of the list and the back gesture returns to it.
export default function ReportsLayout() {
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
      <Stack.Screen name="[id]" options={{ title: 'レポート' }} />
    </Stack>
  );
}
