import { useCallback, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { fetchReport } from '@/lib/personalized-reports';
import {
  CLAIM_TYPE_LABEL,
  STANCE_LABEL,
  buildImpactRows,
  buildStockRows,
  changeDirection,
  hasHoldingImpacts,
  marketDirectionLabel,
  stanceSummary,
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
  type ImpactRow,
  type MarketDetail,
  type OutlookCheck,
  type PersonalizedReport,
  type Stance,
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
  const detail = report.body?.market_detail ?? null;
  const upgraded = hasHoldingImpacts(report);
  const impactRows = upgraded ? buildImpactRows(report) : [];
  const stanceLine = stanceSummary(impactRows);

  // Deterministic figures (computed in code, not by the AI).
  const figures = (
    <>
      <View style={styles.figures}>
        {!detail && snapshot.indices.map((index) => (
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
    </>
  );

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

      {!detail && figures}

      {/* Market-wide detail, built in code from the same shared packets X uses (no per-user AI). */}
      {!!detail && <MarketDetailSection detail={detail} close={close} />}

      {/* Shared market analysis: identical to the X post's source, shown verbatim. */}
      {!detail && !!report.body?.market_section && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{close ? '今日の市場全体' : 'けさの市場全体'}</Text>
          <Text style={styles.marketHeadline}>{report.body.market_section.headline_ja}</Text>
          <Text style={styles.paragraph}>{report.body.market_section.market_summary_ja}</Text>
          {report.body.market_section.claims.map((claim, index) => (
            <View key={`claim-${index}`} style={styles.pointRow}>
              <Text style={styles.pointDot}>・</Text>
              <Text style={styles.pointText}>
                {claim.text_ja}
                {!!CLAIM_TYPE_LABEL[claim.claim_type] && <Text style={styles.claimTag}>（{CLAIM_TYPE_LABEL[claim.claim_type]}）</Text>}
              </Text>
            </View>
          ))}
          {report.body.market_section.next_watch_ja.map((item, index) => <Bullet key={`watch-${index}`} text={`注目: ${item}`} />)}
          {report.body.market_section.data_gaps_ja.map((note) => <Text key={note} style={styles.footnote}>{note}</Text>)}
        </View>
      )}

      {upgraded && (
        <View style={styles.partHeader}>
          <Text style={styles.partTitle}>{close ? '保有株への実際の影響' : '保有株への今日の影響見通し'}</Text>
          {!!stanceLine && <Text style={styles.partSub}>{stanceLine}</Text>}
        </View>
      )}
      {!!detail && figures}

      {!!report.body?.overview_ja && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{close ? '今日のポート総括' : '今日のポート見通し'}</Text>
          <Text style={styles.paragraph}>{report.body.overview_ja}</Text>
        </View>
      )}

      {close && !!report.body?.morning_review_ja && (
        <View style={[styles.section, styles.reviewCard]}>
          <Text style={styles.sectionTitle}>朝の見通しとの答え合わせ</Text>
          <Text style={styles.paragraph}>{report.body.morning_review_ja}</Text>
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

      {upgraded && impactRows.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{close ? '保有銘柄ごとの結果' : '保有銘柄ごとの見通し'}</Text>
          {impactRows.map((row) => <ImpactCard key={row.stock.ticker_code} row={row} close={close} />)}
        </View>
      )}

      {upgraded && impactRows.length === 0 && (
        <View style={styles.section}>
          <Text style={styles.footnote}>保有銘柄が登録されていないため、保有株への影響は表示していません。</Text>
        </View>
      )}

      {!upgraded && rows.holdings.length > 0 && (
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

const STANCE_STYLE: Record<Stance, { color: string; backgroundColor: string }> = {
  tailwind: { color: '#2c6940', backgroundColor: '#e4f1e7' },
  headwind: { color: '#a1352c', backgroundColor: '#fbe7e4' },
  neutral: { color: '#5e6d63', backgroundColor: '#eef1ee' },
  no_clear_material: { color: '#6b766f', backgroundColor: '#f1f3f1' },
};

const CHECK_COLOR: Record<OutlookCheck, string> = {
  matched: '#2c6940', diverged: '#a1352c', mixed: '#946222', not_comparable: '#89918c',
};

function MarketDetailSection({ detail, close }: { detail: MarketDetail; close: boolean }) {
  const flowClaims = close ? detail.today_claims : detail.overnight_claims;
  const secondaryClaims = close ? detail.overnight_claims : detail.today_claims;
  return (
    <View>
      <View style={styles.partHeader}>
        <Text style={styles.partTitle}>{close ? '市場全体の大引け詳報' : '市場全体の朝刊'}</Text>
        <Text style={styles.partSub}>方向感: {marketDirectionLabel(detail.direction)}</Text>
      </View>
      <View style={styles.section}>
        <Text style={styles.marketHeadline}>{detail.headline_ja}</Text>
        <Text style={styles.paragraph}>{detail.summary_ja}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{close ? '主要指標（今日の終値ベース）' : '主要指標（前営業日・海外市場）'}</Text>
        {detail.metric_groups.map((group) => (
          <View key={group.group_ja} style={styles.metricGroup}>
            <Text style={styles.metricGroupTitle}>{group.group_ja}</Text>
            {group.items.map((item) => (
              <View key={item.key} style={styles.metricRow}>
                <Text style={styles.metricLabel}>{item.label}</Text>
                <View style={styles.metricValues}>
                  <Text style={styles.metricValue}>{item.value_display ?? '—'}</Text>
                  {!!item.change_display && (
                    <Text style={[styles.metricChange, { color: DIRECTION_COLOR[changeDirection(item.change_display)] }]}>
                      {item.change_display}
                    </Text>
                  )}
                </View>
                {!!item.note_ja && <Text style={styles.metricNote}>{item.note_ja}</Text>}
              </View>
            ))}
          </View>
        ))}
      </View>

      {flowClaims.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{close ? '今日の相場の流れと主導した材料' : '海外市場・前日の流れ'}</Text>
          {flowClaims.map((claim, index) => <ClaimBullet key={`flow-${index}`} text={claim.text_ja} type={claim.claim_type} />)}
        </View>
      )}
      {secondaryClaims.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{close ? '海外・為替などの影響' : '日本市場の状況'}</Text>
          {secondaryClaims.map((claim, index) => <ClaimBullet key={`sub-${index}`} text={claim.text_ja} type={claim.claim_type} />)}
        </View>
      )}

      {(detail.tailwind_themes_ja.length > 0 || detail.headwind_themes_ja.length > 0) && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{close ? '業種・テーマ別の強弱' : 'セクター別の追い風・逆風'}</Text>
          {detail.tailwind_themes_ja.map((theme) => <Bullet key={`tw-${theme}`} text={`${close ? '強い' : '追い風'}: ${theme}`} />)}
          {detail.headwind_themes_ja.map((theme) => <Bullet key={`hw-${theme}`} text={`${close ? '弱い' : '逆風'}: ${theme}`} />)}
        </View>
      )}

      {detail.key_news.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{close ? '当日の重要ニュース・決算' : '国内外の重要ニュース・決算'}</Text>
          {detail.key_news.map((item) => (
            <View key={item.ref_id} style={styles.newsItem}>
              <Text style={styles.newsHeadline}>{item.headline_ja}</Text>
              <Text style={styles.newsWhy}>{item.why_it_matters_ja}</Text>
            </View>
          ))}
        </View>
      )}

      {close && !!detail.morning_reference && (
        <View style={[styles.section, styles.reviewCard]}>
          <Text style={styles.sectionTitle}>朝の想定と実際</Text>
          <Text style={styles.paragraph}>朝の見立て: {detail.morning_reference.headline_ja}（{marketDirectionLabel(detail.morning_reference.direction)}）</Text>
          <Text style={styles.paragraph}>実際: {detail.headline_ja}（{marketDirectionLabel(detail.direction)}）</Text>
          {detail.morning_reference.next_watch_ja.map((item, index) => <Bullet key={`mw-${index}`} text={`朝の注目点: ${item}`} />)}
        </View>
      )}

      {(detail.watch_points_ja.length > 0 || detail.risks_ja.length > 0) && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{close ? '翌営業日に持ち越す注目材料' : '寄り付き前の注目ポイントとシナリオ'}</Text>
          {detail.watch_points_ja.map((item, index) => <Bullet key={`wp-${index}`} text={item} />)}
          {detail.risks_ja.map((item, index) => <Bullet key={`rk-${index}`} text={`リスク: ${item}`} />)}
        </View>
      )}

      {detail.data_gaps_ja.length > 0 && (
        <View style={styles.gapBox}>
          {detail.data_gaps_ja.map((note) => <Text key={note} style={styles.footnote}>{note}</Text>)}
        </View>
      )}
    </View>
  );
}

function ClaimBullet({ text, type }: { text: string; type: string }) {
  return (
    <View style={styles.pointRow}>
      <Text style={styles.pointDot}>・</Text>
      <Text style={styles.pointText}>
        {text}
        {!!CLAIM_TYPE_LABEL[type] && <Text style={styles.claimTag}>（{CLAIM_TYPE_LABEL[type]}）</Text>}
      </Text>
    </View>
  );
}

function ImpactCard({ row, close }: { row: ImpactRow; close: boolean }) {
  const impact = row.impact;
  const brief = row.stock.detail_level === 'brief';
  return (
    <View style={[styles.stockCard, brief && styles.briefCard]}>
      <View style={styles.stockHead}>
        {!!impact && <Text style={[styles.stanceBadge, STANCE_STYLE[impact.stance]]}>{STANCE_LABEL[impact.stance]}</Text>}
        <Text style={styles.ticker}>{row.stock.ticker_code}</Text>
        <Text style={[styles.change, { color: DIRECTION_COLOR[row.changeDirection] }]}>{row.changeLine}</Text>
      </View>
      <Text style={styles.stockName}>{row.stock.company_name}</Text>
      <Text style={styles.stockLine}>{row.priceLine}{row.relativeLine ? `・${row.relativeLine}` : ''}</Text>
      {!!row.plLine && <Text style={styles.stockLineSub}>{row.plLine}</Text>}
      {close && !!row.outlookLine && (
        <Text style={[styles.outlookLine, { color: CHECK_COLOR[row.outlookCheck ?? 'not_comparable'] }]}>{row.outlookLine}</Text>
      )}
      {!!impact?.fact_ja && <ImpactLine label="事実" text={impact.fact_ja} />}
      {!!impact?.inference_ja && <ImpactLine label="推定" text={impact.inference_ja} />}
      {!!impact?.watch_ja && <ImpactLine label={close ? '翌営業日の確認点' : '見るポイント'} text={impact.watch_ja} />}
      {!impact && <Text style={styles.stockLineSub}>この銘柄の解説はありません。</Text>}
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

function ImpactLine({ label, text }: { label: string; text: string }) {
  return (
    <View style={styles.impactLine}>
      <Text style={styles.impactLabel}>{label}</Text>
      <Text style={styles.impactText}>{text}</Text>
    </View>
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
  marketHeadline: { color: '#17211a', fontWeight: '900', fontSize: 16, lineHeight: 24, marginBottom: 6 },
  claimTag: { color: '#89918c', fontSize: 12, fontWeight: '700' },
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
  partHeader: { marginTop: 30, paddingBottom: 8, borderBottomWidth: 2, borderBottomColor: '#397449' },
  partTitle: { color: '#17211a', fontWeight: '900', fontSize: 18 },
  partSub: { color: '#5e6d63', fontSize: 13, fontWeight: '700', marginTop: 4 },
  metricGroup: { backgroundColor: '#fff', borderRadius: 14, borderWidth: 1, borderColor: '#e1e5e2', paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8 },
  metricGroupTitle: { color: '#548161', fontSize: 12, fontWeight: '900', marginBottom: 4 },
  metricRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', paddingVertical: 5 },
  metricLabel: { flex: 1, minWidth: 140, color: '#3d4a42', fontSize: 14, fontWeight: '700' },
  metricValues: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  metricValue: { color: '#17211a', fontSize: 15, fontWeight: '900' },
  metricChange: { fontSize: 13, fontWeight: '800' },
  metricNote: { width: '100%', color: '#89918c', fontSize: 12, marginTop: 2 },
  newsItem: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e1e5e2', padding: 12, marginBottom: 8 },
  newsHeadline: { color: '#17211a', fontSize: 14, fontWeight: '900', lineHeight: 21 },
  newsWhy: { color: '#3d4a42', fontSize: 14, lineHeight: 21, marginTop: 4 },
  reviewCard: { backgroundColor: '#f4f1e8', borderRadius: 16, padding: 16 },
  gapBox: { marginTop: 12, gap: 4 },
  briefCard: { paddingVertical: 10 },
  stanceBadge: { fontSize: 11, fontWeight: '900', borderRadius: 99, paddingHorizontal: 8, paddingVertical: 4, overflow: 'hidden' },
  outlookLine: { fontSize: 13, fontWeight: '800', marginTop: 6 },
  impactLine: { flexDirection: 'row', gap: 8, marginTop: 8 },
  impactLabel: { width: 64, color: '#548161', fontSize: 12, fontWeight: '900', lineHeight: 22 },
  impactText: { flex: 1, color: '#2f3a33', fontSize: 15, lineHeight: 23 },
});
