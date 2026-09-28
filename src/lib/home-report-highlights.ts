// Extracts 2-3 short "today's points" for the home report card from a stored
// PersonalizedReport only. It never generates new text: it picks the highest
// -confidence existing stored fields and falls back down a chain, ending at
// summary_ja, exactly like buildNewsPresentation's origin-priority pattern.
//
// This module has no RN imports so it can be tested with Deno and bundled by Metro.

import type { PersonalizedReport } from '@/lib/report-presentation';

export type ReportHighlightsSource =
  | 'today_claims'
  | 'checkpoints'
  | 'market_claims'
  | 'overview'
  | 'summary'
  | 'none';

export type ReportHighlights = {
  points: string[];
  source: ReportHighlightsSource;
};

export type ReportCardStatus = 'loading' | 'error' | 'report' | 'empty';

/**
 * The report hero card's render branch, made an explicit, independently
 * testable decision: a fetch error must never be shown as "not generated
 * yet" once loading ends, and loading only applies while nothing is shown.
 */
export function reportCardStatus(hasReport: boolean, loading: boolean, error: string): ReportCardStatus {
  if (loading && !hasReport) return 'loading';
  if (!hasReport && error) return 'error';
  if (hasReport) return 'report';
  return 'empty';
}

const MAX_POINTS = 3;
const POINT_MAX_CHARS = 90;

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function trim(value: string, max: number): string {
  const normalized = collapse(value);
  const characters = Array.from(normalized);
  if (characters.length <= max) return normalized;
  return `${characters.slice(0, max - 1).join('').trimEnd()}…`;
}

function fromStrings(values: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const points: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const cleaned = trim(value, POINT_MAX_CHARS);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    points.push(cleaned);
    if (points.length >= MAX_POINTS) break;
  }
  return points;
}

/**
 * The hero card's report, scoped strictly to `today`: an older stored report
 * (yesterday, last week) must never be shown labeled "today's report" just
 * because it happens to be the newest row. When both morning and close exist
 * for today, the later-generated one wins (normally close). Returns null,
 * not a fallback, when nothing was generated for today yet.
 */
export function currentReport(reports: readonly PersonalizedReport[], today: string): PersonalizedReport | null {
  const todays = reports.filter((report) => report.trading_date === today);
  return todays
    .slice()
    .sort((left, right) => (right.generated_at ?? '').localeCompare(left.generated_at ?? ''))[0] ?? null;
}

/**
 * 2-3 short points from existing stored fields, most factual/specific first:
 * upgraded reports' today_claims, then older checkpoints_ja, then the shared
 * market_section claims, then a split of overview_ja, and finally the whole
 * summary_ja as a single fail-soft point when nothing else is usable.
 */
export function buildReportHighlights(report: PersonalizedReport | null): ReportHighlights {
  if (!report) return { points: [], source: 'none' };
  const body = report.body;

  const todayClaims = fromStrings(body?.market_detail?.today_claims?.map((claim) => claim.text_ja));
  if (todayClaims.length > 0) return { points: todayClaims, source: 'today_claims' };

  const checkpoints = fromStrings(body?.checkpoints_ja);
  if (checkpoints.length > 0) return { points: checkpoints, source: 'checkpoints' };

  const marketClaims = fromStrings(body?.market_section?.claims?.map((claim) => claim.text_ja));
  if (marketClaims.length > 0) return { points: marketClaims, source: 'market_claims' };

  const overview = typeof body?.overview_ja === 'string' ? collapse(body.overview_ja) : '';
  if (overview) {
    const sentences = overview.split(/(?<=[。！？])/u).map((sentence) => sentence.trim()).filter(Boolean);
    const points = fromStrings(sentences.length > 0 ? sentences : [overview]);
    if (points.length > 0) return { points, source: 'overview' };
  }

  const summary = typeof report.summary_ja === 'string' ? collapse(report.summary_ja) : '';
  if (summary) return { points: [trim(summary, POINT_MAX_CHARS)], source: 'summary' };

  return { points: [], source: 'none' };
}
