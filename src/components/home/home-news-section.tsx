import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import type { KabumoriPalette } from '@/constants/kabumori-theme';
import type { ImportantStockNews } from '@/lib/important-news';
import { categoryLabels, formatNewsTime, importanceLabel } from '@/lib/news-labels';
import { buildNewsPresentation } from '@/lib/news-presentation';
import { homeNewsVisual } from '@/lib/home-news-visual';

type HomeNewsSectionProps = {
  palette: KabumoriPalette;
  eyebrow: string;
  title: string;
  items: ImportantStockNews[];
  loading: boolean;
  error: string;
  emptyText: string;
  itemSubtitle: (item: ImportantStockNews) => string;
  onRetry: () => void;
};

// Shared presentation for the two home news sections (market-wide / holding),
// so market vs. holding filtering stays the only difference between them.
export function HomeNewsSection({
  palette,
  eyebrow,
  title,
  items,
  loading,
  error,
  emptyText,
  itemSubtitle,
  onRetry,
}: HomeNewsSectionProps) {
  return (
    <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border }]}>
      <View style={styles.header}>
        <View>
          <Text style={[styles.eyebrow, { color: palette.accent }]}>{eyebrow}</Text>
          <Text style={[styles.title, { color: palette.text }]}>{title}</Text>
        </View>
        <Pressable onPress={() => router.push('/news')} accessibilityRole="button" accessibilityLabel={`${title}をすべて見る`}>
          <Text style={[styles.link, { color: palette.accent }]}>すべて見る ›</Text>
        </Pressable>
      </View>

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
        <Text style={[styles.emptyText, { color: palette.muted }]}>{emptyText}</Text>
      ) : null}

      {items.map((item) => {
        const importance = importanceLabel(item);
        const view = buildNewsPresentation(item);
        const visual = homeNewsVisual(item);
        const category = categoryLabels(item.coverage_categories)[0] ?? null;
        return (
          <Pressable
            key={item.news_id}
            onPress={() => router.push({ pathname: '/news/[id]', params: { id: item.news_id } })}
            style={({ pressed }) => [styles.row, { borderTopColor: palette.border }, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityHint="ニュースの詳細を開きます">
            <View style={[styles.visual, { backgroundColor: palette.soft }]}>
              <Text style={[styles.visualGlyph, { color: palette.accent }]}>{visual.glyph}</Text>
            </View>
            <View style={styles.rowMain}>
              <View style={styles.rowTopLine}>
                <Text style={[styles.subtitle, { color: palette.muted }]} numberOfLines={1}>
                  {itemSubtitle(item)}
                </Text>
                <Text style={[styles.importance, { color: importance.subtle ? palette.muted : '#a23e37' }]}>{importance.text}</Text>
              </View>
              <Text style={[styles.rowTitle, { color: palette.text }]} numberOfLines={2}>
                {view.title}
              </Text>
              <View style={styles.rowFooter}>
                {category ? (
                  <Text style={[styles.category, { color: palette.accent, backgroundColor: palette.soft }]} numberOfLines={1}>
                    {category}
                  </Text>
                ) : null}
                <Text style={[styles.rowTime, { color: palette.muted }]}>{formatNewsTime(item.news_time)}</Text>
              </View>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 18, borderWidth: 1, padding: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { fontWeight: '900', letterSpacing: 1.4, fontSize: 11 },
  title: { fontSize: 19, fontWeight: '900', marginTop: 3 },
  link: { fontSize: 12, fontWeight: '900' },
  status: { marginVertical: 18 },
  emptyText: { fontSize: 13, lineHeight: 19, marginTop: 12 },
  errorCard: { borderRadius: 12, padding: 12, marginTop: 12 },
  errorText: { fontSize: 13, lineHeight: 19 },
  retryButton: { alignSelf: 'flex-start', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8, marginTop: 10 },
  retryText: { color: '#fff', fontWeight: '900', fontSize: 12 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderTopWidth: 1, paddingVertical: 12, marginTop: 4 },
  visual: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  visualGlyph: { fontSize: 14, fontWeight: '900' },
  rowMain: { flex: 1 },
  rowTopLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  subtitle: { flex: 1, fontSize: 11, fontWeight: '800' },
  importance: { fontSize: 11, fontWeight: '900' },
  rowTitle: { fontSize: 15, lineHeight: 21, fontWeight: '900', marginTop: 4 },
  rowFooter: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  category: { fontSize: 10, fontWeight: '800', borderRadius: 99, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  rowTime: { fontSize: 11 },
  pressed: { opacity: 0.7 },
});
