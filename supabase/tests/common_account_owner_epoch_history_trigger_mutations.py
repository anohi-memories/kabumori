"""Mutation check for the G5-21 revision of the owner-epoch candidate (the history's triggers must be exactly its two guards; every bump refuses
before writing and checks the row it wrote; the install and the rollback refuse a left trigger): ONE rule is broken in a scratch COPY; the G5-21
suite (common_account_owner_epoch_history_trigger_pg_run.sh) must fail. A control must pass first. The copy has no .git, so the suite's
"before" world (PR #446's head) is skipped there. Usage (needs the socket variables of a THROW-AWAY local cluster):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
    python3 supabase/tests/common_account_owner_epoch_history_trigger_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/migrations', 'supabase/tests', 'supabase/candidates/common_account_brand_owner_epoch']
RUNNER = 'supabase/tests/common_account_owner_epoch_history_trigger_pg_run.sh'
C = 'supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql'
RB = 'supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch_rollback.sql'
PRE = "  if private.account_lifecycle_owner_epoch_history_triggers() is not null then\n    raise exception 'OWNER_EPOCH_HISTORY_TRIGGERS_NOT_EXACT' using errcode = '42501';\n  end if;\n"

M = [
    # ---- read time
    ('the coverage ignores the history triggers', C, "     and private.account_lifecycle_owner_epoch_history_triggers() is null\n", ""),
    # ---- the exact-guard match. Equivalent mutants left out on purpose: dropping `tgconstraint = 0` (a constraint trigger is always AFTER, so the
    # exact tgtype already refuses it); the former trigger-count clause and the former not-found check after the row lock were removed from the code
    # as redundant (unique trigger names; the written-row check sees "not found" too)
    ('a foreign trigger name is accepted', C, "    when exists (select 1 from t where t.tgname not in ('account_lifecycle_owner_epoch_history_row', 'account_lifecycle_owner_epoch_history_truncate'))\n      then 'HISTORY_FOREIGN_TRIGGER'\n", ""),
    ('internal triggers are counted', C, "select t.* from pg_catalog.pg_trigger t, h where t.tgrelid = h.oid and not t.tgisinternal", "select t.* from pg_catalog.pg_trigger t, h where t.tgrelid = h.oid"),
    ('the guard function is not checked', C, "     where t.tgfoid = pg_catalog.to_regprocedure('private.account_lifecycle_owner_epoch_history_guard()')\n       and t.tgenabled", "     where true\n       and t.tgenabled"),
    ('a disabled guard counts', C, "       and t.tgenabled in ('O', 'A') and t.tgqual is null and pg_catalog.cardinality(t.tgattr::int2[]) = 0 and t.tgconstraint = 0 and t.tgnargs = 0\n       and t.tgoldtable",
     "       and t.tgqual is null and pg_catalog.cardinality(t.tgattr::int2[]) = 0 and t.tgconstraint = 0 and t.tgnargs = 0\n       and t.tgoldtable"),
    ('a WHEN clause is accepted', C, "       and t.tgenabled in ('O', 'A') and t.tgqual is null and pg_catalog.cardinality(t.tgattr::int2[]) = 0 and t.tgconstraint = 0 and t.tgnargs = 0\n       and t.tgoldtable",
     "       and t.tgenabled in ('O', 'A') and pg_catalog.cardinality(t.tgattr::int2[]) = 0 and t.tgconstraint = 0 and t.tgnargs = 0\n       and t.tgoldtable"),
    ('a column list is accepted', C, "       and t.tgenabled in ('O', 'A') and t.tgqual is null and pg_catalog.cardinality(t.tgattr::int2[]) = 0 and t.tgconstraint = 0 and t.tgnargs = 0\n       and t.tgoldtable",
     "       and t.tgenabled in ('O', 'A') and t.tgqual is null and t.tgconstraint = 0 and t.tgnargs = 0\n       and t.tgoldtable"),
    ('arguments are accepted', C, "       and t.tgenabled in ('O', 'A') and t.tgqual is null and pg_catalog.cardinality(t.tgattr::int2[]) = 0 and t.tgconstraint = 0 and t.tgnargs = 0\n       and t.tgoldtable",
     "       and t.tgenabled in ('O', 'A') and t.tgqual is null and pg_catalog.cardinality(t.tgattr::int2[]) = 0 and t.tgconstraint = 0\n       and t.tgoldtable"),
    ('the guard function owner is not checked', C, "       and f.proowner = (select c.relowner from pg_catalog.pg_class c, h where c.oid = h.oid)\n", ""),
    ('a non-definer guard function is accepted', C, "       and f.prosecdef and f.proconfig @> array['search_path=\"\"']\n       -- row, BEFORE", "       and f.proconfig @> array['search_path=\"\"']\n       -- row, BEFORE"),
    ('the guard function search_path is not checked', C, "       and f.prosecdef and f.proconfig @> array['search_path=\"\"']\n       -- row, BEFORE", "       and f.prosecdef\n       -- row, BEFORE"),
    ('the row guard timing / events are checked by bits only', C, "t.tgtype = 27)", "t.tgtype & 27 = 27)"),
    ('the truncate guard timing is checked by bits only', C, "t.tgtype = 34))", "t.tgtype & 32 = 32))"),
    # ---- every write
    ('the bump does not check before writing', C, "begin\n  -- (G5-21) no foreign trigger may run inside a bump: refuse BEFORE writing the history, so its code never runs as the owner\n" + PRE, "begin\n"),
    ('the bump does not check the row it updated', C, "  if not found or v_got_epoch is distinct from v_epoch + 1\n     or v_got_owner", "  if false and v_got_epoch is distinct from v_epoch + 1\n     or v_got_owner"),
    ('the truncate path does not check before writing', C, "begin\n  -- (G5-21) the same refusal and the same written-exactly check as the bump, row by row\n" + PRE, "begin\n"),
    # ---- install and rollback
    ('the re-install accepts a left trigger', C, "    v_code := private.account_lifecycle_owner_epoch_history_triggers();\n    if v_code is not null then", "    v_code := private.account_lifecycle_owner_epoch_history_triggers();\n    if false then"),
    ('the rollback accepts a left trigger', RB, "      raise exception 'OWNER_EPOCH_ROLLBACK_HISTORY_FOREIGN_TRIGGER';", "      null;"),
    ('the rollback does not check the rows it moved', RB, "      if not found or v_got is distinct from v_row.epoch + 1 then", "      if false then"),
]


def run(root):
    env = dict(os.environ, HT_REPO_ROOT=root)
    try:
        return subprocess.run(['bash', os.path.join(root, RUNNER)], cwd=root, capture_output=True, text=True, timeout=600, env=env).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='ht-mut-', dir=os.environ.get('SCRATCH', None))
    for tree in TREES:
        shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
    return root


for name in ('CAL_PGHOST', 'CAL_PGPORT', 'CAL_PGSUPER'):
    if not os.environ.get(name):
        sys.exit(f'{name} is required')
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
