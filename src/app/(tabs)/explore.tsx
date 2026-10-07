import { useCallback, useMemo, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { HoldingsHeader, HoldingsList } from '@/components/portfolio/holdings-section';
import {
  AiSummaryCard,
  AskAiCta,
  AssetSummaryCard,
  ImpactCard,
  PortfolioHeader,
} from '@/components/portfolio/portfolio-sections';
import { PF, toneColor } from '@/components/portfolio/portfolio-theme';
import { StockAvatar } from '@/components/portfolio/stock-avatar';
import { TrackedStockEditor } from '@/components/tracked-stock-editor';
import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { todayJst } from '@/lib/dashboard';
import { fetchRecentReports } from '@/lib/personalized-reports';
import {
  aiSummary,
  assetSummary,
  buildHoldingRows,
  buildWatchRows,
  formatPriceYen,
  formatSignedPercent,
  portfolioBasis,
  portfolioLabels,
  sparklineValues,
  tone,
  topImpacts,
} from '@/lib/portfolio-view';
import { dataGapNotes, latestCloseReport, type PersonalizedReport } from '@/lib/report-presentation';
import type { TrackedStock } from '@/lib/stocks';
import { supabase } from '@/lib/supabase';

const colors = KABUMORI_COLORS.light;
// The tab bar already sits below this scroll area, so only a calm gap is needed under the last block.
const BOTTOM_SPACE = 28;

// The 銘柄 tab: the canonical portfolio dashboard (summary, AI overview, impact top 3, holdings) with a
// Watchlist subview. Every figure comes from the latest SAVED close report -- no live quotes -- joined to the
// user's CURRENT registrations (tracked_stocks), which stay editable through the existing editor. Search is its
// own screen (/search). Holdings, watch stocks and the report load independently, so a failed report never
// hides the registrations (and vice versa).
export default function PortfolioScreen() {
  const [view, setView] = useState<'portfolio' | 'watchlist'>('portfolio');
  const [items, setItems] = useState<TrackedStock[]>([]);
  const [reports, setReports] = useState<PersonalizedReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [reportError, setReportError] = useState(false);
  const [selected, setSelected] = useState<TrackedStock | null>(null);
  // The pull-to-refresh spinner follows a pull only, not the reload on tab focus.
  const [pulling, setPulling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage('');
    const reportsPromise = fetchRecentReports(20)
      .then((next) => {
        setReports(next);
        setReportError(false);
      })
      .catch(() => setReportError(true));
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) {
      setItems([]);
      setMessage('一覧を見るにはログインが必要です。');
    } else {
      const { data, error } = await supabase
        .from('tracked_stocks')
        .select('id,user_id,stock_id,tracking_type,quantity,average_price,position_type,side,target_buy_price,target_sell_price,memo,stocks_master!inner(id,ticker_code,company_name,market)')
        .eq('user_id', authData.user.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false });
      if (error) {
        setItems([]);
        setMessage('一覧を読み込めませんでした。');
      } else {
        setItems((data ?? []) as unknown as TrackedStock[]);
      }
    }
    await reportsPromise;
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const today = todayJst();
  const report = useMemo(() => latestCloseReport(reports), [reports]);
  const basis = useMemo(() => portfolioBasis(report, today), [report, today]);
  const labels = portfolioLabels(basis);
  const summary = assetSummary(basis?.snapshot ?? null);
  const spark = useMemo(() => sparklineValues(reports), [reports]);
  const impacts = useMemo(() => topImpacts(basis?.snapshot ?? null), [basis]);
  const overview = aiSummary(basis);
  const holdings = useMemo(() => buildHoldingRows(items, report), [items, report]);
  const watch = useMemo(() => buildWatchRows(items, report), [items, report]);
  const notes = dataGapNotes(basis?.snapshot ?? null);

  const openTracked = (trackedId: string) => setSelected(items.find((item) => item.id === trackedId) ?? null);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={() => { setPulling(true); void load().finally(() => setPulling(false)); }} tintColor={colors.accent} />}>
        {view === 'portfolio' ? (
          <View style={styles.stack}>
            <PortfolioHeader onWatchlist={() => setView('watchlist')} onSearch={() => router.push('/search')} />

            {loading && !items.length && !reports.length ? <ActivityIndicator color={colors.accent} style={styles.status} /> : null}
            {!loading && !!message ? <Text style={styles.message}>{message}</Text> : null}

            <AssetSummaryCard summary={summary} labels={labels} spark={spark} hasReport={!!basis} notes={notes} />
            {reportError ? <Text style={styles.reportError}>レポートのデータを読み込めませんでした。引っ張って更新できます。</Text> : null}

            {overview ? <AiSummaryCard summary={overview} labels={labels} /> : null}
            {basis && impacts.length > 0 ? <ImpactCard items={impacts} labels={labels} reportId={basis.report.id} /> : null}

            <View style={styles.holdings}>
              <HoldingsHeader count={holdings.length} />
              {holdings.length > 0 ? (
                <HoldingsList rows={holdings} labels={labels} hasReport={!!basis} onOpen={openTracked} />
              ) : !loading && !message ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyText}>保有銘柄はまだありません。検索から銘柄を登録できます。</Text>
                  <Pressable onPress={() => router.push('/search')} accessibilityRole="button" style={styles.emptyButton}>
                    <Text style={styles.emptyButtonText}>銘柄を探す</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>

            <AskAiCta />
          </View>
        ) : (
          <View style={styles.stack}>
            <Pressable onPress={() => setView('portfolio')} accessibilityRole="button" accessibilityLabel="ポートフォリオへ戻る" hitSlop={8} style={styles.backLink}>
              <Text style={styles.backText}>‹ ポートフォリオ</Text>
            </Pressable>
            <View style={styles.watchHead}>
              <View style={styles.watchTitles}>
                <Text style={styles.eyebrow}>WATCHLIST</Text>
                <Text style={styles.title}>ウォッチリスト</Text>
              </View>
              <Pressable onPress={() => router.push('/search')} accessibilityRole="button" accessibilityLabel="銘柄を検索" style={styles.addButton}>
                <Text style={styles.addText}>＋ 追加</Text>
              </Pressable>
            </View>
            {!loading && !!message ? <Text style={styles.message}>{message}</Text> : null}
            {watch.length === 0 && !loading && !message ? (
              <View style={styles.empty}>
                <Text style={styles.emptyText}>監視銘柄はまだありません。気になる銘柄を検索から登録できます。</Text>
                <Pressable onPress={() => router.push('/search')} accessibilityRole="button" style={styles.emptyButton}>
                  <Text style={styles.emptyButtonText}>銘柄を探す</Text>
                </Pressable>
              </View>
            ) : null}
            <View style={styles.watchList}>
              {watch.map((row) => {
                const change = tone(row.changePercent);
                const { target_buy_price: buy, target_sell_price: sell } = row.tracked;
                return (
                  <Pressable
                    key={row.tracked.id}
                    onPress={() => setSelected(row.tracked)}
                    accessibilityRole="button"
                    accessibilityLabel={`${row.company} ${row.ticker}`}
                    accessibilityHint="この監視銘柄の情報を編集または削除します"
                    style={({ pressed }) => [styles.watchCard, pressed && styles.pressed]}>
                    <StockAvatar label={row.avatar} name={row.company} size={48} />
                    <View style={styles.watchMain}>
                      <Text style={styles.watchCompany} numberOfLines={2}>{row.company}</Text>
                      <Text style={styles.watchTicker}>{row.ticker} ・ {row.tracked.stocks_master.market}</Text>
                      {buy != null ? <Text style={styles.watchTarget}>買いたい {formatPriceYen(buy)}</Text> : null}
                      {sell != null ? <Text style={styles.watchTarget}>売りたい {formatPriceYen(sell)}</Text> : null}
                    </View>
                    <View style={styles.watchPrice}>
                      <Text style={styles.watchPriceLabel}>終値</Text>
                      <Text style={styles.watchPriceValue}>{formatPriceYen(row.close)}</Text>
                      <Text style={[styles.watchChange, { color: toneColor(change) }]}>{formatSignedPercent(row.changePercent, 1)}</Text>
                    </View>
                    <Text style={styles.chevron}>›</Text>
                  </Pressable>
                );
              })}
            </View>
            {watch.length > 0 ? <Text style={styles.watchNote}>終値は{labels.basis}（保存済み大引け）です。リアルタイム価格ではありません。</Text> : null}
          </View>
        )}
      </ScrollView>

      <TrackedStockEditor
        stock={selected?.stocks_master ?? null}
        existing={selected}
        visible={!!selected}
        onClose={() => setSelected(null)}
        onSaved={() => { setSelected(null); void load(); }}
        onDeleted={() => { setSelected(null); void load(); }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: PF.page },
  content: { width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: PF.gutter, paddingTop: 10, paddingBottom: BOTTOM_SPACE },
  stack: { gap: 12 },
  status: { marginTop: 8 },
  message: { color: PF.muted, textAlign: 'center', lineHeight: 22 },
  reportError: { color: colors.errorText, backgroundColor: colors.errorSoft, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, fontSize: 12.5, lineHeight: 18 },
  holdings: { marginTop: 6 },
  empty: { backgroundColor: PF.card, borderRadius: PF.radius, borderWidth: 1, borderColor: PF.cardBorder, padding: 18, gap: 12, alignItems: 'center' },
  emptyText: { color: PF.muted, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  emptyButton: { backgroundColor: PF.cta, borderRadius: 99, paddingHorizontal: 20, paddingVertical: 10 },
  emptyButtonText: { color: '#ffffff', fontWeight: '800', fontSize: 14 },
  pressed: { opacity: 0.75 },

  backLink: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  backText: { color: colors.accent, fontWeight: '800', fontSize: 15 },
  watchHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  watchTitles: { flex: 1 },
  eyebrow: { color: PF.muted, fontWeight: '800', letterSpacing: 3, fontSize: 11 },
  title: { color: PF.ink, fontSize: 30, fontWeight: '900', marginTop: 2 },
  addButton: { minHeight: 44, borderRadius: 22, paddingHorizontal: 16, justifyContent: 'center', backgroundColor: PF.aiBackground, borderWidth: 1, borderColor: PF.aiBorder },
  addText: { color: PF.up, fontWeight: '800', fontSize: 13 },
  watchList: { gap: 8 },
  watchCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: PF.card, borderRadius: PF.radius, borderWidth: 1, borderColor: PF.cardBorder, paddingVertical: 12, paddingLeft: 12, paddingRight: 10 },
  watchMain: { flex: 1, minWidth: 0, gap: 2 },
  watchCompany: { color: PF.ink, fontSize: 15.5, lineHeight: 20, fontWeight: '900' },
  watchTicker: { color: PF.muted, fontSize: 12 },
  watchTarget: { color: PF.muted, fontSize: 12 },
  watchPrice: { alignItems: 'flex-end', gap: 2 },
  watchPriceLabel: { color: PF.muted, fontSize: 11 },
  watchPriceValue: { color: PF.ink, fontSize: 15, fontWeight: '900' },
  watchChange: { fontSize: 12, fontWeight: '700' },
  chevron: { color: PF.muted, fontSize: 22, lineHeight: 24 },
  watchNote: { color: PF.muted, fontSize: 11.5, lineHeight: 17 },
});
