export type MarketMacroProviderRunDiagnostic = {
  sourceKey: string;
  providerStatus: "succeeded" | "failed";
  candidateCount: number;
  failureCode: string | null;
};

export type BreakingMarketQueryRunDiagnostic = {
  queryKey: string;
  providerStatus: "succeeded" | "failed";
  rawCandidateCount: number;
  validatedCandidateCount: number;
  rejectionCounts: Record<string, number>;
  failureCode: string | null;
  webSearchCallCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
};

/**
 * JP official lane counters of one run (J1-a). Counters only: no ids, urls, titles, bodies or error text. `skipped` /
 * `drops` are reason -> count maps whose keys come from a fixed vocabulary in the lane code; anything that does not look
 * like such a key is folded into "other" and the number of keys is bounded, so a bad reason string can neither leak nor
 * grow the stored JSON.
 */
export type JpOfficialRunDiagnostic = {
  enabled: boolean;
  signalsRead: number;
  selected: number;
  alreadyKnown: number;
  inserted: number;
  deferred: number;
  enrichedPages: number;
  skipped: Record<string, number>;
  drops: Record<string, number>;
};

const MAX_REASON_KEYS = 40;
const REASON_KEY = /^[a-z0-9_]{1,64}$/u;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.trunc(value), 1_000_000) : 0;
}

function reasonCounts(input: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof input !== "object" || input === null) return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const safe = REASON_KEY.test(key) ? key : "other";
    if (!(safe in out) && Object.keys(out).length >= MAX_REASON_KEYS) {
      out.other = (out.other ?? 0) + count(value);
      continue;
    }
    out[safe] = (out[safe] ?? 0) + count(value);
  }
  return out;
}

export function jpOfficialRunDiagnostics(input: JpOfficialRunDiagnostic) {
  return {
    enabled: input.enabled === true,
    signalsRead: count(input.signalsRead),
    selected: count(input.selected),
    alreadyKnown: count(input.alreadyKnown),
    inserted: count(input.inserted),
    deferred: count(input.deferred),
    enrichedPages: count(input.enrichedPages),
    skipped: reasonCounts(input.skipped),
    drops: reasonCounts(input.drops),
  };
}

const n = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Bounded, secret-free per-run diagnostics; zeroes remain queryable across runs to derive consecutive streaks. */
export type HeadlineTriggerRunDiagnostic = {
  /** The lane's own record (feeds, counts, triaged items); also the next runs' dedupe history. */
  lane: unknown;
  triage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number } | null;
  verify: Array<{ webSearchCallCount?: number; inputTokens?: number; outputTokens?: number; estimatedCostUsd?: number }>;
};

export function buildCollectionRunDiagnostics(input: {
  marketMacroProviders: MarketMacroProviderRunDiagnostic[];
  breakingMarketQueries: BreakingMarketQueryRunDiagnostic[];
  headlineTrigger?: HeadlineTriggerRunDiagnostic;
  /** Additive (J1-a): omitted when not supplied, so existing readers and tests are unaffected. */
  jpOfficial?: JpOfficialRunDiagnostic;
}) {
  const marketMacroProviders = input.marketMacroProviders.map((item) => ({ ...item }));
  const breakingMarketQueries = input.breakingMarketQueries.map((item) => ({
    ...item,
    rejectionCounts: { ...item.rejectionCounts },
  }));
  const cost = {
    breakingMarket: {
      queries: breakingMarketQueries.length,
      webSearchCalls: breakingMarketQueries.reduce((sum, item) => sum + n(item.webSearchCallCount), 0),
      inputTokens: breakingMarketQueries.reduce((sum, item) => sum + n(item.inputTokens), 0),
      outputTokens: breakingMarketQueries.reduce((sum, item) => sum + n(item.outputTokens), 0),
      estimatedCostUsd: Number(
        breakingMarketQueries.reduce((sum, item) => sum + n(item.estimatedCostUsd), 0).toFixed(6),
      ),
    },
  };
  const trigger = input.headlineTrigger;
  const headlineTriggerCost = trigger
    ? {
      triageCalls: trigger.triage ? 1 : 0,
      verifySearches: trigger.verify.length,
      webSearchCalls: trigger.verify.reduce((sum, item) => sum + n(item.webSearchCallCount), 0),
      inputTokens: n(trigger.triage?.inputTokens) + trigger.verify.reduce((sum, item) => sum + n(item.inputTokens), 0),
      outputTokens: n(trigger.triage?.outputTokens) + trigger.verify.reduce((sum, item) => sum + n(item.outputTokens), 0),
      estimatedCostUsd: Number((n(trigger.triage?.estimatedCostUsd) +
        trigger.verify.reduce((sum, item) => sum + n(item.estimatedCostUsd), 0)).toFixed(6)),
    }
    : null;
  return {
    version: 1,
    // Additive (cost optimisation Phase 0); readers of version 1 keep working.
    cost: headlineTriggerCost ? { ...cost, headlineTrigger: headlineTriggerCost } : cost,
    ...(trigger ? { triggerLane: trigger.lane } : {}),
    ...(input.jpOfficial ? { jpOfficial: jpOfficialRunDiagnostics(input.jpOfficial) } : {}),
    marketMacro: {
      providers: marketMacroProviders,
      zeroResultCount: marketMacroProviders.filter((item) =>
        item.providerStatus === "succeeded" && item.candidateCount === 0
      ).length,
    },
    breakingMarket: {
      queries: breakingMarketQueries,
      zeroResultCount: breakingMarketQueries.filter((item) =>
        item.providerStatus === "succeeded" && item.rawCandidateCount === 0
      ).length,
    },
  };
}
