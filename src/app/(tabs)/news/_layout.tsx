import { Stack } from 'expo-router';

import { KABUMORI_COLORS } from '@/constants/kabumori-theme';

const colors = KABUMORI_COLORS.light;

// The 重要ニュース tab is just its list. The news detail is a route of the root stack (src/app/news-detail.tsx),
// so a detail opened from anywhere pops straight back to where it was opened from.
export default function NewsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="index" />
    </Stack>
  );
}
