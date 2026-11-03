"""G5-42: build (or --check) the entrypoint-only MIGRATION CANDIDATE (supabase/candidates/postona_personal_auth_migration/) from the bundle's
two reviewed entrypoints (PR #537, H2 focused PASS), deterministically:
  20261028090000_postona_personal_auth_install.sql   = INSTALL_ALL.sql with ONE read-only block inserted right after its single `begin;`:
                                                       the machine-checked PREREQUISITES (P1 lifecycle chain, P2 owner epoch of PR #457,
                                                       P3 G3's L-1 revoke, P4 auth.uid / auth.sessions). Still one transaction; nothing else
                                                       of INSTALL_ALL changes.
  ROLLBACK_20261028090000_postona_personal_auth.sql  = ROLLBACK_ALL.sql, byte for byte (its preflight already refuses anything but the
                                                       installed state).
Nothing else ships: no part file, no standalone R10 / R20 / R30, no per-step install.
Usage: python3 supabase/tests/postona_personal_auth_migration_build.py <repository root> [--check]"""
import os
import sys

repo = sys.argv[1]
check = '--check' in sys.argv[2:]
BUNDLE = os.path.join(repo, 'supabase/candidates/postona_personal_auth_bundle')
OUT = os.path.join(repo, 'supabase/candidates/postona_personal_auth_migration')
INSTALL_NAME = '20261028090000_postona_personal_auth_install.sql'
ROLLBACK_NAME = 'ROLLBACK_20261028090000_postona_personal_auth.sql'

# P1: one object per migration of the G5 lifecycle chain the bundle stands on (20261001150000 .. 20261015120000; T13 20261010051938 is
# checked by its own part, md5 08840016...). By name in its schema: an overload change is that migration's own business.
P1 = [('private', 'account_lifecycle_lock', '20261001150000'), ('private', 'account_lifecycle_start_service', '20261006230000'),
      ('private', 'account_lifecycle_gate_open', '20261009120000'), ('private', 'account_lifecycle_assert_active_service_write', '20261010051938'),
      ('private', 'account_lifecycle_service_state_refusal', '20261012130000'), ('private', 'account_lifecycle_brand_owner', '20261012230000'),
      ('private', 'account_lifecycle_finish_service_deletion', '20261013120000'), ('public', 'common_account_service_end_result', '20261013140000'),
      ('private', 'account_lifecycle_enrollment_fence', '20261015090000'), ('public', 'record_owned_service_deletion_x_unconfirmed', '20261015120000')]
P1_SQL = '\n'.join(
    f"""  if not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = '{s}' and p.proname = '{f}') then
    raise exception 'MIGRATION_PREREQ_P1_LIFECYCLE_CHAIN %', '{m} ({s}.{f})';
  end if;""" for s, f, m in P1)

PREREQ = f"""-- ==== G5-42 PREREQUISITES (read-only; in this same transaction, before any part) ====
-- The install stands on objects this file does not create. Each is checked here and the whole migration refuses (nothing created) without it:
--   P1 the G5 lifecycle migration chain 20261001150000 .. 20261015120000 (G5 Draft chain; only 20261001150000 is on main);
--   P2 the brand owner epoch candidate of PR #285 -> #303 -> #457 (exposure check clean, history guard present). PR #457's independent review
--      is NOT accepted (H3 stopped): passing this check proves presence, not acceptance -- this migration is not applicable to production
--      until that review is accepted;
--   P3 G3's L-1 revoke on public.brand_memberships (PR #370): no API role holds TRIGGER, and anon / authenticated hold no TRUNCATE / REFERENCES
--      (checked BEFORE P2: the owner-epoch exposure check would otherwise report the same drift less precisely);
--   P4 auth.uid() (STABLE) and auth.users / auth.sessions (managed GoTrue / PostgREST claim behaviour itself is NOT verifiable here).
do $$
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false then
    raise exception 'MIGRATION_PREREQ_OWNER_IS_SUPERUSER';
  end if;
{P1_SQL}
  if pg_catalog.to_regclass('public.brand_memberships') is null
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')
                 and pg_catalog.has_table_privilege(r.oid, 'public.brand_memberships', 'TRIGGER'))
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated')
                 and (pg_catalog.has_table_privilege(r.oid, 'public.brand_memberships', 'TRUNCATE')
                      or pg_catalog.has_table_privilege(r.oid, 'public.brand_memberships', 'REFERENCES'))) then
    raise exception 'MIGRATION_PREREQ_P3_L1_REVOKE';
  end if;
  if pg_catalog.to_regprocedure('private.account_lifecycle_owner_epoch_exposure()') is null
     or pg_catalog.to_regprocedure('private.account_lifecycle_owner_epoch_history_guard()') is null
     or pg_catalog.to_regprocedure('private.account_lifecycle_brand_owner_epoch(text)') is null then
    raise exception 'MIGRATION_PREREQ_P2_OWNER_EPOCH_MISSING';
  end if;
  if private.account_lifecycle_owner_epoch_exposure() is not null then
    raise exception 'MIGRATION_PREREQ_P2_OWNER_EPOCH_EXPOSED %', private.account_lifecycle_owner_epoch_exposure();
  end if;
  if pg_catalog.to_regprocedure('auth.uid()') is null
     or (select p.provolatile from pg_catalog.pg_proc p where p.oid = 'auth.uid()'::pg_catalog.regprocedure) is distinct from 's'
     or pg_catalog.to_regclass('auth.users') is null or pg_catalog.to_regclass('auth.sessions') is null then
    raise exception 'MIGRATION_PREREQ_P4_AUTH';
  end if;
end $$;
"""

HEAD = """-- G5 MIGRATION CANDIDATE (G5-42, Issue #320 task 42) -- NOT in supabase/migrations/, NOT applied anywhere. GENERATED by
-- supabase/tests/postona_personal_auth_migration_build.py from the bundle's INSTALL_ALL.sql (PR #537, H2 focused PASS) plus the read-only
-- prerequisites block; `--check` re-derives it byte for byte. Production NO_GO: PR #457 (P2) is not accepted, the managed read-only audit
-- has not run, and the owner has not approved. One transaction; run as the lifecycle owner (never a superuser) with ON_ERROR_STOP.
"""
install_all = open(os.path.join(BUNDLE, 'INSTALL_ALL.sql'), encoding='utf-8').read()
rollback_all = open(os.path.join(BUNDLE, 'ROLLBACK_ALL.sql'), encoding='utf-8').read()
if install_all.split('\n').count('begin;') != 1:
    sys.exit('INSTALL_ALL.sql: expected exactly one `begin;` line')
at = install_all.index('\nbegin;\n') + len('\nbegin;\n')
install = HEAD + install_all[:at] + '\n' + PREREQ + install_all[at:]
bad = 0
for name, text in ((INSTALL_NAME, install), (ROLLBACK_NAME, rollback_all)):
    path = os.path.join(OUT, name)
    if check:
        same = os.path.isfile(path) and open(path, encoding='utf-8').read() == text
        print(f'{"PASS" if same else "FAIL"}  {name} re-derives byte for byte from the bundle entrypoints', flush=True)
        bad += 0 if same else 1
    else:
        os.makedirs(OUT, exist_ok=True)
        open(path, 'w', encoding='utf-8').write(text)
        print(f'wrote {name}', flush=True)
if check:
    extra = sorted(set(os.listdir(OUT)) - {INSTALL_NAME, ROLLBACK_NAME, 'README.md'})
    print(f'{"PASS" if not extra else "FAIL"}  the candidate ships only the two entrypoints (+ README.md){": " + ", ".join(extra) if extra else ""}', flush=True)
    bad += 1 if extra else 0
sys.exit(1 if bad else 0)
