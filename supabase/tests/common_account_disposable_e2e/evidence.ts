// Outcome model for a FUTURE disposable-Supabase proof run (Phase 3c, corrected in Phase 3e for the H2 E11 review
// R1-R4). Only PASS counts; FAIL, UNKNOWN, NOT_RUN and a missing experiment all block. The best a complete run can
// earn is "evidence complete, pending independent review" for a candidate fence -- never a release, never a choice
// between the candidates, and the Phase 3a release gate is not touched by anything here.
//
// Phase 3e additions (each fails closed):
//   R4  a destructive experiment counts as PASS only with the run's manual witness checks complete (witness.ts);
//       the guard's dry-run eligibility is self-declared and proves nothing about the destination or the fakes.
//   R1  E11 counts as PASS only with the full Admin-vs-SQL matrix (e11_matrix.ts); any residue it records (stale-token
//       writes, and since Phase 3f non-token after-state) blocks Option D.
//   R2  Option D also needs the separate full-decision proof (OPTION_D_FULL_DECISION_PROOF), not part of E1-E12.
//   R3  an E4 LINKED finding qualifies A+B only with an evidenced upper bound (e4_bound.ts); a label is not enough.
import { EXPERIMENT_IDS, experiment, REQUIRED_FOR, type ExperimentId } from './catalog.ts';
import { evaluateE4Bound, type E4BoundEvidence } from './e4_bound.ts';
import { evaluateE11, OPTION_D_FULL_DECISION_PROOF, type E11Evidence } from './e11_matrix.ts';
import { evaluateWitness, requiredWitness, type WitnessRecord } from './witness.ts';

export type Outcome = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_RUN';
export const OUTCOMES: readonly Outcome[] = ['PASS', 'FAIL', 'UNKNOWN', 'NOT_RUN'];

export interface ExperimentResult {
  id: ExperimentId;
  outcome: Outcome;
  /** Redacted evidence file names; a PASS without evidence is not a PASS. */
  evidence: string[];
  /** E4 only: what GoTrue did with the manual link begun before the ban. */
  e4Finding?: 'LINKED' | 'REFUSED';
  /** E4 LINKED only: the mitigation claimed. A label alone never qualifies; see e4Bound. */
  e4Mitigation?: 'manual_linking_disabled_verified' | 'settle_exceeds_measured_flow_expiry';
  /** E4 LINKED only: the upper-bound evidence the mitigation stands on (R3). */
  e4Bound?: E4BoundEvidence;
  /** E11 only: the Admin-vs-SQL deletion matrix (R1). */
  e11?: E11Evidence;
}

export interface AdditionalProof {
  id: typeof OPTION_D_FULL_DECISION_PROOF.id;
  evidence: string[];
  /** Reviewed by an independent security reviewer (a reference to that review is part of the evidence). */
  independentlyReviewed: boolean;
}

export interface RunContext {
  runId?: string;
  witness?: readonly WitnessRecord[];
  additionalProofs?: readonly AdditionalProof[];
}

export type CandidateVerdict = 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW' | 'BLOCKED';
export interface RunVerdict {
  /** Never 'READY' or 'RELEASE': the gate stays blocked until a separately reviewed migration. */
  overall: 'BLOCKED' | 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW';
  candidates: Record<'A+B' | 'D', { verdict: CandidateVerdict; reasons: string[] }>;
  invalid: string[];
  /** Why individual experiments were downgraded from PASS. */
  downgraded: string[];
}

const isDestructive = (id: ExperimentId) => experiment(id)?.kind === 'destructive';

function effective(result: ExperimentResult | undefined, context: RunContext, downgraded: string[]): Outcome {
  if (!result) return 'NOT_RUN';
  if (result.outcome !== 'PASS') return result.outcome;
  const reasons: string[] = [];
  if (result.evidence.length === 0) reasons.push('NO_EVIDENCE');
  if (result.id === 'E4' && !result.e4Finding) reasons.push('E4_FINDING_MISSING');
  if (isDestructive(result.id)) reasons.push(...evaluateWitness(context.witness, context.runId, requiredWitness([result.id], isDestructive)).reasons);
  if (result.id === 'E11') {
    const matrix = evaluateE11(result.e11);
    if (matrix.outcome === 'FAIL') {
      downgraded.push(...matrix.reasons.map((r) => `E11:${r}`));
      return 'FAIL';
    }
    reasons.push(...matrix.reasons);
  }
  if (reasons.length === 0) return 'PASS';
  downgraded.push(...reasons.map((r) => `${result.id}:${r}`));
  return 'UNKNOWN';
}

export function verdict(results: readonly ExperimentResult[], context: RunContext = {}): RunVerdict {
  const invalid: string[] = [];
  const downgraded: string[] = [];
  const byId = new Map<ExperimentId, ExperimentResult>();
  for (const r of results) {
    if (!EXPERIMENT_IDS.includes(r.id)) invalid.push(`UNKNOWN_EXPERIMENT:${String(r.id)}`);
    else if (!OUTCOMES.includes(r.outcome)) invalid.push(`UNKNOWN_OUTCOME:${r.id}`);
    else if (byId.has(r.id)) invalid.push(`DUPLICATE_RESULT:${r.id}`);
    else byId.set(r.id, r);
  }
  const outcomes = new Map<ExperimentId, Outcome>();
  for (const id of EXPERIMENT_IDS) outcomes.set(id, effective(byId.get(id), context, downgraded));

  const candidates = {} as RunVerdict['candidates'];
  for (const candidate of ['A+B', 'D'] as const) {
    const reasons: string[] = [];
    for (const id of REQUIRED_FOR[candidate]) {
      const outcome = outcomes.get(id)!;
      if (outcome !== 'PASS') reasons.push(`${id}:${outcome}`);
    }
    if (candidate === 'A+B') {
      // The source-level counterexample (V11): refuted, or mitigated with an evidenced UPPER bound (R3).
      const e4 = byId.get('E4');
      if (outcomes.get('E4') === 'PASS' && e4?.e4Finding === 'LINKED') {
        if (!e4.e4Mitigation) reasons.push('E4:LINKED_WITHOUT_PROVEN_MITIGATION');
        else for (const r of evaluateE4Bound(e4.e4Bound)) reasons.push(`E4:${r}`);
      }
    } else {
      // R2: the E11 row-latch probe is not the decision proof. R1: any residue the matrix recorded -- stale-token writes
      // and (Phase 3f) remaining sessions, refresh tokens, identities, Storage metadata or blobs, service rows -- blocks
      // Option D even though the matrix itself passed.
      const proof = (context.additionalProofs ?? []).find((p) => p.id === OPTION_D_FULL_DECISION_PROOF.id);
      if (!proof || proof.evidence.length === 0 || proof.independentlyReviewed !== true) reasons.push(`${OPTION_D_FULL_DECISION_PROOF.id}:MISSING`);
      if (outcomes.get('E11') === 'PASS') for (const r of evaluateE11(byId.get('E11')?.e11).residue) reasons.push(`E11:${r}`);
    }
    if (invalid.length) reasons.push('INVALID_RESULTS');
    candidates[candidate] = { verdict: reasons.length ? 'BLOCKED' : 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW', reasons };
  }
  const anyComplete = Object.values(candidates).some((c) => c.verdict !== 'BLOCKED');
  return { overall: anyComplete ? 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW' : 'BLOCKED', candidates, invalid, downgraded };
}
