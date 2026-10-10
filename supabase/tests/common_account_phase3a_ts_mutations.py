"""Mutation check for the common-account Phase 3a TypeScript tests. Copies the needed trees into a scratch root, applies one
mutation at a time to the COPY, runs the Deno suites there and requires a failure. The worktree is never
edited. Usage: python3 supabase/tests/common_account_phase3a_ts_mutations.py <repository root>"""
import os, shutil, subprocess, sys, tempfile

src_root = sys.argv[1]
TREES = ['supabase/functions', 'supabase/migrations', 'src', 'apps/kabumori-web', 'tests/app']
SUITES = ['supabase/functions/account-delete/', 'tests/app/account-deletion_test.ts', 'tests/app/settings-menu_test.ts']

L = 'supabase/functions/account-delete/lifecycle_logic.ts'
H = 'supabase/functions/account-delete/http.ts'
C = 'src/lib/account-deletion.ts'
A = 'supabase/functions/account-delete/apple_outcome.ts'
M = [
    ('another function reaches the Auth Admin API', 'NEW:supabase/functions/legacy-probe/index.ts',
     None, "await fetch(`${url}/auth/v1/admin/users/${id}`, { method: 'DELETE' });\n"),
    ('a new SQL login delete appears', 'NEW:supabase/migrations/20261010000000_probe.sql', None, 'delete from auth.users where id = $1;\n'),
    ('the legacy no-body call is routed to the deletion', H,
     "if (action !== 'preview' && action !== 'withdraw_kabumori' && action !== 'delete_common_account') {",
     "if (action !== undefined && action !== 'preview' && action !== 'withdraw_kabumori' && action !== 'delete_common_account') {"),
    ('the person token is sent to the RPCs', H,
     "headers: { ...service, 'Content-Type': 'application/json' },\n          body: JSON.stringify(args),",
     "headers: { ...service, Authorization: req.headers.get('Authorization') ?? '', 'Content-Type': 'application/json' },\n          body: JSON.stringify(args),"),
    ('the function calls the unowned Phase 1 readiness', H,
     "  owned_prepare: 'prepare_owned_common_account_auth_delete',", "  owned_prepare: 'prepare_common_account_auth_delete',"),
    ('the revalidation prepare is skipped', L, "  const stale = await prepare();", "  const stale = null;"),
    ('the revalidation Storage list is skipped', L, "  const recheck = await storageInventory(deps, userId);", "  const recheck = { objects: [], more: false, bucketsOwned: false };"),
    ('deletion without a recent re-authentication', L,
     "  if (body.confirmation !== DELETE_CONFIRMATION) return fail(400, 'CONFIRMATION_REQUIRED');\n  if (!recentlyAuthenticated(token, userId, deps.nowSeconds())) return fail(403, 'REAUTH_REQUIRED');",
     "  if (body.confirmation !== DELETE_CONFIRMATION) return fail(400, 'CONFIRMATION_REQUIRED');"),
    ('withdrawal without a recent re-authentication', L,
     "  if (record(input.body).confirmation !== WITHDRAW_CONFIRMATION) return fail(400, 'CONFIRMATION_REQUIRED');\n  if (!recentlyAuthenticated(token, user.id, deps.nowSeconds())) return fail(403, 'REAUTH_REQUIRED');",
     "  if (record(input.body).confirmation !== WITHDRAW_CONFIRMATION) return fail(400, 'CONFIRMATION_REQUIRED');"),
    ('C1: a future authentication time within a minute is accepted', L,
     "  return at !== null && at <= nowSeconds && nowSeconds - at <= RECENT_AUTH_SECONDS;",
     "  return at !== null && at <= nowSeconds + 60 && nowSeconds - at <= RECENT_AUTH_SECONDS;"),
    ('success before the read-back', L, "  // 11. Post-delete read-back.", "  if (deleted !== 'failed') return { status: 200, body: { ok: true, outcome: 'deleted' } };\n  // 11. Post-delete read-back."),
    ('a 404 is taken as success without verification', L, "  if (deleted === 'failed') {", "  if (deleted === 'not_found') return { status: 200, body: { ok: true, outcome: 'deleted' } };\n  if (deleted === 'failed') {"),
    ('R4: a residue on a completed deletion counts as success', L,
     "    if (done?.status === 'completed' && done.login_deleted === true) {",
     "    if ((done?.status === 'completed' || done?.status === 'residue_found') && done.login_deleted === true) {"),
    ('the X scope pre-check is skipped', L, "    if (preview?.scope !== 'social_only') return fail(409, 'X_CLEANUP_UNSUPPORTED');", "    void preview;"),
    ('R1: a second owner is not told "in progress"', L, "  if (claimed.status === 'in_progress') return fail(409, 'DELETION_IN_PROGRESS');\n", ""),
    ('R1: ownership is not given back', L, "    await call(deps, 'release', owner);", "    void owner;"),
    ('R1: a lost lease at the Storage checkpoint is ignored', L,
     "  if (storageCheckpoint === 'lease_lost') return lost();\n", ""),
    ('R2: the Apple intent is not recorded before the call', L,
     "    const intent = await call(deps, 'begin_external_step', { ...owner, p_step: 'apple_revocation' });",
     "    const intent = { status: 'owned' } as Record<string, unknown>;"),
    ('R2: an Apple success that could not be recorded is treated as recorded', L,
     "      if (settled?.status !== (outcome === 'succeeded' ? 'recorded' : 'cleared')) {", "      if (false) {"),
    ('R2: an unknown Apple outcome continues', L,
     "      if (outcome === 'unknown') return stop(fail(500, 'RECONCILIATION_REQUIRED', { sessionsRevoked }));\n", ""),
    ('R3: the release gate pre-check is skipped', L,
     "  if (!(await managedDeleteReleased(deps))) return fail(409, 'COMMON_ACCOUNT_DELETION_UNAVAILABLE');\n", ""),
    ('R3: a release-blocked intent is not reported as unavailable', L,
     "  if (intent?.status === 'release_blocked') return stop(fail(409, 'COMMON_ACCOUNT_DELETION_UNAVAILABLE', { sessionsRevoked }));\n", ""),
    ('R3: the managed delete runs without an owned intent', L,
     "  if (intent?.status !== 'owned') return stop(fail(500, 'FAILED', { sessionsRevoked }));\n\n  // 10.", "\n  // 10."),
    ('a failed managed delete with the login present is not settled', L,
     "      await call(deps, 'settle_external_step', { ...owner, p_step: 'managed_auth_delete', p_outcome: 'failed' });\n", ""),
    ('Storage that never empties counts as clean', L, "    if (pass === STORAGE_PASSES) return 'not_empty';", "    if (pass === STORAGE_PASSES) return 'clean';"),
    ('a resumed deletion ignores the version shown', L,
     "  if (begun.status === 'in_progress' && begun.lifecycle_version !== expected) return fail(409, 'LIFECYCLE_CHANGED');\n", ""),
    ('a body-supplied user id is used', L, "  const { token, user } = caller;\n  const userId = user.id;\n  const body = record(input.body);",
     "  const { token, user } = caller;\n  const userId = typeof (input.body as Record<string, unknown>)?.p_user_id === 'string' ? (input.body as Record<string, string>).p_user_id : user.id;\n  const body = record(input.body);"),
    ('withdrawal allowed during a whole-account deletion', L,
     "  if (state.accountStatus === 'deleting') return fail(409, 'WITHDRAW_BLOCKED', { reasons: ['ACCOUNT_DELETION_IN_PROGRESS'] });\n", ""),
    ('a failed session revocation is ignored', L, "  if (!revoked) return stop(fail(502, 'SESSION_REVOKE_FAILED'));", "  void revoked;"),
    ('X failure is ignored', L, "    if (outcome !== 'done') return stop(fail(502, 'X_CLEANUP_FAILED'));", "    if (outcome !== 'done' && outcome !== 'failed') return stop(fail(502, 'X_CLEANUP_FAILED'));"),
    ('the server logs the person', L, "  const { token, user } = caller;\n  const userId = user.id;\n  const body = record(input.body);",
     "  const { token, user } = caller;\n  const userId = user.id;\n  console.log('deleting', userId);\n  const body = record(input.body);"),
    ('an unknown reason code is passed through', L, "const reasonCode = (value: unknown) => ((REASON_CODES as readonly unknown[]).includes(value) ? value as string : 'UNKNOWN');",
     "const reasonCode = (value: unknown) => String(value);"),
    ('the client sends the user id', C, "  const result = await invokeSafely(client, 'withdraw_kabumori', { confirmation: WITHDRAW_CONFIRMATION }, fresh.accessToken);",
     "  const result = await invokeSafely(client, 'withdraw_kabumori', { confirmation: WITHDRAW_CONFIRMATION, user_id: signed.userId }, fresh.accessToken);"),
    ('the client accepts any 200 as a deletion', C, "  if (result.status === 200 && body.ok === true && body.outcome === 'deleted') return { ok: true };",
     "  if (result.status === 200) return { ok: true };"),
    ('the client does not check that the fresh sign-in is the same person', C, "  if (reauth.userId !== signed.userId) {", "  if (false) {"),
    ('the client shows Apple people a deletion it cannot complete', C,
     "  if (preview.apple.required && preview.apple.codeRequired) return { available: false, message: APPLE_UNSUPPORTED_MESSAGE };\n", ""),
    ('R3: the client offers a deletion the server keeps closed', C,
     "  if (!preview.deletionAvailable) return { available: false, message: DELETION_UNAVAILABLE_MESSAGE };\n", ""),
    ('R2: the client does not treat a reconciliation as an operator follow-up', C,
     " || code === 'RECONCILIATION_REQUIRED';", ";"),
    # --- H2 rereview R2: the Apple outcome must never call an ambiguous answer a failure ---------------
    ('R2b: the production adapter reverts to the boolean X helper', H,
     "      revokeApple: apple ? (code, subjects) => revokeAppleGrantOutcome(apple, code, subjects, Math.floor(Date.now() / 1000), fetchImpl) : null,",
     "      revokeApple: apple ? async (code, subjects) => ((await import('../social-mobile-account-delete/apple_revoke.ts')).revokeAppleGrant(apple, code, subjects, Math.floor(Date.now() / 1000), fetchImpl).then((ok) => (ok ? 'succeeded' : 'definitively_failed'))) : null,"),
    ('R2b: a gateway error after the revocation is called a failure', A,
     "  return revoked.ok ? 'succeeded' : 'unknown';", "  return revoked.ok ? 'succeeded' : 'definitively_failed';"),
    ('R2b: a lost token-endpoint answer is called a failure', A,
     "    return 'unknown'; // sent, answer lost: the code may have been consumed", "    return 'definitively_failed';"),
    ('R2b: any non-2xx token answer is called a failure', A,
     "    await discard(exchanged);\n    return 'unknown';", "    await discard(exchanged);\n    return 'definitively_failed';"),
    ('R2b: an unrecognised 400 is called a failure', A,
     "      if (typeof refusal?.error === 'string' && REFUSED_TOKEN_REQUEST.has(refusal.error)) return 'definitively_failed';\n      return 'unknown';",
     "      return 'definitively_failed';"),
    ('R2b: an unexpected identity after consumption is called a failure', A,
     "  if (!subject || !expectedSubjects.includes(subject)) return 'unknown';", "  if (!subject || !expectedSubjects.includes(subject)) return 'definitively_failed';"),
    ('R2b: the orchestrator maps any non-success to a failure', L,
     "        outcome = answer === 'succeeded' || answer === 'definitively_failed' ? answer : 'unknown';",
     "        outcome = answer === 'succeeded' ? 'succeeded' : 'definitively_failed';"),
]

def run(root):
    cmd = ['deno', 'test', '--no-config', '--no-check', '--allow-read', *SUITES]
    return subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=600).returncode

detected = 0
for label, target, old, new in M:
    root = tempfile.mkdtemp(prefix='p3a-mut-', dir=os.environ.get('SCRATCH', None))
    try:
        for tree in TREES:
            shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
        if target.startswith('NEW:'):
            path = os.path.join(root, target[4:])
            os.makedirs(os.path.dirname(path), exist_ok=True)
            open(path, 'w').write(new)
        else:
            path = os.path.join(root, target)
            text = open(path, encoding='utf-8').read()
            if text.count(old) != 1:
                print(f'INVALID   {label} (site matched {text.count(old)} times)'); continue
            open(path, 'w', encoding='utf-8').write(text.replace(old, new))
        code = run(root)
        if code != 0:
            detected += 1
            print(f'DETECTED  {label}')
        else:
            print(f'SURVIVED  {label}')
    finally:
        shutil.rmtree(root, ignore_errors=True)
# Control: the unmutated copy passes.
root = tempfile.mkdtemp(prefix='p3a-ctl-', dir=os.environ.get('SCRATCH', None))
for tree in TREES:
    shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
control = run(root)
shutil.rmtree(root, ignore_errors=True)
print(f'CONTROL   {"PASS" if control == 0 else "FAIL"}')
print(f'TS_MUTATIONS {detected}/{len(M)} detected')
sys.exit(0 if detected == len(M) and control == 0 else 1)
