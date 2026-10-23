"""Mutation check for the G5-27 (D1) candidate: ONE rule is broken in a scratch COPY -- in one function at a time (the reading lines are the same
text in R1, R0 and SV, in that order, so a mutant names its occurrence) -- and the suite (postona_personal_d1_verdicts_pg_run.sh) must fail. A body
mutant gets that function's D1 checksum recomputed in the candidate and the rollback, so it fails for the rule, not for the checksum. A control
must pass first. The copy has no .git: the pinned tree is extracted once with `git archive` and handed over in S27_PINNED_TREE. Usage (needs the
socket variables of a THROW-AWAY local cluster):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
    python3 supabase/tests/postona_personal_d1_verdicts_mutations.py <repository root>"""
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/tests', 'supabase/candidates/postona_personal_auth']
RUNNER = 'supabase/tests/postona_personal_d1_verdicts_pg_run.sh'
C = 'supabase/candidates/postona_personal_auth/002_verdicts_anonymous_strict.sql'
RB = 'supabase/candidates/postona_personal_auth/002_verdicts_anonymous_strict_rollback.sql'
PIN = '21a5cad4b71de63265db8517da93c6efc60cdde8'
ORDER = ['R1', 'R0', 'SV']
SIGS = {'R1': 'create or replace function public.common_account_authorization_verdict(', 'R0': 'create or replace function public.common_account_bootstrap_verdict(',
        'SV': 'create or replace function private.account_lifecycle_session_verdict('}
LEG = "    v_anonymous := nullif(pg_catalog.current_setting('request.jwt.claim.is_anonymous', true), '');\n"
JS = "      v_anonymous := case when pg_catalog.jsonb_typeof(v_claims -> 'is_anonymous') = 'boolean' then v_claims ->> 'is_anonymous' end;\n"

# (label, file, old, new, occurrence index or None for "exactly once")
M = []
for i, k in enumerate(ORDER):
    M += [
        (f'{k}: a missing or empty per-claim setting counts as false', C, LEG,
         "    v_anonymous := coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.is_anonymous', true), ''), 'false');\n", i),
        (f'{k}: a missing or null JSON claim counts as false', C, JS,
         "      v_anonymous := coalesce(nullif((v_claims -> 'is_anonymous')::text, 'null'), 'false');\n", i),
        (f'{k}: the JSON type is not checked', C, JS, "      v_anonymous := v_claims ->> 'is_anonymous';\n", i),
    ]
M += [
    ('the R0 body is not checked before the install', C, "    raise exception 'D1_PRECONDITION_R0_BODY_NOT_REVIEWED';", "    null;", None),
    ('the R0 shape is not checked', C, "    raise exception 'D1_PRECONDITION_R0_SHAPE';", "    null;", None),
    ('the SV shape is not checked', C, "    raise exception 'D1_PRECONDITION_SV_SHAPE';", "    null;", None),
    ('the R1 shape is not checked', C, "    raise exception 'D1_PRECONDITION_R1_SHAPE';", "    null;", None),
    ('a second install is not refused (R1)', C, "    raise exception 'D1_ALREADY_APPLIED';", "    null;", 0),
    ('the superuser check is gone', C, "    raise exception 'D1_PRECONDITION_OWNER_IS_SUPERUSER';", "    null;", None),
    ('the rollback restores a different SV body', RB, "  return case f_session_state when 'active' then 'active'",
     "  -- edited\n  return case f_session_state when 'active' then 'active'", None),
]


def bodies(text):
    out = {}
    for k, sig in SIGS.items():
        s = text.index(sig)
        a = text.index('as $$', s) + 5
        out[k] = hashlib.md5(text[a:text.index('$$;', a)].encode()).hexdigest()
    return out


def replace_nth(text, old, new, n):
    pos = -1
    for _ in range(n + 1):
        pos = text.index(old, pos + 1)
    return text[:pos] + new + text[pos + len(old):]


def run(root, pinned):
    env = dict(os.environ, S27_REPO_ROOT=root, S27_PINNED_TREE=pinned)
    try:
        return subprocess.run(['bash', os.path.join(root, RUNNER)], cwd=root, capture_output=True, text=True, timeout=900, env=env).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='s27-mut-', dir=os.environ.get('SCRATCH', None))
    for tree in TREES:
        shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
    return root


for name in ('CAL_PGHOST', 'CAL_PGPORT', 'CAL_PGSUPER'):
    if not os.environ.get(name):
        sys.exit(f'{name} is required')
pinned = tempfile.mkdtemp(prefix='s27-pin-', dir=os.environ.get('SCRATCH', None))
archive = subprocess.run(['git', '-C', src_root, 'archive', PIN, 'supabase/migrations', 'supabase/tests', 'supabase/candidates/common_account_brand_owner_epoch',
                          'supabase/candidates/common_account_authorization_verdict'], capture_output=True, check=True).stdout
subprocess.run(['tar', '-x', '-C', pinned], input=archive, check=True)
root = fresh_copy()
control = run(root, pinned)
shutil.rmtree(root, ignore_errors=True)
print(f'CONTROL   {"PASS" if control == 0 else "FAIL"}', flush=True)
if control != 0:
    sys.exit(1)
detected = 0
invalid = 0
for label, target, old, new, nth in M:
    root = fresh_copy()
    try:
        path = os.path.join(root, target)
        text = open(path, encoding='utf-8').read()
        count = text.count(old)
        if (nth is None and count != 1) or (nth is not None and count != 3):
            print(f'INVALID   {label}: the site occurs {count} times', flush=True)
            invalid += 1
            continue
        before = bodies(text)
        text = text.replace(old, new) if nth is None else replace_nth(text, old, new, nth)
        after = bodies(text)
        open(path, 'w', encoding='utf-8').write(text)
        if target == C:
            for k in ORDER:
                if before[k] != after[k]:
                    for f in (C, RB):
                        p = os.path.join(root, f)
                        open(p, 'w', encoding='utf-8').write(open(p, encoding='utf-8').read().replace(before[k], after[k]))
        code = run(root, pinned)
        print(f'{"DETECTED " if code != 0 else "SURVIVED "} {label}', flush=True)
        detected += 1 if code != 0 else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)
shutil.rmtree(pinned, ignore_errors=True)
print(f'MUTANTS   {detected}/{len(M)} detected, {invalid} invalid', flush=True)
sys.exit(0 if detected == len(M) and invalid == 0 else 1)
