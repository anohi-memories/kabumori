import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import type { KabumoriPalette } from '@/constants/kabumori-theme';

const QUESTION_CHIPS = ['この銘柄は今買い時？', '今日の市場のポイントは？', '保有銘柄への影響は？'];

// No AI chat route/service exists yet, so this navigates to an honest
// "準備中" screen (src/app/ai.tsx) rather than pretending a question can
// actually be sent -- no fake chat, no dead button. Styled as a compact
// input-field-style entry point rather than a large disabled CTA, so it
// doesn't bloat the card's height.
export function AskAiEntry({ palette }: { palette: KabumoriPalette }) {
  return (
    <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border }]}>
      <Text style={[styles.eyebrow, { color: palette.accent }]}>ASK KABUMORI AI</Text>
      <Text style={[styles.title, { color: palette.text }]}>AIに聞いてみる</Text>
      <Pressable
        onPress={() => router.push('/ai')}
        style={({ pressed }) => [styles.inputRow, { backgroundColor: palette.soft, borderColor: palette.border }, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="AIに聞いてみる">
        <Text style={[styles.inputText, { color: palette.muted }]} numberOfLines={1}>
          気になるニュースや銘柄について聞いてみる…
        </Text>
      </Pressable>
      <View style={styles.chipRow}>
        {QUESTION_CHIPS.map((chip) => (
          <Pressable
            key={chip}
            onPress={() => router.push('/ai')}
            style={[styles.chip, { backgroundColor: palette.soft, borderColor: palette.border }]}
            accessibilityRole="button"
            accessibilityLabel={chip}>
            <Text style={[styles.chipText, { color: palette.muted }]} numberOfLines={1}>
              {chip}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 18, borderWidth: 1, padding: 16 },
  eyebrow: { fontWeight: '900', letterSpacing: 1.4, fontSize: 11 },
  title: { fontSize: 19, fontWeight: '900', marginTop: 3 },
  inputRow: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, marginTop: 12 },
  inputText: { fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.7 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  chip: { borderRadius: 99, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 7, maxWidth: '100%' },
  chipText: { fontSize: 12, fontWeight: '800' },
});
