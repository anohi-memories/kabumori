"""Mutation check for the Phase 8 TypeScript changes of supabase/functions/account-delete (the typed X bridge, the
durable unconfirmed-post fact and its read-back, the fail-closed read of the record). Copies the needed trees into a
scratch root, applies ONE mutation at a time to the COPY, runs the account-delete Deno suite there and requires a
failure. The worktree is never edited.
Usage: python3 supabase/tests/common_account_phase8_ts_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/functions', 'supabase/migrations', 'src', 'apps/kabumori-web']
SUITE = 'supabase/functions/account-delete/'
L = 'supabase/functions/account-delete/lifecycle_logic.ts'
H = 'supabase/functions/account-delete/http.ts'
M = [
    ('the unconfirmed count is not recorded before the end', L,
     "      for (let attempt = 0; attempt < FACT_ATTEMPTS && fact?.status !== 'recorded' && fact?.status !== 'lease_lost'; attempt++) {\n        fact = await call(deps, 'record_reconciliation', { ...own, p_fact: 'x_posts_unconfirmed', p_count: unconfirmedPosts });\n      }\n",
     ""),
    ('a failed record of the count does not stop the end', L,
     "      if (fact?.status !== 'recorded') {\n        await record('x', 'reconciliation_required');\n        return refuse(fail(500, 'FAILED', { xPostsUnconfirmed: unconfirmedPosts }));\n      }\n",
     ""),
    ('a failed record of the count leaves X recorded as done', L,
     "        await record('x', 'reconciliation_required');\n        return refuse(fail(500, 'FAILED', { xPostsUnconfirmed: unconfirmedPosts }));",
     "        await record('x', 'done');\n        return refuse(fail(500, 'FAILED', { xPostsUnconfirmed: unconfirmedPosts }));"),
    ('the person is not told the count when it cannot be recorded', L,
     "        return refuse(fail(500, 'FAILED', { xPostsUnconfirmed: unconfirmedPosts }));",
     "        return refuse(fail(500, 'FAILED'));"),
    ('the count is offered only once (no retry)', L,
     "const FACT_ATTEMPTS = 3;", "const FACT_ATTEMPTS = 1;"),
    ('a lost lease while the count is recorded does not stop the end', L,
     "      if (fact?.status === 'lease_lost') return { ok: false, response: args.lost() };\n      if (fact?.status !== 'recorded') {",
     "      if (fact?.status !== 'recorded') {"),
    ('the saga\'s checkpoint is never acknowledged', L,
     "      await call(deps, 'ack_x_unconfirmed', { p_user_id: userId, p_expected: unconfirmedPosts });\n", ""),
    ('the saga\'s checkpoint is acknowledged with another count', L,
     "{ p_user_id: userId, p_expected: unconfirmedPosts }", "{ p_user_id: userId, p_expected: 1 }"),
    ('a failed acknowledgement stops the end', L,
     "      await call(deps, 'ack_x_unconfirmed', { p_user_id: userId, p_expected: unconfirmedPosts });\n",
     "      if (!(await call(deps, 'ack_x_unconfirmed', { p_user_id: userId, p_expected: unconfirmedPosts }))) return refuse(fail(500, 'FAILED'));\n"),
    ('the final answer ignores the durable (sticky) count', L,
     "      xPostsUnconfirmed: Math.max(facts.xPostsUnconfirmed, unconfirmedPosts),",
     "      xPostsUnconfirmed: unconfirmedPosts,"),
    ('an already-ended request hides the durable count and providers', L,
     "    const facts = await endFacts(deps, user.id);\n    if (!facts) return fail(500, 'FAILED');\n",
     "    const facts = NO_FACTS;\n"),
    ('an unreadable record is treated as "nothing on record" when ended', L,
     "    const facts = await endFacts(deps, user.id);\n    if (!facts) return fail(500, 'FAILED');\n",
     "    const facts = (await endFacts(deps, user.id)) ?? NO_FACTS;\n"),
    ('an end starts although the record of an earlier end cannot be read', L,
     "    if ((await endFacts(deps, userId)) === null) return refuse(fail(500, 'FAILED'));\n",
     ""),
    ('a readable-looking but malformed record is accepted', L,
     "  if (!data || typeof data.status !== 'string') return null;\n  if (data.status === 'none') return NO_FACTS;",
     "  if (!data) return null;\n  if (data.status === 'none' || typeof data.status !== 'string') return NO_FACTS;"),
    ('the answer to a retry does not carry the unconfirmed count', L,
     "      ...(ended.xPostsUnconfirmed > 0 ? { x_posts_unconfirmed: ended.xPostsUnconfirmed } : {}),\n    },\n  };\n}\n\n// ----",
     "    },\n  };\n}\n\n// ----"),
    ('the typed reasons of a blocked X are not passed on', L,
     "    const xReasons = xReason ? { reasons: [reasonCode(xReason)] } : {};",
     "    const xReasons = {};"),
    ('a scope refusal of the saga is not refused', L,
     "    if (outcome === 'scope_refused') return refuse(fail(409, 'X_CLEANUP_UNSUPPORTED'));\n",
     ""),
    ('a saga that is still running is treated as failed', L,
     "    if (outcome === 'in_progress') return refuse(fail(409, 'X_CLEANUP_IN_PROGRESS'));\n",
     ""),
    ('the saga that deleted the login is not a stop', L,
     "    if (outcome === 'login_deleted') return { ok: false, response: fail(500, 'DELETION_VERIFICATION_PENDING') };\n",
     ""),
    ('a malformed unconfirmed count is read as done', H,
     "    if (unconfirmed !== undefined && !(typeof unconfirmed === 'number' && Number.isInteger(unconfirmed) && unconfirmed > 0)) return { outcome: 'failed' };\n",
     ""),
    ('an unknown block reason is a retryable block', H,
     "    return (X_BLOCK_REASONS as readonly string[]).includes(reason) ? { outcome: 'blocked', reason } : { outcome: 'failed' };",
     "    return { outcome: 'blocked', reason };"),
    ('the saga\'s failure reason is dropped', H,
     "  if (error === 'X_REVOKE_FAILED' || error === 'CREDENTIALS_CHANGED' || error === 'FINALIZE_FAILED') return { outcome: 'failed', reason: error };\n",
     ""),
    ('login_deleted without the flag is a clean done', H,
     "    if (data.login_deleted !== false) return { outcome: 'failed' };\n",
     ""),
    ('the operator hand-off is not a block', H,
     "  if (error === 'DELETION_OPERATOR_REQUIRED') return { outcome: 'blocked', reason: 'OPERATOR_REQUIRED' };\n",
     ""),
]


def run(root):
    try:
        return subprocess.run(['deno', 'test', '--no-config', '--no-check', '--allow-read', '--allow-env', SUITE],
                              cwd=root, capture_output=True, text=True, timeout=180).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy(prefix):
    root = tempfile.mkdtemp(prefix=prefix, dir=os.environ.get('SCRATCH', None))
    for tree in TREES:
        shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
    return root


root = fresh_copy('p8-ctl-')
control = run(root)
shutil.rmtree(root, ignore_errors=True)
print(f'CONTROL   {"PASS" if control == 0 else "FAIL"}')
if control != 0:
    sys.exit(1)
detected = 0
for label, target, old, new in M:
    root = fresh_copy('p8-mut-')
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
