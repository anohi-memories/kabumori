// Chooses which of the eight Hero character expressions to show for a stored personalized report.
//
// Pure and deterministic: the input is only the stored PersonalizedReport (already Fact-passed when
// it was saved). No network, no AI call, no clock, no randomness -- the same report always gives
// the same state. The state is a presentation mapping of the report's own structured material, NOT
// a prediction or a trading signal, and the UI never shows its name.
//
//   very_positive 01 | positive 02 | neutral 03 | uncertain 04
//   caution 05 | negative 06 | very_negative 07 | volatile 08
//
// This module has no RN imports so it can be tested with Deno and bundled by Metro.

import type { PersonalizedReport } from '@/lib/report-presentation';

export type ReportCharacterState =
  | 'very_positive'
  | 'positive'
  | 'neutral'
  | 'uncertain'
  | 'caution'
  | 'negative'
  | 'very_negative'
  | 'volatile';

/** Display order == asset numbering (01..08). */
export const REPORT_CHARACTER_STATES: readonly ReportCharacterState[] = [
  'very_positive',
  'positive',
  'neutral',
  'uncertain',
  'caution',
  'negative',
  'very_negative',
  'volatile',
];

// Explicit rough-market wording. Sentences that only hedge ("...になる可能性", risk/watch wording)
// never count, and mere direction "mixed" or a large negative score never selects `volatile`.
const VOLATILE_PATTERNS: readonly RegExp[] = [
  /乱高下/,
  /値動きが(?:激しい|荒い|荒く|大きく)/,
  /(?:激しい|荒い)値動き/,
  /荒い(?:展開|相場|動き)/,
  /ボラティリティ(?:が|は|も)?(?:高|大き|拡大|上昇)/,
  /(?:高|大き)(?:い|く)ボラティリティ/,
  /上下に(?:大きく)?振れ/,
  /大きく(?:上下に)?振れ/,
  /急騰(?:と|し|して|も)[^。]*急落/,
  /急落(?:と|し|して|も)[^。]*急騰/,
];
// A sentence that merely warns about a possibility is risk/watch wording, not an observed fact.
const HEDGE_PATTERN = /可能性|おそれ|恐れ|懸念|かもしれ|リスク|注意が必要|警戒|見通し|予想|ありうる|あり得る|場合/;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function claimTexts(claims: unknown): string[] {
  if (!Array.isArray(claims)) return [];
  const texts: string[] = [];
  for (const claim of claims) {
    if (!claim || typeof claim !== 'object') continue;
    const record = claim as { text_ja?: unknown; claim_type?: unknown };
    // A watch_point is by definition a "keep an eye on" statement, not an observation.
    if (record.claim_type === 'watch_point') continue;
    if (typeof record.text_ja === 'string') texts.push(record.text_ja);
  }
  return texts;
}

function hasExplicitVolatility(report: PersonalizedReport): boolean {
  const body = report.body;
  const texts = [
    ...claimTexts(body?.market_detail?.today_claims),
    ...claimTexts(body?.market_detail?.overnight_claims),
    ...claimTexts(body?.market_section?.claims),
    typeof body?.overview_ja === 'string' ? body.overview_ja : '',
    typeof report.summary_ja === 'string' ? report.summary_ja : '',
  ];
  for (const text of texts) {
    for (const sentence of text.split(/(?<=[。！？\n])/u)) {
      if (!sentence || HEDGE_PATTERN.test(sentence)) continue;
      if (VOLATILE_PATTERNS.some((pattern) => pattern.test(sentence))) return true;
    }
  }
  return false;
}

type Scores = { positive: number; negative: number };

function directionOf(report: PersonalizedReport): string | null {
  const detail = report.body?.market_detail?.direction;
  if (typeof detail === 'string') return detail;
  const section = report.body?.market_section?.market_direction;
  return typeof section === 'string' ? section : null;
}

function score(report: PersonalizedReport): Scores {
  const scores: Scores = { positive: 0, negative: 0 };
  const body = report.body;

  // 1. Overall tone of the stored report.
  if (body?.tone === 'positive') scores.positive += 1;
  else if (body?.tone === 'cautious') scores.negative += 1;

  // 2. Market direction (market_detail first, then the shared market_section).
  const direction = directionOf(report);
  if (direction === 'up') scores.positive += 1;
  else if (direction === 'down') scores.negative += 1;

  // 3. Holding impact stances: the side with more holdings wins; a tie scores nothing.
  const impacts = Array.isArray(body?.holding_impacts) ? body.holding_impacts : [];
  const tailwind = impacts.filter((impact) => impact?.stance === 'tailwind').length;
  const headwind = impacts.filter((impact) => impact?.stance === 'headwind').length;
  if (tailwind > headwind) scores.positive += 1;
  else if (headwind > tailwind) scores.negative += 1;

  // 4. Close reports only: the day's actual portfolio / benchmark change.
  if (report.report_type === 'close') {
    const dayChange = finiteNumber(report.portfolio_snapshot?.totals?.day_change_percent);
    if (dayChange !== null && dayChange > 0) scores.positive += 1;
    else if (dayChange !== null && dayChange < 0) scores.negative += 1;
    const benchmarkChange = finiteNumber(report.portfolio_snapshot?.totals?.topix_change_percent);
    if (benchmarkChange !== null && benchmarkChange > 0) scores.positive += 1;
    else if (benchmarkChange !== null && benchmarkChange < 0) scores.negative += 1;
  }
  return scores;
}

function isUncertain(report: PersonalizedReport, scores: Scores): boolean {
  const body = report.body;
  const direction = directionOf(report);
  if (direction === 'mixed' || direction === 'unknown') return true;
  if (scores.positive > 0 && scores.negative > 0) return true;
  if (Array.isArray(body?.market_detail?.data_gaps_ja) && body.market_detail.data_gaps_ja.length > 0) return true;
  if (Array.isArray(body?.market_section?.data_gaps_ja) && body.market_section.data_gaps_ja.length > 0) return true;
  const impacts = Array.isArray(body?.holding_impacts) ? body.holding_impacts : [];
  const directional = impacts.filter((impact) => impact?.stance === 'tailwind' || impact?.stance === 'headwind').length;
  const noClear = impacts.filter((impact) => impact?.stance === 'no_clear_material').length;
  return noClear > 0 && noClear > directional;
}

/**
 * The character state for the report currently shown on Home. Missing, legacy or malformed reports
 * (and any unexpected shape) fall back to `neutral`; this function never throws.
 */
export function selectReportCharacterState(report: PersonalizedReport | null | undefined): ReportCharacterState {
  if (!report) return 'neutral';
  try {
    if (hasExplicitVolatility(report)) return 'volatile';

    const scores = score(report);
    const close = report.report_type === 'close';
    const strongThreshold = close ? 4 : 3;
    const { positive, negative } = scores;

    if (negative === 0 && positive >= strongThreshold) return 'very_positive';
    if (positive > negative) return 'positive';
    if (positive === 0 && negative >= strongThreshold) return 'very_negative';
    if (negative - positive >= 2) return 'negative';
    if (negative > positive) return 'caution';

    // positive === negative: no directional majority.
    return isUncertain(report, scores) ? 'uncertain' : 'neutral';
  } catch {
    return 'neutral';
  }
}
