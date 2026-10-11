import type { UsageRecord } from "./types.ts";

// Design for sharing one Claude credit pool between several apps (Kabumori now, POSTONA later). Pure functions over
// UsageRecord rows; no database. A later, separately reviewed change can persist these dimensions (today the ledger,
// public.ai_usage_events, has feature/model/cost columns only, and is written by the important-news Function alone).
//
// Credit rules implemented here come from the Anthropic docs (retrieved 2026-10-09): the monthly credit is one balance
// for the whole organization, it expires at the end of the billing cycle with no rollover, and every key and workspace
// in the organization draws from the same balance. The harness therefore splits a month's credit across apps in
// proportion to spend; the real enforcement (per-workspace spend limits) happens in the Console, not here.

export type Dimension = "provider" | "app" | "feature" | "model" | "month";

export type Totals = { calls: number; inputTokens: number; outputTokens: number; webSearchRequests: number; costUsd: number };

const EMPTY: Totals = { calls: 0, inputTokens: 0, outputTokens: 0, webSearchRequests: 0, costUsd: 0 };

function add(total: Totals, record: UsageRecord): Totals {
  return {
    calls: total.calls + 1,
    inputTokens: total.inputTokens + record.usage.inputTokens + record.usage.cacheReadTokens + record.usage.cacheWriteTokens,
    outputTokens: total.outputTokens + record.usage.outputTokens,
    webSearchRequests: total.webSearchRequests + record.usage.webSearchRequests,
    costUsd: total.costUsd + record.costUsd,
  };
}

/** Totals grouped by the chosen dimensions, keys joined with "/" in the given order, sorted for stable output. */
export function aggregate(records: readonly UsageRecord[], by: readonly Dimension[]): Map<string, Totals> {
  const groups = new Map<string, Totals>();
  for (const record of records) {
    const key = by.map((dimension) => record[dimension]).join("/");
    groups.set(key, add(groups.get(key) ?? EMPTY, record));
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, total]) => [
    key,
    { ...total, costUsd: Math.round(total.costUsd * 1e6) / 1e6 },
  ]));
}

export type CreditAllocation = {
  month: string;
  claudeSpendUsd: number;
  creditUsd: number;
  coveredByCreditUsd: number;
  selfPayUsd: number;
  /** Unused credit that expires at the end of the cycle (no rollover). */
  expiredCreditUsd: number;
  byApp: Record<string, { spendUsd: number; coveredByCreditUsd: number; selfPayUsd: number }>;
};

/** Applies a monthly credit to that month's Anthropic spend only; OpenAI spend is never covered by it. */
export function allocateMonthlyCredit(records: readonly UsageRecord[], month: string, creditUsd: number): CreditAllocation {
  const credit = Math.max(0, creditUsd);
  const claude = records.filter((record) => record.provider === "anthropic" && record.month === month);
  const spend = claude.reduce((total, record) => total + record.costUsd, 0);
  const covered = Math.min(spend, credit);
  const perApp = new Map<string, number>();
  for (const record of claude) perApp.set(record.app, (perApp.get(record.app) ?? 0) + record.costUsd);
  const byApp: CreditAllocation["byApp"] = {};
  for (const [app, appSpend] of [...perApp.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const share = spend > 0 ? appSpend / spend : 0;
    byApp[app] = {
      spendUsd: Math.round(appSpend * 1e6) / 1e6,
      coveredByCreditUsd: Math.round(covered * share * 1e6) / 1e6,
      selfPayUsd: Math.round((appSpend - covered * share) * 1e6) / 1e6,
    };
  }
  return {
    month,
    claudeSpendUsd: Math.round(spend * 1e6) / 1e6,
    creditUsd: credit,
    coveredByCreditUsd: Math.round(covered * 1e6) / 1e6,
    selfPayUsd: Math.round((spend - covered) * 1e6) / 1e6,
    expiredCreditUsd: Math.round((credit - covered) * 1e6) / 1e6,
    byApp,
  };
}
