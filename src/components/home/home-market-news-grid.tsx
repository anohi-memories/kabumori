import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import type { KabumoriPalette } from '@/constants/kabumori-theme';
import { HOME_COLORS, HOME_LAYOUT } from '@/constants/home-tokens';
import type { ImportantStockNews } from '@/lib/important-news';
import { categoryLabels, importanceLabel } from '@/lib/news-labels';
import { buildNewsPresentation } from '@/lib/news-presentation';
import { homeNewsVisual } from '@/lib/home-news-visual';
import { newsTint, relativeTimeJa } from '@/lib/home-format';
import { HomeSectionHeader } from '@/components/home/home-section-header';

export const MARKET_CARD_WIDTH = 152;
export const MARKET_MEDIA_HEIGHT = 58;

type HomeMarketNewsGridProps = {
  palette: KabumoriPalette;
  items: ImportantStockNews[];
  loading: boolean;
  error: string;
  onRetry: () => void;
};

// Compact horizontally-scrolling cards (about 2.3 visible on a phone). The feed has no image URL,
// so each card's media area is a neutral, deterministic category tile (tint + glyph) -- never a
// fetched or invented picture.
export function HomeMarketNewsGrid({ palette, items, loading, error, onRetry }: HomeMarketNewsGridProps) {
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
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          // Bleed to the screen edges so the cards scroll under the gutter.
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}>
          {items.map((item) => {
            const importance = importanceLabel(item);
            const view = buildNewsPresentation(item);
            const visual = homeNewsVisual(item);
            const tint = newsTint(item.coverage_categories);
            const category = categoryLabels(item.coverage_categories)[0] ?? null;
            return (
              <Pressable
                key={item.news_id}
                onPress={() => router.push({ pathname: '/news/[id]', params: { id: item.news_id } })}
                style={({ pressed }) => [styles.card, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityHint="ニュースの詳細を開きます">
                <View style={[styles.media, { backgroundColor: tint.background }]}>
                  <Text style={[styles.glyph, { color: tint.foreground }]}>{visual.glyph}</Text>
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
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { marginHorizontal: -HOME_LAYOUT.gutter, marginTop: 8 },
  scrollContent: { paddingHorizontal: HOME_LAYOUT.gutter, gap: 8 },
  card: {
    width: MARKET_CARD_WIDTH,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: HOME_COLORS.cardBorder,
    backgroundColor: HOME_COLORS.card,
    overflow: 'hidden',
  },
  media: { height: MARKET_MEDIA_HEIGHT, justifyContent: 'center', alignItems: 'center' },
  glyph: { fontSize: 26, fontWeight: '900', opacity: 0.55 },
  importanceBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    backgroundColor: HOME_COLORS.important,
    color: '#fff',
    fontSize: 10,
    fontWeight: '900',
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  timeChip: {
    position: 'absolute',
    right: 6,
    bottom: 5,
    backgroundColor: 'rgba(23,33,26,0.55)',
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  body: { padding: 8, gap: 5 },
  category: { alignSelf: 'flex-start', fontSize: 10, fontWeight: '900', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  title: { fontSize: 12.5, lineHeight: 17, fontWeight: '900', minHeight: 34 },
  status: { marginVertical: 18 },
  emptyText: { fontSize: 13, lineHeight: 19, marginTop: 10 },
  errorCard: { borderRadius: 12, padding: 12, marginTop: 10 },
  errorText: { fontSize: 13, lineHeight: 19 },
  retryButton: { alignSelf: 'flex-start', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8, marginTop: 10 },
  retryText: { color: '#fff', fontWeight: '900', fontSize: 12 },
  pressed: { opacity: 0.75 },
});
