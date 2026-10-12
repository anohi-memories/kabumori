"""Mutation check for the Phase 4 provider cleanup port and its place in the whole-account deletion. Copies the
needed trees into a scratch root, applies one mutation at a time to the COPY, runs the account-delete Deno
suite there and requires a failure. The worktree is never edited.
Usage: python3 supabase/tests/common_account_phase4_ts_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/functions', 'supabase/migrations', 'src', 'apps/kabumori-web']
SUITE = 'supabase/functions/account-delete/'
L = 'supabase/functions/account-delete/lifecycle_logic.ts'
P = 'supabase/functions/account-delete/provider_cleanup.ts'
FINISH_CALL = ("    // The POSTONA entitlement is ended only once every other provider of the service is settled (T10).\n"
               "    const providerFailure = await providerStep();\n    if (providerFailure) return providerFailure;\n")
ELSE_CALL = ("    // POSTONA was never started or already ended: a provider credential may still be there (T10).\n"
             "    const providerFailure = await providerStep();\n    if (providerFailure) return providerFailure;\n")
# Not mutated on purpose: the orchestrator's own `owned()` right before the POSTONA entitlement ends. The port
# already asked the database as the last thing every adapter does (after its read or after its cleanup), with
# no await in between, so no behavior depends on it: an equivalent mutant kept as defence in depth (H4-P4-R1
# asked for a check before finish_service_deletion; the port's check IS that check, this one makes it
# independent of the port's internals).
M = [
    ('the provider step never runs', L, "    const report = await runProviderCleanups(adapters, userId, { stillOwned: owned });",
     "    const report = { decision: 'proceed' as const, providers: [], remoteUnverified: [] as string[] };"),
    ('reconciliation is not a stop', L, "    if (report.decision === 'reconciliation_required') {", "    if (false as boolean) {"),
    ('blocked is not a stop', L, "    if (report.decision === 'blocked') return stop(fail(409, 'PROVIDER_CLEANUP_BLOCKED', { sessionsRevoked, providers: report.providers }));\n", ""),
    ('remote-unverified is always accepted', L, "    if (remoteUnverified.length > 0 && deps.acceptRemoteUnverified !== true) {", "    if (false as boolean) {"),
    ('a stale owner still calls the adapters', L, "    if (!(await owned())) return lost();\n    // Ownership is asked again", "    // Ownership is asked again"),
    ('a lost lease reported by the port is not a stop', L, "    if (report.decision === 'lease_lost') return lost();\n", ""),
    ('R1: the lease is not asked after the read (a stale owner calls the destructive cleanup)', P,
     "    if (!(await ownedNow(stillOwned))) return 'lease_lost';\n    if (connected === false) return 'not_connected';",
     "    if (connected === false) return 'not_connected';"),
    ('R1: the lease is not asked after the cleanup (a stale owner\'s answer is used)', P,
     "    if (!(await ownedNow(stillOwned))) return 'lease_lost';\n    return (PROVIDER_OUTCOMES",
     "    return (PROVIDER_OUTCOMES"),
    ('R1: a lost lease does not stop the next adapter', P, "      break; // no further adapter is called by a stale owner\n", ""),
    ('R1: the adapter is told it always owns the deletion', P,
     "    stillOwned: async () => open && await ownedNow(stillOwned),", "    stillOwned: async () => true,"),
    ('R1: an abandoned adapter keeps its ownership view after a timeout', P,
     "    open = false;\n    abort.abort();\n", ""),
    ('R1: an ownership question that throws is read as owned', P,
     "    return (await stillOwned()) === true;\n  } catch {\n    return false;", "    return (await stillOwned()) === true;\n  } catch {\n    return true;"),
    ('POSTONA ends before its providers are settled', L, FINISH_CALL, ""),
    ('a leftover provider behind an ended POSTONA is not cleaned', L, ELSE_CALL, ""),
    ('the success answer drops the providers to revoke by hand', L,
     "body: { ok: true, outcome: 'deleted', ...(remoteUnverified.length ? { remote_unverified: remoteUnverified } : {}) }",
     "body: { ok: true, outcome: 'deleted' }"),
    ('the port lets blocked outrank reconciliation', P,
     "    : has('reconciliation_required', 'unreadable') ? 'reconciliation_required'\n    : has('blocked', 'invalid') ? 'blocked'",
     "    : has('blocked', 'invalid') ? 'blocked'\n    : has('reconciliation_required', 'unreadable') ? 'reconciliation_required'"),
    ('the port accepts an unknown outcome as confirmed', P,
     "  return (PROVIDER_OUTCOMES as readonly unknown[]).includes(outcome) ? outcome as ProviderOutcome : 'reconciliation_required';",
     "  return (PROVIDER_OUTCOMES as readonly unknown[]).includes(outcome) ? outcome as ProviderOutcome : 'confirmed_remote_revoked';"),
    ('the port reads an unreadable presence as absent', P, "  if (connected !== true) return 'unreadable';", "  if (connected !== true) return 'not_connected';"),
    ('the port lets a reserved provider key run', P, " && !RESERVED_PROVIDER_KEYS.includes(key)", ""),
    ('the port lets a duplicate provider key run', P, " && keys.indexOf(key) === keys.lastIndexOf(key)", ""),
    ('the port has no timeout on cleanup', P, "      outcome = await within(adapter.cleanup(userId, context), timeoutMs);", "      outcome = await adapter.cleanup(userId, context);"),
    ('an adapter failure stops the other adapters', P,
     "    if (result === 'lease_lost') {\n      leaseLost = true;\n      break; // no further adapter is called by a stale owner\n    }\n",
     "    if (result === 'lease_lost') {\n      leaseLost = true;\n      break;\n    }\n    if (result !== 'not_connected' && result !== 'confirmed_remote_revoked' && result !== 'local_removed_remote_unverified') break;\n"),
]


def run(root):
    try:
        return subprocess.run(['deno', 'test', '--no-config', '--no-check', '--allow-read', '--allow-env', SUITE],
                              cwd=root, capture_output=True, text=True, timeout=90).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy(prefix):
    root = tempfile.mkdtemp(prefix=prefix, dir=os.environ.get('SCRATCH', None))
    for tree in TREES:
        shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
    return root


root = fresh_copy('p4-ctl-')
control = run(root)
shutil.rmtree(root, ignore_errors=True)
print(f'CONTROL   {"PASS" if control == 0 else "FAIL"}')
if control != 0:
    sys.exit(1)
detected = 0
for label, target, old, new in M:
    root = fresh_copy('p4-mut-')
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
