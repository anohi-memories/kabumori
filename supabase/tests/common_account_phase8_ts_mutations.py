"""Mutation check for the Phase 8 and Phase 10 TypeScript changes of supabase/functions/account-delete (the typed X
bridge, the durable unconfirmed-post fact and its read-back, the fail-closed read of the record, and Phase 10's
snapshot-bound acknowledgement of F3's checkpoint). Copies the needed trees into a
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
X = 'supabase/functions/account-delete/x_unconfirmed.ts'
M = [
    # -- Phase 8 properties, restated for the pair (count + evidence-set snapshot) of Phase 10 ------------------------
    ('the unconfirmed pair is not recorded before the end', L,
     "      for (let attempt = 0; attempt < FACT_ATTEMPTS && fact?.status !== 'recorded' && fact?.status !== 'lease_lost'; attempt++) {\n        fact = name === null\n          ? await call(deps, 'record_reconciliation', { ...own, p_fact: 'x_posts_unconfirmed', p_count: n })\n          : await call(deps, 'record_x_unconfirmed', { ...own, p_count: n, p_snapshot: name });\n      }\n      return fact?.status === 'recorded' ? 'recorded' : fact?.status === 'lease_lost' ? 'lease_lost' : 'failed';",
     "      return 'recorded';"),
    ('a failed record of the pair does not stop the end', L,
     "      if (kept !== 'recorded') return { kind: 'stop', response: fail(500, 'FAILED', { xPostsUnconfirmed: highest }) };\n",
     ""),
    ('a failed record of the pair leaves X recorded as done', L,
     "      if (settled.kind === 'stop') {\n        await record('x', 'reconciliation_required');\n        return refuse(settled.response);\n      }",
     "      if (settled.kind === 'stop') {\n        await record('x', 'done');\n        return refuse(settled.response);\n      }"),
    ('the person is not told the count when the pair cannot be recorded', L,
     "      if (kept !== 'recorded') return { kind: 'stop', response: fail(500, 'FAILED', { xPostsUnconfirmed: highest }) };",
     "      if (kept !== 'recorded') return { kind: 'stop', response: fail(500, 'FAILED') };"),
    ('the pair is offered only once (no retry)', L,
     "const FACT_ATTEMPTS = 3;", "const FACT_ATTEMPTS = 1;"),
    ('a lost lease while the pair is recorded does not stop the end', L,
     "      const kept = await keep(pair.count, pair.snapshot);\n      if (kept === 'lease_lost') return { kind: 'lost' };\n",
     "      const kept = await keep(pair.count, pair.snapshot);\n"),
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
    ('a malformed unconfirmed count is read as done', X,
     "  if (!(typeof count === 'number' && Number.isInteger(count) && count > 0)) return 'invalid';\n",
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
    # -- Phase 10: the snapshot-bound acknowledgement ------------------------------------------------------------------
    ('the saga\'s checkpoint is never acknowledged', L,
     "      const ack = xUnconfirmedAckOutcomeOf(await call(deps, 'ack_x_unconfirmed', xUnconfirmedAckArgs(userId, pair.snapshot)));\n      if (ack.status === 'snapshot_changed' && ack.snapshot !== null) {\n        pair = { count: ack.count, snapshot: ack.snapshot };\n        continue;\n      }\n      break;",
     "      break;"),
    ('the acknowledgement is sent before the pair is recorded', L,
     "      highest = Math.max(highest, pair.count);\n      const kept = await keep(pair.count, pair.snapshot);\n      if (kept === 'lease_lost') return { kind: 'lost' };\n      if (kept !== 'recorded') return { kind: 'stop', response: fail(500, 'FAILED', { xPostsUnconfirmed: highest }) };\n      if (round >= ACK_ROUNDS) break;\n      const ack = xUnconfirmedAckOutcomeOf(await call(deps, 'ack_x_unconfirmed', xUnconfirmedAckArgs(userId, pair.snapshot)));\n",
     "      highest = Math.max(highest, pair.count);\n      const ack = xUnconfirmedAckOutcomeOf(await call(deps, 'ack_x_unconfirmed', xUnconfirmedAckArgs(userId, pair.snapshot)));\n      const kept = await keep(pair.count, pair.snapshot);\n      if (kept === 'lease_lost') return { kind: 'lost' };\n      if (kept !== 'recorded') return { kind: 'stop', response: fail(500, 'FAILED', { xPostsUnconfirmed: highest }) };\n      if (round >= ACK_ROUNDS) break;\n"),
    ('a changed set is acknowledged under the OLD name again (never re-recorded)', L,
     "        pair = { count: ack.count, snapshot: ack.snapshot };\n        continue;",
     "        continue;"),
    ('a changed set is followed without a bound', X,
     "export const ACK_ROUNDS = 3;", "export const ACK_ROUNDS = 1000;"),
    ('a changed set is never followed (the new set stays unrecorded and unacknowledged)', X,
     "export const ACK_ROUNDS = 3;", "export const ACK_ROUNDS = 0;"),
    ('a changed set that names no snapshot is followed', L,
     "      if (ack.status === 'snapshot_changed' && ack.snapshot !== null) {",
     "      if (ack.status === 'snapshot_changed') {"),
    ('the acknowledgement carries the count instead of the snapshot', X,
     "  return { p_user_id: userId, p_snapshot: snapshot };",
     "  return { p_user_id: userId, p_expected: 1 } as unknown as { p_user_id: string; p_snapshot: string };"),
    ('the acknowledgement names a snapshot without checking its shape', X,
     "  if (!SNAPSHOT_PATTERN.test(snapshot)) throw new Error('X_UNCONFIRMED_SNAPSHOT_INVALID');\n", ""),
    ('a count without its snapshot is accepted as done', X,
     "  if (typeof snapshot !== 'string' || !SNAPSHOT_PATTERN.test(snapshot)) return 'invalid';\n  return { count, snapshot };",
     "  return { count, snapshot: typeof snapshot === 'string' ? snapshot : '' };"),
    ('a snapshot without its count is read as nothing unconfirmed', X,
     "  if (count === undefined && snapshot === undefined) return null;",
     "  if (count === undefined) return null;"),
    ('the acknowledgement answer is read loosely (any status with a count is a success)', X,
     "      return cleared !== null && cleared > 0 && typeof data.replay === 'boolean'\n        ? { status: 'acknowledged', cleared, replay: data.replay } : { status: 'failed' };",
     "      return { status: 'acknowledged', cleared: cleared ?? 0, replay: data.replay === true };"),
    ('an unnamed count is acknowledged anyway', L,
     "    if (snapshot === null) {\n      const kept = await keep(count, null);\n      if (kept === 'lease_lost') return { kind: 'lost' };\n      return {\n        kind: 'stop',\n        response: kept === 'recorded'\n          ? fail(502, 'X_CLEANUP_FAILED', { xPostsUnconfirmed: count })\n          : fail(500, 'FAILED', { xPostsUnconfirmed: count }),\n      };\n    }",
     "    if (snapshot === null) {\n      await keep(count, null);\n      return { kind: 'ok', count };\n    }"),
    ('the recorder of the pair is not the named one (count-only recorder for a named set)', L,
     "          : await call(deps, 'record_x_unconfirmed', { ...own, p_count: n, p_snapshot: name });",
     "          : await call(deps, 'record_reconciliation', { ...own, p_fact: 'x_posts_unconfirmed', p_count: n });"),
    # -- J3 V3 P2 R1: a known larger count is shown even when it could not be recorded --------------------------------
    ('an observed larger count is only counted after it was recorded (the 1 -> 9 under-display)', L,
     "      highest = Math.max(highest, pair.count);\n      const kept = await keep(pair.count, pair.snapshot);\n      if (kept === 'lease_lost') return { kind: 'lost' };\n      if (kept !== 'recorded') return { kind: 'stop', response: fail(500, 'FAILED', { xPostsUnconfirmed: highest }) };\n",
     "      const kept = await keep(pair.count, pair.snapshot);\n      if (kept === 'lease_lost') return { kind: 'lost' };\n      if (kept !== 'recorded') return { kind: 'stop', response: fail(500, 'FAILED', { xPostsUnconfirmed: highest }) };\n      highest = Math.max(highest, pair.count);\n"),
    ('the record-failure answer carries the count of the failed pair, not the largest observed', L,
     "return { kind: 'stop', response: fail(500, 'FAILED', { xPostsUnconfirmed: highest }) };\n      if (round >= ACK_ROUNDS) break;",
     "return { kind: 'stop', response: fail(500, 'FAILED', { xPostsUnconfirmed: pair.count }) };\n      if (round >= ACK_ROUNDS) break;"),
    ('an observed count is replaced by the latest one instead of kept at its maximum', L,
     "      highest = Math.max(highest, pair.count);\n      const kept = await keep(pair.count, pair.snapshot);",
     "      highest = pair.count;\n      const kept = await keep(pair.count, pair.snapshot);"),
    ('another app\'s service key makes the eligibility unreadable', L,
     "  if (!services.every((s) => typeof s.service_key === 'string' && SERVICE_KEY_RE.test(s.service_key) && typeof s.status === 'string')) return null;",
     "  if (!services.every((s) => (s.service_key === 'kabumori' || s.service_key === 'x_autopost') && typeof s.status === 'string')) return null;"),
    ('any string is a service key', L,
     "const SERVICE_KEY_RE = /^[a-z][a-z0-9_]{1,31}$/u;", "const SERVICE_KEY_RE = /^.*$/u;"),
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
