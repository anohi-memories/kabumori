import { router, Stack } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { backFromNewsDetail, goNewsList, resetStackWhenHidden } from '@/lib/detail-navigation';

const colors = KABUMORI_COLORS.light;

// The 重要ニュース tab keeps its own stack so a detail page opens on top of the
// list while the bottom tabs stay in place.
//
// The detail header has a contextual 「‹ 戻る」 on the left and an always-available 「ニュース一覧 ›」 on the
// right. Back is resolved from the explicit `from` origin param the entry point passed (Home market card /
// holding row = home, the news list = news; a report, a notification or a cold deep link = unknown, which
// falls back to Home) -- not from the stack, whose nested news stack can disagree with the visual origin.
// The list action ignores the origin. The header is part of the stack screen, so the loading and
// missing/error states keep both.
export default function NewsLayout() {
  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.accent,
        headerTitleStyle: { color: colors.text, fontWeight: '800' },
        headerStyle: { backgroundColor: colors.background },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.background },
      }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen
        name="[id]"
        options={({ route, navigation }) => ({
          title: 'ニュース詳細',
          headerBackVisible: false,
          headerLeft: () => (
            <Pressable
              onPress={() =>
                backFromNewsDetail(router, (route.params as { from?: unknown } | undefined)?.from, () => resetStackWhenHidden(navigation))
              }
              accessibilityRole="button"
              accessibilityLabel="戻る"
              hitSlop={8}
              style={styles.headerButton}>
              <Text style={styles.headerText}>‹ 戻る</Text>
            </Pressable>
          ),
          headerRight: () => (
            <Pressable
              onPress={() => goNewsList(router)}
              accessibilityRole="button"
              accessibilityLabel="ニュース一覧へ"
              hitSlop={8}
              style={styles.headerButton}>
              <Text style={styles.headerText}>ニュース一覧 ›</Text>
            </Pressable>
          ),
        })}
      />
    </Stack>
  );
}

const styles = StyleSheet.create({
  headerButton: { minHeight: 44, justifyContent: 'center' },
  headerText: { color: colors.accent, fontWeight: '800', fontSize: 15 },
});
