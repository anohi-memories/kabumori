// Dry-run plan printer (Phase 3c, offline readiness): renders the E1-E12 plan for an operator, optionally
// annotated with a guard result. Text only; it never prints a URL, a credential or a token, and it never runs
// anything.
import { EXPERIMENTS, PR121_HEAD, REQUIRED_FOR } from './catalog.ts';
import type { GuardResult } from './guard.ts';

export function renderPlan(guard?: GuardResult): string {
  const lines: string[] = [];
  lines.push('COMMON ACCOUNT PHASE 3C -- DISPOSABLE SUPABASE PROOF PLAN (DRY RUN, NOTHING EXECUTED)');
  lines.push(`source: PR121 section 8 at ${PR121_HEAD}`);
  lines.push('execution: NOT_AVAILABLE_IN_THIS_STAGE (no executor, no network code)');
  if (guard) {
    lines.push(`guard: ${guard.allowed ? 'REQUEST_VALID_DRY_RUN_ONLY' : 'DENIED'}`);
    for (const reason of guard.reasons) lines.push(`  deny: ${reason}`);
  } else {
    lines.push('guard: NO_REQUEST (default deny)');
  }
  for (const e of EXPERIMENTS) {
    const selected = guard ? (guard.scenarios.includes(e.id) ? 'selected' : 'not selected') : 'not selected';
    lines.push('');
    lines.push(`${e.id} [${e.kind}] [${selected}] ${e.what.replace(/\*\*/gu, '')}`);
    lines.push(`  pass (PR121 verbatim): ${e.pass}`);
    lines.push(`  informs: ${e.informs}; timing control: ${e.forcing}`);
    if (e.kind === 'destructive') {
      lines.push(`  destructive in the disposable project: ${e.destructiveOperations.join('; ')}`);
      lines.push(`  requires per-run consent: DESTROY-${e.id}-<ref>-<run_id>`);
    }
    for (const extra of e.extraApprovals) lines.push(`  requires extra approval: ${extra}`);
    lines.push(`  inputs: ${e.inputs.join('; ')}`);
    for (const o of e.observables) lines.push(`  record: ${o}`);
    for (const u of e.unknownWhen) lines.push(`  UNKNOWN (fails closed) when: ${u}`);
  }
  lines.push('');
  lines.push(`needed before Option A+B can be reviewed: ${REQUIRED_FOR['A+B'].join(', ')} (and E4 LINKED needs a proven mitigation)`);
  lines.push(`needed before Option D can be reviewed: ${REQUIRED_FOR['D'].join(', ')} (and separate user + independent security approval)`);
  lines.push('neither candidate is chosen here; the managed_auth_delete release gate stays blocked.');
  return `${lines.join('\n')}\n`;
}
