// Future hook: NewsSignal -> ticker_candidates -> tracked_stocks -> "news for my holdings".
//
// NOT wired to any user data in N2. Pure function over data the caller supplies, so a later task
// can feed it tracked_stocks rows without changing the matching logic. The fan-out cost is a join
// (no per-stock search, no AI).
import type { NewsSignal } from "./types.ts";

export type TrackedStockRow = { user_id: string; ticker_code: string };

export type HoldingNewsCandidate = {
  user_id: string;
  ticker: string;
  signal_id: string;
  match_status: "confirmed" | "candidate";
  score: number;
  discovery_only: boolean;
};

export function holdingNewsCandidates(
  signals: readonly NewsSignal[],
  tracked: readonly TrackedStockRow[],
  options: { includeUnconfirmed?: boolean; includeDiscoveryOnly?: boolean } = {},
): HoldingNewsCandidate[] {
  const usersByTicker = new Map<string, string[]>();
  for (const row of tracked) {
    const users = usersByTicker.get(row.ticker_code) ?? [];
    users.push(row.user_id);
    usersByTicker.set(row.ticker_code, users);
  }
  const out: HoldingNewsCandidate[] = [];
  for (const signal of signals) {
    // Discovery-only signals are leads for verification, never user-facing news by themselves.
    if (signal.discovery_only && !options.includeDiscoveryOnly) continue;
    for (const candidate of signal.ticker_candidates) {
      if (candidate.status !== "confirmed" && !options.includeUnconfirmed) continue;
      for (const userId of usersByTicker.get(candidate.ticker) ?? []) {
        out.push({
          user_id: userId,
          ticker: candidate.ticker,
          signal_id: signal.id,
          match_status: candidate.status,
          score: candidate.score,
          discovery_only: signal.discovery_only,
        });
      }
    }
  }
  return out;
}
