import assert from "node:assert/strict";
import test from "node:test";
import { BudgetError, BudgetGuard, budgetFromArgs } from "./budget.ts";

const env = (values: Record<string, string>) => ({ get: (name: string) => values[name] });

test("mock and dry-run never throw and never count (they cannot reach a network)", () => {
  for (const mode of ["mock", "dry-run"] as const) {
    const guard = new BudgetGuard(mode, { maxCalls: 0, maxUsd: 0 }, false);
    for (let i = 0; i < 1000; i += 1) {
      guard.beforeAttempt(1_000_000);
      guard.afterAttempt(1_000_000);
    }
    assert.equal(guard.snapshot().calls, 0);
    assert.equal(guard.snapshot().spentUsd, 0);
  }
});

test("live is refused without PROVIDER_COMPARE_ALLOW_PAID=1", () => {
  assert.throws(() => budgetFromArgs({ mode: "live", maxCalls: 5, maxUsd: 1 }, env({})), (e: unknown) =>
    e instanceof BudgetError && e.reason === "PAID_NOT_ALLOWED");
  assert.throws(() => budgetFromArgs({ mode: "live", maxCalls: 5, maxUsd: 1 }, env({ PROVIDER_COMPARE_ALLOW_PAID: "true" })), BudgetError);
  assert.doesNotThrow(() => budgetFromArgs({ mode: "live", maxCalls: 5, maxUsd: 1 }, env({ PROVIDER_COMPARE_ALLOW_PAID: "1" })));
});

test("live is refused without BOTH a call limit and a spend limit", () => {
  const allow = env({ PROVIDER_COMPARE_ALLOW_PAID: "1" });
  for (const args of [
    { mode: "live" as const },
    { mode: "live" as const, maxCalls: 5 },
    { mode: "live" as const, maxUsd: 1 },
    { mode: "live" as const, maxCalls: 0, maxUsd: 1 },
    { mode: "live" as const, maxCalls: 2.5, maxUsd: 1 },
    { mode: "live" as const, maxCalls: 5, maxUsd: Number.NaN },
    { mode: "live" as const, maxCalls: 5, maxUsd: -1 },
  ]) {
    assert.throws(() => budgetFromArgs(args, allow), (e: unknown) => e instanceof BudgetError && e.reason === "INVALID_LIMITS", JSON.stringify(args));
  }
});

test("live stops at the call limit", () => {
  const guard = new BudgetGuard("live", { maxCalls: 2, maxUsd: 100 }, true);
  guard.beforeAttempt(0.01); guard.afterAttempt(0.01);
  guard.beforeAttempt(0.01); guard.afterAttempt(0.01);
  assert.throws(() => guard.beforeAttempt(0.01), (e: unknown) => e instanceof BudgetError && e.reason === "MAX_CALLS");
  assert.equal(guard.snapshot().calls, 2);
});

test("live stops before an attempt whose estimate would pass the spend limit", () => {
  const guard = new BudgetGuard("live", { maxCalls: 100, maxUsd: 0.05 }, true);
  guard.beforeAttempt(0.03); guard.afterAttempt(0.02);
  guard.beforeAttempt(0.03); guard.afterAttempt(0.02);
  assert.throws(() => guard.beforeAttempt(0.02), (e: unknown) => e instanceof BudgetError && e.reason === "MAX_USD");
  assert.equal(guard.snapshot().spentUsd, 0.04);
});

test("a retried attempt is a new attempt: it counts against the call limit", () => {
  const guard = new BudgetGuard("live", { maxCalls: 3, maxUsd: 100 }, true);
  for (let i = 0; i < 3; i += 1) { guard.beforeAttempt(0); guard.afterAttempt(0); }
  assert.throws(() => guard.beforeAttempt(0), BudgetError);
});

test("the reservation is replaced by the real cost, so an over-estimate does not eat the budget", () => {
  const guard = new BudgetGuard("live", { maxCalls: 100, maxUsd: 0.1 }, true);
  for (let i = 0; i < 20; i += 1) {
    guard.beforeAttempt(0.05); // pessimistic estimate
    guard.afterAttempt(0.001); // real cost
  }
  assert.equal(guard.snapshot().calls, 20);
  assert.equal(guard.snapshot().spentUsd, 0.02);
});
