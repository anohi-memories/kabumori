import { router, Stack } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { goHomeFromNews, goNewsList } from '@/lib/detail-navigation';

const colors = KABUMORI_COLORS.light;

// The 重要ニュース tab keeps its own stack so a detail page opens on top of the
// list while the bottom tabs stay in place.
//
// The detail header always offers both destinations -- ニュース一覧 on the left and ホーム on the right --
// as direct routes (never router.back()/canGoBack()), so they exist whichever entry opened the detail:
// the Home market card or holding row, the news list, a report, a push notification or a cold deep link.
// The header is part of the stack screen, so the loading and missing/error states keep it too.
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
        options={{
          title: 'ニュース詳細',
          headerBackVisible: false,
          headerLeft: () => (
            <Pressable
              onPress={() => goNewsList(router)}
              accessibilityRole="button"
              accessibilityLabel="ニュース一覧へ"
              hitSlop={8}
              style={styles.headerButton}>
              <Text style={styles.headerText}>‹ ニュース一覧</Text>
            </Pressable>
          ),
          headerRight: () => (
            <Pressable
              onPress={() => goHomeFromNews(router)}
              accessibilityRole="button"
              accessibilityLabel="ホームへ"
              hitSlop={8}
              style={styles.headerButton}>
              <Text style={styles.headerText}>ホーム</Text>
            </Pressable>
          ),
        }}
      />
    </Stack>
  );
}

const styles = StyleSheet.create({
  headerButton: { minHeight: 44, justifyContent: 'center' },
  headerText: { color: colors.accent, fontWeight: '800', fontSize: 15 },
});
