// Budget guard: every HTTP attempt (retries included) must reserve its upper-bound cost before it is sent.
//
// Phase 1a scope, stated plainly: InMemoryBudgetGuard limits the calls and the estimated spend of ONE guard instance
// (one Edge Function invocation or one run that owns the instance). It is not a monthly budget: separate
// invocations, functions and processes do not share it, so it cannot enforce the shared Claude monthly allowance.
// The cross-process, persistent guard (database reservations and a monthly ledger) is Phase 1b, behind the same
// BudgetGuard interface. Nothing in Phase 1a guarantees the production-wide budget.
//
// Concurrency inside one process: reserve() checks and commits in one synchronous step (no await in between), so
// concurrent calls on the same instance can never both take the last unit of a limit. There is no module-level
// state: each guard owns its counters.
//
// Phase 1b (ledger_guard.ts) implements the same interface on the database ledger. It uses the optional parts:
// markSent() before the HTTP request (a reservation never marked sent is provably unsent and may be released),
// release() when the request will not be sent, and the settlement details (usage, outcome) for the ledger row.

import type { AiProvider, AiSubject, AiTokenUsage } from "./types.ts";

/** Which calls a limit applies to. An omitted field matches every value. */
export type BudgetScope = {
  readonly provider?: AiProvider;
  readonly application?: string;
  readonly feature?: string;
  readonly logicalRole?: string;
};

export type BudgetLimit = {
  readonly id: string;
  readonly scope: BudgetScope;
  /** Maximum HTTP attempts (each retry is one). */
  readonly maxCalls?: number;
  /** Maximum estimated USD (reserved upper bounds, replaced by measured cost when an attempt settles). */
  readonly maxEstimatedUsd?: number;
  /** Maximum upper-bound USD of a single attempt. */
  readonly maxUsdPerCall?: number;
};

export type BudgetCallContext = {
  readonly provider: AiProvider;
  readonly model: string;
  readonly application: string;
  readonly feature: string;
  readonly logicalRole: string;
  /** The logical call and attempt (always set by executeAiRequest; the ledger guard requires them). */
  readonly callId?: string;
  readonly attempt?: number;
  readonly subject?: AiSubject;
};

/** What happened to an attempt, for a guard that records it (the ledger). Counts and identifiers only. */
export type BudgetSettlement = {
  /** unknown = no usage and no result is known (timeout, lost connection). */
  readonly outcome: "succeeded" | "failed" | "unknown";
  /** measured = priced from reported usage; upper_bound = usage unknown, charged at no less than the hold. */
  readonly costBasis: "measured" | "upper_bound";
  readonly usage: AiTokenUsage | null;
  readonly errorCode: string | null;
  readonly actualModel: string | null;
  readonly providerRequestId: string | null;
  readonly httpStatus: number | null;
  readonly latencyMs: number;
  readonly catalogVersion: string;
};

export type BudgetReservation = {
  readonly id: string;
  readonly limitIds: readonly string[];
  readonly reservedUsd: number;
};

export type BudgetDenyReason =
  | "NO_MATCHING_LIMIT"
  | "CALL_LIMIT"
  | "COST_LIMIT"
  | "PER_CALL_LIMIT"
  | "INVALID_AMOUNT"
  | "GUARD_UNAVAILABLE"
  /** The ledger already finalised this (callId, attempt): it must never be sent again. */
  | "ATTEMPT_FINALIZED"
  /** The guard did not confirm the send (markSent refused or failed): nothing was sent. */
  | "SEND_NOT_CONFIRMED";

export type BudgetDecision =
  | { readonly allowed: true; readonly reservation: BudgetReservation }
  | { readonly allowed: false; readonly reason: BudgetDenyReason; readonly limitId: string | null };

/** The contract the executor depends on; Phase 1b adds a database-backed implementation. */
export interface BudgetGuard {
  /** Reserve one attempt costing at most `upperBoundUsd`. Must not have side effects when it denies. */
  reserve(context: BudgetCallContext, upperBoundUsd: number): Promise<BudgetDecision>;
  /**
   * Replace the reservation with the attempt's estimated cost (the upper bound again when usage is unknown).
   * `settlement` carries the details a recording guard stores; a guard that only counts may ignore it.
   */
  settle(reservation: BudgetReservation, costUsd: number, settlement?: BudgetSettlement): Promise<void>;
  /** Optional: confirm, just before sending, that this reservation may be sent. Throws when it may not. */
  markSent?(reservation: BudgetReservation): Promise<void>;
  /** Optional: return a reservation that will not be sent. Never releases one that was marked sent. */
  release?(reservation: BudgetReservation): Promise<void>;
}

export type BudgetLimitState = {
  readonly id: string;
  readonly calls: number;
  readonly estimatedUsd: number;
};

const EPSILON = 1e-9;

function matches(scope: BudgetScope, context: BudgetCallContext): boolean {
  return (scope.provider === undefined || scope.provider === context.provider) &&
    (scope.application === undefined || scope.application === context.application) &&
    (scope.feature === undefined || scope.feature === context.feature) &&
    (scope.logicalRole === undefined || scope.logicalRole === context.logicalRole);
}

function positiveOrUndefined(value: number | undefined, integer: boolean): boolean {
  if (value === undefined) return true;
  return Number.isFinite(value) && value >= 0 && (!integer || Number.isInteger(value));
}

/** Per-instance guard (see the header for what it does NOT cover). */
export class InMemoryBudgetGuard implements BudgetGuard {
  readonly #limits: ReadonlyArray<{ limit: BudgetLimit; calls: number; usd: number }>;
  readonly #open = new Map<string, BudgetReservation>();
  #sequence = 0;

  constructor(limits: readonly BudgetLimit[]) {
    const ids = new Set<string>();
    for (const limit of limits) {
      if (typeof limit.id !== "string" || limit.id === "" || ids.has(limit.id)) throw new Error("BUDGET_LIMIT_ID_INVALID");
      ids.add(limit.id);
      if (limit.maxCalls === undefined && limit.maxEstimatedUsd === undefined && limit.maxUsdPerCall === undefined) {
        throw new Error("BUDGET_LIMIT_WITHOUT_CAP");
      }
      if (!positiveOrUndefined(limit.maxCalls, true) || !positiveOrUndefined(limit.maxEstimatedUsd, false) || !positiveOrUndefined(limit.maxUsdPerCall, false)) {
        throw new Error("BUDGET_LIMIT_VALUE_INVALID");
      }
    }
    this.#limits = limits.map((limit) => ({ limit: Object.freeze({ ...limit, scope: Object.freeze({ ...limit.scope }) }), calls: 0, usd: 0 }));
  }

  reserve(context: BudgetCallContext, upperBoundUsd: number): Promise<BudgetDecision> {
    // Synchronous check-and-commit: the whole decision happens before this method yields.
    if (!Number.isFinite(upperBoundUsd) || upperBoundUsd < 0) return Promise.resolve({ allowed: false, reason: "INVALID_AMOUNT", limitId: null });
    const applicable = this.#limits.filter((entry) => matches(entry.limit.scope, context));
    if (applicable.length === 0) return Promise.resolve({ allowed: false, reason: "NO_MATCHING_LIMIT", limitId: null });
    for (const entry of applicable) {
      const { limit } = entry;
      if (limit.maxUsdPerCall !== undefined && upperBoundUsd > limit.maxUsdPerCall + EPSILON) {
        return Promise.resolve({ allowed: false, reason: "PER_CALL_LIMIT", limitId: limit.id });
      }
      if (limit.maxCalls !== undefined && entry.calls + 1 > limit.maxCalls) {
        return Promise.resolve({ allowed: false, reason: "CALL_LIMIT", limitId: limit.id });
      }
      if (limit.maxEstimatedUsd !== undefined && entry.usd + upperBoundUsd > limit.maxEstimatedUsd + EPSILON) {
        return Promise.resolve({ allowed: false, reason: "COST_LIMIT", limitId: limit.id });
      }
    }
    for (const entry of applicable) {
      entry.calls += 1;
      entry.usd += upperBoundUsd;
    }
    this.#sequence += 1;
    const reservation: BudgetReservation = Object.freeze({
      id: `r${this.#sequence}`,
      limitIds: Object.freeze(applicable.map((entry) => entry.limit.id)),
      reservedUsd: upperBoundUsd,
    });
    this.#open.set(reservation.id, reservation);
    return Promise.resolve({ allowed: true, reservation });
  }

  settle(reservation: BudgetReservation, costUsd: number): Promise<void> {
    const open = this.#open.get(reservation.id);
    // Unknown or already settled: keep the reservation counted (safe side) and do nothing else.
    if (!open) return Promise.resolve();
    this.#open.delete(reservation.id);
    const delta = Number.isFinite(costUsd) && costUsd >= 0 ? costUsd - open.reservedUsd : 0;
    for (const entry of this.#limits) {
      if (open.limitIds.includes(entry.limit.id)) entry.usd = Math.max(0, entry.usd + delta);
    }
    return Promise.resolve();
  }

  /** Current counters, for reporting and tests. */
  state(): readonly BudgetLimitState[] {
    return this.#limits.map((entry) => ({ id: entry.limit.id, calls: entry.calls, estimatedUsd: Math.round(entry.usd * 1e8) / 1e8 }));
  }
}
