import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import type { KabumoriPalette } from '@/constants/kabumori-theme';
import { HOME_COLORS, HOME_LAYOUT } from '@/constants/home-tokens';
import type { ImportantStockNews } from '@/lib/important-news';
import { categoryLabels } from '@/lib/news-labels';
import { buildNewsPresentation } from '@/lib/news-presentation';
import { companyMark, rowTint, newsTint, relativeTimeJa } from '@/lib/home-format';
import { HomeSectionHeader } from '@/components/home/home-section-header';

type HomeHoldingNewsListProps = {
  palette: KabumoriPalette;
  items: ImportantStockNews[];
  loading: boolean;
  error: string;
  onRetry: () => void;
};

// Dense rows (about 50pt each): initial tile | company + ticker / category + headline | time.
// There is no company-logo data, so the tile is the company's first two characters on a tint
// chosen by row position (so neighbouring rows always differ) -- never a fetched or invented logo.
export function HomeHoldingNewsList({ palette, items, loading, error, onRetry }: HomeHoldingNewsListProps) {
  return (
    <View>
      <HomeSectionHeader
        palette={palette}
        title="あなたの保有銘柄 最新ニュース"
        markColor="#2f9e57"
        accessibilityLabel="保有銘柄の最新ニュースをすべて見る"
      />

      <View style={styles.card}>
        {loading && !items.length ? <ActivityIndicator color={palette.accent} style={styles.status} /> : null}

        {!!error ? (
          <View style={[styles.errorCard, { backgroundColor: palette.error }]}>
            <Text style={[styles.errorText, { color: palette.muted }]}>{error}</Text>
            <Pressable onPress={onRetry} style={[styles.retryButton, { backgroundColor: palette.accent }]} accessibilityRole="button" accessibilityLabel="もう一度読み込む">
              <Text style={styles.retryText}>もう一度試す</Text>
            </Pressable>
          </View>
        ) : null}

        {!loading && !error && !items.length ? (
          <Text style={[styles.emptyText, { color: palette.muted }]}>保有銘柄に関連する新着ニュースはまだありません。</Text>
        ) : null}

        {items.map((item, index) => {
          const view = buildNewsPresentation(item);
          const tint = rowTint(index);
          const category = categoryLabels(item.coverage_categories)[0] ?? null;
          const categoryTint = newsTint(item.coverage_categories);
          return (
            <Pressable
              key={item.news_id}
              onPress={() => router.push({ pathname: '/news-detail', params: { id: item.news_id, from: 'home' } })}
              style={({ pressed }) => [
                styles.row,
                index > 0 && { borderTopColor: HOME_COLORS.cardBorder, borderTopWidth: StyleSheet.hairlineWidth },
                pressed && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityHint="ニュースの詳細を開きます">
              <View style={[styles.tile, { backgroundColor: tint.background }]}>
                <Text style={[styles.tileText, { color: tint.foreground }]}>{companyMark(item.company_name)}</Text>
              </View>
              <View style={styles.main}>
                <View style={styles.nameLine}>
                  <Text style={[styles.company, { color: palette.text }]} numberOfLines={1}>
                    {item.company_name}
                  </Text>
                  {item.ticker_code ? <Text style={[styles.ticker, { color: palette.muted }]}>{item.ticker_code}</Text> : null}
                </View>
                <View style={styles.headlineLine}>
                  {category ? (
                    <Text style={[styles.category, { color: categoryTint.foreground, backgroundColor: categoryTint.background }]} numberOfLines={1}>
                      {category}
                    </Text>
                  ) : null}
                  <Text style={[styles.headline, { color: palette.text }]} numberOfLines={1}>
                    {view.title}
                  </Text>
                </View>
              </View>
              <View style={styles.trailing}>
                <Text style={[styles.time, { color: palette.muted }]} numberOfLines={1}>
                  {relativeTimeJa(item.news_time)}
                </Text>
                <Text style={[styles.chevron, { color: palette.muted }]}>›</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 8,
    borderRadius: HOME_LAYOUT.radius - 4,
    borderWidth: 1,
    borderColor: HOME_COLORS.cardBorder,
    backgroundColor: HOME_COLORS.card,
    paddingHorizontal: 10,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4, minHeight: 40 },
  tile: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  tileText: { fontSize: 12, fontWeight: '900' },
  main: { flex: 1, minWidth: 0, gap: 3 },
  nameLine: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  company: { flexShrink: 1, fontSize: 13, fontWeight: '900' },
  ticker: { fontSize: 11, fontWeight: '700' },
  headlineLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  category: { fontSize: 10, fontWeight: '900', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden', maxWidth: 80 },
  headline: { flex: 1, fontSize: 12, fontWeight: '600' },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  time: { fontSize: 11, fontWeight: '700' },
  chevron: { fontSize: 18, lineHeight: 20 },
  status: { marginVertical: 16 },
  emptyText: { fontSize: 13, lineHeight: 19, paddingVertical: 12 },
  errorCard: { borderRadius: 12, padding: 12, marginVertical: 8 },
  errorText: { fontSize: 13, lineHeight: 19 },
  retryButton: { alignSelf: 'flex-start', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8, marginTop: 10 },
  retryText: { color: '#fff', fontWeight: '900', fontSize: 12 },
  pressed: { opacity: 0.7 },
});
