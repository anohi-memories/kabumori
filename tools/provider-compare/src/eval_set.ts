// The Phase 3 news evaluation set: the 22 original fixtures plus the independently labelled expansion, with a label record
// that says WHERE each expected judgement came from and HOW far it was checked. Pure data and arithmetic: no network, no key.
//
// Two populations are kept apart on purpose:
//   - the HARD set is hand-picked (gap kinds, production misses, borderline). It finds disagreements; it says nothing about
//     overall Recall or Precision, because the way it was assembled is correlated with what is hard.
//   - the SAMPLE set is a seeded stratified random draw from every AI-judged candidate of a fixed window. Only this set can
//     support a statement about production-like traffic, and only with the stratum weights it carries.
import { loadCases, type CaseFixture, type Importance } from "./fixtures.ts";
import { missRateUpperBound95 } from "../scripts/eval_manifest.ts";

export type LabelStatus = "independent_confirmed" | "ai_provisional" | "human_review_pending" | "insufficient_evidence";

export type LabelRecord = {
  /** null when the label is not decidable (pending a policy answer, or the stored text lacks the decisive fact). */
  expected: Importance | null;
  status: LabelStatus;
  /** Id of the pre-declared rule the label follows (see eval_labels.json), or null for a plain judgement. */
  rule: string | null;
  /** Same-news-event cluster or type family; see `families` in eval_labels.json. */
  cluster: string | null;
  /** True only for the one representative of an event that counts toward headline metrics. */
  headline: boolean;
  keyFacts: string[];
  rationale: string;
  gradeNote?: string;
  reviewReason?: string;
  /** How the label was checked against the primary document. */
  primarySourceCheck: string;
  /** Who signed the label off. Nobody has: "human" is reserved for the user's later review. */
  verifier: "none" | "human";
};

export type EvalCase = {
  caseId: string;
  group: string;
  /** Full production candidate id (null for the 22 original fixtures, which only carry an 8-character prefix in caseId). */
  candidateId: string | null;
  sets: Array<"existing" | "hard" | "sample">;
  /**
   * bodyStored is false when the body is deliberately not in the repository (src/body_policy.ts): bodySummary is then null and
   * the body is re-read from production by candidateId and checked against bodySha256 (see attachBodies).
   */
  candidate: CaseFixture["candidate"] & { bodyStored?: boolean; bodyCharsOriginal?: number; bodySha256?: string };
  recorded: CaseFixture["recorded"];
  label: LabelRecord;
  /** Present for members of the representative sample. Weight = stratumN / stratumSampled. */
  sampling: { stratum: string; stratumN: number; stratumRank: number } | null;
};

export type EvalSetFile = {
  version: 2;
  exportedAt: string;
  population: {
    window: string;
    definition: string;
    sample: { seed: string; quotas: Record<string, number>; strata: Record<string, { n: number; sampled: number }> };
  };
  codeVersions: Array<{ label: string; ref: string; files: Record<string, string> }>;
  cases: EvalCase[];
};

export type LabelsFile = {
  version: 1;
  labeledOn: string;
  statuses: Record<string, string>;
  families: string[];
  codeVersions: EvalSetFile["codeVersions"];
  rules: Record<string, string>;
  labels: Record<string, Partial<LabelRecord> & { expected: Importance | null; status: LabelStatus }>;
  existingLabels: Record<string, Partial<LabelRecord> & { expected: Importance | null; status: LabelStatus }>;
};

const root = (name: string) => new URL(`../fixtures/${name}`, import.meta.url);

export async function loadLabels(): Promise<LabelsFile> {
  return JSON.parse(await Deno.readTextFile(root("eval_labels.json"))) as LabelsFile;
}

export async function loadExpansion(): Promise<EvalSetFile> {
  const file = JSON.parse(await Deno.readTextFile(root("eval_expansion.json"))) as EvalSetFile;
  if (file.version !== 2 || !Array.isArray(file.cases)) throw new Error("EVAL_EXPANSION_INVALID");
  return file;
}

const LEGACY_DOMAIN: Record<string, string> = {
  boj: "official_boj_frb",
  fx: "macro_fx_rates",
  geopolitics: "geopolitics",
  north_korea: "geopolitics",
  domestic_incident: "tdnet_misconduct_regulatory",
  disaster: "disaster",
  fsa_action: "official_jp",
  tdnet_earnings: "tdnet_earnings_capital",
  tdnet_capital: "tdnet_earnings_capital",
  tdnet_governance: "tdnet_misconduct_regulatory",
};

/** Maps the original 22 fixtures' groups to the domain names the expansion uses. */
export function legacyDomain(fixture: CaseFixture): string {
  if (fixture.group === "negative_control") {
    return fixture.candidate.sourceType === "tdnet" ? "tdnet_routine_followup" : "official_boj_frb";
  }
  return LEGACY_DOMAIN[fixture.group] ?? fixture.group;
}

function existingToEvalCase(fixture: CaseFixture, labels: LabelsFile): EvalCase {
  const id8 = fixture.caseId.slice(-8);
  const override = labels.existingLabels[id8];
  const productionDerived = fixture.expected.source === "production_decision";
  const label: LabelRecord = {
    expected: override?.expected ?? fixture.expected.importance,
    status: override?.status ?? "ai_provisional",
    rule: override?.rule ?? null,
    cluster: null,
    headline: true,
    keyFacts: override?.keyFacts ?? [],
    rationale: override?.rationale ??
      (productionDerived ? "本番自身の判定を期待値として置いたもの（独立ラベルではない）" : "既知の取りこぼしとして人が指摘したもの"),
    primarySourceCheck: override ? "stored_extraction_of_official_document" : "production_decision",
    verifier: "none",
  };
  return {
    caseId: fixture.caseId,
    group: legacyDomain(fixture),
    candidateId: null,
    sets: ["existing"],
    candidate: fixture.candidate,
    recorded: fixture.recorded,
    label,
    sampling: null,
  };
}

/** The 22 original fixtures followed by the expansion, in a stable order. */
export async function loadEvalSet(): Promise<EvalCase[]> {
  const [labels, original, expansion] = await Promise.all([loadLabels(), loadCases(), loadExpansion()]);
  const existing = original.map((fixture) => existingToEvalCase(fixture, labels));
  return [...existing, ...expansion.cases];
}

/** True when the case counts toward the headline recall / over-call metrics. */
export function isHeadline(item: EvalCase): boolean {
  return item.label.headline && item.label.expected !== null &&
    (item.label.status === "independent_confirmed" || item.label.status === "ai_provisional");
}

export const isPositive = (importance: Importance) => importance !== "no_post";

export type Tally = Record<string, number>;

function tally<T>(items: readonly T[], key: (item: T) => string): Tally {
  const counts: Tally = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export type EvalSummary = {
  total: number;
  bySet: Tally;
  byStatus: Tally;
  byExpected: Tally;
  bySource: Tally;
  byDomain: Tally;
  byRule: Tally;
  headline: {
    cases: number;
    positives: number;
    negatives: number;
    independentPositives: number;
    independentNegatives: number;
    provisionalPositives: number;
    provisionalNegatives: number;
  };
  humanReview: { cases: number; questions: Array<{ family: string; cases: number; reason: string }> };
  insufficientEvidence: number;
  humanConfirmed: number;
};

export function summariseEvalSet(cases: readonly EvalCase[]): EvalSummary {
  const headline = cases.filter(isHeadline);
  const pending = cases.filter((c) => c.label.status === "human_review_pending");
  const questions = new Map<string, { cases: number; reason: string }>();
  for (const item of pending) {
    const key = item.label.cluster ?? item.caseId;
    const entry = questions.get(key) ?? { cases: 0, reason: item.label.reviewReason ?? "" };
    entry.cases += 1;
    questions.set(key, entry);
  }
  const positive = (c: EvalCase) => isPositive(c.label.expected!);
  const independent = (c: EvalCase) => c.label.status === "independent_confirmed";
  return {
    total: cases.length,
    bySet: tally(cases.flatMap((c) => c.sets), (s) => s),
    byStatus: tally(cases, (c) => c.label.status),
    byExpected: tally(cases, (c) => c.label.expected ?? "null"),
    bySource: tally(cases, (c) => c.candidate.sourceName),
    byDomain: tally(cases, (c) => c.group),
    byRule: tally(cases.filter((c) => c.label.rule), (c) => c.label.rule!),
    headline: {
      cases: headline.length,
      positives: headline.filter(positive).length,
      negatives: headline.filter((c) => !positive(c)).length,
      independentPositives: headline.filter((c) => independent(c) && positive(c)).length,
      independentNegatives: headline.filter((c) => independent(c) && !positive(c)).length,
      provisionalPositives: headline.filter((c) => !independent(c) && positive(c)).length,
      provisionalNegatives: headline.filter((c) => !independent(c) && !positive(c)).length,
    },
    humanReview: {
      cases: pending.length,
      questions: [...questions.entries()].map(([family, v]) => ({ family, ...v })).sort((a, b) => a.family.localeCompare(b.family)),
    },
    insufficientEvidence: cases.filter((c) => c.label.status === "insufficient_evidence").length,
    humanConfirmed: cases.filter((c) => c.label.verifier === "human").length,
  };
}

export type Disagreement = {
  caseId: string;
  kind: "production_miss" | "production_overcall";
  label: Importance;
  production: Importance;
  status: LabelStatus;
  rule: string | null;
};

/** Where production's stored decision and the label disagree on post / no_post (headline cases with a label only). */
export function productionDisagreements(cases: readonly EvalCase[]): Disagreement[] {
  const out: Disagreement[] = [];
  for (const item of cases.filter(isHeadline)) {
    const label = item.label.expected!;
    const production = item.recorded.judgement.importance;
    if (isPositive(label) === isPositive(production)) continue;
    out.push({
      caseId: item.caseId,
      kind: isPositive(label) ? "production_miss" : "production_overcall",
      label,
      production,
      status: item.label.status,
      rule: item.label.rule,
    });
  }
  return out.sort((a, b) => a.caseId.localeCompare(b.caseId));
}

export type Confusion = { tp: number; fn: number; fp: number; tn: number };

export type Estimate = {
  /** Labelled sample members that count (headline, label not null). */
  used: number;
  /** Sample members that could not be used (pending / insufficient). */
  nonResponse: number;
  unweighted: Confusion;
  /** Each member weighted by stratumN / sampled-in-stratum, so strata add up to the population. */
  weighted: Confusion;
  recall: number | null;
  precision: number | null;
  /** 95% one-sided upper bound on the miss rate from the unweighted positives; null with no positives. */
  missRateUpperBound95: number | null;
  populationSize: number;
};

/** Production's own decisions scored against the labels of the representative sample. */
export function estimateProductionOnSample(cases: readonly EvalCase[]): Estimate {
  const sample = cases.filter((c) => c.sets.includes("sample") && c.sampling);
  const usable = sample.filter(isHeadline);
  const sampledPerStratum = tally(sample, (c) => c.sampling!.stratum);
  const unweighted: Confusion = { tp: 0, fn: 0, fp: 0, tn: 0 };
  const weighted: Confusion = { tp: 0, fn: 0, fp: 0, tn: 0 };
  for (const item of usable) {
    const truth = isPositive(item.label.expected!);
    const said = isPositive(item.recorded.judgement.importance);
    const weight = item.sampling!.stratumN / sampledPerStratum[item.sampling!.stratum];
    const cell = truth ? (said ? "tp" : "fn") : (said ? "fp" : "tn");
    unweighted[cell] += 1;
    weighted[cell] += weight;
  }
  const strata = new Map<string, number>();
  for (const item of sample) strata.set(item.sampling!.stratum, item.sampling!.stratumN);
  const ratio = (a: number, b: number) => (a + b === 0 ? null : Math.round((a / (a + b)) * 1000) / 1000);
  const positives = unweighted.tp + unweighted.fn;
  return {
    used: usable.length,
    nonResponse: sample.length - usable.length,
    unweighted,
    weighted: Object.fromEntries(Object.entries(weighted).map(([k, v]) => [k, Math.round(v * 10) / 10])) as Confusion,
    recall: ratio(weighted.tp, weighted.fn),
    precision: ratio(weighted.tp, weighted.fp),
    missRateUpperBound95: positives === 0 ? null : missRateUpperBound95(positives, unweighted.fn),
    populationSize: [...strata.values()].reduce((a, b) => a + b, 0),
  };
}
