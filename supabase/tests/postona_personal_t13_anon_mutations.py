"""Mutation check for the G5-24 / G5-25 / G5-30 (S2-1) T13 anonymous-refusal candidate: ONE rule of the candidate is broken in a scratch COPY (a body mutant
also gets its md5 constants recomputed in the candidate and the rollback, so it fails for the rule and not for the checksum); the suite
(postona_personal_t13_anon_pg_run.sh) must fail. A control must pass first. The copy has no .git: the two pinned files are extracted once
with `git show` and handed over in S21_PINNED_DIR. Usage (needs the socket variables of a THROW-AWAY local cluster):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
    python3 supabase/tests/postona_personal_t13_anon_mutations.py <repository root>"""
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/migrations', 'supabase/tests', 'supabase/candidates/postona_personal_auth']
RUNNER = 'supabase/tests/postona_personal_t13_anon_pg_run.sh'
C = 'supabase/candidates/postona_personal_auth/001_t13_anonymous_refusal.sql'
RB = 'supabase/candidates/postona_personal_auth/001_t13_anonymous_refusal_rollback.sql'
PIN = '76b50e1e03f82faaa3460bab1603afa8fef3ce44'

M = [
    # ---- the rule
    ('the anonymous claim is not checked', C, "\n     or v_anonymous is distinct from 'false'\n", "\n"),
    ('only the literal true is refused', C, "     or v_anonymous is distinct from 'false'\n", "     or v_anonymous = 'true'\n"),
    ('the per-claim setting is not read', C, "    v_anonymous := nullif(current_setting('request.jwt.claim.is_anonymous', true), '');\n", ""),
    # (G5-25, H4 P2) a missing / empty claim is NOT proof of non-anonymity
    ('a missing or empty per-claim setting counts as false', C, "    v_anonymous := nullif(current_setting('request.jwt.claim.is_anonymous', true), '');\n",
     "    v_anonymous := coalesce(nullif(current_setting('request.jwt.claim.is_anonymous', true), ''), 'false');\n"),
    ('the JSON claim is not read', C, "      v_anonymous := case when jsonb_typeof(v_claims -> 'is_anonymous') = 'boolean' then v_claims ->> 'is_anonymous' end;\n", ""),
    ('a missing or null JSON claim counts as false', C, "      v_anonymous := case when jsonb_typeof(v_claims -> 'is_anonymous') = 'boolean' then v_claims ->> 'is_anonymous' end;\n",
     "      v_anonymous := coalesce(case when jsonb_typeof(v_claims -> 'is_anonymous') = 'boolean' then v_claims ->> 'is_anonymous' end, 'false');\n"),
    ('the JSON type is not checked (a string "false" counts as false)', C, "      v_anonymous := case when jsonb_typeof(v_claims -> 'is_anonymous') = 'boolean' then v_claims ->> 'is_anonymous' end;\n",
     "      v_anonymous := v_claims ->> 'is_anonymous';\n"),
    ('the refusal is after the locks', C, "     or v_anonymous is distinct from 'false'\n", "\n"),  # paired with the next edit, see below
    # ---- the install guards
    ('a changed body is replaced', C, "  if v_md5 is distinct from '08840016794a973225be767952265e79' then\n    raise exception 'T13_ANON_PRECONDITION_BODY_NOT_REVIEWED';",
     "  if false then\n    raise exception 'T13_ANON_PRECONDITION_BODY_NOT_REVIEWED';"),
    ('the install does not check the shape', C, "    raise exception 'T13_ANON_PRECONDITION_SHAPE';", "    null;"),
    ('a second install is not refused', C, "  if v_md5 = '1f8cd9c764c251f3232c61b7a77ff597' then\n    raise exception 'T13_ANON_ALREADY_APPLIED';",
     "  if false then\n    raise exception 'T13_ANON_ALREADY_APPLIED';"),
    ('the rollback restores a different body', RB, "    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';\n  end if;\n\n  -- 2. I1 lock order",
     "    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';\n  end if;\n  -- edited\n\n  -- 2. I1 lock order"),
]
# (G5-30) the reviewed attributes, removed one at a time from the PRECONDITION of the install and of the rollback (the first of the two
# shape checks in each file, so each site occurs exactly twice). The postcondition copies are not mutated: the CREATE OR REPLACE just before
# them resets every one of these attributes to the declared value, so removing one there cannot change any outcome (equivalent mutants).
ATTRIBUTE_SITES = [
    ('STRICT', 'not p.proisstrict and ', ''),
    ('LEAKPROOF', 'and not p.proleakproof ', ''),
    ('PARALLEL', "and p.proparallel = 'u' ", ''),
    ('COST', 'and p.procost = 100\n', '\n'),
    ('SUPPORT', 'p.prosupport::oid = 0 and ', ''),
    ('TRANSFORM', 'and p.protrftypes is null ', ''),
    ('ROWS', 'and p.prorows = 0 ', ''),
    ('argument modes', 'and p.proargmodes is null\n', '\n'),
    ('a NULL passes (`is not true` -> `is false`, the PR #483 `not (...)`)', ') is not true\n', ') is false\n'),
]
for where, target in (('install', C), ('rollback', RB)):
    for what, old, new in ATTRIBUTE_SITES:
        M.append((f'the {where} precondition does not check {what}', target, old, new, 1, 2))
# the refusal-after-the-locks mutant also adds the check right after the session is read (step 3), keeping the rule but moving it past the locks
AFTER_LOCKS = ("  if not v_live then\n    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';\n  end if;\nend;",
               "  if not v_live or v_anonymous is distinct from 'false' then\n    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';\n  end if;\nend;")


def body_md5(text):
    s = text.index('create or replace function private.account_lifecycle_assert_active_service_write')
    a = text.index('as $$', s) + 5
    return hashlib.md5(text[a:text.index('$$;', a)].encode()).hexdigest()


def run(root, pinned):
    env = dict(os.environ, S21_REPO_ROOT=root, S21_PINNED_DIR=pinned)
    try:
        return subprocess.run(['bash', os.path.join(root, RUNNER)], cwd=root, capture_output=True, text=True, timeout=600, env=env).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='s21-mut-', dir=os.environ.get('SCRATCH', None))
    for tree in TREES:
        shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
    return root


for name in ('CAL_PGHOST', 'CAL_PGPORT', 'CAL_PGSUPER'):
    if not os.environ.get(name):
        sys.exit(f'{name} is required')
pinned = tempfile.mkdtemp(prefix='s21-pin-', dir=os.environ.get('SCRATCH', None))
for path, out in (('supabase/migrations/20261010051938_common_account_service_write_guard.sql', 't13.sql'),
                  ('supabase/tests/common_account_write_guard_fixture.sql', 'fixture.sql')):
    open(os.path.join(pinned, out), 'w', encoding='utf-8').write(
        subprocess.run(['git', '-C', src_root, 'show', f'{PIN}:{path}'], capture_output=True, text=True, check=True).stdout)
root = fresh_copy()
control = run(root, pinned)
shutil.rmtree(root, ignore_errors=True)
print(f'CONTROL   {"PASS" if control == 0 else "FAIL"}', flush=True)
if control != 0:
    sys.exit(1)
detected = 0
invalid = 0
for label, target, old, new, *where in M:
    nth, count = where or (1, 1)  # mutate the nth (1-based) of exactly `count` occurrences
    root = fresh_copy()
    try:
        path = os.path.join(root, target)
        text = open(path, encoding='utf-8').read()
        if text.count(old) != count or (label == 'the refusal is after the locks' and text.count(AFTER_LOCKS[0]) != 1):
            print(f'INVALID   {label}: the site does not occur exactly {count} time(s)', flush=True)
            invalid += 1
            continue
        old_md5 = body_md5(text)
        at = -1
        for _ in range(nth):
            at = text.index(old, at + 1)
        text = text[:at] + new + text[at + len(old):]
        if label == 'the refusal is after the locks':
            text = text.replace(AFTER_LOCKS[0], AFTER_LOCKS[1])
        new_md5 = body_md5(text)
        open(path, 'w', encoding='utf-8').write(text)
        if new_md5 != old_md5 and target == C:  # a candidate body mutant: keep the checksums consistent with the mutated body, in both files
            for f in (C, RB):
                p = os.path.join(root, f)
                open(p, 'w', encoding='utf-8').write(open(p, encoding='utf-8').read().replace(old_md5, new_md5))
        code = run(root, pinned)
        print(f'{"DETECTED " if code != 0 else "SURVIVED "} {label}', flush=True)
        detected += 1 if code != 0 else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)
shutil.rmtree(pinned, ignore_errors=True)
print(f'MUTANTS   {detected}/{len(M)} detected, {invalid} invalid', flush=True)
sys.exit(0 if detected == len(M) and invalid == 0 else 1)
