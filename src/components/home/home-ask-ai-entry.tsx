import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import type { KabumoriPalette } from '@/constants/kabumori-theme';
import { HOME_COLORS, HOME_LAYOUT } from '@/constants/home-tokens';

// No AI chat service exists yet, so this stays an honest, compact entry: it opens the "準備中"
// screen (src/app/ai.tsx) and says so on the card. It deliberately has NO fake text box or
// question chips that would look sendable -- nothing here pretends a question can be asked.
export function HomeAskAiEntry({ palette }: { palette: KabumoriPalette }) {
  return (
    <Pressable
      onPress={() => router.push('/ai')}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel="AIに聞いてみる（準備中）"
      accessibilityHint="AIに聞く機能の準備状況を開きます">
      <View style={[styles.icon, { backgroundColor: palette.soft }]}>
        <Text style={[styles.iconText, { color: palette.accent }]}>✦</Text>
      </View>
      <View style={styles.text}>
        <View style={styles.titleLine}>
          <Text style={[styles.title, { color: palette.text }]}>AIに聞いてみる</Text>
          <Text style={[styles.badge, { color: palette.muted, backgroundColor: palette.soft }]}>準備中</Text>
        </View>
        <Text style={[styles.description, { color: palette.muted }]} numberOfLines={1}>
          気になるニュースや銘柄を、AIがやさしく解説します。
        </Text>
      </View>
      <Text style={[styles.chevron, { color: palette.muted }]}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: HOME_LAYOUT.radius - 4,
    borderWidth: 1,
    borderColor: HOME_COLORS.cardBorder,
    backgroundColor: HOME_COLORS.card,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 56,
  },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 16, fontWeight: '900' },
  text: { flex: 1, minWidth: 0, gap: 2 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 14, fontWeight: '900' },
  badge: { fontSize: 10, fontWeight: '900', borderRadius: 99, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  description: { fontSize: 11.5, fontWeight: '600' },
  chevron: { fontSize: 22, lineHeight: 24 },
  pressed: { opacity: 0.75 },
});
