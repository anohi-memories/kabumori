#!/usr/bin/env bash
# Disposable local proof of the backfill gate files (check.sql read-only, apply.sql fail-closed).
# Builds the lifecycle suite's production-shaped baseline plus the accepted foundation migration in a
# template database on a LOCAL Unix-socket PostgreSQL 17 cluster, seeds fake logins, and runs the real
# files the operator runs in production. Fake data only; never production.
#
# Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
#        bash supabase/tests/common_account_lifecycle_backfill/proof.sh
set -euo pipefail
export LC_ALL=C

host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
port="${CAL_PGPORT:?CAL_PGPORT required}"
super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /tmp/*|/private/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
tests="$here/.."
migrations="$here/../../migrations"
owner="kb_cal_backfill_owner"
tpl="kabumori_cal_backfill_tpl_$$"
dbs="$tpl"
bg=""
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  if [[ -n "$bg" ]]; then kill "$bg" 2>/dev/null || true; fi
  for d in $dbs; do "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb nocreaterole; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
SQL
"${S[@]}" -d postgres -c "create database $tpl owner $owner" >/dev/null
T=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$tpl")
"${T[@]}" -f "$tests/social_mobile_account_deletion_fixture.sql" >/dev/null
"${T[@]}" -f "$migrations/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
"${T[@]}" -f "$migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
"${T[@]}" -f "$migrations/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
"${T[@]}" -f "$tests/common_account_lifecycle_fixture.sql" >/dev/null
"${T[@]}" -c "create schema supabase_migrations;
  create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
  insert into supabase_migrations.schema_migrations (version, name) values ('20261001150000', 'common_account_lifecycle_foundation');" >/dev/null
"${T[@]}" -f "$migrations/20261001150000_common_account_lifecycle_foundation.sql" >/dev/null
# Fake population (ids are fixed fake UUIDs):
#   101 Kabumori with activity, admin     102 Kabumori profile only     103 X self-service owner, verified
#   104 login only                         105 X self-service owner, pending
#   106 admin who solely owns a verified self-service workspace (no profile) -> excluded from X
#   107 owner of an internal workspace (not consumer X)
"${T[@]}" >/dev/null <<'SQL'
select public.fixture_login('00000000-0000-0000-0000-000000000101', true, true);
insert into public.admin_users values ('00000000-0000-0000-0000-000000000101');
select public.fixture_login('00000000-0000-0000-0000-000000000102', true, false);
select public.fixture_user_with_workspace('00000000-0000-0000-0000-000000000103', 'B103');
select public.fixture_login('00000000-0000-0000-0000-000000000104');
select public.fixture_user_with_workspace('00000000-0000-0000-0000-000000000105', 'B105');
update public.social_accounts set connection_status = 'authorization_pending'
 where brand_id = public.social_mobile_account_deletion_workspace('00000000-0000-0000-0000-000000000105');
select public.fixture_user_with_workspace('00000000-0000-0000-0000-000000000106', 'B106');
insert into public.admin_users values ('00000000-0000-0000-0000-000000000106');
select public.fixture_login('00000000-0000-0000-0000-000000000107');
insert into public.brand_memberships (brand_id, user_id, role) values ('kabumori', '00000000-0000-0000-0000-000000000107', 'owner');
SQL

pass=0
ok() { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; exit 1; }
expect() { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 :: got [$2] want [$3]"; }
db=""
fresh() { db="kabumori_cal_backfill_$1_$$"; dbs="$dbs $db"; "${S[@]}" -d postgres -c "create database $db template $tpl owner $owner" >/dev/null; }
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -c "$1"; }
counts() { Q "select (select count(*) from public.common_accounts) || '/' || (select count(*) from public.service_entitlements) || '/' || (select count(*) from private.account_lifecycle_operations)"; }
line() { sed -n "s/^$1=//p" <<<"$OUT"; }
# The approved dry-run for the fake population (7 logins).
EXP=(-v exp_auth_users=7 -v exp_accounts_to_create=7 -v exp_kab_to_create=2 -v exp_kab_activity=1 -v exp_kab_profile_only=1
     -v exp_x_to_create=2 -v exp_x_verified=1 -v exp_x_pending=1 -v exp_x_excluded_admin=1 -v exp_auth_only=3)
check() { set +e; OUT="$(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f "$here/check.sql" 2>&1)"; RC=$?; set -e; }
apply() { set +e; OUT="$(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@" -f "$here/apply.sql" 2>&1)"; RC=$?; set -e; }

# 1. read-only check: dry-run plan, parity, nothing written
fresh check
check
expect "check exits 0" "$RC" "0"
grep -q '"read_only": "on"' <<<"$(line session)" && ok "check runs in a READ ONLY transaction" || bad "read-only session :: $OUT"
dry="$(line B_dry_run)"
python3 - "$dry" <<'PY' && ok "dry-run aggregate equals the expected plan for the fake population" || bad "dry-run :: $dry"
import json, sys
d = json.loads(sys.argv[1])
want = dict(applied=False, auth_users=7, common_accounts_to_create=7, kabumori_candidates=2, kabumori_with_activity=1,
            kabumori_profile_only=1, kabumori_to_create=2, x_autopost_candidates=2, x_autopost_identity_verified=1,
            x_autopost_workspace_pending=1, x_autopost_to_create=2, x_autopost_excluded_admin=1, auth_only=3,
            not_active_accounts_with_candidates=0, admin_users=2, created_common_accounts=0, created_kabumori=0,
            created_x_autopost=0, skipped_account_not_active=0)
sys.exit(0 if all(d.get(k) == v for k, v in want.items()) else 1)
PY
expect "check: counts before = after" "$(line B_counts_before)" "$(line B_counts_after)"
python3 - "$(line C_parity)" "$dry" <<'PY' && ok "parity recomputed from base tables equals the dry-run" || bad "parity"
import json, sys
c, d = json.loads(sys.argv[1]), json.loads(sys.argv[2])
pairs = [("auth_users", "auth_users"), ("missing_common_accounts", "common_accounts_to_create"),
         ("kabumori_candidates", "kabumori_candidates"), ("kabumori_with_activity", "kabumori_with_activity"),
         ("kabumori_profile_only", "kabumori_profile_only"), ("kabumori_to_create", "kabumori_to_create"),
         ("x_candidates", "x_autopost_candidates"), ("x_verified", "x_autopost_identity_verified"),
         ("x_pending", "x_autopost_workspace_pending"), ("x_to_create", "x_autopost_to_create"),
         ("x_excluded_admin", "x_autopost_excluded_admin"), ("auth_only", "auth_only"), ("admins", "admin_users")]
ok = all(c[a] == d[b] for a, b in pairs) and c["plan_rows"] == c["plan_distinct_users"] == c["auth_users"] and c["plan_users_not_in_auth"] == 0
sys.exit(0 if ok else 1)
PY
expect "check wrote nothing" "$(counts)" "0/0/0"
sed 's/account_lifecycle_backfill(false)/account_lifecycle_backfill(true)/' "$here/check.sql" > "${TMPDIR:-/tmp}/cal_check_true.$$.sql"
set +e; OUT="$(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f "${TMPDIR:-/tmp}/cal_check_true.$$.sql" 2>&1)"; RC=$?; set -e
rm -f "${TMPDIR:-/tmp}/cal_check_true.$$.sql"
[[ "$RC" == 3 && "$OUT" == *"read-only transaction"* ]] && ok "a write smuggled into check.sql is refused by the READ ONLY transaction" || bad "read-only guard :: rc=$RC $OUT"
expect "refused write left nothing" "$(counts)" "0/0/0"

# 2. clean apply: commits exactly the approved rows
fresh clean
apply "${EXP[@]}"
expect "apply exits 0" "$RC" "0"
grep -q '^COMMITTED=' <<<"$OUT" && ok "apply reports COMMITTED" || bad "committed :: $OUT"
expect "apply: 7 accounts / 4 entitlements / 0 operations" "$(counts)" "7/4/0"
expect "apply: evidence distribution" \
  "$(Q "select string_agg(service_key || ':' || legacy_evidence || ':' || source || ':' || status, ',' order by service_key, legacy_evidence) from public.service_entitlements")" \
  "kabumori:kabumori_activity:legacy_backfill:active,kabumori:kabumori_profile_only:legacy_backfill:active,x_autopost:x_identity_verified:legacy_backfill:active,x_autopost:x_workspace_pending:legacy_backfill:active"
expect "apply: admins have no X entitlement; login-only and internal owner have none" \
  "$(Q "select count(*) from public.service_entitlements where user_id in ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000104','00000000-0000-0000-0000-000000000106','00000000-0000-0000-0000-000000000107') and service_key = 'x_autopost'")" "0"
expect "apply: the admin keeps the Kabumori rule" "$(Q "select status from public.service_entitlements where user_id = '00000000-0000-0000-0000-000000000101' and service_key = 'kabumori'")" "active"
check
expect "read-back after apply: nothing left to create" \
  "$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d['common_accounts_to_create'], d['kabumori_to_create'], d['x_autopost_to_create'])" "$(line B_dry_run)")" "0 0 0"

# 3. rerun after a commit (e.g. response lost and someone retries): refuses before writing
apply "${EXP[@]}"
expect "rerun after commit: exit 3" "$RC" "3"
grep -q 'BACKFILL_PRECONDITION_STATE' <<<"$OUT" && ok "rerun after commit: precondition refuses" || bad "rerun :: $OUT"
expect "rerun after commit: unchanged" "$(counts)" "7/4/0"

# 4. the plan moved since approval (a new login): refuses before writing
fresh plan_changed
Q "select public.fixture_login('00000000-0000-0000-0000-000000000108', true, false)" >/dev/null
apply "${EXP[@]}"
expect "plan changed: exit 3" "$RC" "3"
grep -q 'BACKFILL_PLAN_CHANGED' <<<"$OUT" && ok "plan changed: refused" || bad "plan changed :: $OUT"
expect "plan changed: nothing written" "$(counts)" "0/0/0"

# 5. approved numbers wrong: refuses before writing
fresh wrong_numbers
apply "${EXP[@]}" -v exp_kab_profile_only=2
expect "wrong approved numbers: exit 3" "$RC" "3"
expect "wrong approved numbers: nothing written" "$(counts)" "0/0/0"

# 6. a busy login (an open transaction holding FOR UPDATE on one auth.users row): lock timeout, full rollback
fresh lock_wait
( psql -X -q -h "$host" -p "$port" -U "$super" -d "$db" \
    -c "begin; select 1 from auth.users where id = '00000000-0000-0000-0000-000000000105' for update; select pg_sleep(30); commit;" >/dev/null 2>&1 & echo $! > "${TMPDIR:-/tmp}/cal_bf_lock.$$" )
bg="$(cat "${TMPDIR:-/tmp}/cal_bf_lock.$$")"; rm -f "${TMPDIR:-/tmp}/cal_bf_lock.$$"
tries=0
until [[ "$(Q "select count(*) from pg_stat_activity where datname = '$db' and query like '%pg_sleep%' and state = 'active'")" -gt 0 ]]; do
  tries=$((tries + 1)); [[ $tries -lt 50 ]] || bad "lock holder did not start"; sleep 0.1
done
t0=$SECONDS
apply "${EXP[@]}"
"${S[@]}" -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$db' and pid <> pg_backend_pid()" >/dev/null
kill "$bg" 2>/dev/null || true; bg=""
expect "lock wait: exit 3" "$RC" "3"
grep -q 'lock timeout' <<<"$OUT" && ok "lock wait: reason is the lock timeout" || bad "lock reason :: $OUT"
[[ $((SECONDS - t0)) -lt 20 ]] && ok "lock wait: gave up within the bound" || bad "lock wait took $((SECONDS - t0))s"
expect "lock wait: rows created for earlier logins were rolled back too" "$(counts)" "0/0/0"

# 7. something wrong after the write (evidence altered by a trigger): postcondition refuses, full rollback
fresh post_fail
"${S[@]}" -d "$db" >/dev/null <<'SQL'
create function public.proof_bend_evidence() returns trigger language plpgsql as $$
begin
  if new.service_key = 'kabumori' then new.legacy_evidence := 'kabumori_profile_only'; end if;
  return new;
end $$;
create trigger proof_bend_evidence before insert on public.service_entitlements for each row execute function public.proof_bend_evidence();
SQL
apply "${EXP[@]}"
expect "postcondition: exit 3" "$RC" "3"
grep -q 'BACKFILL_POSTCONDITION' <<<"$OUT" && ok "postcondition: refused after the write" || bad "postcondition :: $OUT"
expect "postcondition: everything rolled back" "$(counts)" "0/0/0"

# 8. a missing approved number is an error before anything runs
fresh missing_var
set +e; OUT="$(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -v exp_auth_users=7 -f "$here/apply.sql" 2>&1)"; RC=$?; set -e
expect "missing approved numbers: exit 3" "$RC" "3"
expect "missing approved numbers: nothing written" "$(counts)" "0/0/0"

echo "ALL COMMON ACCOUNT BACKFILL GATE CHECKS PASSED ($pass)"
