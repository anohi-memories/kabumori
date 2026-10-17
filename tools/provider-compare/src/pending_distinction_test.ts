import assert from "node:assert/strict";
import test from "node:test";
import { loadEvalSet } from "./eval_set.ts";
import { loadNopostSample } from "../scripts/nopost_report.ts";
import { applyProvisionalPolicy, loadProvisionalPolicy } from "./provisional_policy.ts";

// The 16 policy-pending labels of Phase 3/4 split into 3 AI-provisional ones (decided by the evaluation-only criteria) and
// 13 that stay pending. AI-provisional is never human approval, and the two groups are never merged.
const [policy, evalSet, nopost] = await Promise.all([loadProvisionalPolicy(), loadEvalSet(), loadNopostSample()]);
const id8 = (c: { candidateId?: string | null; caseId: string }) => (c.candidateId ?? c.caseId.slice(-8)).slice(0, 8);

test("16 pending labels: 3 become AI-provisional, 13 stay pending", () => {
  const pendingBefore = [...evalSet, ...nopost.cases].filter((c) => c.label.status === "human_review_pending");
  assert.equal(pendingBefore.length, 16);
  const a = applyProvisionalPolicy(evalSet, policy);
  const b = applyProvisionalPolicy(nopost.cases, policy);
  const resolved = [...a.resolved, ...b.resolved].map((caseId) => caseId);
  assert.equal(resolved.length, 3);
  assert.equal(a.stillPending.length + b.stillPending.length, 13);
  const resolvedIds = [...a.items, ...b.items].filter((c) => resolved.includes(c.caseId)).map(id8).sort();
  assert.deepEqual(resolvedIds, ["077310bc", "16a0eec4", "434cc413"]);
});

test("the three decided ones are AI-provisional with a provisional-policy rule and no human verifier", () => {
  const items = [...applyProvisionalPolicy(evalSet, policy).items, ...applyProvisionalPolicy(nopost.cases, policy).items]
    .filter((c) => c.label.rule?.startsWith("PROVISIONAL-POLICY-"));
  assert.equal(items.length, 3);
  for (const c of items) {
    assert.equal(c.label.status, "ai_provisional");
    assert.equal(c.label.verifier, "none");
    assert.match(c.label.rationale, /評価専用/);
  }
  assert.deepEqual(items.map((c) => c.label.expected).sort(), ["important", "no_post", "no_post"]);
});

test("the thirteen that stay pending keep no expected value and are not counted anywhere as decided", () => {
  const stay = new Set([...applyProvisionalPolicy(evalSet, policy).stillPending, ...applyProvisionalPolicy(nopost.cases, policy).stillPending]);
  assert.equal(stay.size, 13);
  const all = [...applyProvisionalPolicy(evalSet, policy).items, ...applyProvisionalPolicy(nopost.cases, policy).items];
  for (const c of all.filter((x) => stay.has(x.caseId))) {
    assert.equal(c.label.status, "human_review_pending", c.caseId);
    assert.equal(c.label.expected, null, c.caseId);
    assert.equal(c.label.headline, false, c.caseId);
  }
});
