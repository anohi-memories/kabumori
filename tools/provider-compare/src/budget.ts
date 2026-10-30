// Paid calls are opt-in three times over: the mode must be "live", PROVIDER_COMPARE_ALLOW_PAID=1 must be set, and the
// caller must give BOTH a maximum number of HTTP attempts and a maximum estimated spend. Without all of them the
// guard refuses before a single request leaves the machine. Every retry is an attempt and is counted.

export type RunMode = "mock" | "dry-run" | "live";

export class BudgetError extends Error {
  readonly reason: "PAID_NOT_ALLOWED" | "MAX_CALLS" | "MAX_USD" | "INVALID_LIMITS";

  constructor(reason: BudgetError["reason"]) {
    super(`BUDGET_${reason}`);
    this.name = "BudgetError";
    this.reason = reason;
  }
}

export type BudgetLimits = { maxCalls: number; maxUsd: number };

export class BudgetGuard {
  readonly mode: RunMode;
  readonly limits: BudgetLimits;
  private readonly allowPaid: boolean;
  private calls = 0;
  private spentUsd = 0;
  private reservedUsd = 0;

  constructor(mode: RunMode, limits: BudgetLimits, allowPaid: boolean) {
    this.mode = mode;
    this.limits = limits;
    this.allowPaid = allowPaid;
    if (mode === "live") {
      const valid = Number.isInteger(limits.maxCalls) && limits.maxCalls > 0 && Number.isFinite(limits.maxUsd) && limits.maxUsd > 0;
      if (!allowPaid) throw new BudgetError("PAID_NOT_ALLOWED");
      if (!valid) throw new BudgetError("INVALID_LIMITS");
    }
  }

  /** Called before each HTTP attempt. mock / dry-run never reach a network, so they only count. */
  beforeAttempt(estimatedUsd: number): void {
    if (this.mode !== "live") return;
    if (this.calls + 1 > this.limits.maxCalls) throw new BudgetError("MAX_CALLS");
    if (this.spentUsd + this.reservedUsd + estimatedUsd > this.limits.maxUsd) throw new BudgetError("MAX_USD");
    this.calls += 1;
    this.reservedUsd += estimatedUsd;
    this.lastReservation = estimatedUsd;
  }

  private lastReservation = 0;

  /** Called after the attempt with the real (usage-based) cost; replaces the reservation. */
  afterAttempt(costUsd: number): void {
    if (this.mode !== "live") return;
    this.reservedUsd = Math.max(0, this.reservedUsd - this.lastReservation);
    this.lastReservation = 0;
    this.spentUsd += Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
  }

  snapshot(): { mode: RunMode; calls: number; spentUsd: number; maxCalls: number; maxUsd: number } {
    return {
      mode: this.mode,
      calls: this.calls,
      spentUsd: Number(this.spentUsd.toFixed(6)),
      maxCalls: this.limits.maxCalls,
      maxUsd: this.limits.maxUsd,
    };
  }
}

/** Builds the guard from CLI flags and the environment; "live" needs every opt-in. */
export function budgetFromArgs(
  args: { mode: RunMode; maxCalls?: number; maxUsd?: number },
  env: { get(name: string): string | undefined },
): BudgetGuard {
  const allowPaid = env.get("PROVIDER_COMPARE_ALLOW_PAID") === "1";
  return new BudgetGuard(args.mode, { maxCalls: args.maxCalls ?? 0, maxUsd: args.maxUsd ?? 0 }, allowPaid);
}
