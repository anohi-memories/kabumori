import { useCallback, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { fetchMyImportantNewsItem, ImportantStockNews } from '@/lib/important-news';
import { formatNewsTime, importanceLabel, targetLabel } from '@/lib/news-labels';
import { buildNewsPresentation } from '@/lib/news-presentation';

export default function ImportantNewsDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [item, setItem] = useState<ImportantStockNews | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      setItem(await fetchMyImportantNewsItem(String(id)));
    } catch (loadError) {
      setItem(null);
      setError(loadError instanceof Error ? loadError.message : 'ニュースを取得できませんでした。');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  if (loading && !item) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#397449" />
      </View>
    );
  }

  if (!item) {
    return (
      <View style={styles.center}>
        <Text style={styles.missingText}>
          {error || 'このニュースは表示できません。一覧の対象から外れた可能性があります。'}
        </Text>
        <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/news'))} style={styles.backButton}>
          <Text style={styles.backButtonText}>一覧へ戻る</Text>
        </Pressable>
      </View>
    );
  }

  const view = buildNewsPresentation(item);
  const label = importanceLabel(item);
  const target = targetLabel(item);
  const holding = item.tracking_type === 'holding';

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <View style={styles.badgeRow}>
        <View style={[styles.typeBadge, holding ? styles.holdingBadge : styles.watchBadge]}>
          <Text style={[styles.typeText, holding ? styles.holdingText : styles.watchText]}>{target.badge}</Text>
        </View>
        <Text style={styles.target}>{target.detail}</Text>
        <View style={[styles.importanceBadge, label.subtle && styles.subtleBadge]}>
          <Text style={[styles.importanceText, label.subtle && styles.subtleText]}>{label.text}</Text>
        </View>
      </View>

      <Text style={styles.company}>{item.company_name}</Text>
      <Text style={styles.title}>{view.title}</Text>
      {view.title !== view.originalTitle && (
        <Text style={styles.originalTitle} numberOfLines={3}>原題: {view.originalTitle}</Text>
      )}
      <Text style={styles.time}>{formatNewsTime(item.news_time, true)}</Text>

      {view.keyPoints.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>要点</Text>
          {view.keyPoints.map((point, index) => (
            <View key={index} style={styles.pointRow}>
              <Text style={styles.pointDot}>・</Text>
              <Text style={styles.pointText}>{point}</Text>
            </View>
          ))}
        </View>
      )}

      {view.detailParagraphs.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>詳しい内容</Text>
          {view.detailParagraphs.map((paragraph, index) => (
            <Text key={index} style={styles.paragraph}>{paragraph}</Text>
          ))}
          {view.origin === 'app_copy' && (
            <Text style={styles.aiNote}>この日本語要約は、元記事をもとにAIが作成し、内容を元記事と照合しています。</Text>
          )}
        </View>
      ) : (
        <View style={[styles.section, styles.noticeCard]}>
          <Text style={styles.noticeTitle}>日本語の要約は準備中です</Text>
          <Text style={styles.noticeText}>
            このニュースは、内容の確認が済んだ日本語の要約がまだありません。事実を補って訳すことはせず、元の記事の抜粋を表示しています。
          </Text>
          {!!view.originalExcerpt && <Text style={styles.excerpt}>{view.originalExcerpt}</Text>}
        </View>
      )}

      {!!view.marketRelation && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>市場との関係</Text>
          <Text style={styles.paragraph}>{view.marketRelation}</Text>
        </View>
      )}

      {!!view.sourceUrl && (
        <View style={[styles.section, styles.sourceSection]}>
          <Text style={styles.sectionTitle}>出典</Text>
          {!!view.sourceLabel && <Text style={styles.sourceName}>{view.sourceLabel}</Text>}
          <Pressable
            onPress={() => void Linking.openURL(view.sourceUrl!)}
            style={styles.sourceButton}
            accessibilityRole="link"
            accessibilityHint="外部のウェブサイトを開きます">
            <Text style={styles.sourceButtonText}>元記事を確認（外部サイト）↗</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#f7f8f5' },
  // Extra bottom space keeps the last section clear of the tab bar.
  content: { width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 130 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#f7f8f5' },
  missingText: { color: '#5e6d63', textAlign: 'center', lineHeight: 22 },
  backButton: { marginTop: 16, borderRadius: 10, backgroundColor: '#397449', paddingHorizontal: 16, paddingVertical: 10 },
  backButtonText: { color: '#fff', fontWeight: '800' },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  typeBadge: { borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5 },
  holdingBadge: { backgroundColor: '#e4f1e7' },
  watchBadge: { backgroundColor: '#fff0d7' },
  typeText: { fontSize: 12, fontWeight: '900' },
  holdingText: { color: '#2c6940' },
  watchText: { color: '#946222' },
  target: { color: '#4b5b51', fontWeight: '900' },
  importanceBadge: { marginLeft: 'auto', borderRadius: 99, backgroundColor: '#fde8e5', paddingHorizontal: 10, paddingVertical: 5 },
  importanceText: { color: '#a23e37', fontSize: 12, fontWeight: '900' },
  subtleBadge: { backgroundColor: '#eef1ee' },
  subtleText: { color: '#5e6d63' },
  company: { color: '#526058', fontWeight: '700', fontSize: 14, marginTop: 14 },
  title: { color: '#17211a', fontWeight: '900', fontSize: 22, lineHeight: 31, marginTop: 6 },
  originalTitle: { color: '#89918c', fontSize: 12, lineHeight: 18, marginTop: 6 },
  time: { color: '#89918c', fontSize: 12, marginTop: 8 },
  section: { marginTop: 22 },
  sectionTitle: { color: '#548161', fontWeight: '900', fontSize: 13, letterSpacing: 1, marginBottom: 8 },
  pointRow: { flexDirection: 'row', marginBottom: 6 },
  pointDot: { color: '#397449', fontWeight: '900', width: 16 },
  pointText: { flex: 1, color: '#17211a', fontSize: 15, lineHeight: 23, fontWeight: '600' },
  paragraph: { color: '#2f3a33', fontSize: 15, lineHeight: 25, marginBottom: 12 },
  aiNote: { color: '#89918c', fontSize: 12, lineHeight: 18 },
  noticeCard: { backgroundColor: '#eef3ed', borderRadius: 16, padding: 16 },
  noticeTitle: { color: '#2c6940', fontWeight: '900', fontSize: 15 },
  noticeText: { color: '#5e6d63', fontSize: 13, lineHeight: 20, marginTop: 6 },
  excerpt: { color: '#4b5b51', fontSize: 13, lineHeight: 20, marginTop: 12, fontStyle: 'italic' },
  sourceSection: { borderTopWidth: 1, borderTopColor: '#e1e5e2', paddingTop: 18 },
  sourceName: { color: '#4b5b51', fontSize: 14, fontWeight: '700' },
  sourceButton: { marginTop: 12, alignSelf: 'flex-start', borderRadius: 10, borderWidth: 1, borderColor: '#397449', paddingHorizontal: 14, paddingVertical: 9 },
  sourceButtonText: { color: '#397449', fontSize: 14, fontWeight: '800' },
});
