// 「きょうの市況」の画面の組み立て（純粋な関数。React も AI もネットワークも使わない）。
//
// get_app_market_report が返した公開してよい項目だけから、上から順に読む「ブロック」を作る。
//   📌 今日のポイント → 🔮 ゆめちゃんの考察・予想 → 📖 今日の相場のお話 → ⚠️ この先の注目材料 → 📊 参考資料（いつも最後）
// 見出しの文言は生成側（X・アプリのお話）と同じにする。ゆめちゃんの見立ては意見なので、事実の項目とは別のブロックに置き、
// 「AI の見立てで、当たるとは限らない」ことを必ず添える。指標の値は返ってきた行だけを出し、作らない。
//
// このファイルは型だけを読み込む（テストから Deno で単体で動かせるようにしている）。

import type {
  AppYumeReview,
  AppYumeView,
  CompletedMarketReport,
  MarketMove,
  MarketNews,
  NewsScope,
  YumeStance,
  YumeVerdict,
} from './ondemand-analysis-presentation';

export type MarketReportBlockKey = 'points' | 'yume' | 'story' | 'outlook' | 'reference';

/** 生成側と共通の見出し（文言を変えるときは両方を同時に変える）。 */
export const MARKET_REPORT_HEADINGS: Record<MarketReportBlockKey, string> = {
  points: '📌 今日のポイント',
  yume: '🔮 ゆめちゃんの考察・予想',
  story: '📖 今日の相場のお話',
  outlook: '⚠️ この先の注目材料',
  reference: '📊 参考資料｜主な市場指標',
};

/** 小見出し（null なら無し）と本文。本文が空のときは小見出しだけを出す。 */
export type MarketReportParagraph = { subheading: string | null; text: string };

export type MarketIndicatorRow = {
  label: string;
  value: string;
  change: string | null;
  /** その指標の市場の取引日（「10月9日」）。読めない日付は空。 */
  sessionDateJa: string;
  /** 最新ではない（前回の値）。 */
  stale: boolean;
};

export type MarketIndicatorGroup = { title: string; rows: MarketIndicatorRow[] };

export type MarketReportBlock = {
  key: MarketReportBlockKey;
  heading: string;
  /** ブロックの最初の文章。 */
  intro?: string;
  /** intro の下の小さな補足（データの取得時刻など）。 */
  meta?: string;
  paragraphs: MarketReportParagraph[];
  /** 参考資料の指標（東京市場・米国市場・為替・金利・商品など）。 */
  groups?: MarketIndicatorGroup[];
  /** 箇条書きの前に置く小見出し（無ければ出さない）。 */
  bulletsTitle?: string;
  bullets: string[];
  /** ブロックの最後の注記。 */
  note?: string;
};

export type MarketReportView = { blocks: MarketReportBlock[] };

// ---------------------------------------------------------------------------
// ゆめちゃんの文言（supabase/functions/_shared/market_report_yume.ts と同じ。テストで一致を確かめる）
// ---------------------------------------------------------------------------

export const YUME_STANCE_JA: Record<YumeStance, string> = { up: '上昇', down: '下落', flat: '横ばい' };
export const YUME_VERDICT_JA: Record<YumeVerdict, string> = {
  hit: '当たり',
  partial: '部分的に当たり',
  miss: '外れ',
  undeterminable: '判定できません',
};
export const YUME_UNDETERMINABLE_JA: Record<string, string> = {
  NO_MORNING_REPORT: 'この日の朝刊が見つかりません',
  MORNING_READ_FAILED: '朝刊の記録を読み込めませんでした',
  MORNING_TARGET_MISMATCH: '朝刊の日付・種類がこの大引けと合いません',
  NO_MORNING_FORECAST: 'この日の朝刊に予想の記録がありません',
  FORECAST_DEFINITION_INVALID: '朝刊の予想の条件が記録と合いません',
  ACTUAL_UNAVAILABLE: '日経平均の終値を確認できません',
  ACTUAL_NOT_THIS_SESSION: 'この日の日経平均の終値を確認できません',
  ACTUAL_CHANGE_UNAVAILABLE: '日経平均の前日比を確認できません',
};
export const YUME_UNDETERMINABLE_DEFAULT_JA = '比べられる記録がありません';

/** 横ばいの帯をことばで（サーバーの bandRuleJa と同じ）。 */
export function bandRuleJa(bandPct: number): string {
  return `日経平均の前日比が±${bandPct}%未満なら横ばい、それ以上なら上昇・下落`;
}

/** 答え合わせの1行（判定はサーバーのコードが決めたもの。サーバーの reviewLineJa と同じ文）。 */
export function yumeReviewLineJa(review: AppYumeReview): string {
  if (review.verdict === 'undeterminable') {
    const why = YUME_UNDETERMINABLE_JA[review.reasonCode] ?? YUME_UNDETERMINABLE_DEFAULT_JA;
    return `朝の予想との答え合わせはできません（${why}）`;
  }
  // 判定済みなら朝の予想と前日比は必ずある。欠けていたら、その部分だけを出さない（値を作らない）。
  const morning = review.morningStance ? `朝の予想は「${YUME_STANCE_JA[review.morningStance]}」→ ` : '';
  const actual = review.actualChangeDisplay ? `（日経平均 前日比${review.actualChangeDisplay}）` : '';
  return `${morning}結果は「${YUME_VERDICT_JA[review.verdict]}」${actual}`;
}

export function yumeNoteJa(view: Pick<AppYumeView, 'flatBandPct'>): string {
  return `基準：${bandRuleJa(view.flatBandPct)}。ゆめちゃん（AI）の見立てで、当たるとは限りません。`;
}

// ---------------------------------------------------------------------------
// 日付・時刻
// ---------------------------------------------------------------------------

/** "2026-10-09" -> "10月9日"。形が違えば空。 */
export function monthDayJa(date: string | null): string {
  const match = date?.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${Number(match[1])}月${Number(match[2])}日` : '';
}

/** ISO の時刻を、日本時間の「10月14日 07:40」に。読めなければ空。 */
export function dateTimeJa(iso: string | null): string {
  if (!iso) return '';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return '';
  const jst = new Date(value.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日 ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
}

// ---------------------------------------------------------------------------
// ブロック
// ---------------------------------------------------------------------------

const MAX_POINTS = 3;
const SCOPE_RANK: Record<NewsScope, number> = { broad: 0, sector: 1, company: 2 };

/** 市場全体 → 業種・テーマ → 個別企業の順（同じ順位の中では元の順）。 */
export function orderNews(news: readonly MarketNews[]): MarketNews[] {
  return news
    .map((item, index) => ({ item, index }))
    .sort((a, b) => SCOPE_RANK[a.item.scope ?? 'company'] - SCOPE_RANK[b.item.scope ?? 'company'] || a.index - b.index)
    .map(({ item }) => item);
}

const newsLine = (news: MarketNews) => (news.whyJa.trim() ? `${news.headlineJa} — ${news.whyJa}` : news.headlineJa);
const nonEmpty = (paragraphs: MarketReportParagraph[]) =>
  paragraphs.filter((paragraph) => paragraph.text.trim().length > 0 || !!paragraph.subheading);
const plain = (...texts: string[]): MarketReportParagraph[] =>
  texts.filter((value) => value.trim()).map((value) => ({ subheading: null, text: value }));

function pointsBlock(report: CompletedMarketReport): MarketReportBlock | null {
  const bullets = report.pointsJa.slice(0, MAX_POINTS);
  return bullets.length > 0 ? { key: 'points', heading: MARKET_REPORT_HEADINGS.points, paragraphs: [], bullets } : null;
}

function yumeBlock(yume: AppYumeView | null): MarketReportBlock | null {
  if (!yume) return null;
  const stance = YUME_STANCE_JA[yume.stance];
  const view = [yume.headlineJa, yume.reasonsJa, yume.scenarioJa];
  const paragraphs: MarketReportParagraph[] = [];
  if (yume.horizon === 'this_session') {
    const [headline, ...rest] = view;
    paragraphs.push({ subheading: `予想：きょうの日経平均は「${stance}」`, text: headline }, ...plain(...rest));
  } else {
    if (yume.review) paragraphs.push({ subheading: yumeReviewLineJa(yume.review), text: yume.review.textJa.trim() });
    const [headline, ...rest] = view;
    paragraphs.push({ subheading: `次の営業日の見立て：日経平均は「${stance}」`, text: headline }, ...plain(...rest));
  }
  return { key: 'yume', heading: MARKET_REPORT_HEADINGS.yume, paragraphs: nonEmpty(paragraphs), bullets: [], note: yumeNoteJa(yume) };
}

function storyBlock(report: CompletedMarketReport): MarketReportBlock | null {
  const story = report.appStory;
  const bullets = [
    ...orderNews(report.keyNews).map(newsLine),
    ...report.strongThemes.map((theme) => `テーマ：${theme}`),
  ];
  const intro = (story?.summaryJa.trim() ? story.summaryJa : report.summaryJa).trim();
  let paragraphs: MarketReportParagraph[];
  if (!story) {
    // 古い回（お話が無い）: 要約と、確認済みの動き（claims）をそのまま。
    paragraphs = plain(...report.claims.map((claim) => claim.textJa));
  } else if (report.reportType === 'morning') {
    paragraphs = [
      { subheading: '🇺🇸 前夜のアメリカ市場', text: story.overseasJa },
      { subheading: '🇯🇵 日本株の見どころ', text: story.japanJa },
      { subheading: '💱 為替・金利・半導体', text: story.crossAssetJa },
      { subheading: '📰 気になるニュース', text: story.newsJa },
      { subheading: '🔥 注目のテーマ', text: story.strongJa },
    ];
  } else {
    paragraphs = [
      { subheading: '🇯🇵 きょうの東京市場', text: story.japanJa },
      { subheading: '🌏 海外・為替・金利', text: [story.overseasJa, story.crossAssetJa].filter((part) => part.trim()).join('\n') },
      { subheading: '📰 相場を動かした材料', text: story.newsJa },
      { subheading: '🔥 強かったテーマ', text: story.strongJa },
    ];
  }
  // お話の小見出しは、本文があるときだけ出す。
  paragraphs = paragraphs.filter((paragraph) => paragraph.text.trim());
  if (!intro && paragraphs.length === 0 && bullets.length === 0) return null;
  return { key: 'story', heading: MARKET_REPORT_HEADINGS.story, ...(intro ? { intro } : {}), paragraphs, bullets };
}

function outlookBlock(report: CompletedMarketReport): MarketReportBlock | null {
  const paragraphs = plain(report.appStory?.watchJa ?? '', report.appStory?.cautionJa ?? '');
  const yume = report.yume;
  const bullets = [
    ...report.nextWatchJa,
    ...report.risksJa,
    ...report.weakThemes.map((theme) => `弱めのテーマ：${theme}`),
    ...(yume?.counterJa ? [`ゆめちゃんの予想と逆の材料：${yume.counterJa}`] : []),
    ...(yume?.invalidationJa ? [`ゆめちゃんの予想が外れるとしたら：${yume.invalidationJa}`] : []),
  ];
  if (paragraphs.length === 0 && bullets.length === 0) return null;
  return { key: 'outlook', heading: MARKET_REPORT_HEADINGS.outlook, paragraphs, bullets };
}

const TOKYO_KEYS = ['nikkei225', 'topix_proxy_1306'];
const US_KEYS = ['dow', 'sp500', 'nasdaq_composite'];

/** 指標を 東京市場・米国市場・為替・金利・商品など に分ける（返ってきた行だけ。種類の分からない行は3つ目へ）。 */
export function indicatorGroups(moves: readonly MarketMove[]): MarketIndicatorGroup[] {
  const row = (move: MarketMove): MarketIndicatorRow => ({
    label: move.label,
    value: move.value,
    change: move.change,
    sessionDateJa: monthDayJa(move.sessionDate),
    stale: move.stale,
  });
  const pick = (keys: readonly string[]) =>
    keys.flatMap((key) => moves.filter((move) => move.metricKey === key)).map(row);
  const known = new Set([...TOKYO_KEYS, ...US_KEYS]);
  const groups: MarketIndicatorGroup[] = [
    { title: '東京市場', rows: pick(TOKYO_KEYS) },
    { title: '米国市場', rows: pick(US_KEYS) },
    { title: '為替・金利・商品など', rows: moves.filter((move) => !move.metricKey || !known.has(move.metricKey)).map(row) },
  ];
  return groups.filter((group) => group.rows.length > 0);
}

function referenceBlock(report: CompletedMarketReport): MarketReportBlock | null {
  const groups = indicatorGroups(report.majorMoves);
  if (groups.length === 0 && report.dataGapsJa.length === 0) return null;
  const label = report.reportType === 'close' ? '大引け' : '朝刊';
  const target = monthDayJa(report.tradingDate);
  const dataTime = dateTimeJa(report.dataGeneratedAt);
  const madeTime = dateTimeJa(report.generatedAt);
  const meta = dataTime ? `データ取得：${dataTime}` : madeTime ? `レポート作成：${madeTime}` : '';
  return {
    key: 'reference',
    heading: MARKET_REPORT_HEADINGS.reference,
    intro: `対象：${target ? `${target}の` : ''}${label}。値の横に、それぞれの市場の取引日を書いています。`,
    ...(meta ? { meta } : {}),
    paragraphs: [],
    groups,
    ...(report.dataGapsJa.length > 0 ? { bulletsTitle: '確認できなかったデータ' } : {}),
    bullets: [...report.dataGapsJa],
  };
}

/** 完成した回を、上から読むブロックの並びに（参考資料はいつも最後。空のブロックは出さない）。 */
export function buildMarketReportView(report: CompletedMarketReport): MarketReportView {
  const blocks = [
    pointsBlock(report),
    yumeBlock(report.yume),
    storyBlock(report),
    outlookBlock(report),
    referenceBlock(report),
  ].filter((block): block is MarketReportBlock => block !== null);
  return { blocks };
}
