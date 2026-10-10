// Provisional, evaluation-only criteria (Phase 5). They turn some of the policy-pending labels into AI-provisional ones and
// leave the rest pending; they never touch a production rule and never mark anything as human-confirmed.
import type { Importance } from "./fixtures.ts";
import type { LabelRecord } from "./eval_set.ts";

export type PolicyOutcome = "important" | "no_post" | "pending";

export type PolicyFile = {
  version: 1;
  decidedOn: string;
  scope: string;
  criteria: Record<string, string>;
  decisions: Record<string, { criterion: number; outcome: PolicyOutcome; basis: string }>;
};

export async function loadProvisionalPolicy(): Promise<PolicyFile> {
  return JSON.parse(await Deno.readTextFile(new URL("../fixtures/eval_provisional_policy.json", import.meta.url))) as PolicyFile;
}

type Labelled = { caseId: string; candidateId?: string | null; label: LabelRecord };

const id8Of = (item: Labelled) => (item.candidateId ?? item.caseId.slice(-8)).slice(0, 8);

/**
 * Applies the overlay. A decision of "important" or "no_post" turns a policy-pending label into an AI-provisional one with
 * the criterion as its rule; "pending" leaves it untouched. Only human_review_pending labels are eligible, so no
 * independent_confirmed or other AI label can be overwritten, and the verifier stays "none".
 */
export function applyProvisionalPolicy<T extends Labelled>(items: readonly T[], policy: PolicyFile): { items: T[]; resolved: string[]; stillPending: string[] } {
  const resolved: string[] = [];
  const stillPending: string[] = [];
  const out = items.map((item) => {
    const decision = policy.decisions[id8Of(item)];
    if (!decision || item.label.status !== "human_review_pending") return item;
    if (decision.outcome === "pending") {
      stillPending.push(item.caseId);
      return item;
    }
    resolved.push(item.caseId);
    const expected: Importance = decision.outcome;
    const label: LabelRecord = {
      ...item.label,
      expected,
      status: "ai_provisional",
      rule: `PROVISIONAL-POLICY-${decision.criterion}`,
      headline: true,
      rationale: `暫定評価基準${decision.criterion}（評価専用）: ${decision.basis}`,
      verifier: "none",
    };
    return { ...item, label };
  });
  return { items: out, resolved, stillPending };
}
