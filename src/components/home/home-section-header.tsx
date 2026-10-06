import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import type { KabumoriPalette } from '@/constants/kabumori-theme';

type HomeSectionHeaderProps = {
  palette: KabumoriPalette;
  title: string;
  markColor: string;
  accessibilityLabel: string;
  /** Where "すべて見る" goes; the news list is the default. */
  href?: '/news' | '/topics';
};

// One section header shared by every Home block: colour mark + title on the left, "すべて見る"
// on the right. Kept in one place so the section rhythm/typography stays consistent.
export function HomeSectionHeader({ palette, title, markColor, accessibilityLabel, href = '/news' }: HomeSectionHeaderProps) {
  return (
    <View style={styles.row}>
      <View style={styles.titleGroup}>
        <View style={[styles.mark, { backgroundColor: markColor }]} />
        <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>
          {title}
        </Text>
      </View>
      <Pressable
        onPress={() => router.push(href)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}>
        <Text style={[styles.link, { color: palette.accent }]}>すべて見る →</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  titleGroup: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 7 },
  mark: { width: 5, height: 18, borderRadius: 3 },
  title: { flexShrink: 1, fontSize: 17, fontWeight: '900' },
  link: { fontSize: 12, fontWeight: '900' },
});
