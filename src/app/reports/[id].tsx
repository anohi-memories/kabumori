import { useCallback, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { fetchReport } from '@/lib/personalized-reports';
import {
  buildStockRows,
  dataGapNotes,
  direction,
  formatDateJa,
  formatPercent,
  formatPrice,
  formatSignedYen,
  formatTimeJa,
  formatYen,
  positionLabel,
  relativeText,
  reportTypeLabel,
  toneLabel,
  type Direction,
  type PersonalizedReport,
  type StockRow,
} from '@/lib/report-presentation';

const DIRECTION_COLOR: Record<Direction, string> = { up: '#b2332b', down: '#2a5fa8', flat: '#5e6d63', none: '#89918c' };

export default function ReportDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [report, setReport] = useState<PersonalizedReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      setReport(await fetchReport(String(id)));
    } catch (loadError) {
      setReport(null);
      setError(loadError instanceof Error ? loadError.message : 'レポートを取得できませんでした。');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  if (loading && !report) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#397449" />
      </View>
    );
  }

  if (!report || !report.portfolio_snapshot) {
    return (
      <View style={styles.center}>
        <Text style={styles.missingText}>{error || 'このレポートは表示できません。'}</Text>
        <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/reports'))} style={styles.backButton}>
          <Text style={styles.backButtonText}>一覧へ戻る</Text>
        </Pressable>
      </View>
    );
  }

  const snapshot = report.portfolio_snapshot;
  const close = report.report_type === 'close';
  const tone = toneLabel(report.body, report.report_type);
  const rows = buildStockRows(report);
  const relative = relativeText(snapshot);
  const gaps = dataGapNotes(snapshot);
  const byTicker = new Map(rows.holdings.map((row) => [row.stock.ticker_code, row]));
  const movers = (tickers: string[]) => tickers.map((ticker) => byTicker.get(ticker)).filter((row): row is StockRow => !!row);
  const marketNews = snapshot.news.filter((item) => !item.ticker_code);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <View style={styles.badgeRow}>
        <Text style={[styles.typeBadge, close && styles.closeBadge]}>{reportTypeLabel(report.report_type)}</Text>
        <Text style={styles.date}>{formatDateJa(report.trading_date)}</Text>
        {tone && <Text style={[styles.toneBadge, styles[`tone_${tone.tone}`]]}>{tone.text}</Text>}
      </View>
      <Text style={styles.title}>{report.title_ja}</Text>
      {!!report.summary_ja && <Text style={styles.lead}>{report.summary_ja}</Text>}
      <Text style={styles.meta}>{formatTimeJa(report.generated_at)} 作成・{close ? '当日の終値' : '前営業日の終値'}ベース</Text>

      {/* Deterministic figures (computed in code, not by the AI). */}
      <View style={styles.figures}>
        {snapshot.indices.map((index) => (
          <View key={index.label} style={styles.figure}>
            <Text style={styles.figureLabel}>{index.label}</Text>
            <Text style={styles.figureValue}>{index.price.status === 'ok' ? formatPrice(index.price.close) : '—'}</Text>
            <Text style={[styles.figureSub, { color: DIRECTION_COLOR[direction(index.price.changePercent)] }]}>
              {formatPercent(index.price.changePercent)}
            </Text>
          </View>
        ))}
        {close && snapshot.totals.day_pl !== null && (
          <View style={styles.figure}>
            <Text style={styles.figureLabel}>保有の今日の損益</Text>
            <Text style={[styles.figureValue, { color: DIRECTION_COLOR[direction(snapshot.totals.day_pl)] }]}>
              {formatSignedYen(snapshot.totals.day_pl)}
            </Text>
            <Text style={styles.figureSub}>{formatPercent(snapshot.totals.day_change_percent)}</Text>
          </View>
        )}
        {snapshot.totals.market_value !== null && (
          <View style={styles.figure}>
            <Text style={styles.figureLabel}>保有の評価額</Text>
            <Text style={styles.figureValue}>{formatYen(snapshot.totals.market_value)}</Text>
            {snapshot.totals.unrealized_pl !== null && (
              <Text style={[styles.figureSub, { color: DIRECTION_COLOR[direction(snapshot.totals.unrealized_pl)] }]}>
                含み {formatSignedYen(snapshot.totals.unrealized_pl)}
              </Text>
            )}
          </View>
        )}
      </View>
      {close && !!relative && <Text style={styles.relative}>市場との比較: {relative}</Text>}

      {!!report.body?.overview_ja && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{close ? '今日のポート総括' : '今日のポート見通し'}</Text>
          <Text style={styles.paragraph}>{report.body.overview_ja}</Text>
        </View>
      )}

      {close && (snapshot.gainers.length > 0 || snapshot.decliners.length > 0) && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>上昇・下落に効いた保有銘柄</Text>
          {movers(snapshot.gainers).map((row) => (
            <Text key={`g-${row.stock.ticker_code}`} style={styles.moverLine}>
              ▲ {row.stock.company_name} <Text style={{ color: DIRECTION_COLOR.up }}>{row.stock.day_pl !== null ? formatSignedYen(row.stock.day_pl) : formatPercent(row.stock.price.changePercent)}</Text>
            </Text>
          ))}
          {movers(snapshot.decliners).map((row) => (
            <Text key={`d-${row.stock.ticker_code}`} style={styles.moverLine}>
              ▼ {row.stock.company_name} <Text style={{ color: DIRECTION_COLOR.down }}>{row.stock.day_pl !== null ? formatSignedYen(row.stock.day_pl) : formatPercent(row.stock.price.changePercent)}</Text>
            </Text>
          ))}
        </View>
      )}

      {rows.holdings.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{close ? '保有銘柄の値動きと材料' : '影響が大きそうな順の保有銘柄'}</Text>
          {rows.holdings.map((row, index) => (
            <StockCard key={row.stock.ticker_code} row={row} rank={!close && index < 3 ? index + 1 : null} />
          ))}
        </View>
      )}

      {rows.watch.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{close ? '動きのあった監視銘柄' : '今日注目の監視銘柄'}</Text>
          {rows.watch.map((row) => <StockCard key={row.stock.ticker_code} row={row} rank={null} />)}
        </View>
      )}

      {snapshot.sector_weights.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>保有の業種バランス</Text>
          {snapshot.sector_weights.map((entry) => (
            <View key={entry.sector} style={styles.weightRow}>
              <Text style={styles.weightLabel}>{entry.sector}</Text>
              <View style={styles.weightTrack}>
                <View style={[styles.weightBar, { width: `${Math.min(100, Math.max(2, entry.weight_percent))}%` }]} />
              </View>
              <Text style={styles.weightValue}>{entry.weight_percent}%</Text>
            </View>
          ))}
          <Text style={styles.footnote}>
            {snapshot.sector_weights[0].basis === 'market_value' ? '評価額ベース' : '銘柄数ベース（数量が未登録の銘柄があるため）'}
          </Text>
        </View>
      )}

      {(report.body?.risk_notes_ja?.length ?? 0) > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>気をつけたい点</Text>
          {report.body!.risk_notes_ja!.map((note, index) => <Bullet key={index} text={note} />)}
        </View>
      )}

      {marketNews.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>ポートに関係する市場ニュース</Text>
          {marketNews.map((item) => (
            <Pressable
              key={item.news_id}
              onPress={() => router.push({ pathname: '/news/[id]', params: { id: item.news_id } })}
              style={styles.newsLink}
              accessibilityRole="button">
              <Text style={styles.newsLinkText}>{item.headline_ja} ›</Text>
            </Pressable>
          ))}
        </View>
      )}

      {(report.body?.checkpoints_ja?.length ?? 0) > 0 && (
        <View style={[styles.section, styles.checkCard]}>
          <Text style={styles.sectionTitle}>{close ? '明日見るポイント' : '今日のチェックポイント'}</Text>
          {report.body!.checkpoints_ja!.map((note, index) => <Bullet key={index} text={note} />)}
        </View>
      )}

      <View style={styles.disclaimer}>
        {gaps.map((note) => <Text key={note} style={styles.footnote}>{note}</Text>)}
        <Text style={styles.footnote}>
          数値は株価データからアプリが計算しています。文章は、その数値と内容確認済みのニュースだけをもとにAIが作成し、根拠データと照合しています。売買をすすめるものではありません。
        </Text>
      </View>
    </ScrollView>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <View style={styles.pointRow}>
      <Text style={styles.pointDot}>・</Text>
      <Text style={styles.pointText}>{text}</Text>
    </View>
  );
}

function StockCard({ row, rank }: { row: StockRow; rank: number | null }) {
  const holding = row.stock.tracking_type === 'holding';
  return (
    <View style={styles.stockCard}>
      <View style={styles.stockHead}>
        {rank !== null && <Text style={styles.rank}>{rank}</Text>}
        <Text style={[styles.posBadge, holding ? styles.holdingBadge : styles.watchBadge]}>{positionLabel(row.stock)}</Text>
        <Text style={styles.ticker}>{row.stock.ticker_code}</Text>
        <Text style={[styles.change, { color: DIRECTION_COLOR[row.changeDirection] }]}>{row.changeLine}</Text>
      </View>
      <Text style={styles.stockName}>{row.stock.company_name}</Text>
      <Text style={styles.stockLine}>{row.priceLine}</Text>
      {!!row.plLine && <Text style={styles.stockLine}>{row.plLine}</Text>}
      {!!row.unrealizedLine && <Text style={styles.stockLineSub}>{row.unrealizedLine}</Text>}
      {!!row.note && <Text style={styles.note}>{row.note}</Text>}
      {row.news.map((item) => (
        <Pressable
          key={item.news_id}
          onPress={() => router.push({ pathname: '/news/[id]', params: { id: item.news_id } })}
          style={styles.newsLink}
          accessibilityRole="button">
          <Text style={styles.newsLinkText}>{item.headline_ja} ›</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#f7f8f5' },
  content: { width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 130 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#f7f8f5' },
  missingText: { color: '#5e6d63', textAlign: 'center', lineHeight: 22 },
  backButton: { marginTop: 16, borderRadius: 10, backgroundColor: '#397449', paddingHorizontal: 16, paddingVertical: 10 },
  backButtonText: { color: '#fff', fontWeight: '800' },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  typeBadge: { color: '#2c6940', backgroundColor: '#e4f1e7', fontWeight: '900', fontSize: 12, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5, overflow: 'hidden' },
  closeBadge: { color: '#2f4f86', backgroundColor: '#e6edf8' },
  date: { color: '#4b5b51', fontWeight: '800' },
  toneBadge: { marginLeft: 'auto', fontSize: 12, fontWeight: '900', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5, overflow: 'hidden' },
  tone_positive: { color: '#2c6940', backgroundColor: '#e4f1e7' },
  tone_neutral: { color: '#5e6d63', backgroundColor: '#eef1ee' },
  tone_cautious: { color: '#946222', backgroundColor: '#fff0d7' },
  title: { color: '#17211a', fontWeight: '900', fontSize: 22, lineHeight: 31, marginTop: 12 },
  lead: { color: '#3d4a42', fontSize: 15, lineHeight: 24, marginTop: 8 },
  meta: { color: '#89918c', fontSize: 12, marginTop: 8 },
  figures: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 18 },
  figure: { flexGrow: 1, flexBasis: '45%', backgroundColor: '#fff', borderRadius: 14, borderWidth: 1, borderColor: '#e1e5e2', padding: 12 },
  figureLabel: { color: '#6b766f', fontSize: 12, fontWeight: '700' },
  figureValue: { color: '#17211a', fontSize: 19, fontWeight: '900', marginTop: 4 },
  figureSub: { color: '#6b766f', fontSize: 13, fontWeight: '700', marginTop: 2 },
  relative: { color: '#3d4a42', fontSize: 14, fontWeight: '700', marginTop: 12 },
  section: { marginTop: 24 },
  sectionTitle: { color: '#548161', fontWeight: '900', fontSize: 13, letterSpacing: 1, marginBottom: 10 },
  paragraph: { color: '#2f3a33', fontSize: 15, lineHeight: 25 },
  moverLine: { color: '#2f3a33', fontSize: 15, lineHeight: 26, fontWeight: '700' },
  stockCard: { backgroundColor: '#fff', borderRadius: 16, borderWidth: 1, borderColor: '#e1e5e2', padding: 14, marginBottom: 10 },
  stockHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rank: { color: '#fff', backgroundColor: '#397449', fontWeight: '900', fontSize: 12, width: 22, height: 22, lineHeight: 22, textAlign: 'center', borderRadius: 11, overflow: 'hidden' },
  posBadge: { fontSize: 11, fontWeight: '900', borderRadius: 99, paddingHorizontal: 8, paddingVertical: 4, overflow: 'hidden' },
  holdingBadge: { color: '#2c6940', backgroundColor: '#e4f1e7' },
  watchBadge: { color: '#946222', backgroundColor: '#fff0d7' },
  ticker: { color: '#4b5b51', fontWeight: '900' },
  change: { marginLeft: 'auto', fontWeight: '900', fontSize: 14 },
  stockName: { color: '#17211a', fontWeight: '900', fontSize: 17, marginTop: 8 },
  stockLine: { color: '#3d4a42', fontSize: 14, marginTop: 4 },
  stockLineSub: { color: '#6b766f', fontSize: 13, marginTop: 2 },
  note: { color: '#2f3a33', fontSize: 15, lineHeight: 24, marginTop: 10 },
  newsLink: { marginTop: 8, backgroundColor: '#f3f6f2', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  newsLinkText: { color: '#397449', fontSize: 13, fontWeight: '800', lineHeight: 19 },
  weightRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  weightLabel: { width: 96, color: '#3d4a42', fontSize: 13, fontWeight: '700' },
  weightTrack: { flex: 1, height: 8, backgroundColor: '#e6eae6', borderRadius: 4, overflow: 'hidden' },
  weightBar: { height: 8, backgroundColor: '#397449', borderRadius: 4 },
  weightValue: { width: 52, textAlign: 'right', color: '#3d4a42', fontSize: 13, fontWeight: '800' },
  pointRow: { flexDirection: 'row', marginBottom: 6 },
  pointDot: { color: '#397449', fontWeight: '900', width: 16 },
  pointText: { flex: 1, color: '#17211a', fontSize: 15, lineHeight: 23 },
  checkCard: { backgroundColor: '#eef3ed', borderRadius: 16, padding: 16 },
  disclaimer: { marginTop: 28, borderTopWidth: 1, borderTopColor: '#e1e5e2', paddingTop: 14, gap: 6 },
  footnote: { color: '#89918c', fontSize: 12, lineHeight: 18 },
});
