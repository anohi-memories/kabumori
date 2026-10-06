import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { TopicLevel } from '@/lib/home-topic';
import { TOPIC_DETAIL_LEVEL_COLORS } from '@/lib/topic-detail-presentation';
import { TOPIC_SWITCH_LEVELS } from '@/lib/topic-detail-switch';

// The compact 初級 / 中級 / 上級 selector shared by the topic detail and the topic list. It is a viewing
// aid only: it reports the tapped level and never writes the Home level preference. The track takes the
// active level's tint; the selected segment is that level's accent colour (green / blue / lavender).
export function LevelSwitcher({
  active,
  pending = null,
  onSelect,
  hint,
}: {
  active: TopicLevel;
  /** A level that is being loaded: its label shows a small spinner. */
  pending?: TopicLevel | null;
  onSelect: (level: TopicLevel) => void;
  hint: string;
}) {
  const colors = TOPIC_DETAIL_LEVEL_COLORS[active];
  return (
    <View style={[styles.switcher, { backgroundColor: colors.soft, borderColor: colors.outline }]}>
      {TOPIC_SWITCH_LEVELS.map(({ level, label }) => {
        const selected = active === level;
        const levelColors = TOPIC_DETAIL_LEVEL_COLORS[level];
        return (
          <Pressable
            key={level}
            onPress={() => onSelect(level)}
            accessibilityRole="button"
            accessibilityLabel={`${label}のトピック`}
            accessibilityState={{ selected, busy: pending === level }}
            accessibilityHint={hint}
            style={[styles.segment, selected && { backgroundColor: levelColors.strong }]}>
            {pending === level ? (
              <ActivityIndicator size="small" color={levelColors.strong} />
            ) : (
              <Text style={[styles.text, { color: selected ? '#ffffff' : levelColors.strong }]}>{label}</Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  switcher: { marginTop: 12, flexDirection: 'row', borderRadius: 14, borderWidth: 1, padding: 3, gap: 3 },
  segment: { flex: 1, minHeight: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  text: { fontSize: 15, fontWeight: '900' },
});
