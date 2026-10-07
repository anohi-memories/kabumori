// Delivery first (2026-10-07): an objective error is isolated to the smallest unit it lives in, and the rest of the
// report is delivered.
//
// The first GPT-6.1 Sol close (2026-10-07 16:20 JST) was useful text, yet both generations were withheld: one sentence
// in each tripped a guard, so the whole cycle failed. The product decision is that a daily report is delivered unless
// nothing coherent is left. Here a generated analysis is cut into units (a sentence of a prose field, one point, one
// claim, one news item, one watch / risk item, the headline), each unit is checked on its own, and only the units with
// an objective error are dropped (or, where the fix is deterministic, neutralized). The removals are returned so they
// can be recorded; nothing is invented to replace a removed unit except two code-rendered fallbacks built from the
// input itself (the headline and the market summary).
//
// Pure: no I/O, no model call. The checks themselves are injected (analysis_logic.checkUnit) so the guard rules have a
// single home and this module stays free of a runtime import cycle.

import type { AnalysisInput } from "./analysis_input.ts";
import type { GeneratedAnalysis } from "./analysis_logic.ts";

export type UnitKind = "factual" | "forward";

/** One reason a unit is wrong (`remove`) or only worth recording (`advisory`). `detail` is the guard's own text. */
export type UnitFinding = { code: string; detail: string };

export type UnitCheck = {
  remove: UnitFinding[];
  advisory: UnitFinding[];
  /** A deterministic repair that passes every check (e.g. a chart emoji pointing the wrong way, removed). */
  neutralized?: string;
};

export type UnitChecker = (text: string, kind: UnitKind) => UnitCheck;

export type RemovedUnit = {
  /** Where the unit was: `x_post.points_ja[1]`, `app_story.japan_ja#2` (the sentence index), `claims[c3]` ... */
  path: string;
  code: string;
  detail: string;
  /** The unit as the model wrote it (kept for the trace; it never reaches a reader). */
  text: string;
  action: "removed" | "neutralized" | "fallback";
};

export type SanitizeResult = {
  analysis: GeneratedAnalysis;
  removed: RemovedUnit[];
  advisories: string[];
  /** A minimally coherent report is left: enough model-written narrative survived to be worth delivering. */
  coherent: boolean;
  incoherentReason: string | null;
  narrativeUnits: { total: number; kept: number };
};

/** Fewer kept model-written narrative units than this and the generation is not delivered (another may be). */
export const MIN_KEPT_NARRATIVE_UNITS = 3;
export const MAX_POINTS = 3;

/**
 * Sentences of a prose field with their terminators kept, so that `units.join("")` reproduces the text. A sentence
 * ends at 。！？!? or a line break, and at a pictograph followed by a space or the end ("…でした📉 10月6日の米国…" is
 * two sentences: 2026-10-07 the second sentence's date was read as the first one's).
 */
export function splitUnits(text: string): string[] {
  const units: string[] = [];
  const pattern = /[。！？!?]+[」』）)]*\s*|\n+|\p{Extended_Pictographic}(?:️)?(?=\s|$)\s*/gu;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    const end = match.index! + match[0].length;
    if (end > start) units.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) units.push(text.slice(start));
  return units.filter((unit) => unit.trim().length > 0);
}

type Ctx = { check: UnitChecker; removed: RemovedUnit[]; advisories: Set<string>; counts: { total: number; kept: number } };

function record(ctx: Ctx, path: string, text: string, check: UnitCheck, action: RemovedUnit["action"]) {
  for (const finding of check.remove) ctx.removed.push({ path, code: finding.code, detail: finding.detail, text, action });
}

/** One checked unit: kept as is, neutralized, or dropped. Advisory findings are recorded either way. */
function checkOne(ctx: Ctx, path: string, text: string, kind: UnitKind): string | null {
  const result = ctx.check(text, kind);
  for (const finding of result.advisory) ctx.advisories.add(`${finding.code}@${path}`);
  if (result.remove.length === 0) return text;
  if (result.neutralized !== undefined) {
    record(ctx, path, text, result, "neutralized");
    return result.neutralized;
  }
  record(ctx, path, text, result, "removed");
  return null;
}

/** A prose field, sentence by sentence. `narrative` fields count towards coherence. */
function prose(ctx: Ctx, path: string, text: string, kind: UnitKind, narrative: boolean): string {
  const kept: string[] = [];
  splitUnits(text).forEach((unit, index) => {
    if (narrative) ctx.counts.total += 1;
    const value = checkOne(ctx, `${path}#${index}`, unit, kind);
    if (value === null) return;
    if (narrative) ctx.counts.kept += 1;
    kept.push(value);
  });
  return kept.join("").trim();
}

/** Items of a list (points, watch points, risks): each item is one unit. */
function items(ctx: Ctx, path: string, values: readonly string[], kind: UnitKind, narrative: boolean): string[] {
  const kept: string[] = [];
  values.forEach((value, index) => {
    if (narrative) ctx.counts.total += 1;
    const checked = checkOne(ctx, `${path}[${index}]`, value, kind);
    if (checked === null) return;
    if (narrative) ctx.counts.kept += 1;
    kept.push(checked);
  });
  return kept;
}

export type Fallbacks = {
  /** A code-rendered headline from the input (dates and values exactly as in the packet). */
  headline: string;
  /** A code-rendered one-paragraph summary from the input. */
  summary: string;
};

/**
 * The analysis with every objectively wrong unit removed (or neutralized), the removals, and whether a minimally
 * coherent report is left. Claims, news items and themes are checked against the input's refs first; text units
 * second (the causal check reads the kept claims, so it is part of the injected checker's context).
 */
export function sanitizeAnalysis(
  analysis: GeneratedAnalysis,
  input: AnalysisInput,
  check: (keptClaims: GeneratedAnalysis["claims"]) => UnitChecker,
  fallbacks: Fallbacks,
): SanitizeResult {
  const removed: RemovedUnit[] = [];
  const advisories = new Set<string>();

  // 1. Claims: references first (unknown ref, a factual claim without one, a causal claim without news).
  const refChecked = analysis.claims.filter((claim) => {
    const path = `claims[${claim.claim_id}]`;
    const unknown = claim.evidence_refs.filter((ref) => !input.allowedRefs.has(ref));
    const reason = unknown.length > 0
      ? { code: "UNKNOWN_REF", detail: `入力に無い ref: ${unknown.join(",")}` }
      : claim.claim_type !== "insufficient_evidence" && claim.claim_type !== "watch_point" && claim.evidence_refs.length === 0
      ? { code: "CLAIM_WITHOUT_REF", detail: `根拠 ref の無い claim: ${claim.claim_id}` }
      : claim.claim_type === "causal" && !claim.evidence_refs.some((ref) => input.newsRefs.has(ref))
      ? { code: "CAUSAL_WITHOUT_NEWS", detail: `ニュースの根拠が無い causal: ${claim.claim_id}` }
      : null;
    if (reason) removed.push({ path, ...reason, text: claim.text_ja, action: "removed" });
    return !reason;
  });
  const ctx: Ctx = { check: check(refChecked), removed, advisories, counts: { total: 0, kept: 0 } };
  const claims = refChecked.filter((claim) =>
    checkOne(ctx, `claims[${claim.claim_id}]`, claim.text_ja, claim.claim_type === "watch_point" ? "forward" : "factual") !== null
  );
  const claimIds = new Set(claims.map((claim) => claim.claim_id));

  // 2. Headline: one unit; a wrong headline is replaced by the code-rendered one.
  let headline = checkOne(ctx, "headline_ja", analysis.headline_ja, "factual");
  if (headline === null || !headline.trim()) {
    removed.push({ path: "headline_ja", code: "FALLBACK", detail: "code-rendered headline", text: analysis.headline_ja, action: "fallback" });
    headline = fallbacks.headline;
  }

  // 3. Summary: sentences; an emptied summary is replaced by the code-rendered one.
  let summary = prose(ctx, "market_summary_ja", analysis.market_summary_ja, "factual", true);
  if (!summary) {
    removed.push({ path: "market_summary_ja", code: "FALLBACK", detail: "code-rendered summary", text: analysis.market_summary_ja, action: "fallback" });
    summary = fallbacks.summary;
  }

  // 4. News items: unknown refs are dropped whole; the explanation sentence by sentence.
  const keyNews = analysis.key_news.flatMap((news, index) => {
    const path = `key_news[${index}]`;
    if (!input.newsRefs.has(news.ref)) {
      removed.push({ path, code: "UNKNOWN_REF", detail: `入力に無いニュース: ${news.ref}`, text: news.why_it_matters_ja, action: "removed" });
      return [];
    }
    const why = prose(ctx, `${path}.why_it_matters_ja`, news.why_it_matters_ja, "factual", false);
    return why ? [{ ...news, why_it_matters_ja: why }] : [];
  });

  // 5. Themes: their claims must have survived; the name is a unit.
  const themes = (list: GeneratedAnalysis["strong_themes"], path: string) =>
    list.filter((theme, index) => {
      if (theme.claim_ids.length === 0 || theme.claim_ids.some((id) => !claimIds.has(id))) {
        removed.push({ path: `${path}[${index}]`, code: "THEME_CLAIMS", detail: `テーマの claim_ids が不正: ${theme.name_ja}`, text: theme.name_ja, action: "removed" });
        return false;
      }
      return checkOne(ctx, `${path}[${index}]`, theme.name_ja, "factual") !== null;
    });

  // 6. X digest and app story.
  const x = analysis.x_post;
  let lead = prose(ctx, "x_post.lead_ja", x.lead_ja, "factual", true);
  if (!lead) {
    removed.push({ path: "x_post.lead_ja", code: "FALLBACK", detail: "code-rendered lead", text: x.lead_ja, action: "fallback" });
    lead = headline;
  }
  let points = items(ctx, "x_post.points_ja", x.points_ja, "factual", true);
  if (points.length > MAX_POINTS) {
    points.slice(MAX_POINTS).forEach((value, offset) =>
      removed.push({ path: `x_post.points_ja[${MAX_POINTS + offset}]`, code: "POINTS_OVER_LIMIT", detail: "more than three points", text: value, action: "removed" })
    );
    points = points.slice(0, MAX_POINTS);
  }
  const xPost = {
    ...x,
    lead_ja: lead,
    points_ja: points,
    closing_ja: prose(ctx, "x_post.closing_ja", x.closing_ja, "factual", true),
    ...(typeof x.context_ja === "string" ? { context_ja: prose(ctx, "x_post.context_ja", x.context_ja, "factual", true) } : {}),
    ...(typeof x.news_ja === "string" ? { news_ja: prose(ctx, "x_post.news_ja", x.news_ja, "factual", true) } : {}),
    ...(typeof x.watch_ja === "string" ? { watch_ja: prose(ctx, "x_post.watch_ja", x.watch_ja, "forward", true) } : {}),
  };
  const story = analysis.app_story;
  const appStory = story
    ? {
      summary_ja: prose(ctx, "app_story.summary_ja", story.summary_ja, "factual", true),
      overseas_ja: prose(ctx, "app_story.overseas_ja", story.overseas_ja, "factual", true),
      japan_ja: prose(ctx, "app_story.japan_ja", story.japan_ja, "factual", true),
      cross_asset_ja: prose(ctx, "app_story.cross_asset_ja", story.cross_asset_ja, "factual", true),
      news_ja: prose(ctx, "app_story.news_ja", story.news_ja, "factual", true),
      strong_ja: prose(ctx, "app_story.strong_ja", story.strong_ja, "factual", true),
      caution_ja: prose(ctx, "app_story.caution_ja", story.caution_ja, "forward", true),
      watch_ja: prose(ctx, "app_story.watch_ja", story.watch_ja, "forward", true),
    }
    : undefined;

  const sanitized: GeneratedAnalysis = {
    ...analysis,
    headline_ja: headline,
    market_summary_ja: summary,
    claims,
    key_news: keyNews,
    strong_themes: themes(analysis.strong_themes, "strong_themes"),
    weak_themes: themes(analysis.weak_themes, "weak_themes"),
    next_watch_ja: items(ctx, "next_watch_ja", analysis.next_watch_ja, "forward", false),
    risks_ja: items(ctx, "risks_ja", analysis.risks_ja, "forward", false),
    x_post: xPost,
    ...(appStory ? { app_story: appStory } : {}),
  };
  const coherent = ctx.counts.kept >= MIN_KEPT_NARRATIVE_UNITS;
  return {
    analysis: sanitized,
    removed,
    advisories: [...advisories],
    coherent,
    incoherentReason: coherent ? null : `only ${ctx.counts.kept} of ${ctx.counts.total} narrative units are safe`,
    narrativeUnits: { total: ctx.counts.total, kept: ctx.counts.kept },
  };
}

/** Compact, fixed-shape codes of the removals for warnings, diagnostics and the trace (no model text). */
export function removalCodes(removed: readonly RemovedUnit[]): string[] {
  return removed.map((unit) => `UNIT_${unit.action.toUpperCase()}:${unit.code}@${unit.path}`);
}
