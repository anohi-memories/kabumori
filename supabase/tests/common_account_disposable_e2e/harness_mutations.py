"""Defect-detection proof for the Phase 3c offline harness tests. Copies the harness (and the runbook it checks)
into a scratch tree, applies ONE mutation at a time to the copy, runs the Deno suite there with read permission
only, and requires a failure; the unmutated control must pass. The worktree is never edited; no network.
Usage: python3 supabase/tests/common_account_disposable_e2e/harness_mutations.py"""
import os
import shutil
import subprocess
import sys
import tempfile

here = os.path.dirname(os.path.abspath(__file__))
repo = os.path.abspath(os.path.join(here, '..', '..', '..'))
REL = 'supabase/tests/common_account_disposable_e2e'
RUNBOOK = 'docs/common-account/phase3c-disposable-supabase-proof-runbook.md'

G, R, E, C, K = 'guard.ts', 'redact.ts', 'evidence.ts', 'cli.ts', 'catalog.ts'
W, X, B, P, T, XR = 'witness.ts', 'e11_matrix.ts', 'e4_bound.ts', 'plan.ts', 'target_readback.sql', 'catalog_extended_readback.sql'
M = [
    ('a production ref is accepted', G, "if (refOk && PRODUCTION_PROJECT_REFS.includes(ref)) reasons.push('PROJECT_REF_PRODUCTION');", ''),
    ('a reused ref is accepted', G, "else if (refOk && (ledger.used_project_refs as string[]).includes(ref)) reasons.push('PROJECT_REF_REUSED');", ''),
    ('a missing ledger is accepted', G, "if (!isObject(ledger)) reasons.push('LEDGER_MISSING');", "if (!isObject(ledger)) { /* tolerated */ }"),
    ('a marker inside the repository is accepted', G, "reasons.push('MARKER_PATH_INSIDE_REPOSITORY');", 'void 0;'),
    ('the CLI link is accepted as a marker', G, "reasons.push('MARKER_PATH_IS_CLI_LINK');", 'void 0;'),
    ('a symlinked marker path is accepted', G, "else if (markerPath !== request.project_marker_path) reasons.push('MARKER_PATH_MISMATCH');", ''),
    ('a production-like name is accepted', G, "PRODUCTION_LIKE.test(name.slice(PROJECT_NAME_PREFIX.length).toLowerCase())", 'false'),
    ('an expired marker is accepted', G, "else if (expires.getTime() <= input.now.getTime()) reasons.push('MARKER_EXPIRED');", ''),
    ('a non-disposable marker is accepted', G, "marker.environment !== 'disposable' || ", ''),
    ('the typed confirmation is case-insensitive', G,
     "request.typed_confirmation !== typedConfirmation(ref as string, runId as string)",
     "String(request.typed_confirmation).toUpperCase() !== typedConfirmation(ref as string, runId as string).toUpperCase()"),
    ('override-shaped fields are ignored', G, "    if (!allowed.includes(key)) reasons.push(", "    if (false) reasons.push("),
    ('any consent string is accepted', G, "      else if (!refOk || !runOk || given !== destructiveConsent(id, ref as string, runId as string)) reasons.push(`CONSENT_MISMATCH:${id}`);", ''),
    ('a consent for an unrequested scenario is accepted', G, "      else if (!scenarios.includes(e.id)) reasons.push(`CONSENT_FOR_UNREQUESTED:${key}`);", ''),
    ('Option D needs the user approval only', G, "isString(extra.user_approval_reference) && isString(extra.independent_security_review_reference)", 'isString(extra.user_approval_reference)'),
    ('duplicate scenarios are accepted', G, "      else if (scenarios.includes(id as ExperimentId)) reasons.push(`SCENARIO_DUPLICATE:${id}`);\n", ''),
    ('the CLI accepts --force', C, "(force|f|y|yes|", '(f|y|yes|'),
    ('the CLI follows a symlinked marker silently', C, "      markerPath = await deps.realPath(requested);", "      markerPath = requested; await deps.realPath(requested);"),
    ('the CLI echoes the project ref', C, "  return { code: guard.allowed ? 0 : 3, out: renderPlan(guard) };",
     "  return { code: guard.allowed ? 0 : 3, out: renderPlan(guard) + String((request as Record<string, unknown>)?.project_ref ?? '') };"),
    ('e-mail addresses are kept', R, "  { kind: 'email', pattern: /", "  { kind: 'email', pattern: /(?!)"),
    ('UUIDs are kept', R, "  { kind: 'uuid', pattern: /", "  { kind: 'uuid', pattern: /(?!)"),
    ('authorization codes are kept', R, "[?&#](?:code|state|", "[?&#](?:state|"),
    ('secret-named JSON fields are kept', R, "    kind: 'field',\n    pattern: /(", "    kind: 'field',\n    pattern: /(?!)("),
    ('redaction is salted by nothing (linkable across runs)', R, "encoder.encode(`${salt}|${kind}|${value}`)", "encoder.encode(`${kind}|${value}`)"),
    ('a PASS without evidence counts', E, "  if (result.evidence.length === 0) reasons.push('NO_EVIDENCE');\n", ''),
    ('UNKNOWN counts as PASS', E, "      if (outcome !== 'PASS') reasons.push(`${id}:${outcome}`);", "      if (outcome !== 'PASS' && outcome !== 'UNKNOWN') reasons.push(`${id}:${outcome}`);"),
    ('E4 LINKED without mitigation is accepted', E, "        if (!e4.e4Mitigation) reasons.push('E4:LINKED_WITHOUT_PROVEN_MITIGATION');", "        if (!e4.e4Mitigation) { /* accepted */ }"),
    ('E4 without a finding counts', E, "  if (result.id === 'E4' && !result.e4Finding) reasons.push('E4_FINDING_MISSING');\n", ''),
    ('a PR121 pass condition is reworded', K, "pass: '403 `user_banned`; no `auth.identities` row; no session',", "pass: '403 `user_banned`; no session',"),
    ('E11 loses its extra approval', K, "    extraApprovals: ['option_d_security_approval'],", '    extraApprovals: [],'),
    ('E6 claims it can be forced', K, "    forcing: 'statistical_only',", "    forcing: 'database_lock_latch',"),
    ('the harness gains a network call', C, "if (import.meta.main) {", "if (import.meta.main) {\n  await fetch('about:blank').catch(() => null);"),
    # --- Phase 3e: H2 E11 review R1-R5 -------------------------------------------------------------------
    ('R4 a self-declared witness record counts', W, "    if (r.self_declared === true) reasons.push(`WITNESS_SELF_DECLARED:${id}`);\n    else if (r.self_declared !== false)", "    if (r.self_declared !== false && r.self_declared !== true)"),
    ('R4 the two-person rule is dropped', W, "if (check.twoPerson && (r.second_observer === undefined || r.second_observer === r.observed_by))", 'if (false)'),
    ('R4 witness records of another run count', W, "(r as WitnessRecord).id === id && (r as WitnessRecord).run_id === runId", "(r as WitnessRecord).id === id"),
    ('R4 E11 no longer needs W5-W7', W, "    if (id === 'E11') for (const c of WITNESS_CHECKS) if (c.appliesTo === 'E11') needed.add(c.id);\n", ''),
    ('R4 a mismatching witness counts', W, "    else if (r.result === 'MISMATCH') reasons.push(`WITNESS_MISMATCH:${id}`);\n    else if (r.result !== 'MATCH')", "    else if (r.result !== 'MATCH' && r.result !== 'MISMATCH')"),
    ('R4 a destructive PASS no longer needs witness', E, "  if (isDestructive(result.id)) reasons.push(...evaluateWitness(context.witness, context.runId, requiredWitness([result.id], isDestructive)).reasons);\n", ''),
    ('R4 the guard calls its inputs verified', G, "    verification: 'SELF_DECLARED_INPUTS_NOT_VERIFIED',\n", "    verification: 'VERIFIED' as 'SELF_DECLARED_INPUTS_NOT_VERIFIED',\n"),
    ('R4 the plan stops warning that inputs are self-declared', P, "    lines.push(`  verification: ${guard.verification} (dry-run plan eligibility only; NOT verified consent, destination, reviewer, fake users or prior evidence)`);\n", ''),
    ('R1 zero denominators are accepted', X, "    for (const d of E11_DENOMINATORS) if (!isPositiveInt(c.denominators?.[d])) unknown.push(`E11_DENOMINATOR_ZERO:${name}:${d}`);\n", ''),
    ('R1 an expired token may be accepted', X, "const mustRefuse = kind === 'expired_old_jwt' || target === 'guarded_writer' || target === 'auth_get_user';", "const mustRefuse = target === 'guarded_writer' || target === 'auth_get_user';"),
    ('R1 a blind retry is tolerated', X, "  if (commit?.blindRetry !== false) fail.push('E11_BLIND_RETRY');\n", ''),
    ('R1 cohorts need not be comparable', X, "  if (a && s && (!HEX64.test(a.schemaFingerprintSha256)", "  if (false && a && s && (!HEX64.test(a.schemaFingerprintSha256)"),
    ('R1 cleanup may be inferred from the users row', X, "  if (e.cleanupInferredFromUsersRowOrCatalog !== false) unknown.push('E11_CLEANUP_INFERRED_NOT_MEASURED');\n", ''),
    ('R1 a changed failure branch is only unknown', X, "    if (got === 'CHANGED') fail.push(`E11_FAILURE_BRANCH_CHANGED_STATE:${b}`);\n    else if", "    if"),
    ('R1 recorded residue is not flagged', X, "        else if (got === 'ACCEPTED_RESIDUE_RECORDED') residue.push(`STALE_TOKEN_RESIDUE_RECORDED:${name}:${key}`);\n", ''),
    ('R1 the E11 matrix is not evaluated', E, "    const matrix = evaluateE11(result.e11);", "    const matrix = { outcome: 'PASS' as Outcome, reasons: [] as string[], residue: false };"),
    ('R1 residue does not block Option D', E, "      if (outcomes.get('E11') === 'PASS') for (const r of evaluateE11(byId.get('E11')?.e11).residue) reasons.push(`E11:${r}`);\n", ''),
    ('R2 Option D no longer needs the full-decision proof', E, "      if (!proof || proof.evidence.length === 0 || proof.independentlyReviewed !== true) reasons.push(`${OPTION_D_FULL_DECISION_PROOF.id}:MISSING`);\n", ''),
    ('R2 E11 claims the lifecycle lock again', K, "while holding only a login row latch (auth.users FOR UPDATE) -- NOT the lifecycle decision", 'under the lifecycle lock'),
    ('R2 the E11 scope label changes', X, "export const E11_PROBE_SCOPE = 'platform_permission_fk_cascade_row_latch_probe' as const;", "export const E11_PROBE_SCOPE = 'option_d_proof' as const;"),
    ('R3 the E4 bound is not evaluated', E, "        else for (const r of evaluateE4Bound(e4.e4Bound)) reasons.push(`E4:${r}`);\n", ''),
    ('R3 the settle need not cover the expiry', B, "    && bound.settleSeconds < bound.configuredFlowExpirySeconds", "    && false && bound.settleSeconds < bound.configuredFlowExpirySeconds"),
    ('R3 the last success may stand in for the expiry', B, "    && !(bound.expiredCallbackAttemptDelaySeconds > bound.configuredFlowExpirySeconds)) reasons.push('E4_BOUND_NO_CALLBACK_AFTER_EXPIRY');", "    && false) reasons.push('E4_BOUND_NO_CALLBACK_AFTER_EXPIRY');"),
    ('R3 started flows need not be drained', B, "  if (bound.inFlightDrainVerified !== true) reasons.push('E4_BOUND_IN_FLIGHT_NOT_DRAINED');\n", ''),
    ('R3 the order revoke -> ban -> drain -> re-check is not required', B, "  if (!Array.isArray(bound.sequence) || bound.sequence.join('>') !== E4_REQUIRED_SEQUENCE.join('>')) reasons.push('E4_BOUND_SEQUENCE');\n", ''),
    ('R5 the per-target read-back gains a write', T, "with probes(label, tbl, query) as (", "insert into public.p3e_probe values (1);\nwith probes(label, tbl, query) as ("),
    ('R5 the extended read-back takes a row lock', XR, "  select format('rls|%s.%s|enabled=%s|forced=%s', nspname, relname, relrowsecurity, relforcerowsecurity) as line from watched_tables", "  select format('rls|%s.%s|enabled=%s|forced=%s', nspname, relname, relrowsecurity, relforcerowsecurity) as line from watched_tables for update"),
    # --- Phase 3f: H2 PR130 rereview residuals R1 / R4 -----------------------------------------------------
    ('P3f non-token residue does not block D', X, "      } else if (after.remaining > 0) {\n        residue.push(`NON_TOKEN_RESIDUE_RECORDED:${name}:${kind}`);\n      }", "      }"),
    ('P3f after-state needs no read-back evidence', X, " || !isCount(after.remaining) || !hasEvidence(after.evidence)) {", " || !isCount(after.remaining)) {"),
    ('P3f the physical blob may come from a metadata count', X, "owned_objects_metadata: 'target_readback', owned_objects_blob: 'storage_service_readback',", "owned_objects_metadata: 'target_readback', owned_objects_blob: 'target_readback',"),
    ('P3f after-state may exceed the before-count', X, "      } else if (isPositiveInt(before) && after.remaining > before) {", "      } else if (false && isPositiveInt(before) && after.remaining > before) {"),
    ('P3f an invalid token value is accepted', X, "        if (!(E11_TOKEN_OUTCOMES as readonly unknown[]).includes(got)) unknown.push(`E11_TOKEN_INVALID:${name}:${key}`);\n        else if", "        if (false) unknown.push(`E11_TOKEN_INVALID:${name}:${key}`);\n        else if"),
    ('P3f an unresolved lost COMMIT is accepted', X, " || commit.resolution === 'UNKNOWN'", ""),
    ('P3f a lost COMMIT needs no independent read-back', X, "    || commit.resolvedByIndependentReadback !== true || !hasEvidence(commit.evidence)) {", "    || !hasEvidence(commit.evidence)) {"),
    ('P3f a missing self_declared flag is accepted', W, "    else if (r.self_declared !== false) reasons.push(`WITNESS_MALFORMED:${id}:self_declared`);\n", ''),
    ('P3f an unknown observer role is accepted', W, "    if (!ROLES.includes(r.observed_by)) reasons.push(`WITNESS_MALFORMED:${id}:observed_by`);\n", ''),
    ('P3f non-string evidence entries are accepted', W, " || !r.evidence.every((x) => typeof x === 'string' && x.length > 0)) reasons.push(`WITNESS_NO_EVIDENCE:${id}`);", ") reasons.push(`WITNESS_NO_EVIDENCE:${id}`);"),
]

def deno(root):
    return subprocess.run(['deno', 'test', '--no-config', '--no-check', '--allow-read', f'{root}/{REL}/'],
                          capture_output=True, text=True, cwd=root).returncode

def tree(tmp):
    root = os.path.join(tmp, 'repo')
    shutil.copytree(os.path.join(repo, REL), os.path.join(root, REL))
    os.makedirs(os.path.dirname(os.path.join(root, RUNBOOK)), exist_ok=True)
    shutil.copy(os.path.join(repo, RUNBOOK), os.path.join(root, RUNBOOK))
    return root

failures = []
with tempfile.TemporaryDirectory(prefix='kabumori-p3c-harness-mutations.', dir='/private/tmp') as tmp:
    root = tree(tmp)
    if deno(root) != 0:
        sys.exit('FAIL the unmutated control does not pass')
    print('CONTROL   PASS')
    for label, name, old, new in M:
        path = os.path.join(root, REL, name)
        original = open(path, encoding='utf-8').read()
        if original.count(old) != 1:
            failures.append(f'INVALID ({original.count(old)} sites)  {label}')
            continue
        open(path, 'w', encoding='utf-8').write(original.replace(old, new))
        try:
            code = deno(root)
        finally:
            open(path, 'w', encoding='utf-8').write(original)
        if code != 0:
            print(f'DETECTED  {label}')
        else:
            failures.append(f'SURVIVED  {label}')

for f in failures:
    print(f, file=sys.stderr)
if failures:
    print(f'FAIL {len(failures)} of {len(M)} mutations not detected', file=sys.stderr)
    sys.exit(1)
print(f'COMMON_ACCOUNT_DISPOSABLE_HARNESS_MUTATIONS_ALL_DETECTED {len(M)}/{len(M)}')
