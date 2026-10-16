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
 * grow the stored JSON. Counts saturate at 1,000,000.
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
const COUNT_CAP = 1_000_000;
const REASON_KEY = /^[a-z0-9_]{1,64}$/u;
const OVERFLOW_KEY = "other";

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.trunc(value), COUNT_CAP) : 0;
}

/**
 * reason -> count, at most MAX_REASON_KEYS keys INCLUDING the overflow key "other". Keys that do not look like a reason
 * (and a literal "other") are folded into "other". When more than 40 valid keys exist, the 39 with the largest counts are
 * kept (ties by key, so the result does not depend on input order) and the rest are folded into "other". Every sum
 * saturates at COUNT_CAP: a saturated count means "at least this many", never a wrapped or larger number.
 */
function reasonCounts(input: unknown): Record<string, number> {
  if (typeof input !== "object" || input === null) return {};
  const valid = new Map<string, number>();
  let overflow = 0;
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const value = count(raw);
    if (REASON_KEY.test(key) && key !== OVERFLOW_KEY) valid.set(key, Math.min(COUNT_CAP, (valid.get(key) ?? 0) + value));
    else overflow = Math.min(COUNT_CAP, overflow + value);
  }
  const ranked = [...valid.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const keepAll = overflow === 0 && ranked.length <= MAX_REASON_KEYS;
  const kept = keepAll ? ranked : ranked.slice(0, MAX_REASON_KEYS - 1);
  if (!keepAll) {
    for (const [, value] of ranked.slice(MAX_REASON_KEYS - 1)) overflow = Math.min(COUNT_CAP, overflow + value);
  }
  const out: Record<string, number> = {};
  for (const [key, value] of kept) out[key] = value;
  if (overflow > 0) out[OVERFLOW_KEY] = overflow;
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
