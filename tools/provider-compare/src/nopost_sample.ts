// The Phase 4 no_post-layer sample: what production's no_post decisions miss.
//
// Frame: AI-judged candidates whose final importance was no_post, in a fixed window, minus every case already in the
// evaluation set. Two layers: gate_suppressed (the pipeline forced no_post because the model asked for review) and the
// rest. Inside a layer the allocation is proportional with a minimum of one row per cell, so inclusion probabilities are
// nearly equal; the exact design weight (cell N / cell sampled) travels with every row.
//
// What this can say: an upper bound on the share of no_post items a labeller judged important, with the labeller's status
// attached. What it cannot say: the application's Recall (that needs the posted side too), the miss rate of items production
// never ingested, or anything about the true miss rate if the labels are AI-only.
import type { Importance } from "./fixtures.ts";
import type { LabelRecord } from "./eval_set.ts";

export type NopostCase = {
  caseId: string;
  candidateId: string;
  sourceName: string;
  sourceUrl: string;
  title: string;
  companyName: string | null;
  companyCode: string | null;
  category: string;
  publishedAt: string;
  bodyStored: boolean;
  bodySummary: string | null;
  bodyCharsOriginal: number;
  bodySha256: string;
  layer: "gate_suppressed" | "not_gated";
  cell: { n: number; sampled: number; rank: number };
  recorded: { importance: Importance; model: string; confidence: number; escalatedToSol: boolean; reason: string; coverageSeverity: string | null };
  label: LabelRecord & { suspected: boolean };
};

export type NopostSampleFile = {
  version: 3;
  exportedAt: string;
  population: {
    window: string;
    definition: string;
    seed: string;
    excludedCases: number;
    layers: Record<"gate_suppressed" | "not_gated", { n: number; sampled: number }>;
    cells: Array<{ layer: string; source: string; n: number; sampled: number }>;
  };
  codeVersions: Array<{ label: string; ref: string; files: Record<string, string> }>;
  cases: NopostCase[];
};

export type BlindView = {
  caseId: string;
  sourceName: string;
  sourceUrl: string;
  title: string;
  category: string;
  publishedAt: string;
  companyName: string | null;
  body: string | null;
};

/**
 * What a labeller (human or model) is shown. Production's importance, confidence, reason, gate state and status are not part
 * of it, so a label cannot be anchored on the decision it will later be compared with.
 */
export function blindView(item: NopostCase, body: string | null = item.bodySummary): BlindView {
  return {
    caseId: item.caseId,
    sourceName: item.sourceName,
    sourceUrl: item.sourceUrl,
    title: item.title,
    category: item.category,
    publishedAt: item.publishedAt,
    companyName: item.companyName,
    body,
  };
}

/** One-sided Clopper-Pearson upper bound at confidence 1 - alpha for k events in n trials (exact binomial). */
export function clopperPearsonUpper(n: number, k: number, alpha = 0.05): number | null {
  if (n <= 0 || k < 0 || k > n) return null;
  if (k === n) return 1;
  if (k === 0) return 1 - Math.pow(alpha, 1 / n);
  // P(X <= k | p) = alpha, solved by bisection; the CDF decreases in p.
  const cdf = (p: number) => {
    let sum = 0;
    let term = Math.pow(1 - p, n);
    for (let i = 0; i <= k; i += 1) {
      sum += term;
      term = (term * (n - i) * p) / ((i + 1) * (1 - p));
    }
    return sum;
  };
  let lo = k / n;
  let hi = 1 - 1e-12;
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) > alpha) lo = mid; else hi = mid;
  }
  return hi;
}

const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

export type LayerEstimate = {
  layer: string;
  frame: number;
  sampled: number;
  /** Labelled important / most_important. */
  misses: number;
  independentMisses: number;
  /** Not decidable (pending a policy answer, or the stored text lacks the decisive fact). */
  undetermined: number;
  /** Design-weighted share of the layer that is a miss (undetermined counted as not a miss). */
  missShare: number;
  /** Exact upper bounds at the per-layer level (see overall.alphaPerLayer), undetermined counted as not a miss / as misses. */
  upperBoundOptimistic: number | null;
  upperBoundConservative: number | null;
};

export type NopostEstimate = {
  sampled: number;
  frame: number;
  layers: LayerEstimate[];
  overall: {
    /** Each layer bound is taken at 1 - alpha/2 so that the sum of the two bounds holds jointly at 95%. */
    alphaPerLayer: number;
    estimatedMisses: number;
    upperBoundMissesOptimistic: number | null;
    upperBoundMissesConservative: number | null;
    upperBoundShareOptimistic: number | null;
    upperBoundShareConservative: number | null;
  };
};

const isMiss = (c: NopostCase) => c.label.expected === "important" || c.label.expected === "most_important";
const isUndetermined = (c: NopostCase) => c.label.expected === null;

export function estimateNopostMissRate(cases: readonly NopostCase[]): NopostEstimate {
  const alpha = 0.05 / 2;
  const names = ["gate_suppressed", "not_gated"] as const;
  const layers: LayerEstimate[] = names.map((layer) => {
    const inLayer = cases.filter((c) => c.layer === layer);
    const cells = new Map<string, NopostCase>();
    for (const c of inLayer) cells.set(c.sourceName, c);
    const frame = [...cells.values()].reduce((sum, c) => sum + c.cell.n, 0);
    const misses = inLayer.filter(isMiss);
    const undetermined = inLayer.filter(isUndetermined).length;
    const weightedMisses = misses.reduce((sum, c) => sum + c.cell.n / c.cell.sampled, 0);
    const optimistic = inLayer.length === 0 ? null : clopperPearsonUpper(inLayer.length, misses.length, alpha);
    const conservative = inLayer.length === 0 ? null : clopperPearsonUpper(inLayer.length, misses.length + undetermined, alpha);
    return {
      layer,
      frame,
      sampled: inLayer.length,
      misses: misses.length,
      independentMisses: misses.filter((c) => c.label.status === "independent_confirmed").length,
      undetermined,
      missShare: frame === 0 ? 0 : round(weightedMisses / frame),
      upperBoundOptimistic: optimistic === null ? null : round(optimistic),
      upperBoundConservative: conservative === null ? null : round(conservative),
    };
  });
  const frame = layers.reduce((sum, l) => sum + l.frame, 0);
  const estimatedMisses = layers.reduce((sum, l) => sum + l.missShare * l.frame, 0);
  const sum = (pick: (l: LayerEstimate) => number | null) =>
    layers.every((l) => pick(l) !== null) ? layers.reduce((s, l) => s + pick(l)! * l.frame, 0) : null;
  const optimistic = sum((l) => l.upperBoundOptimistic);
  const conservative = sum((l) => l.upperBoundConservative);
  return {
    sampled: cases.length,
    frame,
    layers,
    overall: {
      alphaPerLayer: alpha,
      estimatedMisses: round(estimatedMisses, 1),
      upperBoundMissesOptimistic: optimistic === null ? null : round(optimistic, 1),
      upperBoundMissesConservative: conservative === null ? null : round(conservative, 1),
      upperBoundShareOptimistic: optimistic === null || frame === 0 ? null : round(optimistic / frame),
      upperBoundShareConservative: conservative === null || frame === 0 ? null : round(conservative / frame),
    },
  };
}

/**
 * Re-attaches bodies that are deliberately not stored in the repository. `rows` is the local, uncommitted export of the
 * same candidates (candidate id -> body_summary). A body whose SHA-256 differs from the stored one is rejected: it means
 * production changed the row since the case was built.
 */
export async function attachBodies<T extends { candidateId: string | null; candidate: { bodySummary: string | null; bodySha256?: string; bodyStored?: boolean } }>(
  cases: readonly T[],
  rows: ReadonlyMap<string, string | null>,
): Promise<{ cases: T[]; attached: number; missing: string[]; changed: string[] }> {
  const out: T[] = [];
  const missing: string[] = [];
  const changed: string[] = [];
  let attached = 0;
  for (const item of cases) {
    if (item.candidate.bodyStored !== false || item.candidateId === null) {
      out.push(item);
      continue;
    }
    const body = rows.get(item.candidateId);
    if (body === undefined) {
      missing.push(item.candidateId);
      out.push(item);
      continue;
    }
    const digest = await sha256(body ?? "");
    if (digest !== item.candidate.bodySha256) {
      changed.push(item.candidateId);
      out.push(item);
      continue;
    }
    attached += 1;
    out.push({ ...item, candidate: { ...item.candidate, bodySummary: body } });
  }
  return { cases: out, attached, missing, changed };
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
