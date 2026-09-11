// Turns a stored personalized report (morning / close) into what the app shows.
//
// Pure and deterministic: every number comes from portfolio_snapshot, which the
// personalized-reports Edge Function computed in code. The only prose shown is
// the Fact-passed commentary in body. Nothing here calls an AI.

export type ReportType = 'morning' | 'close';

export type PriceFact = {
  status: 'ok' | 'unavailable';
  sessionDate: string | null;
  close: number | null;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
};

export type ReportStock = {
  ticker_code: string;
  company_name: string;
  sector: string | null;
  tracking_type: 'holding' | 'watch';
  quantity: number | null;
  average_price: number | null;
  position_type: 'cash' | 'margin' | null;
  side: 'long' | 'short' | null;
  price: PriceFact;
  market_value: number | null;
  day_pl: number | null;
  unrealized_pl: number | null;
  unrealized_pl_percent: number | null;
  news_ids: string[];
  market_news_ids: string[];
};

export type ReportSnapshot = {
  report_type: ReportType;
  trading_date: string;
  price_basis_date: string | null;
  holdings: ReportStock[];
  watch: ReportStock[];
  indices: Array<{ label: string; price: PriceFact }>;
  totals: {
    holding_count: number;
    watch_count: number;
    all_holdings_valued: boolean;
    market_value: number | null;
    day_pl: number | null;
    day_change_percent: number | null;
    unrealized_pl: number | null;
    // The comparison benchmark (TOPIX-tracking ETF 1306); the topix_* names are kept for stability.
    benchmark_label?: string;
    topix_change_percent: number | null;
    relative_to_topix_pt: number | null;
    relative_label: 'stronger' | 'weaker' | 'similar' | null;
  };
  sector_weights: Array<{ sector: string; weight_percent: number; basis: 'market_value' | 'count'; holding_count: number }>;
  top_impact: string[];
  gainers: string[];
  decliners: string[];
  news: Array<{
    news_id: string;
    ticker_code: string | null;
    company_name: string;
    severity: string;
    headline_ja: string;
    news_time: string;
    source_url: string | null;
  }>;
  data_gaps: string[];
};

export type ReportBody = {
  tone?: 'positive' | 'neutral' | 'cautious';
  overview_ja?: string;
  stock_notes?: Array<{ ticker_code: string; note_ja: string }>;
  watch_notes?: Array<{ ticker_code: string; note_ja: string }>;
  risk_notes_ja?: string[];
  checkpoints_ja?: string[];
};

export type PersonalizedReport = {
  id: string;
  report_type: ReportType;
  trading_date: string;
  title_ja: string | null;
  summary_ja: string | null;
  body: ReportBody | null;
  portfolio_snapshot: ReportSnapshot | null;
  generated_at: string | null;
};

export function reportTypeLabel(type: ReportType): string {
  return type === 'morning' ? '朝刊' : '大引けレポート';
}

export function toneLabel(body: ReportBody | null | undefined, type: ReportType): { text: string; tone: 'positive' | 'neutral' | 'cautious' } | null {
  const tone = body?.tone;
  if (tone !== 'positive' && tone !== 'neutral' && tone !== 'cautious') return null;
  const words = type === 'morning'
    ? { positive: '好材料が目立つ', neutral: '中立', cautious: '慎重に確認' }
    : { positive: '堅調', neutral: 'まちまち', cautious: '軟調' };
  return { text: words[tone], tone };
}

export function formatDateJa(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const weekday = ['日', '月', '火', '水', '木', '金', '土'][new Date(`${date}T00:00:00Z`).getUTCDay()];
  return `${Number(match[2])}月${Number(match[3])}日（${weekday}）`;
}

export function formatTimeJa(iso: string | null): string {
  if (!iso) return '';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return '';
  const jst = new Date(value.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCHours()}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
}

function grouped(value: number, maxDigits = 0): string {
  return Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: maxDigits });
}

export function formatPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value < 0 ? '-' : ''}${grouped(value, 2)}`;
}

export function formatYen(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value < 0 ? '-' : ''}${grouped(Math.round(value))}円`;
}

export function formatSignedYen(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : rounded < 0 ? '-' : '±'}${grouped(rounded)}円`;
}

export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : value < 0 ? '-' : '±'}${Math.abs(value).toFixed(2)}%`;
}

export type Direction = 'up' | 'down' | 'flat' | 'none';

export function direction(value: number | null): Direction {
  if (value === null || !Number.isFinite(value)) return 'none';
  return value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
}

export function positionLabel(stock: Pick<ReportStock, 'tracking_type' | 'position_type' | 'side'>): string {
  if (stock.tracking_type === 'watch') return '監視';
  const parts = ['保有'];
  if (stock.position_type === 'cash') parts.push('現物');
  if (stock.position_type === 'margin') parts.push('信用');
  if (stock.side === 'short') parts.push('売り');
  return parts.join('・');
}

export function relativeText(snapshot: ReportSnapshot): string | null {
  const label = snapshot.totals.relative_label;
  const diff = snapshot.totals.relative_to_topix_pt;
  if (!label || diff === null) return null;
  const benchmark = snapshot.totals.benchmark_label || 'TOPIX連動ETF（1306）';
  const words = { stronger: 'より強い', weaker: 'より弱い', similar: 'とほぼ同じ' } as const;
  return `${benchmark}${words[label]}（差 ${diff > 0 ? '+' : diff < 0 ? '-' : '±'}${Math.abs(diff).toFixed(2)}ポイント）`;
}

export type StockRow = {
  stock: ReportStock;
  note: string | null;
  priceLine: string;
  changeLine: string;
  changeDirection: Direction;
  plLine: string | null;
  unrealizedLine: string | null;
  news: ReportSnapshot['news'];
};

/**
 * One row per stock in display order (holdings by priority, then watch), with
 * the Fact-passed note attached by ticker. A watch stock appears in the watch
 * list only when it has a note or its own news, so the page stays readable.
 */
export function buildStockRows(report: PersonalizedReport): { holdings: StockRow[]; watch: StockRow[] } {
  const snapshot = report.portfolio_snapshot;
  if (!snapshot) return { holdings: [], watch: [] };
  const notes = new Map<string, string>();
  for (const note of [...(report.body?.stock_notes ?? []), ...(report.body?.watch_notes ?? [])]) {
    if (note?.ticker_code && note.note_ja) notes.set(note.ticker_code, note.note_ja);
  }
  const newsById = new Map(snapshot.news.map((item) => [item.news_id, item]));
  const close = snapshot.report_type === 'close';
  const row = (stock: ReportStock): StockRow => ({
    stock,
    note: notes.get(stock.ticker_code) ?? null,
    priceLine: stock.price.status === 'ok'
      ? `${close ? '終値' : '前日終値'} ${formatPrice(stock.price.close)}円`
      : '価格を取得できませんでした',
    changeLine: stock.price.status === 'ok'
      ? `${close ? '前日比' : '前営業日'} ${formatPercent(stock.price.changePercent)}`
      : '',
    changeDirection: stock.price.status === 'ok' ? direction(stock.price.changePercent) : 'none',
    plLine: close && stock.tracking_type === 'holding'
      ? stock.day_pl !== null ? `今日の損益 ${formatSignedYen(stock.day_pl)}` : '今日の損益 —（数量未登録）'
      : null,
    unrealizedLine: stock.tracking_type === 'holding'
      ? stock.unrealized_pl !== null
        ? `取得単価からの含み損益 ${formatSignedYen(stock.unrealized_pl)}（${formatPercent(stock.unrealized_pl_percent)}）`
        : '含み損益 —（取得単価・数量が未登録）'
      : null,
    news: stock.news_ids.map((id) => newsById.get(id)).filter((item): item is ReportSnapshot['news'][number] => !!item),
  });
  return {
    holdings: snapshot.holdings.map(row),
    watch: snapshot.watch.map(row).filter((item) => item.note !== null || item.news.length > 0),
  };
}

/** Human-readable notes for data the report could not use. */
export function dataGapNotes(snapshot: ReportSnapshot | null): string[] {
  if (!snapshot) return [];
  const notes: string[] = [];
  const missingPrices = snapshot.data_gaps.filter((gap) => gap.startsWith('PRICE_UNAVAILABLE:')).length;
  if (missingPrices > 0) notes.push(`${missingPrices}銘柄の価格を取得できませんでした。`);
  if (snapshot.data_gaps.some((gap) => gap.startsWith('INDEX_UNAVAILABLE:'))) notes.push('一部の指数を取得できませんでした。');
  if (snapshot.data_gaps.includes('HOLDING_QUANTITY_MISSING')) {
    notes.push('数量が未登録の保有銘柄があるため、ポート全体の損益は計算していません。');
  }
  return notes;
}

/** Deep link target for a tapped push; only report pushes are routed here. */
export function reportRouteForPush(data: { source_type?: unknown; source_id?: unknown } | null | undefined): string | null {
  if (data?.source_type !== 'personalized_report') return null;
  const id = typeof data.source_id === 'string' ? data.source_id : '';
  return /^[0-9a-f-]{36}$/i.test(id) ? `/reports/${id}` : '/reports';
}
