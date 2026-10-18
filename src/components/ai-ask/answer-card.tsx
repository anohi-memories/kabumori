import { Pressable, StyleSheet, Text, View } from 'react-native';

import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import {
  ASK_DISCLAIMER_JA,
  ASK_SOURCE_LABEL_JA,
  asOfLabel,
  dataAsOfLabel,
  formatJstDateTime,
  sourcesSummary,
  type AskResponse,
} from '@/lib/ai-ask';

const palette = KABUMORI_COLORS.light;

type Answered = Extract<AskResponse, { status: 'answered' }>;

// A shown answer always carries: what it is based on (sources, each with its own time or 不明), when the data it
// used was taken, whether it used the user's holdings, and the investment caution. None of these is optional.
export function AnswerCard({ answer, onOpenSource }: { answer: Answered; onOpenSource?: (kind: string, ref: string) => void }) {
  return (
    <View style={styles.card} accessible={false}>
      <Text style={styles.answer} selectable accessibilityRole="text">{answer.answer}</Text>

      {answer.keyPoints.length > 0 ? (
        <View style={styles.points}>
          {answer.keyPoints.map((point) => (
            <View key={point} style={styles.pointRow}>
              <Text style={styles.bullet}>•</Text>
              <Text style={styles.pointText}>{point}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.meta}>
        <Text style={styles.metaText}>{dataAsOfLabel(answer.dataAsOf)}</Text>
        <Text style={styles.metaText}>
          {answer.generatedAt ? `回答の作成: ${formatJstDateTime(answer.generatedAt) ?? '不明'}` : '回答の作成: 不明'}
        </Text>
        {answer.usedHoldings ? <Text style={styles.metaText}>あなたの保有銘柄の情報を使っています</Text> : null}
      </View>

      <View style={styles.sources}>
        <Text style={styles.sourcesTitle}>{sourcesSummary(answer.sources)}</Text>
        {answer.sources.map((source, index) => {
          const canOpen = !!source.ref && !!onOpenSource;
          const body = (
            <View style={styles.sourceRow}>
              <Text style={styles.sourceKind}>{ASK_SOURCE_LABEL_JA[source.kind]}</Text>
              <View style={styles.sourceMain}>
                <Text style={styles.sourceTitle} numberOfLines={2}>{source.title}</Text>
                <Text style={styles.sourceTime}>{asOfLabel(source.asOf)}</Text>
              </View>
            </View>
          );
          return canOpen ? (
            <Pressable
              key={`${source.kind}-${index}`}
              onPress={() => onOpenSource?.(source.kind, source.ref as string)}
              accessibilityRole="button"
              accessibilityLabel={`${ASK_SOURCE_LABEL_JA[source.kind]} ${source.title} ${asOfLabel(source.asOf)}`}>
              {body}
            </Pressable>
          ) : (
            <View
              key={`${source.kind}-${index}`}
              accessible
              accessibilityLabel={`${ASK_SOURCE_LABEL_JA[source.kind]} ${source.title} ${asOfLabel(source.asOf)}`}>
              {body}
            </View>
          );
        })}
      </View>

      <Text style={styles.disclaimer}>{ASK_DISCLAIMER_JA}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: palette.card, borderRadius: 18, borderWidth: 1, borderColor: palette.border, padding: 16, gap: 12 },
  answer: { color: palette.text, fontSize: 15.5, lineHeight: 24 },
  points: { gap: 6 },
  pointRow: { flexDirection: 'row', gap: 8 },
  bullet: { color: palette.accent, fontWeight: '900', lineHeight: 22 },
  pointText: { flex: 1, color: palette.text, fontSize: 14.5, lineHeight: 22 },
  meta: { gap: 3, paddingTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  metaText: { color: palette.muted, fontSize: 12.5, lineHeight: 18 },
  sources: { gap: 8 },
  sourcesTitle: { color: palette.text, fontSize: 13, fontWeight: '900' },
  sourceRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', minHeight: 44 },
  sourceKind: { color: palette.accent, backgroundColor: palette.soft, fontSize: 11, fontWeight: '900', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, overflow: 'hidden' },
  sourceMain: { flex: 1, gap: 2 },
  sourceTitle: { color: palette.text, fontSize: 13.5, fontWeight: '700', lineHeight: 19 },
  sourceTime: { color: palette.muted, fontSize: 12 },
  disclaimer: { color: palette.muted, fontSize: 11.5, lineHeight: 17 },
});
