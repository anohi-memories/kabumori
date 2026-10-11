import assert from "node:assert/strict";
import test from "node:test";
import { loadEvalSet, summariseEvalSet } from "./eval_set.ts";
import { loadNopostSample } from "../scripts/nopost_report.ts";
import { applyProvisionalPolicy, loadProvisionalPolicy } from "./provisional_policy.ts";

const [policy, evalSet, nopost] = await Promise.all([loadProvisionalPolicy(), loadEvalSet(), loadNopostSample()]);

test("the overlay is labelled evaluation-only and every decision cites a declared criterion", () => {
  assert.match(policy.scope, /Evaluation only/);
  assert.match(policy.scope, /NOT a change to the production delivery rules/);
  for (const [id, decision] of Object.entries(policy.decisions)) {
    assert.ok(policy.criteria[String(decision.criterion)], `${id}: unknown criterion ${decision.criterion}`);
    assert.ok(["important", "no_post", "pending"].includes(decision.outcome), id);
    assert.ok(decision.basis.length > 0, id);
  }
});

test("every pending label in the evaluation set and the no_post sample has a decision, and every decision has a case", () => {
  const pending = [
    ...evalSet.filter((c) => c.label.status === "human_review_pending").map((c) => (c.candidateId ?? c.caseId.slice(-8)).slice(0, 8)),
    ...nopost.cases.filter((c) => c.label.status === "human_review_pending").map((c) => c.candidateId.slice(0, 8)),
  ];
  assert.deepEqual([...new Set(pending)].filter((id) => !policy.decisions[id]), []);
  const known = new Set([
    ...evalSet.map((c) => (c.candidateId ?? c.caseId.slice(-8)).slice(0, 8)),
    ...nopost.cases.map((c) => c.candidateId.slice(0, 8)),
  ]);
  // d830d203 is a decided AI-provisional label that the policy confirms; it is listed so the criterion is visible.
  assert.deepEqual(Object.keys(policy.decisions).filter((id) => !known.has(id)), []);
});

test("applying the overlay resolves only policy-pending labels and never invents a human confirmation", () => {
  const before = summariseEvalSet(evalSet);
  const applied = applyProvisionalPolicy(evalSet, policy);
  const after = summariseEvalSet(applied.items);
  assert.equal(after.humanConfirmed, 0);
  assert.equal(after.byStatus["human_review_pending"], (before.byStatus["human_review_pending"] ?? 0) - applied.resolved.length);
  for (const item of applied.items) {
    assert.equal(item.label.verifier, "none", item.caseId);
    if (item.label.rule?.startsWith("PROVISIONAL-POLICY-")) assert.equal(item.label.status, "ai_provisional");
  }
  // Labels that were not pending are untouched, byte for byte.
  const original = new Map(evalSet.map((c) => [c.caseId, JSON.stringify(c.label)]));
  for (const item of applied.items) {
    if (!applied.resolved.includes(item.caseId)) assert.equal(JSON.stringify(item.label), original.get(item.caseId), item.caseId);
  }
});

test("the outcome is what the criteria say: a successful pivotal trial is important, a routine filing is not", () => {
  assert.equal(policy.decisions["434cc413"].outcome, "important");
  assert.equal(policy.decisions["077310bc"].outcome, "no_post");
  assert.equal(policy.decisions["16a0eec4"].outcome, "no_post");
  for (const id of ["20dfa7bd", "9193e7a9"]) assert.equal(policy.decisions[id].outcome, "pending", id);
  for (const id of ["622f46d2", "d0fd4e00"]) assert.equal(policy.decisions[id].outcome, "pending", id);
});

test("a decided label is not overwritten by the overlay", () => {
  const decided = evalSet.find((c) => (c.candidateId ?? "").startsWith("d830d203"))!;
  assert.equal(decided.label.status, "ai_provisional");
  const applied = applyProvisionalPolicy([decided], policy);
  assert.equal(applied.resolved.length, 0);
  assert.equal(JSON.stringify(applied.items[0].label), JSON.stringify(decided.label));
});
