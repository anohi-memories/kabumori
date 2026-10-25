"""Mutation check for the G5-33 (S2-3) personal-workspace eligibility candidate: ONE rule of the candidate or of its rollback is broken in a scratch
COPY (a body mutant also gets its md5 constants recomputed in both files, so it fails for the rule and not for the checksum); the suite
(postona_personal_s2_3_workspace_pg_run.sh) must fail. A control must pass first. The copy has no .git: the pinned tree is extracted once with
`git archive` and handed over in S33_PINNED_TREE. Usage (needs the socket variables of a THROW-AWAY local cluster):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \\
    python3 supabase/tests/postona_personal_s2_3_workspace_mutations.py <repository root>"""
import hashlib
import io
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/tests', 'supabase/candidates/postona_personal_auth']
RUNNER = 'supabase/tests/postona_personal_s2_3_workspace_pg_run.sh'
C = 'supabase/candidates/postona_personal_auth/003_s2_3_workspace_eligibility.sql'
RB = 'supabase/candidates/postona_personal_auth/003_s2_3_workspace_eligibility_rollback.sql'
PIN = '21a5cad4b71de63265db8517da93c6efc60cdde8'
D1_R0 = 'f3fb1fb4102b0cbf969145045e079318'
SIGS = {'pred': 'create function private.postona_personal_workspace_eligibility(', 'r0': 'create or replace function public.common_account_bootstrap_verdict('}
SHAPE_TAIL = '           from pg_catalog.pg_proc p where p.oid = v_fn) is not true\n'

# (label, file, old, new, occurrence index, how often the site occurs)
M = [
    # ---- the rule (the predicate's body)
    ('absent ignores another owned brand', C, "    when not f_ws_found and f_orphans = 0 and not f_other_owned then 'absent'",
     "    when not f_ws_found and f_orphans = 0 then 'absent'", 0, 1),
    ('absent ignores memberships without the brand row', C, "    when not f_ws_found and f_orphans = 0 and not f_other_owned then 'absent'",
     "    when not f_ws_found and not f_other_owned then 'absent'", 0, 1),
    ('another member on the own workspace is allowed', C, "    when f_member_count <> 1 then 'OWN_WORKSPACE_CONFLICT'", "    when false then 'OWN_WORKSPACE_CONFLICT'", 0, 1),
    ('the own workspace plus another owned brand is allowed', C, "    when f_other_owned then 'OWN_WORKSPACE_CONFLICT'", "    when false then 'OWN_WORKSPACE_CONFLICT'", 0, 1),
    ('the kind is not checked', C, "    when f_ws_kind is distinct from 'social_mobile_user_v1' then 'OWN_WORKSPACE_CONFLICT'",
     "    when false then 'OWN_WORKSPACE_CONFLICT'", 0, 1),
    ('a NULL user does not raise', C, "  if p_user is null then\n    raise exception 'POSTONA_PERSONAL_WORKSPACE_USER_REQUIRED'",
     "  if false then\n    raise exception 'POSTONA_PERSONAL_WORKSPACE_USER_REQUIRED'", 0, 1),
    ('the own workspace counts as "another owned brand"', C, " and o.role = 'owner' and o.brand_id <> v_workspace)", " and o.role = 'owner')", 0, 1),
    # ---- R0's mapping
    ('R0 lets a conflict through', C, "    when f_ws_eligibility in ('absent', 'own') then null",
     "    when f_ws_eligibility in ('absent', 'own', 'OWN_WORKSPACE_CONFLICT') then null", 0, 1),
    ('R0 turns the unknown answer into an allow', C, "    else pg_catalog.jsonb_build_object('decision', 'unknown', 'reason', 'WORKSPACE_OWNER_UNKNOWN')\n  end;",
     "    else null\n  end;", 0, 1),
    # ---- the install
    ('the predicate is granted to authenticated', C, "revoke all on function private.postona_personal_workspace_eligibility(uuid) from public, anon, authenticated, service_role;",
     "revoke all on function private.postona_personal_workspace_eligibility(uuid) from public, anon, authenticated, service_role;\n"
     "grant execute on function private.postona_personal_workspace_eligibility(uuid) to authenticated;", 0, 1),
    ('the install does not check the superuser', C, "    raise exception 'S23_PRECONDITION_OWNER_IS_SUPERUSER';", "    null;", 0, 1),
    # (G5-35) the suite reads its checksums from this very line, so the condition is kept as a comment: the mutant must fail a SUITE test, not
    # the suite's own parse of the candidate
    ('a second install is not refused', C, "  if v_md5 = '3e89fcff1a3232ef794cdf0483a75130' then\n    raise exception 'S23_ALREADY_APPLIED';",
     "  if false then -- was: if v_md5 = '3e89fcff1a3232ef794cdf0483a75130' then\n    raise exception 'S23_ALREADY_APPLIED';", 0, 1),
    ('the install does not check the R0 body', C, f"  if v_md5 is distinct from '{D1_R0}' then\n    raise exception 'S23_PRECONDITION_R0_BODY_NOT_REVIEWED';",
     f"  if false then -- was: if v_md5 is distinct from '{D1_R0}' then\n    raise exception 'S23_PRECONDITION_R0_BODY_NOT_REVIEWED';", 0, 1),
    ('the install does not check the R0 shape', C, "    raise exception 'S23_PRECONDITION_R0_SHAPE';", "    null;", 0, 1),
    ('the install R0 shape check lets a NULL pass', C, SHAPE_TAIL, SHAPE_TAIL.replace('is not true', 'is false'), 0, 3),
    ('the install does not refuse an existing predicate', C, "    raise exception 'S23_PRECONDITION_PREDICATE_EXISTS';", "    null;", 0, 1),
    ('the install accepts FORCE RLS', C, "      raise exception 'S23_PRECONDITION_RLS_FORCED %', v_rel;", "      null;", 0, 1),
    ('the install accepts RLS hiding rows', C, "      raise exception 'S23_PRECONDITION_RLS_HIDES_ROWS %', v_rel;", "      null;", 0, 1),
    # ---- the rollback
    ('the rollback does not check the R0 shape', RB, "    raise exception 'S23_ROLLBACK_PRECONDITION_R0_SHAPE';", "    null;", 0, 1),
    ('the rollback R0 shape check lets a NULL pass', RB, SHAPE_TAIL, SHAPE_TAIL.replace('is not true', 'is false'), 0, 3),
    ('the rollback does not check the predicate body', RB, "    raise exception 'S23_ROLLBACK_PRECONDITION_PREDICATE_BODY';", "    null;", 0, 1),
    ('the rollback does not check the predicate shape', RB, "    raise exception 'S23_ROLLBACK_PRECONDITION_PREDICATE_SHAPE';", "    null;", 0, 1),
    ('the rollback predicate shape check lets a NULL pass', RB, SHAPE_TAIL, SHAPE_TAIL.replace('is not true', 'is false'), 1, 3),
    ('the rollback leaves the predicate', RB, "drop function private.postona_personal_workspace_eligibility(uuid);\n", "", 0, 1),
]
# The postcondition shape checks of R0 (install and rollback) are not mutated: the CREATE OR REPLACE just before them resets every attribute to
# the declared value, so removing a clause there cannot change an outcome (equivalent mutants, as in G5-28 / G5-30 / G5-31).


def body(text, sig):
    s = text.index(sig)
    a = text.index('as $$', s) + 5
    return hashlib.md5(text[a:text.index('$$;', a)].encode()).hexdigest()


def replace_nth(text, old, new, n):
    pos = -1
    for _ in range(n + 1):
        pos = text.index(old, pos + 1)
    return text[:pos] + new + text[pos + len(old):]


def run(root, pinned):
    env = dict(os.environ, S33_REPO_ROOT=root, S33_PINNED_TREE=pinned)
    try:
        r = subprocess.run(['bash', os.path.join(root, RUNNER)], cwd=root, capture_output=True, text=True, timeout=900, env=env)
        return r.returncode, r.stdout + r.stderr
    except subprocess.TimeoutExpired:
        return 124, ''


ANSI = re.compile(r'\x1b\[[0-9;]*m')


def classify(code, output, body_mutant):
    """(G5-35) Why the suite failed, so that only a failed SUITE ASSERTION counts as a detection: SURVIVED (it passed); TIMEOUT; SETUP (no test
    reported a failure: the world, the runner or a pinned file broke); CHECKSUM (a body mutant failed on a body-checksum guard, i.e. the md5
    rewrite did not hold); STATIC (the test module's checks on the candidate's TEXT failed before any test ran); ASSERTION (a suite test failed on its assertions). The second value names the first failed test, for the record."""
    if code == 0:
        return 'SURVIVED', ''
    if code == 124:
        return 'TIMEOUT', ''
    text = ANSI.sub('', output)
    if '(uncaught error)' in text:  # the test module's own static checks on the candidate text failed before any test ran
        return 'STATIC', next((l for l in text.splitlines() if 'Error' in l), '')[:140]
    failed = re.findall(r'^(.+?) \.\.\. FAILED', text, re.M)
    if not failed or not re.search(r'FAILED \| \d+ passed \| [1-9]\d* failed', text):
        return 'SETUP', ((text.strip().splitlines() or [''])[-1])[:140]
    errors = text[text.index(' ERRORS '):] if ' ERRORS ' in text else text
    if body_mutant and re.search(r'[A-Z0-9]_BODY\b|checksum', errors):
        return 'CHECKSUM', failed[0][:140]
    return 'ASSERTION', failed[0][:140]


def fresh_copy():
    root = tempfile.mkdtemp(prefix='s23-mut-', dir=os.environ.get('SCRATCH', None))
    for tree in TREES:
        shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
    return root


for name in ('CAL_PGHOST', 'CAL_PGPORT', 'CAL_PGSUPER'):
    if not os.environ.get(name):
        sys.exit(f'{name} is required')
pinned = tempfile.mkdtemp(prefix='s23-pin-', dir=os.environ.get('SCRATCH', None))
archive = subprocess.run(['git', '-C', src_root, 'archive', PIN, 'supabase/migrations', 'supabase/tests', 'supabase/candidates/common_account_brand_owner_epoch',
                          'supabase/candidates/common_account_authorization_verdict'], capture_output=True, check=True).stdout
tarfile.open(fileobj=io.BytesIO(archive)).extractall(pinned)
root = fresh_copy()
control, _ = run(root, pinned)
shutil.rmtree(root, ignore_errors=True)
print(f'CONTROL   {"PASS" if control == 0 else "FAIL"}', flush=True)
if control != 0:
    sys.exit(1)
detected = 0
invalid = 0
kinds = {}
for label, target, old, new, nth, count in M:
    root = fresh_copy()
    body_mutant = False
    try:
        path = os.path.join(root, target)
        text = open(path, encoding='utf-8').read()
        if text.count(old) != count:
            print(f'INVALID   {label}: the site occurs {text.count(old)} times, not {count}', flush=True)
            invalid += 1
            continue
        before = {k: body(text, s) for k, s in SIGS.items()} if target == C else {}
        text = replace_nth(text, old, new, nth)
        open(path, 'w', encoding='utf-8').write(text)
        if target == C:  # a body mutant: keep every checksum consistent with the mutated body, in both files
            after = {k: body(text, s) for k, s in SIGS.items()}
            for k in SIGS:
                if after[k] != before[k]:
                    for f in (C, RB):
                        p = os.path.join(root, f)
                        # (G5-35) read BEFORE opening for write: `open(p, 'w').write(open(p).read() ...)` truncated the file first and wrote it back EMPTY,
                        # so every body mutant ran against an empty candidate / rollback and was 'detected' whatever the suite checked
                        content = open(p, encoding='utf-8').read().replace(before[k], after[k])
                        if not content.strip():
                            sys.exit(f'{f} would be written empty')
                        open(p, 'w', encoding='utf-8').write(content)
                        body_mutant = True
        code, output = run(root, pinned)
        kind, where = classify(code, output, body_mutant)
        print(f'{kind:<10} {"body " if body_mutant else "guard"} {label}{"  :: " + where if where else ""}', flush=True)
        kinds[kind] = kinds.get(kind, 0) + 1
        detected += 1 if kind == 'ASSERTION' else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)
shutil.rmtree(pinned, ignore_errors=True)
print(f'MUTANTS   {detected}/{len(M)} detected by a suite assertion, {invalid} invalid; by kind: {kinds}', flush=True)
sys.exit(0 if detected == len(M) and invalid == 0 else 1)
