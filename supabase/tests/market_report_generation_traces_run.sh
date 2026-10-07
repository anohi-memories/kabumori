#!/usr/bin/env bash
# Disposable-PostgreSQL proof of 20261007120000_market_report_generation_traces.sql. Never touches Supabase.
#
#   TRC_PGHOST=/tmp/<socket dir> TRC_PGPORT=54878 TRC_PGSUPER=<superuser> bash supabase/tests/market_report_generation_traces_run.sh
#
# Part 1: the clean path (behaviour: append-only, access, retention, constraints).
# Part 2: adverse access graphs. The migration verifies EFFECTIVE privileges, not only its own grants, and must
#         refuse, atomically and without repairing anything, when the table or its helper would be reachable by
#         an unintended role. Each case runs in a fresh database; after a refusal there must be no trace object
#         and the unrelated default-ACL / membership / role state must be exactly what it was.
#
# The host must be a local socket directory under /tmp (the runner refuses anything else), so a mistyped host
# can never point this at a real project. Scratch databases are created and dropped.
set -euo pipefail
export LC_ALL=C

HOST="${TRC_PGHOST:?TRC_PGHOST (local socket dir under /tmp or /private/tmp) is required}"
PORT="${TRC_PGPORT:-5432}"
SUPER="${TRC_PGSUPER:-postgres}"
case "$HOST" in
  /tmp/*|/private/tmp/*) ;;
  *) echo "refusing host '$HOST': only a local socket directory under /tmp is allowed" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATION="$HERE/../migrations/20261007120000_market_report_generation_traces.sql"
PREFIX="trc_proof_$$"
DBS=()
psql_super() { psql -h "$HOST" -p "$PORT" -U "$SUPER" -v ON_ERROR_STOP=1 -q "$@"; }
# Roles and memberships are CLUSTER-wide: the adverse cases below change them, so they are undone after every
# case, at exit, and before the first case (a run that was killed half-way must not poison the next one).
EXTRA_ROLES=(unknown_reader unknown_exec trigger_holder reader_via_default team_reader other_super)
reset_cluster_roles() {
  psql_super -d postgres >/dev/null 2>&1 <<SQL || true
do \$\$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke %I from %I', '$SUPER', r);
      execute format('revoke pg_read_all_data from %I', r);
      execute format('revoke pg_write_all_data from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'alter role service_role nosuperuser';
  end if;
  foreach r in array array['unknown_reader', 'unknown_exec', 'trigger_holder', 'reader_via_default', 'team_reader', 'other_super'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('drop role %I', r);
    end if;
  end loop;
end
\$\$;
SQL
}
cleanup() {
  for db in ${DBS[@]+"${DBS[@]}"}; do psql_super -d postgres -c "drop database if exists $db" >/dev/null 2>&1 || true; done
  reset_cluster_roles
}
trap cleanup EXIT
# Scratch databases of a killed earlier run (they hold default ACLs that pin the extra roles) go first.
for leftover in $(psql_super -d postgres -Atc "select datname from pg_database where datname like 'trc\\_proof\\_%'"); do
  psql_super -d postgres -c "drop database if exists $leftover" >/dev/null 2>&1 || true
done
reset_cluster_roles

# A fresh database with the three roles Supabase provides (created only inside this scratch cluster).
fresh_db() {
  local db="${PREFIX}_$1"
  DBS+=("$db")
  psql_super -d postgres -c "create database $db" >/dev/null
  psql_super -d "$db" >/dev/null <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end
$$;
grant usage on schema public to anon, authenticated, service_role;
SQL
  echo "$db"
}

# A digest of everything the migration must not disturb on refusal: default ACLs, memberships, role attributes.
state_digest() {
  psql_super -d "$1" -Atc "
    select md5(
      coalesce((select string_agg(pg_get_userbyid(defaclrole) || ':' || defaclnamespace::text || ':' || defaclobjtype::text || ':' || defaclacl::text, '|' order by 1) from pg_default_acl), '') || '#' ||
      coalesce((select string_agg(roleid::regrole::text || '>' || member::regrole::text || ':' || coalesce(admin_option::text, ''), '|' order by 1) from pg_auth_members where roleid > 16384 or member > 16384), '') || '#' ||
      coalesce((select string_agg(rolname || ':' || rolsuper || rolinherit || rolcanlogin || rolbypassrls, '|' order by rolname) from pg_roles where rolname !~ '^pg_'), '')
    )"
}

# ---- Part 1: the clean path ---------------------------------------------------------------------------------
CLEAN="$(fresh_db clean)"
psql_super -d "$CLEAN" -f "$MIGRATION" >/dev/null
echo "migration applied to scratch database $CLEAN"
# Re-applying must fail cleanly (create table, not create-or-replace): the migration is one-shot.
if psql_super -d "$CLEAN" -f "$MIGRATION" >/dev/null 2>&1; then echo "FAIL: migration applied twice" >&2; exit 1; fi
psql_super -d "$CLEAN" -f "$HERE/market_report_generation_traces_behavior.sql"

# Supabase-like defaults (ALL on new tables / functions for the application roles) are revoked by the migration:
# it must still apply and leave exactly service_role SELECT + INSERT.
SUPA="$(fresh_db supabase_like)"
psql_super -d "$SUPA" >/dev/null <<'SQL'
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
SQL
psql_super -d "$SUPA" -f "$MIGRATION" >/dev/null
psql_super -d "$SUPA" -f "$HERE/market_report_generation_traces_behavior.sql" >/dev/null
echo "supabase-like default privileges: applied, behaviour PASS"

# ---- Part 2: adverse access graphs --------------------------------------------------------------------------
# refuse <name> <expected error code> <setup sql>
refuse() {
  local name="$1" code="$2" setup="$3" db before after out
  db="$(fresh_db "$name")"
  psql_super -d "$db" >/dev/null <<SQL
$setup
SQL
  before="$(state_digest "$db")"
  if out="$(psql_super -d "$db" -f "$MIGRATION" 2>&1)"; then
    echo "FAIL [$name]: the migration applied although the access graph is unsafe" >&2; exit 1
  fi
  case "$out" in
    *"$code"*) ;;
    *) echo "FAIL [$name]: refused for the wrong reason (wanted $code): $out" >&2; exit 1 ;;
  esac
  # Atomic: nothing of the trace stays behind, and nothing unrelated was repaired or changed.
  local leftovers
  leftovers="$(psql_super -d "$db" -Atc "
    select (select count(*) from pg_class where relname like 'market_report_generation_traces%')
         + (select count(*) from pg_proc where proname like 'market_report_generation_traces%')
         + (select count(*) from pg_trigger where tgname like 'market_report_generation_traces%')")"
  [ "$leftovers" = "0" ] || { echo "FAIL [$name]: $leftovers trace objects left behind" >&2; exit 1; }
  after="$(state_digest "$db")"
  [ "$before" = "$after" ] || { echo "FAIL [$name]: unrelated role / default-ACL / membership state changed" >&2; exit 1; }
  echo "refused atomically [$name]: $code"
  psql_super -d postgres -c "drop database $db" >/dev/null
  reset_cluster_roles
}

# H2 case 1: a role the migration does not know has a default SELECT on new tables -> it could read the evidence.
refuse default_table_select MARKET_REPORT_TRACE_ACL_UNEXPECTED_TABLE_GRANT "
create role unknown_reader nologin;
alter default privileges in schema public grant select on tables to unknown_reader;"

# H2 case 2: a role the migration does not know has a default EXECUTE on new functions -> the helper survives it.
refuse default_helper_execute MARKET_REPORT_TRACE_ACL_UNEXPECTED_HELPER_GRANT "
create role unknown_exec nologin;
alter default privileges in schema public grant execute on functions to unknown_exec;"

# H2 case 3: service_role inherits TRIGGER from another role -> it could add a trigger that silently drops inserts.
refuse service_role_inherits_trigger MARKET_REPORT_TRACE_ACL_UNEXPECTED_TABLE_GRANT "
create role trigger_holder nologin;
grant trigger_holder to service_role;
alter default privileges in schema public grant trigger on tables to trigger_holder;"

# H2 case 4: authenticated is a member of the owner -> it inherits ownership: read, erase, drop.
refuse authenticated_member_of_owner MARKET_REPORT_TRACE_ACL_UNSAFE_MEMBERSHIP "
grant $SUPER to authenticated;"

# Further graphs the verification must close.
refuse anon_member_of_owner MARKET_REPORT_TRACE_ACL_UNSAFE_MEMBERSHIP "grant $SUPER to anon;"
refuse service_role_member_of_owner MARKET_REPORT_TRACE_ACL_UNSAFE_MEMBERSHIP "grant $SUPER to service_role;"
refuse service_role_is_superuser MARKET_REPORT_TRACE_ACL_UNSAFE_MEMBERSHIP "alter role service_role superuser;"
refuse authenticated_inherits_superuser MARKET_REPORT_TRACE_ACL_UNSAFE_MEMBERSHIP "
create role other_super nologin superuser;
grant other_super to authenticated;"
# Reachable with no ACL entry at all: a predefined role that reads / writes every table. Only the effective
# privilege check sees it.
refuse authenticated_in_pg_read_all_data MARKET_REPORT_TRACE_ACL_EFFECTIVE_PRIVILEGE "grant pg_read_all_data to authenticated;"
refuse service_role_in_pg_write_all_data MARKET_REPORT_TRACE_ACL_EFFECTIVE_PRIVILEGE "grant pg_write_all_data to service_role;"
refuse anon_in_pg_read_all_data MARKET_REPORT_TRACE_ACL_EFFECTIVE_PRIVILEGE "grant pg_read_all_data to anon;"

refuse default_public_table_select MARKET_REPORT_TRACE_ACL_UNEXPECTED_TABLE_GRANT "
create role reader_via_default nologin;
alter default privileges in schema public grant select, update on tables to reader_via_default with grant option;"
refuse authenticated_inherits_reader MARKET_REPORT_TRACE_ACL_UNEXPECTED_TABLE_GRANT "
create role team_reader nologin;
grant team_reader to authenticated;
alter default privileges in schema public grant select on tables to team_reader;"

echo "market_report_generation_traces: clean path PASS, access-graph refusals PASS"
