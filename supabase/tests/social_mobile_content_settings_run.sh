#!/usr/bin/env bash
# Disposable-only proof runner for the social-mobile content settings hardening.
# Creates throwaway databases on a LOCAL Unix-socket PostgreSQL cluster, applies the
# production-shaped fixture, the unchanged candidate and the hardening migration as a
# non-superuser owner, then proves contract, privileges, RLS, versioning (incl. two-connection
# races), lifecycle and drift handling. Fake data only; never production.
# Usage: SMCS_PGHOST=/private/tmp/<socket-dir> SMCS_PGPORT=<port> SMCS_PGSUPER=<local superuser> \
#        supabase/tests/social_mobile_content_settings_run.sh
# Optional: SMCS_HARDENING=<path> runs a modified copy of the hardening migration (mutation tests).
set -euo pipefail

host="${SMCS_PGHOST:?SMCS_PGHOST (local socket dir) required}"
port="${SMCS_PGPORT:?SMCS_PGPORT required}"
super="${SMCS_PGSUPER:?SMCS_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: SMCS_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac
# Start the cluster with lc_messages=C: the checks below match English server messages.
export LC_ALL=C

here="$(cd "$(dirname "$0")" && pwd)"
candidate="$here/../migrations/20260922045046_social_mobile_content_settings_candidate.sql"
hardening="${SMCS_HARDENING:-$here/../migrations/20261003120000_social_mobile_content_settings_hardening.sql}"
fixture="$here/social_mobile_content_settings_fixture.sql"
behavior="$here/social_mobile_content_settings_behavior.sql"
owner="kb_smcs_owner"
prefix="kabumori_smcs_$$"
psql_bin="${PSQL:-psql}"
as_super=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-smcs.XXXXXX)"

# Every database this run created starts with $prefix (new_db runs in a subshell, so the names
# are looked up from the catalog rather than remembered).
cleanup() {
  rm -rf "$tmp"
  local db
  for db in $("${as_super[@]}" -A -t -d postgres -c "select datname from pg_database where datname like '${prefix}\_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

"${as_super[@]}" -d postgres <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then
    create role $owner login nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_smcs_stranger') then create role kb_smcs_stranger nologin; end if;
end \$\$;
grant anon, authenticated, service_role to $owner;
SQL

# new_db <name>: fresh database owned by the non-superuser owner, with the fixture applied.
new_db() {
  local db="${prefix}_$1"
  "${as_super[@]}" -d postgres -c "create database $db owner $owner" >/dev/null
  "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f "$fixture" >/dev/null
  echo "$db"
}
q() { local db="$1"; shift; "$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
fail() { echo "FAIL $*" >&2; exit 1; }

# --- Apply: candidate, then hardening in one transaction; a re-run is a safe no-op -------------
main="$(new_db main)"
q "$main" -f "$candidate" >/dev/null
q "$main" -1 -f "$hardening" >/dev/null || fail "hardening on the exact candidate"
q "$main" -1 -f "$hardening" >/dev/null || fail "re-running the hardening"
echo "SMCS_APPLY_AND_RERUN_PASS"

# Candidate and hardening together in ONE transaction on a fresh database (fresh rollout path).
fresh="$(new_db fresh)"
q "$fresh" -1 -f "$candidate" -f "$hardening" >/dev/null || fail "candidate+hardening in one transaction"
echo "SMCS_SINGLE_TRANSACTION_APPLY_PASS"

# --- Behaviour (contract, version, privileges, RLS, lifecycle) ---------------------------------
out="$(q "$main" -f "$behavior" 2>&1)" || { echo "$out" >&2; fail "behavior"; }
grep -q SOCIAL_MOBILE_CONTENT_SETTINGS_BEHAVIOR_PASS <<<"$out" || fail "behavior marker: $out"
echo "SOCIAL_MOBILE_CONTENT_SETTINGS_BEHAVIOR_PASS"

# --- Two-connection races ---------------------------------------------------------------------
as_owner_a="select t.as_user('00000000-0000-4000-8000-00000000000a'); set local role authenticated;"
version() { q "$main" -c "select updated_at from public.social_mobile_content_settings where brand_id = 'u_brand_a'"; }

# 1. Concurrent CAS on the same version: exactly one winner. The first holds its row lock while
#    the second waits, then re-checks the WHERE clause against the committed row and matches 0.
v="$(version)"
cas_a="update public.social_mobile_content_settings set settings = jsonb_set(settings, '{notes}', '\"A\"') where brand_id = 'u_brand_a' and updated_at = '$v'"
cas_b="update public.social_mobile_content_settings set settings = jsonb_set(settings, '{notes}', '\"B\"') where brand_id = 'u_brand_a' and updated_at = '$v'"
q "$main" -c "begin; $as_owner_a select 'changed=' || t.affected(\$q\$$cas_a\$q\$); select pg_sleep(1.5); commit;" > "$tmp/ra" 2>&1 &
sleep 0.4
q "$main" -c "begin; $as_owner_a select 'changed=' || t.affected(\$q\$$cas_b\$q\$); commit;" > "$tmp/rb" 2>&1 &
wait
grep -q 'changed=1' "$tmp/ra" || fail "CAS race first writer: $(cat "$tmp/ra")"
grep -q 'changed=0' "$tmp/rb" || fail "CAS race second writer must match 0: $(cat "$tmp/rb")"
[[ "$(q "$main" -c "select settings ->> 'notes' from public.social_mobile_content_settings where brand_id = 'u_brand_a'")" == A ]] || fail "CAS race result"
echo "SMCS_CONCURRENT_CAS_ONE_WINNER_PASS"

# 2. A long-running EARLIER transaction cannot move the version behind a later committed one.
q "$main" -c "begin; select now(); select pg_sleep(1.5); $as_owner_a update public.social_mobile_content_settings set settings = jsonb_set(settings, '{notes}', '\"late\"') where brand_id = 'u_brand_a'; commit;" > "$tmp/long" 2>&1 &
sleep 0.4
q "$main" -c "update public.social_mobile_content_settings set settings = jsonb_set(settings, '{notes}', '\"mid\"') where brand_id = 'u_brand_a'" >/dev/null
mid="$(version)"
wait
grep -qi error "$tmp/long" && fail "long transaction: $(cat "$tmp/long")"
after="$(version)"
[[ "$(q "$main" -c "select '$after'::timestamptz > '$mid'::timestamptz")" == t ]] || fail "version regressed: mid=$mid after=$after"
echo "SMCS_LONG_TRANSACTION_NO_REGRESSION_PASS"

# 3. Two first-time inserts for the same brand: one row, the other gets a unique violation.
q "$main" -c "insert into public.brand_memberships values ('u_brand_c', '00000000-0000-4000-8000-00000000000a', 'owner')" >/dev/null
ins="insert into public.social_mobile_content_settings (brand_id) values ('u_brand_c')"
q "$main" -c "begin; $as_owner_a $ins; select pg_sleep(1.5); commit;" > "$tmp/i1" 2>&1 &
sleep 0.4
q "$main" -c "begin; $as_owner_a $ins; commit;" > "$tmp/i2" 2>&1 &
wait || true
grep -q 'duplicate key' "$tmp/i2" || fail "competing insert: $(cat "$tmp/i1" "$tmp/i2")"
[[ "$(q "$main" -c "select count(*) from public.social_mobile_content_settings where brand_id = 'u_brand_c'")" == 1 ]] || fail "competing insert rows"
echo "SMCS_COMPETING_INSERT_UNIQUE_PASS"

# --- Existing rows that break the contract stop the migration (nothing is rewritten) ----------
bad="$(new_db badrow)"
q "$bad" -f "$candidate" >/dev/null
q "$bad" -c "insert into public.social_mobile_content_settings (brand_id, settings) values ('u_brand_a', jsonb_set(t.default_settings(), '{frequencyTargetPerWeek}', '\"3\"'))" >/dev/null
if q "$bad" -1 -f "$hardening" > "$tmp/badrow" 2>&1; then fail "invalid existing row was accepted"; fi
grep -q SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_EXISTING_ROWS_INVALID "$tmp/badrow" || fail "badrow error: $(cat "$tmp/badrow")"
[[ "$(q "$bad" -c "select count(*) from pg_constraint where conname = 'social_mobile_content_settings_shape'")" == 1 ]] || fail "badrow did not roll back"
echo "SMCS_EXISTING_INVALID_ROWS_REFUSED_PASS"

# --- Drift: unknown drift is refused; only the enumerated CHECK replacement is repaired --------
# drift_refused <name> <sql applied after the candidate>
drift_refused() {
  local db; db="$(new_db "d_$1")"
  q "$db" -f "$candidate" >/dev/null
  q "$db" -c "$2" >/dev/null
  if q "$db" -1 -f "$hardening" > "$tmp/$1" 2>&1; then fail "drift accepted: $1"; fi
  grep -q SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_DRIFT "$tmp/$1" || fail "drift $1 wrong error: $(cat "$tmp/$1")"
  # Nothing was changed: the candidate's shape CHECK and trigger are still there.
  [[ "$(q "$db" -c "select count(*) from pg_proc where proname = 'social_mobile_content_settings_version'")" == 0 ]] || fail "drift $1 partially applied"
  echo "SMCS_DRIFT_REFUSED_PASS $1"
}
t_="public.social_mobile_content_settings"
fk="social_mobile_content_settings_brand_id_fkey"
drift_refused fk_missing "alter table $t_ drop constraint $fk"
drift_refused fk_retargeted "create table public.other_brands (id text primary key); alter table $t_ drop constraint $fk; alter table $t_ add constraint $fk foreign key (brand_id) references public.other_brands (id) on delete cascade"
drift_refused fk_restrict "alter table $t_ drop constraint $fk; alter table $t_ add constraint $fk foreign key (brand_id) references public.brands (id) on delete restrict"
drift_refused fk_not_valid "alter table $t_ drop constraint $fk; alter table $t_ add constraint $fk foreign key (brand_id) references public.brands (id) on delete cascade not valid"
drift_refused fk_extra "create table public.other_brands (id text primary key); alter table $t_ add constraint extra_fk foreign key (brand_id) references public.other_brands (id)"
drift_refused column_type "alter table $t_ drop constraint social_mobile_content_settings_shape; alter table $t_ alter column settings drop default; alter table $t_ alter column settings type json using settings::json"
drift_refused column_nullable "alter table $t_ alter column settings drop not null"
drift_refused column_extra "alter table $t_ add column publish_enabled boolean"
drift_refused column_missing "alter table $t_ drop column persona_last_analyzed_at"
drift_refused check_unknown "alter table $t_ add constraint loose check (true)"
drift_refused unique_extra "alter table $t_ add constraint extra_unique unique (settings)"
drift_refused index_extra "create index extra_idx on $t_ (updated_at)"
drift_refused trigger_unknown "create function public.extra_trigger() returns trigger language plpgsql as \$\$ begin return new; end; \$\$; create trigger extra before insert on $t_ for each row execute function public.extra_trigger()"
drift_refused trigger_rebound "create function public.extra_trigger() returns trigger language plpgsql as \$\$ begin return new; end; \$\$; drop trigger social_mobile_content_settings_touch_updated_at on $t_; create trigger social_mobile_content_settings_touch_updated_at before update on $t_ for each row execute function public.extra_trigger()"
drift_refused policy_extra "create policy wide_open on $t_ for select to authenticated using (true)"
drift_refused grantee_unknown "grant select on $t_ to kb_smcs_stranger"
drift_refused column_grantee_unknown "grant update (settings) on $t_ to kb_smcs_stranger"
drift_refused table_missing "drop table $t_"
drift_refused view_impostor "drop table $t_; create view $t_ as select 'x'::text as brand_id"

# Drift that appears after hardening is refused on re-run as well.
post="$(new_db d_post)"
q "$post" -f "$candidate" >/dev/null
q "$post" -1 -f "$hardening" >/dev/null
q "$post" -c "alter table $t_ drop constraint $fk" >/dev/null
if q "$post" -1 -f "$hardening" > "$tmp/post" 2>&1; then fail "post-hardening drift accepted"; fi
grep -q SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_DRIFT "$tmp/post" || fail "post drift error: $(cat "$tmp/post")"
echo "SMCS_DRIFT_REFUSED_PASS after_hardening"

# Enumerated repair: a weakened or missing candidate CHECK is replaced by the hardened contract.
# drift_repaired <name> <sql>
drift_repaired() {
  local db; db="$(new_db "r_$1")"
  q "$db" -f "$candidate" >/dev/null
  q "$db" -c "$2" >/dev/null
  q "$db" -1 -f "$hardening" > "$tmp/r_$1" 2>&1 || fail "repair $1: $(cat "$tmp/r_$1")"
  [[ "$(q "$db" -c "select count(*) from pg_constraint where conrelid = '$t_'::regclass and conname in ('social_mobile_content_settings_settings_contract', 'social_mobile_content_settings_persona_contract', 'social_mobile_content_settings_shape', 'social_mobile_content_settings_persona_shape')")" == 2 ]] || fail "repair $1 constraints"
  if q "$db" -c "insert into $t_ (brand_id, settings) values ('u_brand_a', jsonb_set(t.default_settings(), '{locale}', 'null'))" >/dev/null 2>&1; then fail "repair $1 still accepts null locale"; fi
  [[ "$(q "$db" -c "select has_table_privilege('anon', '$t_', 'SELECT') or has_table_privilege('authenticated', '$t_', 'TRUNCATE') or has_table_privilege('service_role', '$t_', 'SELECT')")" == f ]] || fail "repair $1 privileges"
  echo "SMCS_ENUMERATED_REPAIR_PASS $1"
}
drift_repaired check_weakened "alter table $t_ drop constraint social_mobile_content_settings_shape; alter table $t_ add constraint social_mobile_content_settings_shape check (true)"
drift_repaired check_missing "alter table $t_ drop constraint social_mobile_content_settings_shape, drop constraint social_mobile_content_settings_persona_shape"
drift_repaired grants_widened "grant all on $t_ to anon, authenticated, service_role"

# --- Unrelated objects untouched; database dropped ---------------------------------------------
[[ "$(q "$main" -c "select count(*) from public.unrelated_rows")" == 2 ]] || fail "unrelated rows"
cleanup
trap - EXIT
left="$("${as_super[@]}" -A -t -d postgres -c "select count(*) from pg_database where datname like '${prefix}%'")"
[[ "$left" == 0 ]] || fail "cleanup left databases"
echo "SMCS_CLEANUP_PASS"
echo "SOCIAL_MOBILE_CONTENT_SETTINGS_ALL_PASS"
