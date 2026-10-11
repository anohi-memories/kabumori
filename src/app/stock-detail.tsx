import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackButton } from '@/components/back-button';
import { PF, toneColor, toneSoft } from '@/components/portfolio/portfolio-theme';
import { StockAvatar } from '@/components/portfolio/stock-avatar';
import { TrackedStockEditor } from '@/components/tracked-stock-editor';
import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { formatNewsTime } from '@/lib/news-labels';
import { fetchRecentReports } from '@/lib/personalized-reports';
import {
  avatarLabel,
  formatAmount,
  formatPriceYen,
  formatSignedAmount,
  formatSignedPercent,
  tone,
} from '@/lib/portfolio-view';
import { latestCloseReport, type PersonalizedReport } from '@/lib/report-presentation';
import {
  backLabel,
  buildStockDetail,
  NOT_REALTIME_NOTE,
  parseStockDetailParams,
  type DetailPrice,
  type HoldingDetail,
  type StockDetailView,
} from '@/lib/stock-detail-view';
import type { StockMaster, TrackedStock } from '@/lib/stocks';
import { supabase } from '@/lib/supabase';

const colors = KABUMORI_COLORS.light;

const TRACKED_COLUMNS =
  'id,user_id,stock_id,tracking_type,quantity,average_price,position_type,side,target_buy_price,target_sell_price,memo,stocks_master!inner(id,ticker_code,company_name,market)';
const MASTER_COLUMNS = 'id,ticker_code,company_name,market';

type Loaded = { stock: StockMaster; tracked: TrackedStock | null };
type State =
  | { status: 'loading' }
  | { status: 'ready'; loaded: Loaded }
  | { status: 'not_found' }
  | { status: 'signed_out' }
  | { status: 'error' };

// 銘柄詳細 (a root Stack screen, so the native edge swipe and 戻る both return to the screen it was opened from,
// with that screen's state -- the portfolio/watchlist segment, the search text -- untouched).
//
// READ-ONLY: it only selects the signed-in user's own registration (owner-constrained), the shared stock record
// and the stored close reports. Every figure is the latest SAVED close, dated, and never called live. The one
// way to change anything is the explicit 登録内容を編集 button, which opens the existing TrackedStockEditor:
// saving or deleting happens only on that editor's own buttons.
export default function StockDetailScreen() {
  const raw = useLocalSearchParams<{ trackedId?: string; stockId?: string; from?: string }>();
  const params = useMemo(() => parseStockDetailParams(raw), [raw.trackedId, raw.stockId, raw.from]);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [reports, setReports] = useState<PersonalizedReport[]>([]);
  const [reportError, setReportError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestId.current;
    const stale = () => request !== requestId.current;
    setState((current) => (current.status === 'ready' ? current : { status: 'loading' }));

    const reportsPromise = fetchRecentReports(20)
      .then((next) => ({ ok: true as const, next }))
      .catch(() => ({ ok: false as const, next: [] as PersonalizedReport[] }));

    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (stale()) return;
    if (authError || !authData.user) {
      setState({ status: 'signed_out' });
      return;
    }
    if (!params.trackedId && !params.stockId) {
      setState({ status: 'not_found' });
      return;
    }

    // The user's own active registration first (by its id, or by the stock for a search result).
    let query = supabase
      .from('tracked_stocks')
      .select(TRACKED_COLUMNS)
      .eq('user_id', authData.user.id)
      .eq('is_active', true);
    query = params.trackedId ? query.eq('id', params.trackedId) : query.eq('stock_id', params.stockId as string);
    const { data: trackedData, error: trackedError } = await query.maybeSingle();
    if (stale()) return;
    if (trackedError) {
      setState({ status: 'error' });
      return;
    }

    let loaded: Loaded | null = null;
    if (trackedData) {
      const tracked = trackedData as unknown as TrackedStock;
      loaded = { stock: tracked.stocks_master, tracked };
    } else if (params.stockId) {
      // Not registered (or no longer): the shared record alone, shown without any user-specific figure.
      const { data: master, error: masterError } = await supabase
        .from('stocks_master')
        .select(MASTER_COLUMNS)
        .eq('id', params.stockId)
        .eq('is_listed', true)
        .maybeSingle();
      if (stale()) return;
      if (masterError) {
        setState({ status: 'error' });
        return;
      }
      if (master) loaded = { stock: master as StockMaster, tracked: null };
    }

    const result = await reportsPromise;
    if (stale()) return;
    setReports(result.next);
    setReportError(!result.ok);
    setState(loaded ? { status: 'ready', loaded } : { status: 'not_found' });
  }, [params.trackedId, params.stockId]);

  useEffect(() => {
    void load();
    return () => { requestId.current += 1; };
  }, [load]);

  const report = useMemo(() => latestCloseReport(reports), [reports]);
  const view = useMemo(
    () => (state.status === 'ready' ? buildStockDetail({ stock: state.loaded.stock, tracked: state.loaded.tracked, report }) : null),
    [state, report],
  );

  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={() => { setPulling(true); void load().finally(() => setPulling(false)); }} tintColor={colors.accent} />}>
        <View style={styles.stack}>
          <BackButton label={backLabel(params.origin)} onPress={goBack} />

          {state.status === 'loading' ? <ActivityIndicator color={colors.accent} style={styles.status} /> : null}
          {state.status === 'signed_out' ? <Notice text="銘柄を見るにはログインが必要です。" /> : null}
          {state.status === 'not_found' ? <Notice text="この銘柄が見つかりませんでした。登録が解除された可能性があります。" /> : null}
          {state.status === 'error' ? (
            <Notice text="銘柄を読み込めませんでした。" actionLabel="もう一度読み込む" onAction={() => void load()} />
          ) : null}

          {view ? (
            <>
              <HeaderCard view={view} />
              <PriceCard price={view.price} unregistered={view.kind === 'unregistered'} reportError={reportError} />
              {view.holding ? <HoldingCard holding={view.holding} /> : null}
              {view.targetBuy !== null || view.targetSell !== null || view.memo ? <TargetsCard view={view} /> : null}
              {view.news ? (
                <NewsCard
                  headline={view.news.headline}
                  time={view.news.newsTime}
                  onOpen={() => router.push({ pathname: '/news-detail', params: { id: view.news!.newsId, from: 'stocks' } })}
                />
              ) : null}

              <Pressable
                onPress={() => setEditing(true)}
                accessibilityRole="button"
                accessibilityLabel={view.tracked ? '登録内容を編集' : 'この銘柄を登録する'}
                accessibilityHint={view.tracked ? '保有・監視の登録内容を編集または削除する画面を開きます' : '保有または監視に登録する画面を開きます'}
                style={({ pressed }) => [view.tracked ? styles.editButton : styles.registerButton, pressed && styles.pressed]}>
                <Text style={view.tracked ? styles.editText : styles.registerText}>{view.tracked ? '登録内容を編集' : 'この銘柄を登録する'}</Text>
              </Pressable>

              <Text style={styles.footnote}>表示は保存済みの大引けレポートの値です。{NOT_REALTIME_NOTE}。</Text>
            </>
          ) : null}
        </View>
      </ScrollView>

      <TrackedStockEditor
        stock={state.status === 'ready' ? state.loaded.stock : null}
        existing={state.status === 'ready' ? state.loaded.tracked : null}
        visible={editing && state.status === 'ready'}
        onClose={() => setEditing(false)}
        onSaved={() => { setEditing(false); void load(); }}
        onDeleted={() => { setEditing(false); goBack(); }}
      />
    </SafeAreaView>
  );
}

function Notice({ text, actionLabel, onAction }: { text: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <View style={styles.notice}>
      <Text style={styles.noticeText}>{text}</Text>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} accessibilityRole="button" style={styles.noticeButton}>
          <Text style={styles.noticeButtonText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const KIND_STYLE = {
  holding: { background: '#e4f3e9', color: '#1f7a45' },
  watch: { background: '#e4f1ef', color: '#1f6f66' },
  unregistered: { background: '#eef0ed', color: '#5d6a62' },
} as const;

function HeaderCard({ view }: { view: StockDetailView }) {
  const kind = KIND_STYLE[view.kind];
  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <StockAvatar label={avatarLabel(view.company, view.ticker)} name={view.company} size={52} seed={view.ticker} />
        <View style={styles.headerText}>
          <Text style={styles.sub}>{view.ticker}　{view.market}</Text>
          <View style={[styles.kindChip, { backgroundColor: kind.background }]} accessible accessibilityLabel={`登録区分 ${view.kindLabel}`}>
            <Text style={[styles.kindText, { color: kind.color }]}>{view.kindLabel}</Text>
          </View>
        </View>
      </View>
      {/* The name has the card's full width: a long company name no longer leaves a single character on a line. */}
      <Text style={styles.company} accessibilityRole="header">{view.company}</Text>
    </View>
  );
}

function signedPrice(change: number | null): string {
  if (change === null || !Number.isFinite(change)) return '—';
  const sign = change > 0 ? '+' : change < 0 ? '−' : '±';
  return `${sign}${formatPriceYen(Math.abs(change))}`;
}

function PriceCard({ price, unregistered, reportError }: { price: DetailPrice; unregistered: boolean; reportError: boolean }) {
  if (!price.available) {
    return (
      <View style={styles.card} accessible accessibilityLabel={`終値 データなし。${price.reason}`}>
        <Text style={styles.cardLabel}>終値</Text>
        <Text style={styles.bigValueMuted}>—</Text>
        <Text style={styles.reason}>{unregistered || !reportError ? price.reason : 'レポートのデータを読み込めませんでした。引っ張って更新できます。'}</Text>
      </View>
    );
  }
  const change = tone(price.changePercent ?? price.change);
  const summary = [
    `終値 ${formatPriceYen(price.close)}`,
    price.change !== null || price.changePercent !== null ? `前日比 ${signedPrice(price.change)} ${formatSignedPercent(price.changePercent, 2)}` : '',
    price.basisLabel,
    NOT_REALTIME_NOTE,
  ].filter(Boolean).join('、');
  return (
    <View style={styles.card} accessible accessibilityLabel={summary}>
      <View style={styles.priceHead}>
        <Text style={styles.cardLabel}>終値</Text>
        <Text style={styles.basis}>{price.basisLabel}</Text>
      </View>
      <Text style={styles.bigValue} numberOfLines={1} adjustsFontSizeToFit>{formatPriceYen(price.close)}</Text>
      <View style={styles.changeRow}>
        <Text style={styles.changeLabel}>前日比</Text>
        <Text style={[styles.changeAmount, { color: change === 'none' ? PF.muted : toneColor(change) }]}>{signedPrice(price.change)}</Text>
        <View style={[styles.pill, { backgroundColor: toneSoft(change) }]}>
          <Text style={[styles.pillText, { color: toneColor(change) }]}>{formatSignedPercent(price.changePercent, 2)}</Text>
        </View>
      </View>
      {price.previousClose !== null ? <Text style={styles.prev}>前日終値 {formatPriceYen(price.previousClose)}</Text> : null}
      <Text style={styles.note}>{NOT_REALTIME_NOTE}</Text>
    </View>
  );
}

function Fact({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.fact} accessible accessibilityLabel={`${label} ${value}`}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={[styles.factValue, color ? { color } : null]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    </View>
  );
}

function HoldingCard({ holding }: { holding: HoldingDetail }) {
  const quantity = holding.quantity === null ? '—' : `${holding.quantity.toLocaleString('en-US', { maximumFractionDigits: 4 })}株`;
  const kinds = [holding.positionLabel, holding.sideLabel].filter(Boolean).join('・') || '—';
  const valuation = holding.valuation;
  const plTone = tone(valuation?.unrealizedPl ?? null);
  const dayTone = tone(valuation?.dayPl ?? null);
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>保有内容</Text>
      <View style={styles.facts}>
        <Fact label="保有株数" value={quantity} />
        <Fact label="平均取得価格" value={formatPriceYen(holding.averagePrice)} />
        <Fact label="区分" value={kinds} />
      </View>
      {valuation ? (
        <>
          <View style={styles.rule} />
          <View style={styles.facts}>
            <Fact label="評価額" value={formatAmount(valuation.marketValue)} />
            <Fact
              label="評価損益"
              value={`${formatSignedAmount(valuation.unrealizedPl)}（${formatSignedPercent(valuation.unrealizedPlPercent, 2)}）`}
              color={plTone === 'none' ? undefined : toneColor(plTone)}
            />
            <Fact label="当日損益" value={formatSignedAmount(valuation.dayPl)} color={dayTone === 'none' ? undefined : toneColor(dayTone)} />
          </View>
        </>
      ) : null}
      {holding.valuationNote ? <Text style={styles.reason}>{holding.valuationNote}</Text> : null}
    </View>
  );
}

function TargetsCard({ view }: { view: StockDetailView }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>目標価格・メモ</Text>
      <View style={styles.facts}>
        {view.targetBuy !== null ? <Fact label="買いたい価格" value={formatPriceYen(view.targetBuy)} /> : null}
        {view.targetSell !== null ? <Fact label="売りたい価格" value={formatPriceYen(view.targetSell)} /> : null}
      </View>
      {view.memo ? <Text style={styles.memo}>{view.memo}</Text> : null}
    </View>
  );
}

function NewsCard({ headline, time, onOpen }: { headline: string; time: string; onOpen: () => void }) {
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`関連ニュース ${headline}`}
      accessibilityHint="ニュース詳細を開きます"
      style={({ pressed }) => [styles.newsCard, pressed && styles.pressed]}>
      <Text style={styles.newsLabel}>関連ニュース</Text>
      <Text style={styles.newsHeadline} numberOfLines={3}>{headline}</Text>
      <View style={styles.newsFoot}>
        <Text style={styles.newsDate}>{formatNewsTime(time)}</Text>
        <Text style={styles.newsCta}>ニュースを見る ›</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: PF.page },
  content: { width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: PF.gutter, paddingTop: 4, paddingBottom: 40 },
  stack: { gap: 12 },
  status: { marginTop: 24 },
  pressed: { opacity: 0.75 },
  footnote: { color: PF.muted, fontSize: 11.5, lineHeight: 17 },

  card: { backgroundColor: PF.card, borderRadius: PF.radius, borderWidth: 1, borderColor: PF.cardBorder, padding: 16, gap: 10 },
  cardLabel: { color: PF.muted, fontSize: 12.5, fontWeight: '800' },
  cardTitle: { color: PF.ink, fontSize: 16, fontWeight: '900' },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  headerText: { flex: 1, minWidth: 0, gap: 4 },
  company: { color: PF.ink, fontSize: 22, lineHeight: 28, fontWeight: '900' },
  sub: { color: PF.muted, fontSize: 13.5 },
  kindChip: { alignSelf: 'flex-start', borderRadius: 99, paddingHorizontal: 12, paddingVertical: 4 },
  kindText: { fontSize: 13, fontWeight: '900' },

  priceHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  basis: { color: PF.muted, fontSize: 12.5, fontWeight: '800' },
  bigValue: { color: PF.ink, fontSize: 34, lineHeight: 42, fontWeight: '900' },
  bigValueMuted: { color: PF.muted, fontSize: 34, lineHeight: 42, fontWeight: '900' },
  changeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  changeLabel: { color: PF.muted, fontSize: 13, fontWeight: '700' },
  changeAmount: { fontSize: 16, fontWeight: '900' },
  pill: { borderRadius: 99, paddingHorizontal: 10, paddingVertical: 2 },
  pillText: { fontSize: 13.5, fontWeight: '900' },
  prev: { color: PF.muted, fontSize: 13 },
  note: { color: PF.muted, fontSize: 12 },
  reason: { color: PF.muted, fontSize: 13, lineHeight: 19 },

  facts: { gap: 10 },
  fact: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 28 },
  factLabel: { color: PF.muted, fontSize: 13.5, fontWeight: '700' },
  factValue: { flexShrink: 1, color: PF.ink, fontSize: 16, fontWeight: '900', textAlign: 'right' },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: PF.cardBorder },
  memo: { color: PF.ink, fontSize: 14.5, lineHeight: 21 },

  newsCard: { backgroundColor: '#e4f1ef', borderRadius: PF.radius, borderWidth: 1, borderColor: '#c6e0db', padding: 16, gap: 6 },
  newsLabel: { color: '#1f6f66', fontSize: 12, fontWeight: '900' },
  newsHeadline: { color: PF.ink, fontSize: 15, lineHeight: 22, fontWeight: '800' },
  newsFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 28 },
  newsDate: { color: PF.muted, fontSize: 12 },
  newsCta: { color: '#1f6f66', fontSize: 14, fontWeight: '900' },

  editButton: { minHeight: 52, borderRadius: 99, borderWidth: 1.5, borderColor: PF.cta, alignItems: 'center', justifyContent: 'center', backgroundColor: PF.card },
  editText: { color: PF.cta, fontSize: 16, fontWeight: '900' },
  registerButton: { minHeight: 52, borderRadius: 99, alignItems: 'center', justifyContent: 'center', backgroundColor: PF.cta },
  registerText: { color: '#ffffff', fontSize: 16, fontWeight: '900' },

  notice: { backgroundColor: PF.card, borderRadius: PF.radius, borderWidth: 1, borderColor: PF.cardBorder, padding: 18, gap: 12, alignItems: 'center' },
  noticeText: { color: PF.muted, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  noticeButton: { backgroundColor: PF.cta, borderRadius: 99, paddingHorizontal: 20, minHeight: 44, justifyContent: 'center' },
  noticeButtonText: { color: '#ffffff', fontWeight: '800', fontSize: 14 },
});
