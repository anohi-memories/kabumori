import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { PF, toneColor, toneSoft } from '@/components/portfolio/portfolio-theme';
import { StockAvatar } from '@/components/portfolio/stock-avatar';
import {
  formatPriceYen,
  formatSignedAmount,
  formatSignedPercent,
  tone,
  type HoldingRow,
  type PortfolioLabels,
} from '@/lib/portfolio-view';

/** Stacked bars: the section mark (a native shape, no icon dependency). */
function StackMark() {
  return (
    <View style={styles.stack}>
      <View style={[styles.layer, { opacity: 1 }]} />
      <View style={[styles.layer, { opacity: 0.65 }]} />
      <View style={[styles.layer, { opacity: 0.35 }]} />
    </View>
  );
}

export function HoldingsHeader({ count }: { count: number }) {
  return (
    <View style={styles.header}>
      <StackMark />
      <Text style={styles.headerTitle}>保有銘柄</Text>
      <View style={styles.countBadge}>
        <Text style={styles.countText}>{count}銘柄</Text>
      </View>
    </View>
  );
}

// Material tags are restrained and only come from stored report data (see buildHoldingRows).
const TAG_STYLE: Record<string, { background: string; color: string }> = {
  ニュース: { background: '#e8f1fb', color: '#2b5d93' },
  追い風: { background: PF.upSoft, color: PF.up },
  逆風: { background: PF.downSoft, color: PF.down },
};
const NEUTRAL_TAG = { background: '#eef0ed', color: PF.muted };

// One holding: the top line carries identity and the two figures (終値 / 評価損益) so the company name keeps
// a readable column; the stored material tag + one-line note sit on a full-width line below.
function HoldingCard({ row, labels, hasReport, onPress }: { row: HoldingRow; labels: PortfolioLabels; hasReport: boolean; onPress: () => void }) {
  const width = useWindowDimensions().width;
  const wide = width >= 600;
  // On phones the figure columns are a little narrower so the company name keeps its room.
  const narrow = width < 390;
  const changeTone = tone(row.changePercent);
  const plTone = tone(row.unrealizedPl);
  const pctTone = tone(row.unrealizedPlPercent);
  const tagStyle = row.tag ? TAG_STYLE[row.tag] ?? NEUTRAL_TAG : null;
  const unreflected = hasReport && !row.reflected;
  const summary = [
    row.company,
    row.ticker,
    row.reflected ? `${labels.priceWord} ${formatPriceYen(row.close)}` : unreflected ? '最新レポート未反映' : '',
    row.reflected ? `評価損益 ${formatSignedAmount(row.unrealizedPl)}` : '',
  ].filter(Boolean).join(' ');
  const hasMaterial = row.reflected && (!!row.tag || !!row.line);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={summary}
      accessibilityHint="この保有銘柄の情報を編集します"
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
      <View style={styles.top}>
        <StockAvatar label={row.avatar} name={row.company} size={wide ? 52 : 42} />
        <View style={styles.name}>
          <Text style={styles.company} numberOfLines={3}>{row.company}</Text>
          <Text style={styles.ticker}>{row.ticker}</Text>
        </View>
        <View style={[styles.price, narrow && styles.priceNarrow]}>
          <Text style={styles.colLabel}>{labels.priceWord}</Text>
          <Text style={styles.colValue} numberOfLines={1} adjustsFontSizeToFit>{formatPriceYen(row.close)}</Text>
          <Text style={[styles.colSub, { color: toneColor(changeTone) }]} numberOfLines={1}>{formatSignedPercent(row.changePercent, 1)}</Text>
        </View>
        <View style={[styles.pl, narrow && styles.plNarrow]}>
          <Text style={styles.colLabel}>評価損益</Text>
          <Text style={[styles.colValue, styles.right, { color: plTone === 'none' ? PF.muted : toneColor(plTone) }]} numberOfLines={1} adjustsFontSizeToFit>
            {formatSignedAmount(row.unrealizedPl)}
          </Text>
          <View style={[styles.pill, { backgroundColor: toneSoft(pctTone) }]}>
            <Text style={[styles.pillText, { color: toneColor(pctTone) }]}>{formatSignedPercent(row.unrealizedPlPercent, 1)}</Text>
          </View>
        </View>
        <Text style={styles.chevron}>›</Text>
      </View>
      {unreflected ? (
        <View style={styles.material}>
          <View style={[styles.tag, { backgroundColor: NEUTRAL_TAG.background }]}>
            <Text style={[styles.tagText, { color: NEUTRAL_TAG.color }]}>最新レポート未反映</Text>
          </View>
        </View>
      ) : null}
      {hasMaterial ? (
        <View style={styles.material}>
          {tagStyle ? (
            <View style={[styles.tag, { backgroundColor: tagStyle.background }]}>
              <Text style={[styles.tagText, { color: tagStyle.color }]}>{row.tag}</Text>
            </View>
          ) : null}
          {row.line ? <Text style={styles.line} numberOfLines={1}>{row.line}</Text> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

export function HoldingsList({
  rows,
  labels,
  hasReport,
  onOpen,
}: {
  rows: readonly HoldingRow[];
  labels: PortfolioLabels;
  /** False when there is no saved close report at all: rows then simply have no figures, no 未反映 tag. */
  hasReport: boolean;
  onOpen: (trackedId: string) => void;
}) {
  return (
    <View style={styles.list}>
      {rows.map((row) => (
        <HoldingCard key={row.trackedId} row={row} labels={labels} hasReport={hasReport} onPress={() => onOpen(row.trackedId)} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 10 },
  headerTitle: { color: PF.ink, fontSize: 20, fontWeight: '900' },
  countBadge: { backgroundColor: '#e7ece8', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 3 },
  countText: { color: PF.muted, fontSize: 12.5, fontWeight: '800' },
  stack: { width: 22, gap: 2 },
  layer: { height: 5, borderRadius: 2.5, backgroundColor: PF.up },

  list: { gap: 8 },
  card: { backgroundColor: PF.card, borderRadius: PF.radius, borderWidth: 1, borderColor: PF.cardBorder, paddingVertical: 12, paddingLeft: 12, paddingRight: 8, gap: 8 },
  pressed: { opacity: 0.75 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1, minWidth: 0, gap: 1 },
  company: { color: PF.ink, fontSize: 15, lineHeight: 20, fontWeight: '900' },
  ticker: { color: PF.muted, fontSize: 12 },
  price: { width: 62, gap: 2 },
  priceNarrow: { width: 58 },
  pl: { width: 92, gap: 2, alignItems: 'flex-end' },
  plNarrow: { width: 86 },
  colLabel: { color: PF.muted, fontSize: 11 },
  colValue: { color: PF.ink, fontSize: 15, lineHeight: 20, fontWeight: '900', alignSelf: 'stretch' },
  right: { textAlign: 'right' },
  colSub: { fontSize: 12, fontWeight: '700' },
  pill: { borderRadius: 99, paddingHorizontal: 8, paddingVertical: 2 },
  pillText: { fontSize: 12, fontWeight: '800' },
  chevron: { color: PF.muted, fontSize: 20, lineHeight: 22, width: 8 },
  material: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 4 },
  tag: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  tagText: { fontSize: 11, fontWeight: '800' },
  line: { flex: 1, color: PF.muted, fontSize: 12, lineHeight: 16 },
});
