"""Mutation check for the G5-09 session-only verdict model (supabase/candidates/common_account_postona_authz/session_verdict.ts): ONE rule (the claims,
the login, the session row and its owner, not_after, fail-closed facts, the consumer gate's order / owner / cancellable rule, the Edge's claim hand-off)
is broken in a scratch COPY; the suite must fail. A control must pass first. Offline: no database, no network.
  python3 supabase/tests/common_account_g5_09_session_verdict_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/tests', 'supabase/candidates/common_account_postona_authz']
S = 'supabase/candidates/common_account_postona_authz/session_verdict.ts'
SUITE = 'supabase/tests/common_account_g5_09_session_verdict_test.ts'

M = [
    # ---- sessionVerdict
    ('the claims are not checked', S, "  if ('refused' in principal) return 'AUTH_REQUIRED';\n", ''),
    ('unreadable facts are not unknown', S, "  if (facts === undefined || typeof facts !== 'object' || facts === null || typeof facts.userExists !== 'boolean') return 'SESSION_UNKNOWN';\n",
     "  if (facts === undefined || facts === null) return 'active';\n"),
    ('a missing login is a person', S, "  if (!facts.userExists) return 'AUTH_REQUIRED';\n", ''),
    ('a missing session row is live (signed out / unknown id)', S, "  if (s === null) return 'SESSION_REVOKED';\n", "  if (s === null) return 'active';\n"),
    ('a malformed session row is read', S, "  if (typeof s !== 'object' || typeof s.userId !== 'string' || (s.notAfterMs !== null && !Number.isFinite(s.notAfterMs))) return 'SESSION_UNKNOWN';\n", ''),
    ('another person\'s session is accepted', S, "  if (s.userId !== principal.userId) return 'SESSION_REVOKED';\n", ''),
    ('an expired session is live', S, "  if (s.notAfterMs !== null && !(s.notAfterMs > nowMs)) return 'SESSION_EXPIRED';\n", ''),
    ('not_after = now is live', S, "!(s.notAfterMs > nowMs)", "!(s.notAfterMs >= nowMs)"),
    # ---- reservationPersonGate
    ('an unknown session reads rows', S, "  if (verdict === 'SESSION_UNKNOWN') return { refused: 'AUTH_UNAVAILABLE' };\n", ''),
    ('a dead session reads rows', S, "  if (verdict !== 'active') return { refused: 'AUTH_REQUIRED' };\n", ''),
    ('the row is read before the session', S, "  if (verdict === 'SESSION_UNKNOWN') return { refused: 'AUTH_UNAVAILABLE' };\n",
     "  readRow();\n  if (verdict === 'SESSION_UNKNOWN') return { refused: 'AUTH_UNAVAILABLE' };\n"),
    ('another person\'s row is answered', S, "  if (row === null || row.ownerUserId !== callerUserId) return { refused: 'NOT_FOUND' };", "  if (row === null) return { refused: 'NOT_FOUND' };"),
    ('a sent reservation can be cancelled', S, "  if (op === 'cancel' && !(CANCELLABLE as readonly string[]).includes(row.status)) return { refused: 'NOT_CANCELLABLE' };\n", ''),
    ('a session refusal is a 403', S, "AUTH_REQUIRED: 401,", "AUTH_REQUIRED: 403,"),
    # ---- edgeClaimsForDb
    ('the session id is not handed over', S, "  return JSON.stringify({ sub, role: 'authenticated', session_id: session, is_anonymous: false });",
     "  return JSON.stringify({ sub, role: 'authenticated', is_anonymous: false });"),
    ('a token without session_id is accepted', S, "  if (typeof session !== 'string' || !UUID.test(session)) return null;\n", ''),
    ('sub need not be the user Auth returned', S, "if (typeof sub !== 'string' || !UUID.test(sub) || body.id !== sub) return null;", "if (typeof sub !== 'string' || !UUID.test(sub)) return null;"),
    ('an anonymous token is accepted', S, "  if (payload.is_anonymous === true || body.is_anonymous === true) return null;\n", ''),
    ('a non-boolean is_anonymous is accepted', S, "  if (payload.is_anonymous !== undefined && payload.is_anonymous !== false) return null;\n", ''),
    ('another role is accepted', S, "  if (payload.role !== 'authenticated' || (body.role !== undefined && body.role !== 'authenticated')) return null;\n", ''),
]


def run(root):
    try:
        return subprocess.run(['deno', 'test', '--no-config', '--no-check', SUITE], cwd=root, capture_output=True, text=True, timeout=300).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='g509-mut-', dir=os.environ.get('SCRATCH', None))
    for tree in TREES:
        shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
    return root


root = fresh_copy()
control = run(root)
shutil.rmtree(root, ignore_errors=True)
print(f'CONTROL   {"PASS" if control == 0 else "FAIL"}', flush=True)
if control != 0:
    sys.exit(1)
detected = 0
invalid = 0
for label, target, old, new in M:
    root = fresh_copy()
    try:
        path = os.path.join(root, target)
        text = open(path, encoding='utf-8').read()
        if text.count(old) != 1:
            print(f'INVALID   {label}: the site occurs {text.count(old)} times', flush=True)
            invalid += 1
            continue
        open(path, 'w', encoding='utf-8').write(text.replace(old, new))
        code = run(root)
        print(f'{"DETECTED " if code != 0 else "SURVIVED "} {label}', flush=True)
        detected += 1 if code != 0 else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)
print(f'MUTANTS   {detected}/{len(M)} detected, {invalid} invalid', flush=True)
sys.exit(0 if detected == len(M) and invalid == 0 else 1)
