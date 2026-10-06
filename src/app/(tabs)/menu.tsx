import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { MENU_ENTRIES } from '@/lib/menu-entries';

const palette = KABUMORI_COLORS.light;

// The メニュー tab: destinations that do not get their own bottom tab. Each one
// is a root Stack screen pushed on top of the tabs, with its own back button.
export default function MenuScreen() {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.headerRow}>
        <Text style={styles.eyebrow}>MENU</Text>
        <Text style={styles.title}>メニュー</Text>
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        {MENU_ENTRIES.map((entry) => (
          <Pressable
            key={entry.id}
            onPress={() => router.push(entry.href)}
            accessibilityRole="button"
            accessibilityLabel={entry.label}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
            <View style={styles.rowMain}>
              <Text style={styles.rowLabel}>{entry.label}</Text>
              <Text style={styles.rowDescription}>{entry.description}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.background },
  headerRow: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 6 },
  eyebrow: { color: palette.accent, fontWeight: '900', letterSpacing: 2, fontSize: 11 },
  title: { color: palette.text, fontSize: 26, fontWeight: '900', marginTop: 4 },
  list: { padding: 20, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: palette.card, borderColor: palette.border, borderWidth: 1, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, minHeight: 60 },
  rowMain: { flex: 1, gap: 3 },
  rowLabel: { color: palette.text, fontSize: 15, fontWeight: '800' },
  rowDescription: { color: palette.muted, fontSize: 13, lineHeight: 19 },
  chevron: { color: palette.muted, fontSize: 22, marginLeft: 10 },
  pressed: { opacity: 0.7 },
});
