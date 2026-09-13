import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ImportantNewsAlertSettings } from '@/components/important-news-alert-settings';
import {
  fetchMyImportantStockNews,
  ImportantStockNews,
} from '@/lib/important-news';
import { categoryLabels, formatNewsTime, importanceLabel, targetLabel } from '@/lib/news-labels';
import { buildNewsPresentation } from '@/lib/news-presentation';
import { markImportantNewsNotificationsRead } from '@/lib/notifications';

export default function ImportantNewsScreen() {
  const [items, setItems] = useState<ImportantStockNews[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasTrackedStocks, setHasTrackedStocks] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const feed = await fetchMyImportantStockNews();
      setItems(feed.items);
      setHasTrackedStocks(feed.hasTrackedStocks);
    } catch (loadError) {
      setItems([]);
      setError(
        loadError instanceof Error
          ? loadError.message
          : '重大ニュースを取得できませんでした。',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
    void markImportantNewsNotificationsRead();
  }, [load]));

  const emptyMessage = error
    || (!hasTrackedStocks
      ? '登録銘柄がありません。検索から保有または監視に追加してみましょう。'
      : '登録銘柄に該当する重大ニュースはまだありません。');

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.container}>
        <FlatList
          data={items}
          keyExtractor={(item) => item.news_id}
          contentContainerStyle={[styles.list, !items.length && styles.emptyList]}
          ListHeaderComponent={(
            <View>
              <Text style={styles.eyebrow}>FOR YOUR STOCKS</Text>
              <Text style={styles.title}>あなたの重要ニュース</Text>
              <Text style={styles.description}>
                保有・監視銘柄と、市場全体の注目ニュースをまとめます。
              </Text>
              <ImportantNewsAlertSettings />
              {loading && !items.length ? <ActivityIndicator color="#397449" style={styles.status} /> : null}
            </View>
          )}
          refreshControl={
            <RefreshControl refreshing={loading && !!items.length} onRefresh={load} tintColor="#397449" />
          }
          ListEmptyComponent={
            !loading ? (
              <View style={[styles.emptyCard, !!error && styles.errorCard]}>
                <Text style={[styles.emptyText, !!error && styles.errorText]}>{emptyMessage}</Text>
                {!!error && (
                  <Pressable onPress={() => void load()} style={styles.retryButton}>
                    <Text style={styles.retryText}>もう一度試す</Text>
                  </Pressable>
                )}
              </View>
            ) : null
          }
          renderItem={({ item }) => {
            const holding = item.tracking_type === 'holding';
            const label = importanceLabel(item);
            const target = targetLabel(item);
            const view = buildNewsPresentation(item);
            const categories = categoryLabels(item.coverage_categories);
            return (
              <Pressable
                onPress={() => router.push({ pathname: '/news/[id]', params: { id: item.news_id } })}
                style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
                accessibilityRole="button"
                accessibilityHint="ニュースの詳細を開きます">
                <View style={styles.badgeRow}>
                  <View style={[styles.typeBadge, holding ? styles.holdingBadge : styles.watchBadge]}>
                    <Text style={[styles.typeText, holding ? styles.holdingText : styles.watchText]}>
                      {target.badge}
                    </Text>
                  </View>
                  <Text style={styles.ticker}>{target.detail}</Text>
                  <View style={[styles.importanceBadge, label.subtle && styles.subtleBadge]}>
                    <Text style={[styles.importanceText, label.subtle && styles.subtleText]}>
                      {label.text}
                    </Text>
                  </View>
                </View>
                <Text style={styles.company}>{item.company_name}</Text>
                <Text style={styles.newsTitle}>{view.title}</Text>
                {categories.length > 0 ? (
                  <View style={styles.categoryRow}>
                    {categories.slice(0, 3).map((category) => (
                      <View key={category} style={styles.categoryBadge}>
                        <Text style={styles.categoryText}>{category}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                {view.listSummary ? (
                  <Text style={styles.summary} numberOfLines={4}>{view.listSummary}</Text>
                ) : (
                  <Text style={styles.pendingSummary}>日本語の要約は準備中です（詳細で元記事の抜粋を確認できます）</Text>
                )}
                <View style={styles.footer}>
                  <Text style={styles.time}>{formatNewsTime(item.news_time)}</Text>
                  <Text style={styles.moreLink}>詳しく見る ›</Text>
                </View>
              </Pressable>
            );
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f7f8f5' },
  container: { flex: 1, width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 20 },
  eyebrow: { color: '#548161', fontWeight: '900', letterSpacing: 2, fontSize: 12 },
  title: { color: '#17211a', fontSize: 30, fontWeight: '900', marginTop: 6 },
  description: { color: '#667169', fontSize: 15, lineHeight: 22, marginTop: 8, marginBottom: 12 },
  status: { marginTop: 36 },
  list: { paddingTop: 8, paddingBottom: 110, gap: 12 },
  emptyList: { flexGrow: 1 },
  emptyCard: { marginTop: 24, borderRadius: 18, backgroundColor: '#eef3ed', padding: 22, alignItems: 'center' },
  errorCard: { backgroundColor: '#fff0ef' },
  emptyText: { color: '#5e6d63', textAlign: 'center', lineHeight: 22 },
  errorText: { color: '#9a403b' },
  retryButton: { marginTop: 16, borderRadius: 10, backgroundColor: '#397449', paddingHorizontal: 16, paddingVertical: 10 },
  retryText: { color: '#fff', fontWeight: '800' },
  card: { backgroundColor: '#fff', borderRadius: 18, borderWidth: 1, borderColor: '#e1e5e2', padding: 17 },
  cardPressed: { opacity: 0.85 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  typeBadge: { borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5 },
  holdingBadge: { backgroundColor: '#e4f1e7' },
  watchBadge: { backgroundColor: '#fff0d7' },
  typeText: { fontSize: 12, fontWeight: '900' },
  holdingText: { color: '#2c6940' },
  watchText: { color: '#946222' },
  ticker: { color: '#4b5b51', fontWeight: '900' },
  importanceBadge: { marginLeft: 'auto', borderRadius: 99, backgroundColor: '#fde8e5', paddingHorizontal: 10, paddingVertical: 5 },
  importanceText: { color: '#a23e37', fontSize: 12, fontWeight: '900' },
  subtleBadge: { backgroundColor: '#eef1ee' },
  subtleText: { color: '#5e6d63' },
  company: { color: '#526058', fontWeight: '700', fontSize: 14, marginTop: 11 },
  newsTitle: { color: '#17211a', fontWeight: '900', fontSize: 18, lineHeight: 25, marginTop: 8 },
  categoryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 9 },
  categoryBadge: { backgroundColor: '#edf3ed', borderRadius: 99, paddingHorizontal: 9, paddingVertical: 4 },
  categoryText: { color: '#477054', fontSize: 11, fontWeight: '800' },
  summary: { color: '#647068', fontSize: 14, lineHeight: 21, marginTop: 9 },
  pendingSummary: { color: '#89918c', fontSize: 13, lineHeight: 19, marginTop: 9 },
  footer: { flexDirection: 'row', alignItems: 'center', marginTop: 14 },
  time: { color: '#89918c', fontSize: 12 },
  moreLink: { color: '#397449', fontSize: 13, fontWeight: '800', marginLeft: 'auto' },
});
