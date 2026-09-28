import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { KabumoriPalette } from '@/constants/kabumori-theme';

const QUESTION_CHIPS = ['この銘柄は今買い時？', '今日の市場のポイントは？', '保有銘柄への影響は？'];

// No AI chat route/service exists yet in this repo, so this is a disabled
// "coming soon" entry rather than a dead button or fake chat, per the task's
// explicit instruction not to fake navigation that doesn't exist.
export function AskAiEntry({ palette }: { palette: KabumoriPalette }) {
  return (
    <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border }]}>
      <Text style={[styles.eyebrow, { color: palette.accent }]}>ASK KABUMORI AI</Text>
      <Text style={[styles.title, { color: palette.text }]}>AIに聞いてみる</Text>
      <View style={styles.chipRow}>
        {QUESTION_CHIPS.map((chip) => (
          <View key={chip} style={[styles.chip, { backgroundColor: palette.soft, borderColor: palette.border }]}>
            <Text style={[styles.chipText, { color: palette.muted }]} numberOfLines={1}>
              {chip}
            </Text>
          </View>
        ))}
      </View>
      <Pressable
        disabled
        style={[styles.cta, { backgroundColor: palette.soft }]}
        accessibilityRole="button"
        accessibilityLabel="AIに聞いてみる（準備中）"
        accessibilityState={{ disabled: true }}>
        <Text style={[styles.ctaText, { color: palette.muted }]}>準備中です</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 18, borderWidth: 1, padding: 16 },
  eyebrow: { fontWeight: '900', letterSpacing: 1.4, fontSize: 11 },
  title: { fontSize: 19, fontWeight: '900', marginTop: 3 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  chip: { borderRadius: 99, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 7, maxWidth: '100%' },
  chipText: { fontSize: 12, fontWeight: '800' },
  cta: { borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginTop: 14 },
  ctaText: { fontSize: 14, fontWeight: '900' },
});
