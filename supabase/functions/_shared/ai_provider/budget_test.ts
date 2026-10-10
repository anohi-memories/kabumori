// Budget guard (required tests 24, 25): call and cost caps, per-call cap, scope by provider / application / feature
// / role, fail-closed without a matching limit, settlement, and concurrent reservations in one process.
import assert from "node:assert/strict";
import test from "node:test";
import { type BudgetCallContext, InMemoryBudgetGuard } from "./budget.ts";

const opus: BudgetCallContext = { provider: "anthropic", model: "claude-opus-5-5", application: "kabumori", feature: "market_report", logicalRole: "kabumori.market_report.generate" };
const postona: BudgetCallContext = { provider: "anthropic", model: "claude-opus-5-5", application: "postona", feature: "consult", logicalRole: "postona.consult" };
const sol: BudgetCallContext = { provider: "openai", model: "gpt-6.1-sol", application: "kabumori", feature: "market_report", logicalRole: "kabumori.market_report.generate" };

test("24. call cap, cost cap and per-call cap deny before anything is committed", async () => {
  const guard = new InMemoryBudgetGuard([{ id: "anthropic", scope: { provider: "anthropic" }, maxCalls: 2, maxEstimatedUsd: 1, maxUsdPerCall: 0.6 }]);
  assert.deepEqual(await guard.reserve(opus, 0.7), { allowed: false, reason: "PER_CALL_LIMIT", limitId: "anthropic" });
  const first = await guard.reserve(opus, 0.5);
  assert.ok(first.allowed);
  assert.deepEqual(await guard.reserve(opus, 0.6), { allowed: false, reason: "COST_LIMIT", limitId: "anthropic" });
  const second = await guard.reserve(opus, 0.4);
  assert.ok(second.allowed);
  assert.deepEqual(await guard.reserve(opus, 0.01), { allowed: false, reason: "CALL_LIMIT", limitId: "anthropic" });
  assert.deepEqual(guard.state(), [{ id: "anthropic", calls: 2, estimatedUsd: 0.9 }], "denials changed nothing");
});

test("24. scopes: provider, application and feature limits all apply; no matching limit is a denial", async () => {
  const guard = new InMemoryBudgetGuard([
    { id: "claude-total", scope: { provider: "anthropic" }, maxEstimatedUsd: 10 },
    { id: "postona", scope: { provider: "anthropic", application: "postona" }, maxCalls: 1 },
    { id: "report", scope: { application: "kabumori", feature: "market_report" }, maxCalls: 5 },
  ]);
  assert.ok((await guard.reserve(postona, 0.1)).allowed);
  assert.deepEqual(await guard.reserve(postona, 0.1), { allowed: false, reason: "CALL_LIMIT", limitId: "postona" });
  assert.ok((await guard.reserve(opus, 0.1)).allowed, "kabumori is not limited by the postona cap");
  assert.ok((await guard.reserve(sol, 0.1)).allowed, "openai matches only the feature limit");
  const other: BudgetCallContext = { ...sol, application: "mic", feature: "state" };
  assert.deepEqual(await guard.reserve(other, 0.1), { allowed: false, reason: "NO_MATCHING_LIMIT", limitId: null });
  assert.deepEqual(await guard.reserve(opus, Number.NaN), { allowed: false, reason: "INVALID_AMOUNT", limitId: null });
});

test("settlement replaces the reservation with the estimated cost once; unknown cost keeps the upper bound", async () => {
  const guard = new InMemoryBudgetGuard([{ id: "all", scope: {}, maxEstimatedUsd: 1 }]);
  const decision = await guard.reserve(opus, 0.8);
  assert.ok(decision.allowed);
  await guard.settle(decision.reservation, 0.1);
  assert.equal(guard.state()[0].estimatedUsd, 0.1);
  await guard.settle(decision.reservation, 0);
  assert.equal(guard.state()[0].estimatedUsd, 0.1, "second settle is ignored");
  const unknown = await guard.reserve(opus, 0.8);
  assert.ok(unknown.allowed);
  await guard.settle(unknown.reservation, 0.8);
  assert.equal(guard.state()[0].estimatedUsd, 0.9);
  assert.deepEqual(await guard.reserve(opus, 0.2), { allowed: false, reason: "COST_LIMIT", limitId: "all" });
});

test("25. concurrent reservations on one guard never exceed the cap", async () => {
  const guard = new InMemoryBudgetGuard([{ id: "all", scope: {}, maxCalls: 3, maxEstimatedUsd: 100 }]);
  const decisions = await Promise.all(Array.from({ length: 20 }, () => guard.reserve(opus, 1)));
  assert.equal(decisions.filter((d) => d.allowed).length, 3);
  assert.equal(guard.state()[0].calls, 3);
  const costGuard = new InMemoryBudgetGuard([{ id: "usd", scope: {}, maxEstimatedUsd: 1 }]);
  const costDecisions = await Promise.all(Array.from({ length: 10 }, () => costGuard.reserve(opus, 0.3)));
  assert.equal(costDecisions.filter((d) => d.allowed).length, 3);
});

test("guards do not share state (no module-level budget)", async () => {
  const a = new InMemoryBudgetGuard([{ id: "all", scope: {}, maxCalls: 1 }]);
  const b = new InMemoryBudgetGuard([{ id: "all", scope: {}, maxCalls: 1 }]);
  assert.ok((await a.reserve(opus, 0)).allowed);
  assert.ok((await b.reserve(opus, 0)).allowed);
});

test("misconfigured limits are refused at construction", () => {
  assert.throws(() => new InMemoryBudgetGuard([{ id: "x", scope: {} }]), /BUDGET_LIMIT_WITHOUT_CAP/);
  assert.throws(() => new InMemoryBudgetGuard([{ id: "x", scope: {}, maxCalls: 1 }, { id: "x", scope: {}, maxCalls: 1 }]), /BUDGET_LIMIT_ID_INVALID/);
  assert.throws(() => new InMemoryBudgetGuard([{ id: "x", scope: {}, maxCalls: 1.5 }]), /BUDGET_LIMIT_VALUE_INVALID/);
  assert.throws(() => new InMemoryBudgetGuard([{ id: "x", scope: {}, maxEstimatedUsd: -1 }]), /BUDGET_LIMIT_VALUE_INVALID/);
});
