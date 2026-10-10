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
  StocksHeader,
  StocksSwitch,
  type StocksView,
} from '@/components/portfolio/portfolio-sections';
import { PF } from '@/components/portfolio/portfolio-theme';
import { WatchlistSection } from '@/components/portfolio/watchlist-section';
import { TrackedStockEditor } from '@/components/tracked-stock-editor';
import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { todayJst } from '@/lib/dashboard';
import { fetchRecentReports } from '@/lib/personalized-reports';
import {
  aiSummary,
  assetSummary,
  buildHoldingRows,
  buildWatchRows,
  layoutWatchlist,
  portfolioBasis,
  portfolioLabels,
  sparklineValues,
  topImpacts,
  watchlistLabels,
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
  const [view, setView] = useState<StocksView>('portfolio');
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
  const watchLayout = useMemo(() => layoutWatchlist(watch, basis?.snapshot ?? null), [watch, basis]);
  const watchLabels = watchlistLabels(basis);
  const notes = dataGapNotes(basis?.snapshot ?? null);

  const openTracked = (trackedId: string) => setSelected(items.find((item) => item.id === trackedId) ?? null);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={() => { setPulling(true); void load().finally(() => setPulling(false)); }} tintColor={colors.accent} />}>
        <View style={styles.stack}>
          <StocksHeader view={view} onSearch={() => router.push('/search')} />
          <StocksSwitch view={view} onChange={setView} />

          {loading && !items.length && !reports.length ? <ActivityIndicator color={colors.accent} style={styles.status} /> : null}
          {!loading && !!message ? <Text style={styles.message}>{message}</Text> : null}

          {view === 'portfolio' ? (
            <>
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
            </>
          ) : (
            <>
              {reportError ? <Text style={styles.reportError}>レポートのデータを読み込めませんでした。引っ張って更新できます。</Text> : null}
              {watch.length === 0 && !loading && !message ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyText}>監視銘柄はまだありません。気になる銘柄を検索から登録できます。</Text>
                  <Pressable onPress={() => router.push('/search')} accessibilityRole="button" style={styles.emptyButton}>
                    <Text style={styles.emptyButtonText}>銘柄を探す</Text>
                  </Pressable>
                </View>
              ) : null}
              <WatchlistSection
                featured={watchLayout.featured}
                rest={watchLayout.rest}
                flagged={watchLayout.flagged}
                featuredTitle={watchLabels.featuredTitle}
                basisLabel={watchLabels.basis}
                onEdit={openTracked}
                onOpenNews={(newsId) => router.push({ pathname: '/news-detail', params: { id: newsId, from: 'stocks' } })}
              />
              {watch.length > 0 ? (
                <Text style={styles.watchNote}>
                  {basis
                    ? `表示は${watchLabels.basis}（保存済み大引け）の値で、リアルタイム価格ではありません。`
                    : '価格はまだありません。\n大引けレポートが作成されると、終値と前日比が表示されます。'}
                </Text>
              ) : null}
            </>
          )}
        </View>
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

  watchNote: { color: PF.muted, fontSize: 11.5, lineHeight: 17 },
});
