"""Mutation check for the G5-27 / G5-28 / G5-29 / G5-31 (D1) candidate: ONE rule is broken in a scratch COPY -- in one function at a time (the reading lines are the same
text in R1, R0 and SV, in that order, so a mutant names its occurrence) -- and the suite (postona_personal_d1_verdicts_pg_run.sh) must fail. A body
mutant gets that function's D1 checksum recomputed in the candidate and the rollback, so it fails for the rule, not for the checksum. A control
must pass first. The copy has no .git: the pinned tree is extracted once with `git archive` and handed over in S27_PINNED_TREE. Usage (needs the
socket variables of a THROW-AWAY local cluster):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
    python3 supabase/tests/postona_personal_d1_verdicts_mutations.py <repository root>"""
import hashlib
import os
import re
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

# (label, file, old, new, occurrence index or None for "exactly once", how often the site occurs)
M = []
for i, k in enumerate(ORDER):
    M += [
        (f'{k}: a missing or empty per-claim setting counts as false', C, LEG,
         "    v_anonymous := coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.is_anonymous', true), ''), 'false');\n", i, 3),
        (f'{k}: a missing or null JSON claim counts as false', C, JS,
         "      v_anonymous := coalesce(nullif((v_claims -> 'is_anonymous')::text, 'null'), 'false');\n", i, 3),
        (f'{k}: the JSON type is not checked', C, JS, "      v_anonymous := v_claims ->> 'is_anonymous';\n", i, 3),
    ]
M += [
    # (G5-35) the suite reads its checksums from this very line, so the condition is kept as a comment: the mutant must fail a SUITE test, not
    # the suite's own parse of the candidate
    ('the R0 body is not checked before the install', C, "  if v_md5 is distinct from 'e999adeb6cb877b2b3001501d58397a4' then\n    raise exception 'D1_PRECONDITION_R0_BODY_NOT_REVIEWED';",
     "  if false then -- was: if v_md5 is distinct from 'e999adeb6cb877b2b3001501d58397a4' then\n    raise exception 'D1_PRECONDITION_R0_BODY_NOT_REVIEWED';", None, 1),
    ('the R0 shape is not checked', C, "    raise exception 'D1_PRECONDITION_R0_SHAPE';", "    null;", None, 1),
    ('the SV shape is not checked', C, "    raise exception 'D1_PRECONDITION_SV_SHAPE';", "    null;", None, 1),
    ('the R1 shape is not checked', C, "    raise exception 'D1_PRECONDITION_R1_SHAPE';", "    null;", None, 1),
    ('a second install is not refused (R1)', C, "    raise exception 'D1_ALREADY_APPLIED';", "    null;", 0, 3),
    ('the superuser check is gone', C, "    raise exception 'D1_PRECONDITION_OWNER_IS_SUPERUSER';", "    null;", None, 1),
    ('the rollback restores a different SV body', RB, "  return case f_session_state when 'active' then 'active'",
     "  -- edited\n  return case f_session_state when 'active' then 'active'", None, 1),
    # ---- (G5-28, H4 P2 on PR #486) the attribute baseline before the install / the rollback (pre blocks are occurrences 0..2: R1, R0, SV; the
    # post blocks 3..5 cannot see a drift -- CREATE OR REPLACE has just reset every attribute -- so mutating them is equivalent and left out)
    ('R1: a STRICT drift is accepted by the install', C, 'and not p.proisstrict and not p.proleakproof', 'and not p.proleakproof', 0, 6),
    ('R0: a STRICT drift is accepted by the install', C, 'and not p.proisstrict and not p.proleakproof', 'and not p.proleakproof', 1, 6),
    ('SV: a STRICT drift is accepted by the install', C, 'and not p.proisstrict and not p.proleakproof', 'and not p.proleakproof', 2, 6),
    ('R0: a PARALLEL drift is accepted by the install', C, "p.proparallel = 'u'", 'true', 1, 6),
    ('SV: a COST drift is accepted by the install', C, 'p.procost = 100', 'true', 2, 6),
    ('R1: a LEAKPROOF drift is accepted by the install', C, 'and not p.proleakproof and', 'and', 0, 6),
    ('SV: a STRICT drift is accepted by the rollback', RB, 'and not p.proisstrict and not p.proleakproof', 'and not p.proleakproof', 2, 6),
    # ---- (G5-29, H4 P2 on PR #487) protrftypes IS NULL, before the install (R1, R0, SV) and before the rollback (R0)
    ('R1: a protrftypes drift is accepted by the install', C, 'and p.protrftypes is null', '', 0, 6),
    ('R0: a protrftypes drift is accepted by the install', C, 'and p.protrftypes is null', '', 1, 6),
    ('SV: a protrftypes drift is accepted by the install', C, 'and p.protrftypes is null', '', 2, 6),
    ('R0: a protrftypes drift is accepted by the rollback', RB, 'and p.protrftypes is null', '', 1, 6),
]
# ---- (G5-31) `(...) is not true` back to the PR #488 NULL logic (`is false`, i.e. `not (...)`): a RESET ALL (proconfig NULL) slips through. The
# pre blocks of the install and of the rollback, R1 / R0 / SV (occurrences 0..2); the post blocks are equivalent (the replace just set proconfig).
PRE_NULL = ' is not true  -- (G5-31) a NULL (RESET ALL: proconfig NULL) refuses'
for where, target in (('install', C), ('rollback', RB)):
    for i, k in enumerate(ORDER):
        M.append((f'{k}: a NULL shape check (RESET ALL) passes the {where}', target, PRE_NULL, ' is false', i, 3))


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
control, _ = run(root, pinned)
shutil.rmtree(root, ignore_errors=True)
print(f'CONTROL   {"PASS" if control == 0 else "FAIL"}', flush=True)
if control != 0:
    sys.exit(1)
detected = 0
invalid = 0
kinds = {}
for label, target, old, new, nth, expected in M:
    root = fresh_copy()
    body_mutant = False
    try:
        path = os.path.join(root, target)
        text = open(path, encoding='utf-8').read()
        count = text.count(old)
        if count != expected:
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
