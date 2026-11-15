// Outcome model for a FUTURE disposable-Supabase proof run (Phase 3c, offline readiness). Only PASS counts;
// FAIL, UNKNOWN, NOT_RUN and a missing experiment all block. The best a complete run can earn is
// "evidence complete, pending independent review" for a candidate fence -- never a release, never a choice
// between the candidates, and the Phase 3a release gate is not touched by anything here.
import { EXPERIMENT_IDS, REQUIRED_FOR, type ExperimentId } from './catalog.ts';

export type Outcome = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_RUN';
export const OUTCOMES: readonly Outcome[] = ['PASS', 'FAIL', 'UNKNOWN', 'NOT_RUN'];

export interface ExperimentResult {
  id: ExperimentId;
  outcome: Outcome;
  /** Redacted evidence file names; a PASS without evidence is not a PASS. */
  evidence: string[];
  /** E4 only: what GoTrue did with the manual link begun before the ban. */
  e4Finding?: 'LINKED' | 'REFUSED';
  /** E4 LINKED only: how Option A would be safe anyway (each must itself be evidenced). */
  e4Mitigation?: 'manual_linking_disabled_verified' | 'settle_exceeds_measured_flow_expiry';
}

export type CandidateVerdict = 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW' | 'BLOCKED';
export interface RunVerdict {
  /** Never 'READY' or 'RELEASE': the gate stays blocked until a separately reviewed migration. */
  overall: 'BLOCKED' | 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW';
  candidates: Record<'A+B' | 'D', { verdict: CandidateVerdict; reasons: string[] }>;
  invalid: string[];
}

function effective(result: ExperimentResult | undefined): Outcome {
  if (!result) return 'NOT_RUN';
  if (result.outcome === 'PASS' && result.evidence.length === 0) return 'UNKNOWN';
  if (result.id === 'E4' && result.outcome === 'PASS' && !result.e4Finding) return 'UNKNOWN';
  return result.outcome;
}

export function verdict(results: readonly ExperimentResult[]): RunVerdict {
  const invalid: string[] = [];
  const byId = new Map<ExperimentId, ExperimentResult>();
  for (const r of results) {
    if (!EXPERIMENT_IDS.includes(r.id)) invalid.push(`UNKNOWN_EXPERIMENT:${String(r.id)}`);
    else if (!OUTCOMES.includes(r.outcome)) invalid.push(`UNKNOWN_OUTCOME:${r.id}`);
    else if (byId.has(r.id)) invalid.push(`DUPLICATE_RESULT:${r.id}`);
    else byId.set(r.id, r);
  }
  const candidates = {} as RunVerdict['candidates'];
  for (const candidate of ['A+B', 'D'] as const) {
    const reasons: string[] = [];
    for (const id of REQUIRED_FOR[candidate]) {
      const outcome = effective(byId.get(id));
      if (outcome !== 'PASS') reasons.push(`${id}:${outcome}`);
    }
    // The source-level counterexample (V11) must be either refuted or mitigated with evidence.
    if (candidate === 'A+B') {
      const e4 = byId.get('E4');
      if (effective(e4) === 'PASS' && e4?.e4Finding === 'LINKED' && !e4.e4Mitigation) reasons.push('E4:LINKED_WITHOUT_PROVEN_MITIGATION');
    }
    if (invalid.length) reasons.push('INVALID_RESULTS');
    candidates[candidate] = { verdict: reasons.length ? 'BLOCKED' : 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW', reasons };
  }
  const anyComplete = Object.values(candidates).some((c) => c.verdict !== 'BLOCKED');
  return { overall: anyComplete ? 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW' : 'BLOCKED', candidates, invalid };
}
