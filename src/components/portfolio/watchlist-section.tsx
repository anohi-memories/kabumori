import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { PF, toneColor, toneSoft } from '@/components/portfolio/portfolio-theme';
import { StockAvatar } from '@/components/portfolio/stock-avatar';
import { formatNewsTime } from '@/lib/news-labels';
import {
  formatPriceYen,
  featuredMoveLabel,
  formatSignedPercent,
  tone,
  type FeaturedKind,
  type FeaturedWatch,
  type WatchRow,
} from '@/lib/portfolio-view';

// Featured cards (0-3, from the saved close report only) and the compact list of every other watch record.
// Nothing here is live: the figures are the saved close, the dates are the report's own, and a news card exists
// only for a news fact the saved report really contains (see verifiedWatchNews).

const KIND = {
  fall: { background: '#fdecea', border: '#f3cfcb', accent: PF.down, badge: '大きく下落' },
  rise: { background: '#e6f4ea', border: '#cfe6d6', accent: PF.up, badge: '大きく上昇' },
  news: { background: '#e4f1ef', border: '#c6e0db', accent: '#1f6f66', badge: 'ニュース' },
} as const satisfies Record<FeaturedKind, { background: string; border: string; accent: string; badge: string }>;

function FeaturedCard({
  entry,
  basisLabel,
  onEdit,
  onOpenNews,
}: {
  entry: FeaturedWatch;
  basisLabel: string;
  onEdit: (trackedId: string) => void;
  onOpenNews: (newsId: string) => void;
}) {
  const { row, kind, news } = entry;
  const style = KIND[kind];
  // On phones narrower than 390pt the figure column is a little smaller so a long company name keeps its room
  // (two-decimal percents are wider than one-decimal ones).
  const narrow = useWindowDimensions().width < 390;
  const change = tone(row.changePercent);
  const bigMove = featuredMoveLabel(row.changePercent);
  const summary = [
    bigMove ?? '',
    style.badge,
    `${row.company} ${row.ticker}`,
    `終値 ${formatPriceYen(row.close)}`,
    formatSignedPercent(row.changePercent, 2),
    news ? news.headline : '',
  ].filter(Boolean).join(' ');
  return (
    <View style={[styles.featured, { backgroundColor: style.background, borderColor: style.border }]}>
      <Pressable
        onPress={() => onEdit(row.tracked.id)}
        accessibilityRole="button"
        accessibilityLabel={summary}
        accessibilityHint="この監視銘柄の情報を編集または削除します"
        style={({ pressed }) => [styles.featuredMain, pressed && styles.pressed]}>
        <View style={styles.featuredTop}>
          <StockAvatar label={row.avatar} name={row.company} size={44} seed={row.ticker} />
          <View style={styles.featuredName}>
            <View style={[styles.badge, { backgroundColor: '#ffffff' }]}>
              <Text style={[styles.badgeText, { color: style.accent }]}>{style.badge}</Text>
            </View>
            <Text style={[styles.featuredCompany, narrow && styles.featuredCompanyNarrow]} numberOfLines={2}>{row.company}</Text>
            <Text style={styles.ticker}>{row.ticker}　{row.tracked.stocks_master.market}</Text>
          </View>
          <View style={styles.featuredFigure}>
            <Text style={[styles.featuredPercent, narrow && styles.featuredPercentNarrow, { color: change === 'none' ? PF.muted : toneColor(change) }]} numberOfLines={1} adjustsFontSizeToFit>
              {formatSignedPercent(row.changePercent, 2)}
            </Text>
            <Text style={styles.featuredClose}>終値 {formatPriceYen(row.close)}</Text>
            {kind === 'news' && bigMove ? <Text style={[styles.featuredMove, { color: toneColor(change) }]}>{bigMove}</Text> : null}
          </View>
        </View>
        {news ? (
          <View style={styles.newsBox}>
            <Text style={styles.newsHeadline} numberOfLines={2}>{news.headline}</Text>
            <Text style={styles.newsDate}>{formatNewsTime(news.newsTime)}</Text>
          </View>
        ) : null}
      </Pressable>
      {news ? (
        <Pressable
          onPress={() => onOpenNews(news.newsId)}
          accessibilityRole="button"
          accessibilityLabel={`ニュースを見る ${news.headline}`}
          accessibilityHint="ニュース詳細を開きます"
          hitSlop={6}
          style={({ pressed }) => [styles.newsCta, pressed && styles.pressed]}>
          <Text style={[styles.newsCtaText, { color: style.accent }]}>ニュースを見る ›</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function WatchListRow({ row, flagged, last, onEdit }: { row: WatchRow; flagged: boolean; last: boolean; onEdit: (trackedId: string) => void }) {
  const change = tone(row.changePercent);
  const { target_buy_price: buy, target_sell_price: sell } = row.tracked;
  return (
    <Pressable
      onPress={() => onEdit(row.tracked.id)}
      accessibilityRole="button"
      accessibilityLabel={`${row.company} ${row.ticker} 終値 ${formatPriceYen(row.close)} ${formatSignedPercent(row.changePercent, 2)}${flagged ? ' 注目' : ''}`}
      accessibilityHint="この監視銘柄の情報を編集または削除します"
      style={({ pressed }) => [styles.row, !last && styles.rowBorder, pressed && styles.pressed]}>
      <StockAvatar label={row.avatar} name={row.company} size={40} seed={row.ticker} />
      <View style={styles.rowName}>
        <Text style={styles.rowCompany} numberOfLines={1}>{row.company}</Text>
        <View style={styles.rowSub}>
          <Text style={styles.ticker}>{row.ticker}</Text>
          {flagged ? (
            <View style={styles.flag}>
              <Text style={styles.flagText}>注目</Text>
            </View>
          ) : null}
        </View>
        {buy != null || sell != null ? (
          <Text style={styles.ticker} numberOfLines={1}>
            {buy != null ? `買 ${formatPriceYen(buy)}` : ''}
            {buy != null && sell != null ? ' / ' : ''}
            {sell != null ? `売 ${formatPriceYen(sell)}` : ''}
          </Text>
        ) : null}
      </View>
      <View style={styles.rowFigure}>
        <Text style={styles.rowClose} numberOfLines={1}>{formatPriceYen(row.close)}</Text>
        {row.close === null && row.changePercent === null ? null : (
          <View style={[styles.pill, { backgroundColor: toneSoft(change) }]}>
            <Text style={[styles.pillText, { color: toneColor(change) }]}>{formatSignedPercent(row.changePercent, 2)}</Text>
          </View>
        )}
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

export function WatchlistSection({
  featured,
  rest,
  flagged,
  featuredTitle,
  basisLabel,
  onEdit,
  onOpenNews,
}: {
  featured: readonly FeaturedWatch[];
  rest: readonly WatchRow[];
  flagged: ReadonlySet<string>;
  featuredTitle: string;
  basisLabel: string;
  onEdit: (trackedId: string) => void;
  onOpenNews: (newsId: string) => void;
}) {
  const count = featured.length + rest.length;
  return (
    <View style={styles.wrap}>
      {featured.length > 0 ? (
        <View style={styles.block}>
          <View style={styles.blockHead}>
            <Text style={styles.blockTitle}>{featuredTitle}</Text>
            <Text style={styles.blockNote}>{basisLabel}</Text>
          </View>
          {featured.map((entry) => (
            <FeaturedCard key={entry.row.tracked.id} entry={entry} basisLabel={basisLabel} onEdit={onEdit} onOpenNews={onOpenNews} />
          ))}
        </View>
      ) : null}

      {count > 0 ? (
        <View style={styles.block}>
          <View style={styles.blockHead}>
            <Text style={styles.blockTitle}>{featured.length > 0 ? 'その他の監視銘柄' : '監視銘柄'}</Text>
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{count}銘柄</Text>
            </View>
          </View>
          {rest.length > 0 ? (
            <View style={styles.listCard}>
              {rest.map((row, index) => (
                <WatchListRow key={row.tracked.id} row={row} flagged={flagged.has(row.ticker)} last={index === rest.length - 1} onEdit={onEdit} />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 16 },
  block: { gap: 10 },
  blockHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  blockTitle: { flex: 1, color: PF.ink, fontSize: 17, fontWeight: '900' },
  blockNote: { color: PF.muted, fontSize: 12, fontWeight: '700' },
  countBadge: { backgroundColor: '#e7ece8', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 3 },
  countText: { color: PF.muted, fontSize: 12.5, fontWeight: '800' },
  pressed: { opacity: 0.75 },

  featured: { borderRadius: PF.radius, borderWidth: 1, overflow: 'hidden' },
  featuredMain: { padding: 14, gap: 10 },
  featuredTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  featuredName: { flex: 1, minWidth: 0, gap: 3, alignItems: 'flex-start' },
  badge: { borderRadius: 99, paddingHorizontal: 9, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontWeight: '900' },
  featuredCompany: { color: PF.ink, fontSize: 16, lineHeight: 21, fontWeight: '900' },
  ticker: { color: PF.muted, fontSize: 12 },
  featuredFigure: { alignItems: 'flex-end', gap: 2, maxWidth: 120 },
  featuredPercent: { fontSize: 26, lineHeight: 32, fontWeight: '900' },
  featuredPercentNarrow: { fontSize: 22, lineHeight: 28 },
  featuredCompanyNarrow: { fontSize: 15, lineHeight: 20 },
  featuredClose: { color: PF.muted, fontSize: 12, fontWeight: '700' },
  featuredMove: { fontSize: 11, fontWeight: '900' },
  newsBox: { backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: 12, padding: 10, gap: 3 },
  newsHeadline: { color: PF.ink, fontSize: 14, lineHeight: 20, fontWeight: '800' },
  newsDate: { color: PF.muted, fontSize: 11.5 },
  newsCta: { alignSelf: 'flex-end', paddingHorizontal: 14, paddingBottom: 12, paddingTop: 2, minHeight: 36, justifyContent: 'center' },
  newsCtaText: { fontSize: 14, fontWeight: '900' },

  listCard: { backgroundColor: PF.card, borderRadius: PF.radius, borderWidth: 1, borderColor: PF.cardBorder, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 10, paddingLeft: 14, paddingRight: 10 },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: PF.cardBorder },
  rowName: { flex: 1, minWidth: 0, gap: 2 },
  rowSub: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowCompany: { flexShrink: 1, color: PF.ink, fontSize: 15, fontWeight: '800' },
  flag: { backgroundColor: '#fff0d7', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  flagText: { color: '#946222', fontSize: 10.5, fontWeight: '900' },
  rowFigure: { alignItems: 'flex-end', gap: 3 },
  rowClose: { color: PF.ink, fontSize: 15, fontWeight: '900' },
  pill: { borderRadius: 99, paddingHorizontal: 8, paddingVertical: 1 },
  pillText: { fontSize: 12, fontWeight: '800' },
  chevron: { color: PF.muted, fontSize: 20, lineHeight: 22 },
});
