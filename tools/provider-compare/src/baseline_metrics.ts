// Fixed metric definitions and an offline baseline for the news pipeline's cost and delivery, built only from committed
// artefacts (the Phase 5 report and the OpenAI ledger snapshot). Nothing here reads production.
//
// The point of fixing the definitions is that two numbers with different denominators are never compared:
//   - the delivery-failure rate has ONE denominator: candidates judged important or above;
//   - "all judged" (which includes no_post) is a different quantity and is reported under its own name;
//   - a window is always named, so a 30-day figure is not read as the current rate.
import type { LedgerSnapshot } from "./ledger_snapshot.ts";

export type ImportantPlusRow = { importance: "important" | "most_important"; status: string };

export const METRIC_DEFINITIONS = {
  deliveryFailureRate: {
    id: "delivery_failure_rate_v1",
    numerator: "status = generation_failed",
    denominator: "candidates judged important or most_important (no_post is never in the denominator)",
    notThis: ["failed / all judged candidates (that is `failureShareOfAllJudged`)", "the 30-day figure used as the current rate"],
  },
  failureShareOfAllJudged: {
    id: "failure_share_of_all_judged_v1",
    numerator: "status = generation_failed",
    denominator: "every AI-judged candidate, no_post included",
    notThis: ["a delivery-failure rate"],
  },
  gateShareOfNoPost: {
    id: "gate_share_of_no_post_v1",
    numerator: "no_post decisions that carry the information-sufficiency gate sentence",
    denominator: "all AI-judged no_post decisions of the window",
    notThis: ["the share of important news the gate hid (pre-gate importance is not stored)"],
  },
  noPostMissShare: {
    id: "no_post_miss_share_v1",
    numerator: "sampled no_post cases labelled important or most_important",
    denominator: "the no_post sampling frame, weighted by the design weights, two layers (gate / not gated)",
    notThis: ["the application's recall", "anything about items production never ingested"],
  },
  eventReach: {
    id: "event_reach_v1",
    numerator: "events with at least one candidate reaching the channel",
    denominator: "events among candidates judged important or above (approximate grouping)",
    notThis: ["the number of users who saw the news"],
  },
} as const;

/** The delivery-failure rate. Refuses a row that is not important or above, so no_post can never enter the denominator. */
export function deliveryFailureRate(rows: ReadonlyArray<{ importance: string; status: string }>): {
  failed: number;
  denominator: number;
  rate: number | null;
} {
  let failed = 0;
  for (const row of rows) {
    if (row.importance !== "important" && row.importance !== "most_important") {
      throw new Error(`DENOMINATOR_INCLUDES_NO_POST:${row.importance}`);
    }
    if (row.status === "generation_failed") failed += 1;
  }
  return {
    failed,
    denominator: rows.length,
    rate: rows.length === 0 ? null : Math.round((failed / rows.length) * 1000) / 1000,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Offline baseline from the committed Phase 5 report.

type Phase5 = {
  window: string;
  gate: {
    outcomes: Record<string, number>;
    noPost: number;
    solEscalated: number;
    gateShareOfSolEscalated: number | null;
    gatedReasonWording: { total: number; material: number; mixed: number };
  };
  generation: {
    failed: number;
    byPrimaryCause: Record<string, number>;
    byStage: Record<string, number>;
    byPeriod: Record<string, Record<string, number>>;
    pr116Outlook: Record<string, number>;
    pr116OutlookByPeriod: Record<string, Record<string, number>>;
  };
  failureRates: Array<{ name: string; window: string; numerator: number; denominator: number; rate: number | null }>;
  channels: {
    importantPlusAll: ChannelBlock;
    importantPlusLast7Days: ChannelBlock;
    importantPlusFailedOnX: ChannelBlock;
  };
};

type ChannelBlock = {
  candidates: number;
  events: number;
  x: { candidates: number; events: number };
  appListed: { candidates: number; events: number };
  appText: { candidates: number; events: number };
  pushable: { candidates: number; events: number };
  notified: { candidates: number; events: number };
  none: { candidates: number; events: number };
};

export type StageFunnel = {
  window: string;
  judged: number;
  stoppedBefore: {
    /** no_post by the model itself (Fact passed). */
    judgementModelNoPost: number;
    /** no_post forced by the information-sufficiency gate. */
    judgementGate: number;
  };
  importantPlus: number;
  stoppedAtGeneration: { fact: number; voice: number; local: number; api: number };
  reachedX: number;
  /** important-or-above candidates that are neither on X nor failed (waiting rows). */
  other: number;
};

export function stageFunnel(report: Phase5): StageFunnel {
  const importantPlus = report.channels.importantPlusAll.candidates;
  const stage = report.generation.byStage;
  const failed = report.generation.failed;
  const reachedX = report.channels.importantPlusAll.x.candidates;
  return {
    window: report.window,
    judged: report.gate.noPost + importantPlus,
    stoppedBefore: {
      judgementModelNoPost: (report.gate.outcomes["model_no_post"] ?? 0),
      judgementGate: (report.gate.outcomes["gate_after_sol"] ?? 0) + (report.gate.outcomes["gate_sol_required_not_run"] ?? 0),
    },
    importantPlus,
    stoppedAtGeneration: { fact: stage["fact"] ?? 0, voice: stage["voice"] ?? 0, local: stage["local"] ?? 0, api: stage["api"] ?? 0 },
    reachedX,
    other: importantPlus - reachedX - failed,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Cost: ledger averages x Phase 5 counts. Estimates only: the ledger is tokens x ledger rates, not an invoice.

export type CostBaseline = {
  basis: string;
  windowDays: number;
  perFeature: Record<string, { calls: number; usd: number; usdPer30Days: number }>;
  newsPipelineUsdPer30Days: number;
  attributable: {
    /** At the counts of the 30-day window (older, lower volume): Sol + Luna on candidates the gate forced to no_post. */
    gateAfterSolUsd: number;
    /** Same window: Draft + Fact (+ Voice where it ran) on candidates that ended generation_failed. */
    failedGenerationUsd: number;
    /** At the CURRENT ledger volume: the gate's share of Sol calls (30 days) times the Sol cost per 30 days. */
    gateAfterSolUsdPer30DaysAtCurrentVolume: number | null;
    /** At the current ledger volume: the 7-day failure rate times the generation cost per 30 days. */
    failedGenerationUsdPer30DaysAtCurrentVolume: number | null;
  };
  note: string;
};

export function costBaseline(ledger: LedgerSnapshot, report: Phase5): CostBaseline {
  const days = ledger.window.days;
  const perFeature: CostBaseline["perFeature"] = {};
  let total = 0;
  for (const [name, feature] of Object.entries(ledger.features)) {
    perFeature[name] = {
      calls: feature.calls,
      usd: feature.totalUsd,
      usdPer30Days: Math.round((feature.totalUsd * 30) / days * 100) / 100,
    };
    total += feature.totalUsd;
  }
  const f = ledger.features;
  const gated = report.gate.outcomes["gate_after_sol"] ?? 0;
  const gateUsd = gated * ((f["judgement_sol"]?.avgUsd ?? 0) + (f["judgement_luna"]?.avgUsd ?? 0));
  const failed = report.generation.failed;
  const voiceStage = report.generation.byStage["voice"] ?? 0;
  const failedUsd = failed * ((f["generation_draft"]?.avgUsd ?? 0) + (f["generation_fact"]?.avgUsd ?? 0)) +
    voiceStage * (f["generation_voice"]?.avgUsd ?? 0);
  const round2 = (v: number) => Math.round(v * 100) / 100;
  const solShare = report.gate.gateShareOfSolEscalated;
  const failure7 = report.failureRates.find((r) => r.name.startsWith("F "))?.rate ?? null;
  const generation30 = ["generation_draft", "generation_fact", "generation_fact_retry", "generation_voice", "generation_voice_retry"]
    .reduce((sum, name) => sum + (perFeature[name]?.usdPer30Days ?? 0), 0);
  return {
    basis: `ledger snapshot ${ledger.window.fromJst}..${ledger.window.toJst} (${days} days) x Phase 5 counts (${report.window})`,
    windowDays: days,
    perFeature,
    newsPipelineUsdPer30Days: round2((total * 30) / days),
    attributable: {
      gateAfterSolUsd: round2(gateUsd),
      failedGenerationUsd: round2(failedUsd),
      gateAfterSolUsdPer30DaysAtCurrentVolume: solShare === null ? null : round2(solShare * (perFeature["judgement_sol"]?.usdPer30Days ?? 0)),
      failedGenerationUsdPer30DaysAtCurrentVolume: failure7 === null ? null : round2(failure7 * generation30),
    },
    note:
      "Estimates, not an invoice. The ledger window (3.7 days) is the current, higher-volume regime; the Phase 5 counts cover 30 days of an older one, so both views are given. Task-average cost per call; retries are only what the average already contains.",
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Planning a before / after comparison.

/** Sample size per group to detect a change from p1 to p2 with a two-sided test (normal approximation). */
export function sampleSizePerGroup(p1: number, p2: number, alpha = 0.05, power = 0.8): number {
  const z = (p: number) => {
    // Acklam-free: the two quantiles needed are fixed constants for the usual settings.
    const table: Record<string, number> = { "0.975": 1.959964, "0.95": 1.644854, "0.8": 0.841621, "0.9": 1.281552 };
    const key = String(p);
    if (!(key in table)) throw new Error(`UNSUPPORTED_QUANTILE:${p}`);
    return table[key];
  };
  const zAlpha = z(1 - alpha / 2);
  const zBeta = z(power);
  const pBar = (p1 + p2) / 2;
  const delta = Math.abs(p1 - p2);
  if (delta === 0) throw new Error("NO_EFFECT_TO_DETECT");
  const n = (2 * Math.pow(zAlpha + zBeta, 2) * pBar * (1 - pBar)) / (delta * delta);
  return Math.ceil(n);
}

export function runBaseline(ledger: LedgerSnapshot, report: Phase5) {
  const last7 = report.failureRates.find((r) => r.name.startsWith("F "))!;
  const all30 = report.failureRates.find((r) => r.name.startsWith("A "))!;
  const week = report.channels.importantPlusLast7Days;
  return {
    definitions: METRIC_DEFINITIONS,
    funnel: stageFunnel(report),
    deliveryFailure: {
      last30Days: { rate: all30.rate, numerator: all30.numerator, denominator: all30.denominator, window: all30.window },
      last7Days: { rate: last7.rate, numerator: last7.numerator, denominator: last7.denominator, window: last7.window },
      note: "The 30-day figure is front-loaded by failures that were later fixed; the 7-day figure is the current reference.",
    },
    reach: { last7Days: week, all30Days: report.channels.importantPlusAll },
    cost: costBaseline(ledger, report),
    pr116: {
      observed: false,
      expectedAmongLast7DayFailures: report.generation.pr116OutlookByPeriod["C 10-03..10-09"] ?? {},
      expectedAmong30DayFailures: report.generation.pr116Outlook,
      note: "PR #116 was merged after the window; its effect has not been observed. The counts are a reading of what it changes, not a measurement.",
    },
    comparisonPlan: {
      beforeWindow: last7.window,
      beforeRate: last7.rate,
      // Detecting a fall from the recent rate to a target is sized per group of important-or-above candidates.
      perGroupToDetect: [0.15, 0.1].map((target) => ({
        from: last7.rate,
        to: target,
        candidatesPerGroup: sampleSizePerGroup(last7.rate ?? 0, target),
        weeksAtLast7DayVolume: Math.ceil(sampleSizePerGroup(last7.rate ?? 0, target) / (week.candidates || 1)),
      })),
    },
  };
}
