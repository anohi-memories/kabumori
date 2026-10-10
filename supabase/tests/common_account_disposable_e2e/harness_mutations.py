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
    ('a PASS without evidence counts', E, "  if (result.outcome === 'PASS' && result.evidence.length === 0) return 'UNKNOWN';\n", ''),
    ('UNKNOWN counts as PASS', E, "      if (outcome !== 'PASS') reasons.push(`${id}:${outcome}`);", "      if (outcome !== 'PASS' && outcome !== 'UNKNOWN') reasons.push(`${id}:${outcome}`);"),
    ('E4 LINKED without mitigation is accepted', E, "&& !e4.e4Mitigation) reasons.push('E4:LINKED_WITHOUT_PROVEN_MITIGATION');", "&& false) reasons.push('E4:LINKED_WITHOUT_PROVEN_MITIGATION');"),
    ('E4 without a finding counts', E, "  if (result.id === 'E4' && result.outcome === 'PASS' && !result.e4Finding) return 'UNKNOWN';\n", ''),
    ('a PR121 pass condition is reworded', K, "pass: '403 `user_banned`; no `auth.identities` row; no session',", "pass: '403 `user_banned`; no session',"),
    ('E11 loses its extra approval', K, "    extraApprovals: ['option_d_security_approval'],", '    extraApprovals: [],'),
    ('E6 claims it can be forced', K, "    forcing: 'statistical_only',", "    forcing: 'database_lock_latch',"),
    ('the harness gains a network call', C, "if (import.meta.main) {", "if (import.meta.main) {\n  await fetch('about:blank').catch(() => null);"),
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
