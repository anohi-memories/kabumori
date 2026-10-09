import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PF, sparkColor, toneColor, toneSoft } from '@/components/portfolio/portfolio-theme';
import { Sparkline } from '@/components/portfolio/sparkline';
import { StockAvatar } from '@/components/portfolio/stock-avatar';
import {
  avatarLabel,
  formatAmount,
  formatSignedAmount,
  formatSignedPercent,
  sparklineTrend,
  tone,
  type AiSummary,
  type AssetSummary,
  type ImpactItem,
  type PortfolioLabels,
} from '@/lib/portfolio-view';

// The root-stack report detail: a swipe / back pops straight to the portfolio (the nested レポート-tab route
// would reveal the reports list instead).
// Decorative artwork of the asset-summary card only (transparent WebP, 1600x700): pale leaves and a soft glow on the
// right, no text, numbers, chart or arrows. It is never used anywhere else.
const ASSET_CARD_BACKGROUND = require('@/assets/images/portfolio/portfolio_asset_card_growth_background.webp');

const openReport = (reportId: string) => router.push({ pathname: '/report-detail', params: { id: reportId } });

// ---- header ---------------------------------------------------------------------------------------------

/** A magnifier drawn with two Views (no icon dependency, no emoji). */
function SearchIcon() {
  return (
    <View style={styles.searchIcon}>
      <View style={styles.searchRing} />
      <View style={styles.searchHandle} />
    </View>
  );
}

export function PortfolioHeader({ onWatchlist, onSearch }: { onWatchlist: () => void; onSearch: () => void }) {
  return (
    <View style={styles.headerRow}>
      <View style={styles.headerTitles}>
        <Text style={styles.eyebrow}>PORTFOLIO</Text>
        <Text style={styles.title} numberOfLines={1} adjustsFontSizeToFit>ポートフォリオ</Text>
      </View>
      <Pressable
        onPress={onWatchlist}
        accessibilityRole="button"
        accessibilityLabel="ウォッチリスト"
        accessibilityHint="監視している銘柄の一覧を開きます"
        hitSlop={6}
        style={({ pressed }) => [styles.watchButton, pressed && styles.pressed]}>
        <Text style={styles.watchStar}>★</Text>
        <Text style={styles.watchText}>ウォッチリスト</Text>
      </Pressable>
      <Pressable
        onPress={onSearch}
        accessibilityRole="button"
        accessibilityLabel="銘柄を検索"
        hitSlop={6}
        style={({ pressed }) => [styles.searchButton, pressed && styles.pressed]}>
        <SearchIcon />
      </Pressable>
    </View>
  );
}

// ---- asset summary ---------------------------------------------------------------------------------------

function Metric({ label, amount, percent, align }: { label: string; amount: number | null; percent: number | null; align?: 'right' }) {
  const direction = tone(amount);
  return (
    <View style={[styles.metric, align === 'right' && styles.metricRight]}>
      <Text style={styles.metricLabel} numberOfLines={1}>{label}</Text>
      <Text style={[styles.metricValue, { color: direction === 'none' ? PF.muted : toneColor(direction) }]} numberOfLines={1} adjustsFontSizeToFit>
        {formatSignedAmount(amount)}
      </Text>
      <View style={[styles.pill, { backgroundColor: toneSoft(tone(percent)) }]}>
        <Text style={[styles.pillText, { color: toneColor(tone(percent)) }]}>{formatSignedPercent(percent)}</Text>
      </View>
    </View>
  );
}

export function AssetSummaryCard({
  summary,
  labels,
  spark,
  hasReport,
  notes,
}: {
  summary: AssetSummary;
  labels: PortfolioLabels;
  spark: readonly number[];
  hasReport: boolean;
  notes: readonly string[];
}) {
  return (
    <View style={[styles.card, styles.assetCard]} accessibilityLabel={`資産評価額 ${formatAmount(summary.assetValue)}`}>
      {/* Decorative botanical background: first child (behind every text and the sparkline), clipped to the card's
          rounded corners, takes no touches and is hidden from accessibility. It carries no financial meaning. */}
      <Image
        source={ASSET_CARD_BACKGROUND}
        style={styles.assetBackground}
        contentFit="cover"
        pointerEvents="none"
        accessible={false}
      />
      <View style={styles.assetTop}>
        <View style={styles.assetMain}>
          <Text style={styles.assetLabel}>資産評価額</Text>
          <Text style={styles.assetValue} numberOfLines={1} adjustsFontSizeToFit>{formatAmount(summary.assetValue)}</Text>
          <Text style={styles.basisLabel} numberOfLines={1}>
            {hasReport ? `${labels.basis}（保存済み大引け）` : '評価額は大引けレポート作成後に表示されます'}
          </Text>
        </View>
        {spark.length >= 2 ? (
          <View style={styles.sparkWrap}>
            <Sparkline values={spark} width={104} height={56} color={sparkColor(sparklineTrend(spark))} />
          </View>
        ) : null}
      </View>
      <View style={styles.divider} />
      <View style={styles.metricsRow}>
        <Metric label="評価損益" amount={summary.unrealizedPl} percent={summary.unrealizedPlPercent} />
        <View style={styles.metricDivider} />
        <Metric label={labels.dayChange} amount={summary.dayPl} percent={summary.dayChangePercent} />
      </View>
      {notes.map((note) => (
        <Text key={note} style={styles.note}>{note}</Text>
      ))}
    </View>
  );
}

// ---- AI summary ---------------------------------------------------------------------------------------------

export function AiSummaryCard({ summary, labels }: { summary: AiSummary; labels: PortfolioLabels }) {
  return (
    <Pressable
      onPress={() => openReport(summary.reportId)}
      accessibilityRole="button"
      accessibilityLabel={`${labels.aiTitle}。${summary.text}`}
      accessibilityHint="大引けレポートを開きます"
      style={({ pressed }) => [styles.aiCard, pressed && styles.pressed]}>
      <View style={styles.aiHead}>
        <View style={styles.aiBadge}>
          <Text style={styles.aiBadgeMark}>✦</Text>
          <Text style={styles.aiBadgeText}>AI</Text>
        </View>
        <Text style={styles.aiTitle} numberOfLines={1}>{labels.aiTitle}</Text>
        <Text style={styles.chevron}>›</Text>
      </View>
      <Text style={styles.aiBody} numberOfLines={4}>{summary.text}</Text>
      <View style={styles.aiCta}>
        <Text style={styles.aiCtaText}>{labels.aiCta} ›</Text>
      </View>
    </Pressable>
  );
}

// ---- impact top 3 -------------------------------------------------------------------------------------------------

/** Three small bars: the section mark (a native shape, no icon dependency). */
function BarsMark() {
  return (
    <View style={styles.barsMark}>
      <View style={[styles.bar, { height: 9 }]} />
      <View style={[styles.bar, { height: 16 }]} />
      <View style={[styles.bar, { height: 12 }]} />
    </View>
  );
}

export function ImpactCard({ items, labels, reportId }: { items: readonly ImpactItem[]; labels: PortfolioLabels; reportId: string }) {
  return (
    <View style={styles.card}>
      <View style={styles.impactHead}>
        <BarsMark />
        <Text style={styles.impactTitle} numberOfLines={1}>{labels.impactTitle}</Text>
        <Pressable onPress={() => openReport(reportId)} accessibilityRole="button" accessibilityLabel="詳しく見る（大引けレポート）" hitSlop={8}>
          <Text style={styles.moreLink}>詳しく見る ›</Text>
        </Pressable>
      </View>
      {items.map((item, index) => {
        const direction = tone(item.dayPl);
        return (
          <View key={item.ticker} style={[styles.impactRow, index > 0 && styles.impactRowBorder]} accessible accessibilityLabel={`${item.company} ${item.ticker} ${formatSignedAmount(item.dayPl)} ${formatSignedPercent(item.changePercent, 1)}`}>
            <StockAvatar label={avatarLabel(item.company, item.ticker)} name={item.company} size={40} />
            <View style={styles.impactName}>
              <Text style={styles.impactCompany} numberOfLines={2}>{item.company}</Text>
              <Text style={styles.impactTicker}>{item.ticker}</Text>
            </View>
            <Text style={[styles.impactAmount, { color: toneColor(direction) }]} numberOfLines={1}>{formatSignedAmount(item.dayPl)}</Text>
            <View style={[styles.pill, styles.impactPill, { backgroundColor: toneSoft(tone(item.changePercent)) }]}>
              <Text style={[styles.pillText, { color: toneColor(tone(item.changePercent)) }]}>{formatSignedPercent(item.changePercent, 1)}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

// ---- call to action ---------------------------------------------------------------------------------------------------

export function AskAiCta() {
  return (
    <Pressable
      onPress={() => router.push('/ai')}
      accessibilityRole="button"
      accessibilityLabel="このポートフォリオについてAIに聞く（準備中）"
      accessibilityHint="AIに聞く機能の準備状況を開きます"
      style={({ pressed }) => [styles.cta, pressed && styles.pressed]}>
      <View style={styles.ctaIcon}>
        <Text style={styles.ctaIconMark}>✦</Text>
      </View>
      <View style={styles.ctaText}>
        <Text style={styles.ctaTitle} numberOfLines={2}>このポートフォリオについてAIに聞く ›</Text>
        <Text style={styles.ctaSub} numberOfLines={1}>なぜ上がった？ リスクは？ 業種のバランスは？</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.75 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitles: { flex: 1, minWidth: 0 },
  eyebrow: { color: PF.muted, fontWeight: '800', letterSpacing: 3, fontSize: 11 },
  title: { color: PF.ink, fontSize: 32, fontWeight: '900', marginTop: 2 },
  watchButton: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, borderRadius: 22, paddingHorizontal: 14, backgroundColor: PF.aiBackground, borderWidth: 1, borderColor: PF.aiBorder },
  watchStar: { color: PF.up, fontSize: 14 },
  watchText: { color: PF.ink, fontSize: 13, fontWeight: '800' },
  searchButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: PF.aiBackground, borderWidth: 1, borderColor: PF.aiBorder },
  searchIcon: { width: 20, height: 20 },
  searchRing: { position: 'absolute', left: 1, top: 1, width: 13, height: 13, borderRadius: 7, borderWidth: 2.5, borderColor: PF.ink },
  searchHandle: { position: 'absolute', left: 10, top: 14, width: 8, height: 2.5, borderRadius: 2, backgroundColor: PF.ink, transform: [{ rotate: '45deg' }] },

  card: { backgroundColor: PF.card, borderRadius: PF.radius, borderWidth: 1, borderColor: PF.cardBorder, padding: 16 },
  assetCard: { overflow: 'hidden' },
  // The art's leaves sit in the right ~35% of the image; the image spans the card width at its own 1600:700 ratio,
  // anchored top-right and cropped slightly at the right edge, softly translucent so the value stays the priority.
  assetBackground: { position: 'absolute', top: 0, right: -8, width: '102%', aspectRatio: 1600 / 700, opacity: 0.45 },
  assetTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  assetMain: { flex: 1, minWidth: 0 },
  assetLabel: { color: PF.muted, fontSize: 13, fontWeight: '700' },
  assetValue: { color: PF.ink, fontSize: 38, lineHeight: 46, fontWeight: '900', marginTop: 2 },
  basisLabel: { color: PF.muted, fontSize: 11.5, marginTop: 2 },
  sparkWrap: { paddingTop: 10 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: PF.cardBorder, marginVertical: 12 },
  metricsRow: { flexDirection: 'row' },
  metric: { flex: 1, minWidth: 0, gap: 4 },
  metricRight: { alignItems: 'flex-end' },
  metricLabel: { color: PF.muted, fontSize: 12.5, fontWeight: '700' },
  metricValue: { fontSize: 24, lineHeight: 30, fontWeight: '900' },
  metricDivider: { width: StyleSheet.hairlineWidth, backgroundColor: PF.cardBorder, marginHorizontal: 14 },
  pill: { alignSelf: 'flex-start', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 3 },
  pillText: { fontSize: 13, fontWeight: '800' },
  note: { color: PF.muted, fontSize: 11.5, lineHeight: 17, marginTop: 8 },

  aiCard: { backgroundColor: PF.aiBackground, borderRadius: PF.radius, borderWidth: 1, borderColor: PF.aiBorder, padding: 16, gap: 10 },
  aiHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  aiBadge: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#d4ebdb', alignItems: 'center', justifyContent: 'center' },
  aiBadgeMark: { color: PF.up, fontSize: 15, fontWeight: '900', lineHeight: 17 },
  aiBadgeText: { color: PF.up, fontSize: 9, fontWeight: '900', lineHeight: 10 },
  aiTitle: { flex: 1, color: PF.ink, fontSize: 18, fontWeight: '900' },
  chevron: { color: PF.muted, fontSize: 24, lineHeight: 26 },
  aiBody: { color: PF.ink, fontSize: 14.5, lineHeight: 22 },
  aiCta: { alignSelf: 'flex-start', borderRadius: 99, borderWidth: 1, borderColor: PF.aiBorder, backgroundColor: '#ffffff', paddingHorizontal: 16, paddingVertical: 9 },
  aiCtaText: { color: PF.ink, fontSize: 14, fontWeight: '800' },

  barsMark: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 18 },
  bar: { width: 5, borderRadius: 2, backgroundColor: PF.up },
  impactHead: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 8 },
  impactTitle: { flex: 1, color: PF.ink, fontSize: 17, fontWeight: '900' },
  moreLink: { color: PF.muted, fontSize: 13, fontWeight: '700' },
  impactRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  impactRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: PF.cardBorder },
  impactName: { flex: 1, minWidth: 0 },
  impactCompany: { color: PF.ink, fontSize: 15, fontWeight: '800' },
  impactTicker: { color: PF.muted, fontSize: 12, marginTop: 1 },
  impactAmount: { fontSize: 15, fontWeight: '900' },
  impactPill: { minWidth: 58, alignItems: 'center', alignSelf: 'center' },

  cta: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: PF.cta, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14, minHeight: 64 },
  ctaIcon: { width: 36, height: 36, borderRadius: 18, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.8)', alignItems: 'center', justifyContent: 'center' },
  ctaIconMark: { color: '#ffffff', fontSize: 16, fontWeight: '900' },
  ctaText: { flex: 1, minWidth: 0, gap: 2 },
  ctaTitle: { color: '#ffffff', fontSize: 15.5, lineHeight: 21, fontWeight: '900' },
  ctaSub: { color: 'rgba(255,255,255,0.82)', fontSize: 12 },
});
