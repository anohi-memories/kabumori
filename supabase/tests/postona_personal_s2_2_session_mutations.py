"""Mutation check for the G5-34 (S2-2) person-session gate candidate: ONE rule of the candidate or of its rollback is broken in a scratch COPY; the
suite (postona_personal_s2_2_session_pg_run.sh) must fail. A BODY mutant gets its md5 recomputed in both files AND runs with
S34_BEHAVIOUR_ONLY=1, which skips the suite's "same text as SV" checks: it must be caught by a wrong answer, not by a checksum. A control must
pass first. The copy has no .git: the pinned tree is extracted once with `git archive` and handed over in S34_PINNED_TREE. Usage (needs the
socket variables of a THROW-AWAY local cluster):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \\
    python3 supabase/tests/postona_personal_s2_2_session_mutations.py <repository root>"""
import hashlib
import io
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/tests', 'supabase/candidates/postona_personal_auth']
RUNNER = 'supabase/tests/postona_personal_s2_2_session_pg_run.sh'
C = 'supabase/candidates/postona_personal_auth/004_s2_2_personal_session.sql'
RB = 'supabase/candidates/postona_personal_auth/004_s2_2_personal_session_rollback.sql'
PIN = '21a5cad4b71de63265db8517da93c6efc60cdde8'
SIG = 'create function private.postona_personal_session('
LEG = "    v_anonymous := nullif(pg_catalog.current_setting('request.jwt.claim.is_anonymous', true), '');\n"
JS = "      v_anonymous := case when pg_catalog.jsonb_typeof(v_claims -> 'is_anonymous') = 'boolean' then v_claims ->> 'is_anonymous' end;\n"
HELPER = """  if pg_catalog.to_regprocedure('auth.uid()') is null\n"""

# (label, file, old, new, occurrence index, how often the site occurs)
M = [
    # ---- the gate (the body; behaviour only)
    ('the anonymous claim is not checked', C, " and v_role = 'authenticated' and v_anonymous = 'false' then", " and v_role = 'authenticated' then", 0, 1),
    ('the role is not checked', C, " and v_role = 'authenticated' and v_anonymous = 'false' then", " and v_anonymous = 'false' then", 0, 1),
    ('a missing per-claim is_anonymous counts as false', C, LEG,
     "    v_anonymous := coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.is_anonymous', true), ''), 'false');\n", 0, 1),
    ('the JSON type of is_anonymous is not checked', C, JS, "      v_anonymous := v_claims ->> 'is_anonymous';\n", 0, 1),
    ('sub is not compared with auth.uid()', C, "    if (select auth.uid()) is not distinct from v_sub::uuid then", "    if true then", 0, 1),
    ('the session row is matched by id only (another person\'s session counts)', C, "on s.id = v_session_id and s.user_id = v_user", "on s.id = v_session_id", 0, 1),
    ('expiry is ignored', C, "when s.not_after is null or s.not_after > pg_catalog.clock_timestamp() then 'active'", "when true then 'active'", 0, 1),
    ('a missing login is not refused', C, "  if not f_user_exists then\n    return 'AUTH_REQUIRED';", "  if false then\n    return 'AUTH_REQUIRED';", 0, 1),
    # ---- the install
    ('the gate is granted to authenticated', C, "revoke all on function private.postona_personal_session() from public, anon, authenticated, service_role;",
     "revoke all on function private.postona_personal_session() from public, anon, authenticated, service_role;\n"
     "grant execute on function private.postona_personal_session() to authenticated;", 0, 1),
    ('the install does not check the superuser', C, "    raise exception 'S22_PRECONDITION_OWNER_IS_SUPERUSER';", "    null;", 0, 1),
    ('a second install is not refused', C, "      raise exception 'S22_ALREADY_APPLIED';", "      null;", 0, 1),
    ('the install does not refuse a taken name', C, "    raise exception 'S22_PRECONDITION_NAME_TAKEN';", "    null;", 0, 1),
    ('the install accepts FORCE RLS', C, "      raise exception 'S22_PRECONDITION_RLS_FORCED %', v_rel;", "      null;", 0, 1),
    ('the install accepts RLS hiding rows', C, "      raise exception 'S22_PRECONDITION_RLS_HIDES_ROWS %', v_rel;", "      null;", 0, 1),
    ('the install accepts a volatile auth.uid()', C, "    raise exception 'S22_PRECONDITION_AUTH_UID';", "    null;", 0, 1),
    ('the install accepts a different auth shape', C, "    raise exception 'S22_PRECONDITION_AUTH_SHAPE';", "    null;", 0, 1),
    ('the install is coupled to the owner-epoch helper again (as SV)', C, HELPER,
     "  if pg_catalog.to_regprocedure('private.account_lifecycle_owner_epoch_exposure()') is null then\n"
     "    raise exception 'S22_PRECONDITION_HELPER';\n  end if;\n" + HELPER, 0, 1),
    # ---- the rollback
    ('the rollback does not check the shape', RB, "    raise exception 'S22_ROLLBACK_PRECONDITION_SHAPE';", "    null;", 0, 1),
    ('the rollback shape check lets a NULL pass', RB, "           from pg_catalog.pg_proc p where p.oid = v_fn) is not true\n",
     "           from pg_catalog.pg_proc p where p.oid = v_fn) is false\n", 0, 1),
    ('the rollback does not check the body', RB, "    raise exception 'S22_ROLLBACK_PRECONDITION_BODY';", "    null;", 0, 1),
    ('the rollback ignores an API role reaching it', RB, "    raise exception 'S22_ROLLBACK_PRECONDITION_API_ROLE_REACHES';", "    null;", 0, 1),
    ('the rollback ignores a caller', RB, "    raise exception 'S22_ROLLBACK_PRECONDITION_CALLERS';", "    null;", 0, 1),
    ('the rollback leaves the gate', RB, "drop function private.postona_personal_session();\n", "", 0, 1),
]

# The install's postcondition attribute clauses are not mutated: the function was just created with the declared attributes, so removing a clause
# there cannot change an outcome (equivalent mutants). Its ACL / role-graph checks are covered by "granted to authenticated".


def body(text, sig=SIG):
    s = text.index(sig)
    a = text.index('as $$', s) + 5
    return hashlib.md5(text[a:text.index('$$;', a)].encode()).hexdigest()


def replace_nth(text, old, new, n):
    pos = -1
    for _ in range(n + 1):
        pos = text.index(old, pos + 1)
    return text[:pos] + new + text[pos + len(old):]


def run(root, pinned, behaviour_only=False):
    env = dict(os.environ, S34_BEHAVIOUR_ONLY='1' if behaviour_only else '0', S34_REPO_ROOT=root, S34_PINNED_TREE=pinned)
    try:
        return subprocess.run(['bash', os.path.join(root, RUNNER)], cwd=root, capture_output=True, text=True, timeout=900, env=env).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='s22-mut-', dir=os.environ.get('SCRATCH', None))
    for tree in TREES:
        shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
    return root


for name in ('CAL_PGHOST', 'CAL_PGPORT', 'CAL_PGSUPER'):
    if not os.environ.get(name):
        sys.exit(f'{name} is required')
pinned = tempfile.mkdtemp(prefix='s22-pin-', dir=os.environ.get('SCRATCH', None))
archive = subprocess.run(['git', '-C', src_root, 'archive', PIN, 'supabase/migrations', 'supabase/tests', 'supabase/candidates/common_account_brand_owner_epoch',
                          'supabase/candidates/common_account_authorization_verdict'], capture_output=True, check=True).stdout
tarfile.open(fileobj=io.BytesIO(archive)).extractall(pinned)
root = fresh_copy()
control = run(root, pinned)
shutil.rmtree(root, ignore_errors=True)
print(f'CONTROL   {"PASS" if control == 0 else "FAIL"}', flush=True)
if control != 0:
    sys.exit(1)
detected = 0
invalid = 0
for label, target, old, new, nth, count in M:
    root = fresh_copy()
    try:
        path = os.path.join(root, target)
        text = open(path, encoding='utf-8').read()
        if text.count(old) != count:
            print(f'INVALID   {label}: the site occurs {text.count(old)} times, not {count}', flush=True)
            invalid += 1
            continue
        before = body(text) if target == C else None
        text = replace_nth(text, old, new, nth)
        open(path, 'w', encoding='utf-8').write(text)
        body_mutant = target == C and body(text) != before
        if body_mutant:  # keep every checksum consistent with the mutated body, in both files
            for f in (C, RB):
                p = os.path.join(root, f)
                # read BEFORE opening for write: `open(p, 'w').write(open(p).read() ...)` truncates the file first and writes it back EMPTY (the
                # defect found in G5-34 in the earlier G5 mutation scripts, which made every body mutant "detected" by an empty candidate)
                content = open(p, encoding='utf-8').read().replace(before, body(text))
                open(p, 'w', encoding='utf-8').write(content)
                assert content.strip() != '', f'{f} would be empty'
        code = run(root, pinned, behaviour_only=body_mutant)
        print(f'{"DETECTED " if code != 0 else "SURVIVED "} {label}', flush=True)
        detected += 1 if code != 0 else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)
shutil.rmtree(pinned, ignore_errors=True)
print(f'MUTANTS   {detected}/{len(M)} detected, {invalid} invalid', flush=True)
sys.exit(0 if detected == len(M) and invalid == 0 else 1)
