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
    ('the revalidation prepare is skipped', L, "  const stale = await prepare();\n  if (stale) return stop(stale);\n", "  const stale = null;\n  if (stale) return stop(stale);\n"),
    ('the revalidation Storage list is skipped', L, "  const recheck = await storageInventory(deps, userId);", "  const recheck = { objects: [], more: false, bucketsOwned: false };"),
    ('deletion without a recent re-authentication', L,
     "  if (body.confirmation !== DELETE_CONFIRMATION) return fail(400, 'CONFIRMATION_REQUIRED');\n  if (!recentlyAuthenticated(token, user, deps)) return fail(403, 'REAUTH_REQUIRED');",
     "  if (body.confirmation !== DELETE_CONFIRMATION) return fail(400, 'CONFIRMATION_REQUIRED');"),
    ('withdrawal without a recent re-authentication', L,
     "  if (record(input.body).confirmation !== WITHDRAW_CONFIRMATION) return fail(400, 'CONFIRMATION_REQUIRED');\n  if (!recentlyAuthenticated(token, user, deps)) return fail(403, 'REAUTH_REQUIRED');",
     "  if (record(input.body).confirmation !== WITHDRAW_CONFIRMATION) return fail(400, 'CONFIRMATION_REQUIRED');"),
    ('success before the read-back', L, "  // 10. Post-delete read-back.", "  if (deleted !== 'failed') return { status: 200, body: { ok: true, outcome: 'deleted' } };\n  // 10. Post-delete read-back."),
    ('a 404 is taken as success without verification', L, "  if (deleted === 'failed') {", "  if (deleted === 'not_found') return { status: 200, body: { ok: true, outcome: 'deleted' } };\n  if (deleted === 'failed') {"),
    ('the X scope pre-check is skipped', L, "    if (preview?.scope !== 'social_only') return fail(409, 'X_CLEANUP_UNSUPPORTED');", "    void preview;"),
    ('Apple is revoked again on a retry', L, "  if (apple && !appleDone) {\n    let ok = false;", "  if (apple) {\n    let ok = false;"),
    ('Storage that never empties counts as clean', L, "    if (pass === STORAGE_PASSES) return 'not_empty';", "    if (pass === STORAGE_PASSES) return 'clean';"),
    ('a resumed deletion ignores the version shown', L,
     "  if (begun.status === 'in_progress' && begun.lifecycle_version !== expected) return fail(409, 'LIFECYCLE_CHANGED');\n", ""),
    ('a body-supplied user id is used', L, "  const userId = user.id;", "  const userId = typeof (input.body as Record<string, unknown>)?.p_user_id === 'string' ? (input.body as Record<string, string>).p_user_id : user.id;"),
    ('withdrawal allowed during a whole-account deletion', L,
     "  if (state.accountStatus === 'deleting') return fail(409, 'WITHDRAW_BLOCKED', { reasons: ['ACCOUNT_DELETION_IN_PROGRESS'] });\n", ""),
    ('a failed session revocation is ignored', L, "  if (!revoked) return stop(fail(502, 'SESSION_REVOKE_FAILED'));", "  void revoked;"),
    ('X failure is ignored', L, "    if (outcome !== 'done') return stop(fail(502, 'X_CLEANUP_FAILED'));", "    if (outcome !== 'done' && outcome !== 'failed') return stop(fail(502, 'X_CLEANUP_FAILED'));"),
    ('the server logs the person', L, "  const userId = user.id;", "  const userId = user.id;\n  console.log('deleting', userId);"),
    ('an unknown reason code is passed through', L, "const reasonCode = (value: unknown) => ((REASON_CODES as readonly unknown[]).includes(value) ? value as string : 'UNKNOWN');",
     "const reasonCode = (value: unknown) => String(value);"),
    ('the client sends the user id', C, "  const result = await invokeSafely(client, 'withdraw_kabumori', { confirmation: WITHDRAW_CONFIRMATION }, fresh.accessToken);",
     "  const result = await invokeSafely(client, 'withdraw_kabumori', { confirmation: WITHDRAW_CONFIRMATION, user_id: signed.userId }, fresh.accessToken);"),
    ('the client accepts any 200 as a deletion', C, "  if (result.status === 200 && body.ok === true && body.outcome === 'deleted') return { ok: true };",
     "  if (result.status === 200) return { ok: true };"),
    ('the client does not check that the fresh sign-in is the same person', C, "  if (reauth.userId !== signed.userId) {", "  if (false) {"),
    ('the client shows Apple people a deletion it cannot complete', C,
     "  if (preview.apple.required && preview.apple.codeRequired) return { available: false, message: APPLE_UNSUPPORTED_MESSAGE };\n", ""),
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
