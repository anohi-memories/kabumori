"""Mutation check for the Phase 6 POSTONA end (account-delete/lifecycle_logic.ts endPostona and its handlers).
Copies the needed trees into a scratch root, applies one mutation at a time to the COPY, runs the account-delete
Deno suite there and requires a failure. The worktree is never edited.
Usage: python3 supabase/tests/common_account_phase6_ts_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/functions', 'supabase/migrations', 'src', 'apps/kabumori-web']
SUITE = 'supabase/functions/account-delete/'
L = 'supabase/functions/account-delete/lifecycle_logic.ts'
M = [
    ('the service lease is not claimed before X is touched', L,
     "  const claimed = await call(deps, 'claim_service', {",
     "  const claimed = { status: 'acquired', lease: '00000000-0000-4000-8000-0000000000aa' } as Record<string, unknown> | null; void { "),
    ('the acknowledgement is not recorded before the removal', L,
     "      const ack = await call(deps, 'acknowledge_unverified', { ...own, p_providers: needsAck });\n      if (ack?.status === 'lease_lost') return { ok: false, response: args.lost() };\n      if (ack?.status !== 'recorded') return refuse(fail(500, 'FAILED'));\n",
     ""),
    ('a missing acknowledgement does not stop the end', L,
     "    if (lacking.length > 0) {\n      return refuse(fail(409, 'REMOTE_UNVERIFIED_ACK_REQUIRED'",
     "    if (false as boolean) {\n      return refuse(fail(409, 'REMOTE_UNVERIFIED_ACK_REQUIRED'"),
    ('a connected provider without an adapter does not stop the end', L,
     "    if (missing.length > 0) {\n      for (const provider of missing) await record(provider, 'blocked');",
     "    if (false as boolean) {\n      for (const provider of missing) await record(provider, 'blocked');"),
    ('the read-only preflight is skipped before anything changes', L,
     "  const refusal = postonaPreflight(deps, snapshot, acknowledged);\n  if (refusal) return refusal;\n", ""),
    ('X is not recorded', L,
     "    const xRecorded = await record('x', outcome === 'done' ? 'done' : outcome === 'blocked' ? 'blocked' : 'reconciliation_required');\n    if (!xRecorded) return { ok: false, response: args.lost() };\n",
     ""),
    ('a blocked X is recorded as done', L,
     "await record('x', outcome === 'done' ? 'done' : outcome === 'blocked' ? 'blocked' : 'reconciliation_required');",
     "await record('x', 'done');"),
    ('an unreadable provider is recorded as not connected', L,
     "blocked: 'blocked', unreadable: 'reconciliation_required', invalid: 'blocked',",
     "blocked: 'blocked', unreadable: 'not_connected', invalid: 'blocked',"),
    ('provider answers are not recorded', L,
     "        if (durable && !(await record(item.provider, durable))) return { ok: false, response: args.lost() };\n", ""),
    ('an unexpected unverified remote grant needs nobody', L,
     "        if (deps.acceptRemoteUnverified !== true) {\n          return refuse(fail(409, 'PROVIDER_REMOTE_UNVERIFIED', { providers: report.providers }));\n        }\n",
     ""),
    ('an account deletion in progress does not block ending POSTONA alone', L,
     "  if (state.accountStatus === 'deleting') return fail(409, 'WITHDRAW_BLOCKED', { reasons: ['ACCOUNT_DELETION_IN_PROGRESS'] });\n  if (state.accountStatus === 'locked')",
     "  if (state.accountStatus === 'locked')"),
    ('the lease is not released', L,
     "    await call(deps, 'release_service', own);\n", "    void own;\n"),
    ('a lost lease reported by the port is not a stop (POSTONA)', L,
     "      if (report.decision === 'lease_lost') return { ok: false, response: args.lost() };\n      for (const item of report.providers) {",
     "      for (const item of report.providers) {"),
    ('a removal already on record is ended without the person\'s consent', L,
     "    if (withheld.length > 0) {\n      return refuse(fail(409, 'REMOTE_UNVERIFIED_ACK_REQUIRED', {",
     "    if (false as boolean) {\n      return refuse(fail(409, 'REMOTE_UNVERIFIED_ACK_REQUIRED', {"),
    ('the consent of the retry is not recorded', L,
     "    if (unacknowledged.length > 0) {\n      const ack = await call(deps, 'acknowledge_unverified', { ...own, p_providers: unacknowledged });\n      if (ack?.status === 'lease_lost') return { ok: false, response: args.lost() };\n      if (ack?.status !== 'recorded') return refuse(fail(500, 'FAILED'));\n    }\n",
     ""),
    ('a consent already on record is asked for again', L,
     "    const acknowledgedOnRecord = strings(claimed.acknowledged) ?? [];\n",
     "    const acknowledgedOnRecord: string[] = [];\n"),
    ('the whole-account flow does not present its own lease', L,
     "...(scope.kind === 'account' ? { p_account_operation_id: scope.operationId, p_account_lease: scope.lease } : {}),",
     "...{},"),
    ('the whole-account flow ends POSTONA without the owned path', L,
     "  const ended = await endPostona({\n    deps, token, userId, scope: { kind: 'account', operationId, lease: owner.p_lease, owned }, acknowledged,\n    stop, lost,\n  });",
     "  const ended = { ok: true as const, outcome: 'ended' as const, providers: {} as Record<string, string>, remoteUnverified: [] as string[] };"),
]


def run(root):
    try:
        return subprocess.run(['deno', 'test', '--no-config', '--no-check', '--allow-read', '--allow-env', SUITE],
                              cwd=root, capture_output=True, text=True, timeout=120).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy(prefix):
    root = tempfile.mkdtemp(prefix=prefix, dir=os.environ.get('SCRATCH', None))
    for tree in TREES:
        shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
    return root


root = fresh_copy('p6-ctl-')
control = run(root)
shutil.rmtree(root, ignore_errors=True)
print(f'CONTROL   {"PASS" if control == 0 else "FAIL"}')
if control != 0:
    sys.exit(1)
detected = 0
for label, target, old, new in M:
    root = fresh_copy('p6-mut-')
    try:
        path = os.path.join(root, target)
        text = open(path, encoding='utf-8').read()
        if text.count(old) != 1:
            print(f'INVALID   {label} (site matched {text.count(old)} times)')
            continue
        open(path, 'w', encoding='utf-8').write(text.replace(old, new))
        if run(root) != 0:
            detected += 1
            print(f'DETECTED  {label}')
        else:
            print(f'SURVIVED  {label}')
    finally:
        shutil.rmtree(root, ignore_errors=True)
print(f'{detected}/{len(M)} detected')
sys.exit(0 if detected == len(M) else 1)
