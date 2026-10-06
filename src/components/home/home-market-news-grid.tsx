import { ActivityIndicator, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';

import type { KabumoriPalette } from '@/constants/kabumori-theme';
import { HOME_COLORS, HOME_LAYOUT } from '@/constants/home-tokens';
import type { ImportantStockNews } from '@/lib/important-news';
import { categoryLabels, importanceLabel } from '@/lib/news-labels';
import { buildNewsPresentation } from '@/lib/news-presentation';
import { homeNewsVisual } from '@/lib/home-news-visual';
import { newsTint, relativeTimeJa } from '@/lib/home-format';
import { HomeSectionHeader } from '@/components/home/home-section-header';

export const MARKET_CARD_GAP = 8;
export const MARKET_MEDIA_HEIGHT = 44;
// Three cards across, sized from the screen width so they always fill the row exactly.
export const MARKET_CARD_COUNT = 3;

type HomeMarketNewsGridProps = {
  palette: KabumoriPalette;
  items: ImportantStockNews[];
  loading: boolean;
  error: string;
  onRetry: () => void;
};

// Three compact cards across the screen width, like the reference. The feed has no image URL,
// so each card's media area is a neutral, deterministic category tile (tint + glyph) -- never a
// fetched or invented picture.
export function HomeMarketNewsGrid({ palette, items, loading, error, onRetry }: HomeMarketNewsGridProps) {
  const { width } = useWindowDimensions();
  const cardWidth = Math.floor(
    (Math.min(width, 720) - HOME_LAYOUT.gutter * 2 - MARKET_CARD_GAP * (MARKET_CARD_COUNT - 1)) / MARKET_CARD_COUNT,
  );
  return (
    <View>
      <HomeSectionHeader palette={palette} title="重要ニュース" markColor={HOME_COLORS.brandGreen} accessibilityLabel="重要ニュースをすべて見る" />

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
        <Text style={[styles.emptyText, { color: palette.muted }]}>市場全体の重要ニュースはまだありません。</Text>
      ) : null}

      {items.length ? (
        <View style={styles.row}>
          {items.map((item) => {
            const importance = importanceLabel(item);
            const view = buildNewsPresentation(item);
            const visual = homeNewsVisual(item);
            const tint = newsTint(item.coverage_categories);
            const category = categoryLabels(item.coverage_categories)[0] ?? null;
            // The neutral fallback glyph is an arrow, which reads as a button on a tile.
            const glyph = visual.glyph === '›' ? '◇' : visual.glyph;
            return (
              <Pressable
                key={item.news_id}
                onPress={() => router.push({ pathname: '/news-detail', params: { id: item.news_id, from: 'home' } })}
                style={({ pressed }) => [styles.card, { width: cardWidth }, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityHint="ニュースの詳細を開きます">
                <View style={[styles.media, { backgroundColor: tint.background }]}>
                  <Text style={[styles.glyph, { color: tint.foreground }]}>{glyph}</Text>
                  {!importance.subtle ? (
                    <Text style={styles.importanceBadge} numberOfLines={1}>
                      {importance.text}
                    </Text>
                  ) : null}
                  <Text style={styles.timeChip} numberOfLines={1}>
                    {relativeTimeJa(item.news_time)}
                  </Text>
                </View>
                <View style={styles.body}>
                  {category ? (
                    <Text style={[styles.category, { color: tint.foreground, backgroundColor: tint.background }]} numberOfLines={1}>
                      {category}
                    </Text>
                  ) : null}
                  <Text style={[styles.title, { color: palette.text }]} numberOfLines={2}>
                    {view.title}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: MARKET_CARD_GAP, marginTop: 8 },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: HOME_COLORS.cardBorder,
    backgroundColor: HOME_COLORS.card,
    overflow: 'hidden',
  },
  media: { height: MARKET_MEDIA_HEIGHT, justifyContent: 'center', alignItems: 'center' },
  // Top-right, clear of the importance badge (top-left) and the time chip (bottom-right).
  glyph: { position: 'absolute', top: 6, right: 9, fontSize: 18, fontWeight: '900', opacity: 0.55 },
  importanceBadge: {
    position: 'absolute',
    top: 5,
    left: 5,
    backgroundColor: HOME_COLORS.important,
    color: '#fff',
    fontSize: 9.5,
    fontWeight: '900',
    borderRadius: 5,
    paddingHorizontal: 4,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  timeChip: {
    position: 'absolute',
    right: 5,
    bottom: 4,
    backgroundColor: 'rgba(23,33,26,0.55)',
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  body: { padding: 6, gap: 3 },
  category: { alignSelf: 'flex-start', fontSize: 10, fontWeight: '900', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  title: { fontSize: 11.5, lineHeight: 15, fontWeight: '900', minHeight: 30 },
  status: { marginVertical: 18 },
  emptyText: { fontSize: 13, lineHeight: 19, marginTop: 10 },
  errorCard: { borderRadius: 12, padding: 12, marginTop: 10 },
  errorText: { fontSize: 13, lineHeight: 19 },
  retryButton: { alignSelf: 'flex-start', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8, marginTop: 10 },
  retryText: { color: '#fff', fontWeight: '900', fontSize: 12 },
  pressed: { opacity: 0.75 },
});
