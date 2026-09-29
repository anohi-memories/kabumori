// One wall-clock deadline per observer invocation. Every number that bounds how long a run may
// keep starting work lives here (not scattered across fetcher / search / handler).
//
// Supabase Edge Functions (https://supabase.com/docs/guides/functions/limits, checked 2026-09-28):
//   request idle timeout 150 s (no response by then -> 504), wall clock 150 s (Free) / 400 s (paid),
//   CPU 2 s per request. The observer answers only at the end of the run, so the whole run must fit
//   well inside 150 s regardless of plan:
//   - invocation budget 120 s: 30 s margin for cold start, alias build and the response itself;
//   - finalization reserve 25 s: never start new fetch/search work inside it, so the remaining time
//     always covers persisting signals, completing search rows and finish_run (RPC timeout 20 s);
//   - a Web Search starts only with >= 20 s usable (its own timeout is capped to what is usable);
//     a follow-up (escalation) search, the lowest priority, needs >= 40 s usable.

export type DeadlineConfig = {
  invocation_budget_ms: number;
  finalization_reserve_ms: number;
  min_fetch_usable_ms: number;
  min_search_usable_ms: number;
  min_followup_usable_ms: number;
};

export const OBSERVER_DEADLINE: DeadlineConfig = {
  invocation_budget_ms: 120_000,
  finalization_reserve_ms: 25_000,
  min_fetch_usable_ms: 3_000,
  min_search_usable_ms: 20_000,
  min_followup_usable_ms: 40_000,
};

export type DeadlineStats = {
  deadline_ms: number;
  deadline_reached: boolean;
  sources_completed: number;
  sources_skipped: number;
  searches_completed: number;
  searches_skipped: number;
};

export class RunDeadline {
  readonly stats: DeadlineStats;
  private readonly endsAt: number;

  constructor(
    private readonly startedAt: number,
    private readonly config: DeadlineConfig = OBSERVER_DEADLINE,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.endsAt = startedAt + config.invocation_budget_ms;
    this.stats = {
      deadline_ms: config.invocation_budget_ms,
      deadline_reached: false,
      sources_completed: 0,
      sources_skipped: 0,
      searches_completed: 0,
      searches_skipped: 0,
    };
  }

  elapsedMs(): number {
    return this.clock() - this.startedAt;
  }

  /** Time left for NEW work: the finalization reserve is never handed out. */
  usableMs(): number {
    return Math.max(0, this.endsAt - this.clock() - this.config.finalization_reserve_ms);
  }

  #gate(minimum: number): boolean {
    const ok = this.usableMs() >= minimum;
    if (!ok) this.stats.deadline_reached = true;
    return ok;
  }

  canStartFetch(): boolean {
    return this.#gate(this.config.min_fetch_usable_ms);
  }

  /** Follow-up (escalation) searches are the lowest priority and need the most headroom. */
  canStartSearch(followUp: boolean): boolean {
    return this.#gate(followUp ? this.config.min_followup_usable_ms : this.config.min_search_usable_ms);
  }

  /** A per-request timeout never reaches into the finalization reserve. */
  capTimeout(requestedMs: number): number {
    return Math.max(1, Math.min(requestedMs, this.usableMs()));
  }
}
