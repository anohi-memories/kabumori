#!/usr/bin/env bash
# Operator runner for applying 20261007120000_market_report_generation_traces.sql:
#   schema first -> mandatory catalog read-back -> migration history second.
# Same shape as ai_lab_topic_claims_rollout.sh (the reviewed pattern for this project).
#
# The migration carries its own BEGIN/COMMIT (and its own access verification that raises and rolls back),
# so schema and history cannot share one transaction. This runner never lets history get ahead of a verified
# schema, never retries, never repairs and never drops anything. Any surprise is a STOP with a fixed exit code.
#
#   status                   read-only classification of the target database
#   apply                    Stage A (exact migration) -> Stage B (catalog read-back) -> Stage C (history)
#   apply --resume-history   only for "schema present / history missing": Stage B -> Stage C
#   proof                    disposable local PostgreSQL proof of every success/failure path
#
# Connection: libpq environment only (PGHOST, PGPORT, PGUSER, PGDATABASE, PGSSLMODE; password via
# ~/.pgpass or PGPASSWORD). No URL, password, token or project ref is accepted as an argument, stored in this
# file, or printed. Default target is LOCAL and only a /tmp Unix-socket host is accepted. Production needs every
# switch documented in market_report_generation_traces_rollout.md and is NOT run by any agent.
#
# Exit codes: 0 done / already complete / status printed, 2 refused by a guard, 10 STOP precondition,
# 11 STOP Stage A failed (schema confirmed absent), 12 STOP Stage A outcome unknown or inconsistent,
# 13 STOP Stage B catalog mismatch, 14 STOP schema present / history missing, 15 STOP postflight mismatch.
set -euo pipefail

VERSION="20261007120000"
NAME="market_report_generation_traces"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATION="$HERE/../migrations/${VERSION}_${NAME}.sql"
# Accepted source (PR #101, merge e49ecfcc2f6707f64b6282960f9eec61be2973d3). Stage A refuses any other bytes.
MIGRATION_SHA256="f7eb5707fb9695ee6a94c5e2bc9f9eaa3ad4660a67e94f1ad62cb5b07984622b"
PROD_ACK="apply ${VERSION}_${NAME} to production after a same-day read-only preflight"
TABLE="public.market_report_generation_traces"
HELPER="public.market_report_generation_traces_reject_change()"

# Expected catalog sections after an exact apply (PostgreSQL 17; owner normalized away). Regenerated only
# together with a reviewed migration change; `proof` checks a fresh local apply against them.
EXPECTED_SECTIONS="columns=3ece5ad6589b25021d6bfab1e2fbef2c7a0484d1583740870534c55e70f3721a
constraints=1f0f8f48afed911008a3c7c35f57cd3633699d47d697de06cdff2e1564042819
indexes=882813a822cbf5cd8a127c5a3b82d2cb677342ba87548748ead270f3e9299a74
relation=5258dc40603f57e309e55f780c068d9c7963c6c3772b0f41117ff2aae2d9be5b
triggers=f8cf418fa5793a2eef348ec2c862c67183f1173d7515538fd672d5af361d74c4
table_acl=92921dca0632a4efe1dfa86b276a48c0fb135337b3c9d318cb6ac06f24693e15
functions=3c7103d997117f93dc52c2562b9bd60310cec54f0b6ca62a3bc998c2e438119d
function_acl=140bedbf9c3f6d56a9846d2ba7088798683f4da0c248231336e6a05679e4fdfe"

say() { printf '%s\n' "$*"; }
stop() { say "STOP[$1] $2"; exit "$1"; }
refuse() { say "REFUSED $1" >&2; exit 2; }

# ------------------------------------------------------------------------------------------- guards
guard_target() {
  local target="${TRACE_ROLLOUT_TARGET:-local}"
  local hook
  for hook in TRACE_ROLLOUT_TEST_MIGRATION TRACE_ROLLOUT_TEST_STAGE_A TRACE_ROLLOUT_TEST_AFTER_STAGE_A_SQL; do
    if [[ -n "${!hook:-}" && "$target" != local ]]; then refuse "test hook $hook is only allowed for a local target"; fi
  done
  [[ -n "${PGDATABASE:-}" && -n "${PGUSER:-}" && -n "${PGHOST:-}" ]] || refuse "PGHOST, PGUSER and PGDATABASE are required"
  [[ -n "${TRACE_EXPECTED_OWNER:-}" ]] || refuse "TRACE_EXPECTED_OWNER (the role that applies and owns the objects) is required"
  case "$target" in
    local)
      [[ "$TRACE_EXPECTED_OWNER" == "$PGUSER" ]] || refuse "PGUSER must be the expected owner role"
      case "$PGHOST" in
        /tmp/*|/private/tmp/*) ;;
        *) refuse "a local target must be a /tmp Unix-socket directory (set TRACE_ROLLOUT_TARGET=production deliberately for production)" ;;
      esac
      ;;
    production)
      [[ "${TRACE_ROLLOUT_ACK:-}" == "$PROD_ACK" ]] || refuse "production needs TRACE_ROLLOUT_ACK set to the exact phrase in the runbook"
      local ref="${TRACE_ROLLOUT_PROJECT_REF:-}"
      [[ "$ref" =~ ^[a-z]{20}$ ]] || refuse "production needs TRACE_ROLLOUT_PROJECT_REF (20 lowercase letters)"
      [[ "$PGHOST" == *"$ref"* || "$PGUSER" == *"$ref"* ]] || refuse "PGHOST/PGUSER does not belong to TRACE_ROLLOUT_PROJECT_REF"
      [[ "$PGHOST" != /* ]] || refuse "production must be a TCP host, not a local socket"
      case "${PGSSLMODE:-}" in require|verify-ca|verify-full) ;; *) refuse "production needs PGSSLMODE=require or stronger" ;; esac
      [[ "$TRACE_EXPECTED_OWNER" == postgres ]] || refuse "production objects must be owned by postgres"
      [[ "$PGUSER" == postgres || "$PGUSER" == "postgres.$ref" ]] || refuse "production PGUSER must be postgres or postgres.<project ref>"
      [[ "${PGPORT:-5432}" != 6543 ]] || refuse "use a direct or session-mode connection, not the transaction pooler (6543)"
      ;;
    *) refuse "TRACE_ROLLOUT_TARGET must be local or production" ;;
  esac
}

psql_q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v owner="$TRACE_EXPECTED_OWNER" "$@"; }

# ------------------------------------------------------------------------------------------- catalog
# One row per section: name=sha256 of a normalized description. Read-only. The owner name is normalized out;
# non-owner grants are kept. Index validity and trigger enablement are part of the description.
descriptor_sql() {
  cat <<SQL
begin transaction read only;
set local search_path = pg_catalog, public;
with t as (select to_regclass('$TABLE') as oid),
fns as (select to_regprocedure('$HELPER') as oid),
sections(name, body) as (
  select 'columns', (select string_agg(format('%s %s nn=%s def=%s', a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
                                              coalesce(pg_get_expr(d.adbin, d.adrelid), '-')), E'\n' order by a.attnum)
                       from t, pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                      where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped)
  union all
  select 'constraints', (select string_agg(format('%s %s %s', c.conname, c.contype, pg_get_constraintdef(c.oid)), E'\n' order by c.conname collate "C")
                           from t, pg_constraint c where c.conrelid = t.oid)
  union all
  select 'indexes', (select string_agg(format('%s valid=%s ready=%s live=%s %s', i.relname, x.indisvalid, x.indisready, x.indislive,
                                              pg_get_indexdef(i.oid)), E'\n' order by i.relname collate "C")
                       from t, pg_index x join pg_class i on i.oid = x.indexrelid where x.indrelid = t.oid)
  union all
  select 'relation', (select format('kind=%s persistence=%s rls=%s force=%s policies=%s triggers=%s comment=%s',
                                    c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity,
                                    (select count(*) from pg_policy where polrelid = c.oid),
                                    (select count(*) from pg_trigger where tgrelid = c.oid and not tgisinternal),
                                    md5(coalesce(obj_description(c.oid, 'pg_class'), '')))
                        from t join pg_class c on c.oid = t.oid)
  union all
  select 'triggers', (select string_agg(format('%s enabled=%s %s', g.tgname, g.tgenabled, pg_get_triggerdef(g.oid)), E'\n' order by g.tgname collate "C")
                        from t, pg_trigger g where g.tgrelid = t.oid and not g.tgisinternal)
  union all
  select 'table_acl', (select coalesce((select string_agg(line, E'\n' order by line collate "C")
                                             from (select format('%s %s %s', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
                                                                 a.privilege_type, case when a.is_grantable then 't' else 'f' end) as line
                                                     from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                                                    where a.grantee <> c.relowner) acl), 'none')
                                || E'\ncolumn_acls=' || (select count(*) from pg_attribute where attrelid = c.oid and attnum > 0 and attacl is not null)
                         from t join pg_class c on c.oid = t.oid)
  union all
  select 'functions', (select string_agg(format('%s secdef=%s config=%s lang=%s volatility=%s strict=%s returns=%s def=%s',
                                                p.oid::regprocedure, p.prosecdef, p.proconfig, l.lanname, p.provolatile, p.proisstrict,
                                                pg_get_function_result(p.oid), md5(pg_get_functiondef(p.oid))), E'\n' order by p.oid::regprocedure::text collate "C")
                         from fns f join pg_proc p on p.oid = f.oid join pg_language l on l.oid = p.prolang)
  union all
  select 'function_acl', (select coalesce(string_agg(line, E'\n' order by line collate "C"), 'none')
                            from (select format('%s.%s() %s %s %s', n.nspname, p.proname,
                                                case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
                                                a.privilege_type, case when a.is_grantable then 't' else 'f' end) as line
                                    from fns f join pg_proc p on p.oid = f.oid join pg_namespace n on n.oid = p.pronamespace,
                                         lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                   where a.grantee <> p.proowner) acl)
)
select name || '=' || encode(sha256(convert_to(coalesce(body, '<absent>'), 'UTF8')), 'hex') from sections order by
  array_position(array['columns','constraints','indexes','relation','triggers','table_acl','functions','function_acl'], name);
commit;
SQL
}

# Environment-dependent checks the descriptor cannot express. Each failure is one reason code.
semantic_sql() {
  cat <<SQL
begin transaction read only;
set local search_path = pg_catalog, public;
with api(role_name) as (select r from unnest(array['anon','authenticated','service_role']) r where exists (select 1 from pg_roles where rolname = r)),
privs(p) as (select unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']
                           || case when current_setting('server_version_num')::int >= 170000 then array['MAINTAIN'] else array[]::text[] end))
select reason from (
  select 'TABLE_OWNER_MISMATCH' as reason
   where (select pg_get_userbyid(relowner) from pg_class where oid = to_regclass('$TABLE')) is distinct from :'owner'
  union all
  select 'HELPER_MISSING' where to_regprocedure('$HELPER') is null
  union all
  select 'HELPER_OWNER_MISMATCH' where to_regprocedure('$HELPER') is not null
     and pg_get_userbyid((select proowner from pg_proc where oid = to_regprocedure('$HELPER'))) <> :'owner'
  union all
  select 'UNEXPECTED_OVERLOAD:' || p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'market_report_generation_traces_reject_change' and p.oid <> coalesce(to_regprocedure('$HELPER'), 0)
  union all
  select 'API_ROLE_MEMBER_OF_OWNER:' || role_name from api where pg_has_role(role_name, :'owner', 'MEMBER')
  union all
  select 'EFFECTIVE_TABLE_PRIVILEGE:' || role_name || ':' || p from api, privs
   where to_regclass('$TABLE') is not null
     and has_table_privilege(role_name, '$TABLE', p) <> (role_name = 'service_role' and p in ('SELECT', 'INSERT'))
  union all
  select 'GRANT_OPTION:' || role_name || ':' || p from api, privs
   where to_regclass('$TABLE') is not null and has_table_privilege(role_name, '$TABLE', p || ' WITH GRANT OPTION')
  union all
  select 'EFFECTIVE_COLUMN_PRIVILEGE:' || role_name from api
   where to_regclass('$TABLE') is not null
     and ((role_name <> 'service_role' and (has_any_column_privilege(role_name, '$TABLE', 'SELECT')
                                            or has_any_column_privilege(role_name, '$TABLE', 'INSERT')))
          or has_any_column_privilege(role_name, '$TABLE', 'UPDATE')
          or has_any_column_privilege(role_name, '$TABLE', 'REFERENCES'))
  union all
  select 'EFFECTIVE_EXECUTE:' || role_name from api
   where to_regprocedure('$HELPER') is not null and has_function_privilege(role_name, to_regprocedure('$HELPER'), 'EXECUTE')
) checks;
commit;
SQL
}

presence_sql() {
  cat <<SQL
begin transaction read only;
select (to_regclass('$TABLE') is not null)::int
     + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'market_report_generation_traces_reject_change')::int;
commit;
SQL
}

history_sql() {
  cat <<SQL
begin transaction read only;
select case
  when to_regclass('supabase_migrations.schema_migrations') is null then 'LEDGER_MISSING'
  when not exists (select 1 from information_schema.columns where table_schema = 'supabase_migrations'
                     and table_name = 'schema_migrations' and column_name = 'name') then 'LEDGER_SHAPE'
  else (
    select case
      when stray > 0 then 'MISMATCH'
      when rows_for_version = 0 then 'NONE'
      when rows_for_version = 1 and exact = 1 then 'EXACT'
      else 'MISMATCH' end
    from (select
      (select count(*) from supabase_migrations.schema_migrations where version = '$VERSION') as rows_for_version,
      (select count(*) from supabase_migrations.schema_migrations where version = '$VERSION' and name = '$NAME') as exact,
      (select count(*) from supabase_migrations.schema_migrations where name = '$NAME' and version <> '$VERSION') as stray) h)
end;
commit;
SQL
}

# Schema state: ABSENT / EXACT / UNSAFE (partial, drifted or unexpected objects).
schema_state() {
  local present descriptor semantic
  present="$(presence_sql | psql_q -f -)" || { say "UNKNOWN"; return; }
  if [[ "$present" == 0 ]]; then say "ABSENT"; return; fi
  descriptor="$(descriptor_sql | psql_q -f -)" || { say "UNKNOWN"; return; }
  semantic="$(semantic_sql | psql_q -f -)" || { say "UNKNOWN"; return; }
  if [[ "$descriptor" == "$EXPECTED_SECTIONS" && -z "$semantic" ]]; then say "EXACT"; else say "UNSAFE"; fi
}

explain_mismatch() {
  local descriptor semantic
  descriptor="$(descriptor_sql | psql_q -f - 2>/dev/null || true)"
  semantic="$(semantic_sql | psql_q -f - 2>/dev/null || true)"
  local line
  while IFS= read -r line; do
    grep -qxF "$line" <<<"$descriptor" || say "  catalog section differs: ${line%%=*}"
  done <<<"$EXPECTED_SECTIONS"
  [[ -z "$semantic" ]] || printf '%s\n' "$semantic" | sed 's/^/  check failed: /'
}

history_state() { history_sql | psql_q -f - 2>/dev/null || say "UNKNOWN"; }

verify_migration_bytes() {
  local file="$MIGRATION"
  if [[ -n "${TRACE_ROLLOUT_TEST_MIGRATION:-}" ]]; then file="$TRACE_ROLLOUT_TEST_MIGRATION"; say "TEST HOOK: using a substitute migration file (local only)"; else
    [[ "$(shasum -a 256 "$MIGRATION" | cut -d' ' -f1)" == "$MIGRATION_SHA256" ]] || stop 10 "migration bytes differ from the accepted source (SHA-256 mismatch)"
  fi
  MIGRATION_FILE="$file"
}

# ------------------------------------------------------------------------------------------- stages
stage_a() {  # exact migration, its own BEGIN/COMMIT, nothing else in the session
  local rc
  case "${TRACE_ROLLOUT_TEST_STAGE_A:-}" in
    lost-before-apply) say "TEST HOOK: Stage A not sent, response reported lost"; rc=2 ;;
    lost-after-apply)
      set +e; psql -X -q -v ON_ERROR_STOP=1 -f "$MIGRATION_FILE" >/dev/null 2>&1; set -e
      say "TEST HOOK: Stage A sent, response reported lost"; rc=2 ;;
    "")
      set +e; psql -X -q -v ON_ERROR_STOP=1 -f "$MIGRATION_FILE" >/dev/null 2>"${TMPDIR:-/tmp}/trace_stage_a.$$"; rc=$?; set -e
      grep -oE 'MARKET_REPORT_TRACE_[A-Z_]+[^"]*' "${TMPDIR:-/tmp}/trace_stage_a.$$" | head -3 | sed 's/^/  migration said: /' || true
      rm -f "${TMPDIR:-/tmp}/trace_stage_a.$$" ;;
    *) refuse "unknown TRACE_ROLLOUT_TEST_STAGE_A" ;;
  esac
  if [[ -n "${TRACE_ROLLOUT_TEST_AFTER_STAGE_A_SQL:-}" ]]; then
    say "TEST HOOK: injecting catalog change after Stage A (local only)"
    psql_q -c "$TRACE_ROLLOUT_TEST_AFTER_STAGE_A_SQL" >/dev/null
  fi
  STAGE_A_RC=$rc
}

stage_b() {  # mandatory read-back from a fresh session; history is never written unless this passes
  local state
  state="$(schema_state)"
  if [[ "$state" != EXACT ]]; then
    say "Stage B: catalog read-back = $state"
    explain_mismatch
    stop 13 "catalog is not the exact reviewed state; history NOT written; operator review required"
  fi
  say "Stage B: catalog read-back = EXACT"
}

stage_c() {  # history only, own explicit transaction, no upsert, no retry
  set +e
  psql -X -q -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQL
begin;
insert into supabase_migrations.schema_migrations (version, name) values ('$VERSION', '$NAME');
commit;
SQL
  local rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    say "Stage C: history insert failed (psql exit $rc); read-back: schema=$(schema_state) history=$(history_state)"
    stop 14 "schema present / history missing; no automatic retry, no repair; operator review required"
  fi
  say "Stage C: history recorded ($VERSION $NAME)"
}

postflight() {
  local schema history
  schema="$(schema_state)"; history="$(history_state)"
  say "postflight: schema=$schema history=$history"
  [[ "$schema" == EXACT && "$history" == EXACT ]] || stop 15 "postflight read-back is not exact; operator review required"
}

check_identity() {
  local identity
  identity="$(psql_q -c "select current_user || '|' || (current_setting('server_version_num')::int / 10000)")" \
    || stop 10 "cannot connect or read the session identity; nothing applied"
  [[ "${identity%%|*}" == "$TRACE_EXPECTED_OWNER" ]] || stop 10 "session role is not the expected owner; nothing applied"
  [[ "${identity##*|}" == 17 ]] || stop 10 "the pinned catalog expectation is for PostgreSQL 17; nothing applied"
}

cmd_status() {
  guard_target
  check_identity
  say "STATE schema=$(schema_state) history=$(history_state)"
}

cmd_apply() {
  local resume="${1:-}"
  guard_target
  verify_migration_bytes
  check_identity
  local schema history
  schema="$(schema_state)"; history="$(history_state)"
  say "preflight: schema=$schema history=$history"
  case "$schema/$history" in
    EXACT/EXACT) say "already complete: exact schema and exact history; nothing written (read-only no-op)"; exit 0 ;;
    EXACT/NONE)
      [[ "$resume" == --resume-history ]] || stop 14 "schema present / history missing; rerun with --resume-history only after operator review"
      stage_b; stage_c; postflight; say "DONE (history-only resume)."; exit 0 ;;
    ABSENT/NONE)
      [[ "$resume" != --resume-history ]] || stop 10 "--resume-history is only valid for schema present / history missing" ;;
    *) explain_mismatch; stop 10 "unexpected starting state (schema=$schema history=$history); nothing applied" ;;
  esac

  stage_a
  if [[ "$STAGE_A_RC" -ne 0 ]]; then
    schema="$(schema_state)"; history="$(history_state)"
    say "Stage A: psql exit $STAGE_A_RC; read-back: schema=$schema history=$history"
    if [[ "$STAGE_A_RC" -eq 3 && "$schema" == ABSENT && "$history" == NONE ]]; then
      stop 11 "migration failed before COMMIT and rolled back; schema absent, history absent; fix the cause before any new attempt"
    fi
    case "$schema" in
      ABSENT) stop 12 "Stage A outcome unknown but schema is absent and history absent; a new attempt needs operator review" ;;
      EXACT) explain_mismatch; stop 12 "Stage A outcome unknown but the exact schema is present; history not written; resume with --resume-history only after review" ;;
      *) explain_mismatch; stop 12 "Stage A outcome unknown and the schema is partial or unsafe; no history; operator review required" ;;
    esac
  fi
  say "Stage A: migration committed"
  stage_b
  stage_c
  postflight
  say "DONE. Next: deploy exact market-report-analysis per runbook (separate approved step)."
}

# ------------------------------------------------------------------------------------------- proof
cmd_proof() {
  local host="${TRACE_PGHOST:?TRACE_PGHOST (local socket dir) required}"
  local port="${TRACE_PGPORT:?TRACE_PGPORT required}"
  local super="${TRACE_PGSUPER:?TRACE_PGSUPER required}"
  case "$host" in /tmp/*|/private/tmp/*) ;; *) refuse "proof runs only on a local /tmp socket cluster" ;; esac
  local owner="kb_trace_rollout_owner"
  local db=""
  PROOF_DBS=""
  PROOF_SUPER=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
  local -a as_super=("${PROOF_SUPER[@]}")
  trap 'for d in $PROOF_DBS; do "${PROOF_SUPER[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true; done; "${PROOF_SUPER[@]}" -d postgres -c "revoke '"$owner"' from service_role" >/dev/null 2>&1 || true' EXIT
  "${as_super[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb createrole; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_trace_unrelated') then create role kb_trace_unrelated nologin; end if;
  if pg_has_role('service_role', '$owner', 'MEMBER') then execute 'revoke $owner from service_role'; end if;
end \$\$;
SQL
  local pass=0
  ok() { say "PASS $1"; pass=$((pass + 1)); }
  bad() { say "FAIL $1"; exit 1; }
  # A disposable database shaped like production on 2026-10-07 (read-only preflight): the owner is not a superuser;
  # default privileges of the owner in public give anon/authenticated/service_role TRUNCATE, REFERENCES, TRIGGER and
  # MAINTAIN on new tables and give EXECUTE on new functions to the owner only; an event trigger enables RLS on every
  # new public table (Supabase's ensure_rls / rls_auto_enable); the migration ledger has the production shape.
  fresh() {
    db="kabumori_trace_rollout_$1_$$"; PROOF_DBS="$PROOF_DBS $db"
    "${as_super[@]}" -d postgres -c "create database $db owner $owner" >/dev/null
    "${as_super[@]}" -d "$db" >/dev/null <<SQL
grant usage on schema public to anon, authenticated, service_role;
grant create on schema public to $owner;
alter default privileges for role $owner in schema public grant truncate, references, trigger, maintain on tables to anon, authenticated, service_role;
alter default privileges for role $owner in schema public revoke execute on functions from public;
create function public.rls_auto_enable() returns event_trigger language plpgsql security definer set search_path to 'pg_catalog' as \$f\$
declare cmd record;
begin
  for cmd in select * from pg_event_trigger_ddl_commands()
             where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') and object_type in ('table', 'partitioned table') loop
    if cmd.schema_name = 'public' then
      begin
        execute format('alter table if exists %s enable row level security', cmd.object_identity);
      exception when others then null;
      end;
    end if;
  end loop;
end \$f\$;
create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') execute function public.rls_auto_enable();
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (
  version text not null primary key, statements text[], name text, created_by text, idempotency_key text unique, rollback text[]);
grant usage on schema supabase_migrations to $owner;
grant select, insert on supabase_migrations.schema_migrations to $owner;
SQL
  }
  run() {
    set +e
    OUT="$(env TRACE_ROLLOUT_TARGET=local PGHOST="$host" PGPORT="$port" PGUSER="$owner" PGDATABASE="$db" TRACE_EXPECTED_OWNER="$owner" \
           ${PROOF_ENV[@]+"${PROOF_ENV[@]}"} bash "$0" "$@" 2>&1)"
    RC=$?
    set -e
    PROOF_ENV=()
  }
  q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -c "$1"; }
  hist() { q "select coalesce(string_agg(version || ':' || coalesce(name, '-'), ',' order by version), 'none') from supabase_migrations.schema_migrations"; }
  table_present() { q "select (to_regclass('$TABLE') is not null)::text"; }
  expect() { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 :: got [$2] want [$3]  -- $OUT"; }
  PROOF_ENV=()

  # 0. the pinned migration bytes
  [[ "$(shasum -a 256 "$MIGRATION" | cut -d' ' -f1)" == "$MIGRATION_SHA256" ]] && ok "accepted migration bytes match the pinned SHA-256" || bad "migration SHA-256"

  # 1. clean success on the production-shaped database
  fresh clean
  run status; expect "clean: initial state" "$OUT" "STATE schema=ABSENT history=NONE"
  run apply
  expect "clean: apply exits 0" "$RC" "0"
  grep -q "Stage B: catalog read-back = EXACT" <<<"$OUT" && ok "clean: Stage B passed before history" || bad "clean Stage B :: $OUT"
  expect "clean: exactly one history row" "$(hist)" "$VERSION:$NAME"
  run status; expect "clean: postflight state" "$OUT" "STATE schema=EXACT history=EXACT"
  local live; live="$(descriptor_sql | psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f -)"
  expect "clean: live catalog sections equal the pinned expectation" "$live" "$EXPECTED_SECTIONS"
  expect "clean: RLS on (by the migration; the event trigger does the same)" "$(q "select relrowsecurity::text from pg_class where oid = to_regclass('$TABLE')")" "true"
  expect "clean: exact direct table ACL" "$(q "select string_agg(format('%s %s %s', pg_get_userbyid(a.grantee), a.privilege_type, a.is_grantable), ',' order by 1) from pg_class c, aclexplode(c.relacl) a where c.oid = to_regclass('$TABLE') and a.grantee <> c.relowner")" "service_role INSERT f,service_role SELECT f"
  expect "clean: default TRUNCATE/REFERENCES/TRIGGER/MAINTAIN grants did not survive" "$(q "select count(*) from pg_class c, aclexplode(c.relacl) a where c.oid = to_regclass('$TABLE') and a.grantee <> c.relowner and a.privilege_type in ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')")" "0"

  # 1b. every section is independent of the session search_path
  local sp sections_sp
  for sp in '"$user", public, extensions' 'pg_catalog' 'public' "''"; do
    sections_sp="$(PGOPTIONS="-c search_path=$(printf '%s' "$sp" | tr -d ' ')" descriptor_sql | \
      PGOPTIONS="-c search_path=$(printf '%s' "$sp" | tr -d ' ')" psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f -)"
    expect "catalog sections identical under search_path [$sp]" "$sections_sp" "$EXPECTED_SECTIONS"
  done

  # 1c. adverse changes after completion are always detected
  local change
  for change in \
    "grant select on $TABLE to anon" \
    "grant update on $TABLE to service_role" \
    "grant select on $TABLE to kb_trace_unrelated" \
    "grant select on $TABLE to service_role with grant option" \
    "alter table $TABLE disable trigger market_report_generation_traces_no_update" \
    "grant execute on function $HELPER to authenticated" \
    "alter table $TABLE disable row level security" \
    "create policy anyone on $TABLE for select to public using (true)"; do
    fresh "adv_$RANDOM"
    run apply >/dev/null
    q "$change" >/dev/null
    run status
    expect "change detected: ${change:0:70}" "$OUT" "STATE schema=UNSAFE history=EXACT"
    run apply; expect "change blocks apply: ${change:0:50}" "$RC" "10"
  done
  db="$(printf '%s' "$PROOF_DBS" | awk '{print $1}')"

  # 6. completed state: rerun is a read-only no-op
  local before; before="$(q "select count(*) from supabase_migrations.schema_migrations")"
  run apply
  expect "completed: rerun exits 0" "$RC" "0"
  grep -q "read-only no-op" <<<"$OUT" && ok "completed: reported as no-op" || bad "no-op :: $OUT"
  expect "completed: nothing duplicated" "$(q "select count(*) from supabase_migrations.schema_migrations")" "$before"

  # 2. the migration's own access verification refuses (an API role inherits the owner) -> rolled back
  fresh fail_before_commit
  "${as_super[@]}" -d postgres -c "grant $owner to service_role" >/dev/null
  run apply
  "${as_super[@]}" -d postgres -c "revoke $owner from service_role" >/dev/null
  expect "fail-before-commit (access verification): STOP 11" "$RC" "11"
  grep -q "MARKET_REPORT_TRACE_ACL_UNSAFE_MEMBERSHIP" <<<"$OUT" && ok "fail-before-commit: the migration's reason is shown" || bad "reason :: $OUT"
  expect "fail-before-commit: no table" "$(table_present)" "false"
  expect "fail-before-commit: no history" "$(hist)" "none"
  # an unknown role with a default SELECT on new tables -> refused, rolled back
  fresh fail_default_reader
  "${as_super[@]}" -d "$db" -c "alter default privileges for role $owner in schema public grant select on tables to kb_trace_unrelated" >/dev/null
  run apply
  expect "unknown default reader: STOP 11" "$RC" "11"
  expect "unknown default reader: no table" "$(table_present)" "false"
  # late failure: every statement ran, then an error just before COMMIT -> all rolled back
  fresh fail_late
  local late="${TMPDIR:-/tmp}/trace_late_failure.$$.sql"
  awk '/^commit;$/ && !done { print "select 1/0; -- injected late failure"; done = 1 } { print }' "$MIGRATION" > "$late"
  PROOF_ENV=(TRACE_ROLLOUT_TEST_MIGRATION="$late"); run apply; rm -f "$late"
  expect "fail-before-commit (late): STOP 11" "$RC" "11"
  expect "fail-before-commit (late): no table" "$(table_present)" "false"
  expect "fail-before-commit (late): no helper" "$(q "select count(*) from pg_proc where proname like 'market_report_generation_traces%'")" "0"
  expect "fail-before-commit (late): no history" "$(hist)" "none"

  # 3. Stage A response lost: read back first, never rerun
  fresh lost_before
  PROOF_ENV=(TRACE_ROLLOUT_TEST_STAGE_A=lost-before-apply); run apply
  expect "lost (nothing applied): STOP 12" "$RC" "12"
  grep -q "read-back: schema=ABSENT history=NONE" <<<"$OUT" && ok "lost (nothing applied): classified ABSENT" || bad "lost-before :: $OUT"
  fresh lost_after
  PROOF_ENV=(TRACE_ROLLOUT_TEST_STAGE_A=lost-after-apply); run apply
  expect "lost (committed): STOP 12" "$RC" "12"
  grep -q "read-back: schema=EXACT history=NONE" <<<"$OUT" && ok "lost (committed): classified EXACT, history not written" || bad "lost-after :: $OUT"
  run apply; expect "lost (committed): plain rerun refuses (schema present / history missing)" "$RC" "14"
  run apply --resume-history; expect "lost (committed): explicit history-only resume completes" "$RC" "0"
  expect "lost (committed): exactly one history row" "$(hist)" "$VERSION:$NAME"
  fresh lost_partial
  PROOF_ENV=(TRACE_ROLLOUT_TEST_STAGE_A=lost-before-apply TRACE_ROLLOUT_TEST_AFTER_STAGE_A_SQL="create table $TABLE (id uuid primary key)")
  run apply
  expect "lost (partial): STOP 12" "$RC" "12"
  grep -q "read-back: schema=UNSAFE" <<<"$OUT" && ok "lost (partial): classified UNSAFE" || bad "lost-partial :: $OUT"
  expect "lost (partial): no history" "$(hist)" "none"

  # 4. Stage B mismatch: drift injected between Stage A and Stage B -> no history
  local drift
  for drift in \
    "grant select on $TABLE to anon" \
    "create policy stale_allow_all on $TABLE for all to public using (true) with check (true)" \
    "drop index public.market_report_generation_traces_day_idx; create index market_report_generation_traces_day_idx on $TABLE (trading_date)" \
    "drop trigger market_report_generation_traces_no_delete on $TABLE" \
    "alter table $TABLE drop constraint market_report_generation_traces_truncation_consistent" \
    "comment on table $TABLE is 'changed'"; do
    fresh "stage_b_$RANDOM"
    PROOF_ENV=(TRACE_ROLLOUT_TEST_AFTER_STAGE_A_SQL="$drift"); run apply
    expect "Stage B mismatch STOP 13: ${drift:0:60}" "$RC" "13"
    expect "Stage B mismatch wrote no history: ${drift:0:40}" "$(hist)" "none"
  done

  # 5. Stage C history insert fails: schema stays exact, no retry, STOP; later explicit resume works
  fresh history_fail
  "${as_super[@]}" -d "$db" -c "revoke insert on supabase_migrations.schema_migrations from $owner" >/dev/null
  run apply
  expect "history failure: STOP 14" "$RC" "14"
  expect "history failure: table kept (no automatic drop)" "$(table_present)" "true"
  expect "history failure: no history" "$(hist)" "none"
  run apply; expect "history failure: plain rerun still STOP 14" "$RC" "14"
  "${as_super[@]}" -d "$db" -c "grant insert on supabase_migrations.schema_migrations to $owner" >/dev/null
  run apply --resume-history; expect "history failure: explicit resume after review completes" "$RC" "0"
  expect "history failure: exactly one history row after resume" "$(hist)" "$VERSION:$NAME"

  # 7. mismatches always STOP
  fresh wrong_name
  q "insert into supabase_migrations.schema_migrations (version, name) values ('$VERSION', 'something_else')" >/dev/null
  run apply; expect "wrong history name: STOP 10" "$RC" "10"; expect "wrong history name: no schema" "$(table_present)" "false"
  fresh wrong_version
  q "insert into supabase_migrations.schema_migrations (version, name) values ('20261007120001', '$NAME')" >/dev/null
  run apply; expect "wrong history version: STOP 10" "$RC" "10"; expect "wrong history version: no schema" "$(table_present)" "false"
  fresh history_without_schema
  q "insert into supabase_migrations.schema_migrations (version, name) values ('$VERSION', '$NAME')" >/dev/null
  run apply; expect "history without schema: STOP 10" "$RC" "10"; expect "history without schema: no schema created" "$(table_present)" "false"
  fresh resume_misuse
  run apply --resume-history; expect "--resume-history on an empty database: STOP 10" "$RC" "10"
  fresh bad_bytes
  local altered="${TMPDIR:-/tmp}/trace_altered.$$"
  mkdir -p "$altered/tests" "$altered/migrations"; cp "$0" "$altered/tests/"; sed 's/^-- Market report generation traces/--  Market report generation traces/' "$MIGRATION" > "$altered/migrations/${VERSION}_${NAME}.sql"
  set +e; OUT="$(env TRACE_ROLLOUT_TARGET=local PGHOST="$host" PGPORT="$port" PGUSER="$owner" PGDATABASE="$db" TRACE_EXPECTED_OWNER="$owner" bash "$altered/tests/$(basename "$0")" apply 2>&1)"; RC=$?; set -e
  rm -rf "$altered"
  expect "migration bytes differ from accepted SHA: STOP 10" "$RC" "10"; expect "altered bytes: nothing applied" "$(table_present)" "false"

  # guards: production is refused before any connection unless every switch is present
  local -a prod=(TRACE_ROLLOUT_TARGET=production PGHOST=db.abcdefghijklmnopqrst.supabase.invalid PGUSER=postgres PGDATABASE=postgres
                 TRACE_EXPECTED_OWNER=postgres PGSSLMODE=require TRACE_ROLLOUT_PROJECT_REF=abcdefghijklmnopqrst PGCONNECT_TIMEOUT=1)
  guard() {
    local label="$1"; shift
    set +e; OUT="$(env -u PGPASSWORD "${prod[@]}" "$@" bash "$0" apply 2>&1)"; RC=$?; set -e
    [[ "$RC" == 2 && "$OUT" == *REFUSED* && "$OUT" != *"could not"* ]] && ok "guard refuses production: $label" || bad "guard $label :: rc=$RC $OUT"
  }
  guard "no acknowledgement"
  guard "wrong acknowledgement" TRACE_ROLLOUT_ACK="yes"
  guard "project ref missing" TRACE_ROLLOUT_ACK="$PROD_ACK" TRACE_ROLLOUT_PROJECT_REF=
  guard "host not in project" TRACE_ROLLOUT_ACK="$PROD_ACK" TRACE_ROLLOUT_PROJECT_REF=zyxwvutsrqponmlkjihg
  guard "socket host" TRACE_ROLLOUT_ACK="$PROD_ACK" PGHOST=/tmp/abcdefghijklmnopqrst
  guard "no TLS" TRACE_ROLLOUT_ACK="$PROD_ACK" PGSSLMODE=prefer
  guard "owner not postgres" TRACE_ROLLOUT_ACK="$PROD_ACK" PGUSER=other TRACE_EXPECTED_OWNER=other
  guard "test hook set" TRACE_ROLLOUT_ACK="$PROD_ACK" TRACE_ROLLOUT_TEST_STAGE_A=lost-before-apply
  guard "substitute migration set" TRACE_ROLLOUT_ACK="$PROD_ACK" TRACE_ROLLOUT_TEST_MIGRATION=/tmp/x.sql
  guard "transaction pooler port" TRACE_ROLLOUT_ACK="$PROD_ACK" PGPORT=6543
  guard "pooler user of another project" TRACE_ROLLOUT_ACK="$PROD_ACK" PGUSER=postgres.zyxwvutsrqponmlkjihg
  set +e; OUT="$(env -u PGPASSWORD "${prod[@]}" TRACE_ROLLOUT_ACK="$PROD_ACK" PGUSER=postgres.abcdefghijklmnopqrst bash "$0" apply 2>&1)"; RC=$?; set -e
  [[ "$RC" == 10 && "$OUT" == *"cannot connect or read the session identity"* && "$OUT" != *REFUSED* ]] \
    && ok "guard: a fully switched production target passes the guards and stops at the identity check" || bad "identity :: rc=$RC $OUT"
  set +e; OUT="$(env TRACE_ROLLOUT_TARGET=local PGHOST=db.example.invalid PGUSER=x PGDATABASE=x TRACE_EXPECTED_OWNER=x bash "$0" status 2>&1)"; RC=$?; set -e
  [[ "$RC" == 2 && "$OUT" == *REFUSED* ]] && ok "guard: a non-socket host is refused for the default local target" || bad "local guard :: $OUT"

  say "ALL MARKET REPORT GENERATION TRACES ROLLOUT CHECKS PASSED ($pass)"
}

case "${1:-}" in
  status) cmd_status ;;
  apply) shift; cmd_apply "${1:-}" ;;
  proof) cmd_proof ;;
  print-sections)  # local only: prints the catalog sections of the target (used to pin EXPECTED_SECTIONS)
    guard_target; [[ "${TRACE_ROLLOUT_TARGET:-local}" == local ]] || refuse "print-sections is local only"
    descriptor_sql | psql_q -f - ;;
  *) say "usage: $0 status | apply [--resume-history] | proof"; exit 2 ;;
esac
