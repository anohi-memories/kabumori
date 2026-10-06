#!/usr/bin/env bash
# Operator runner for applying 20261004090000_ai_lab_topic_claims.sql:
#   schema first -> mandatory catalog read-back -> migration history second.
#
# The migration carries its own BEGIN/COMMIT, so schema and history cannot share one transaction.
# This runner never lets history get ahead of a verified schema, never retries, never repairs and
# never drops anything. Any surprise is a STOP with a fixed exit code for an operator to review.
#
#   status                   read-only classification of the target database
#   apply                    Stage A (exact migration) -> Stage B (catalog read-back) -> Stage C (history)
#   apply --resume-history   only for "schema present / history missing": Stage B -> Stage C
#   proof                    disposable local PostgreSQL proof of every success/failure path
#
# Connection: libpq environment only (PGHOST, PGPORT, PGUSER, PGDATABASE, PGSSLMODE; password via
# ~/.pgpass or PGPASSWORD). No URL, password, token or project ref is accepted as an argument, stored
# in this file, or printed. Default target is LOCAL and only a /tmp Unix-socket host is accepted.
# Production needs every switch documented in ai_lab_topic_claims_rollout.md and is NOT run here.
#
# Exit codes: 0 done / already complete / status printed, 2 refused by a guard, 10 STOP precondition,
# 11 STOP Stage A failed (schema confirmed absent), 12 STOP Stage A outcome unknown or inconsistent,
# 13 STOP Stage B catalog mismatch, 14 STOP schema present / history missing, 15 STOP postflight mismatch.
set -euo pipefail

VERSION="20261004090000"
NAME="ai_lab_topic_claims"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATION="$HERE/../migrations/${VERSION}_${NAME}.sql"
# Accepted source (PR #82, merge 80e11c9207d44599db26a25195f1ee0091484231). Stage A refuses any other bytes.
MIGRATION_SHA256="30d8504173160f1dc9c3d7d1cf323d9890129d1ff117c2448aa1b2516629c09c"
PROD_ACK="apply ${VERSION}_${NAME} to production after a same-day read-only preflight"

# Expected catalog sections after an exact apply (PostgreSQL 17; owner and environment normalized away).
# Regenerated only together with a reviewed migration change; `proof` checks a fresh local apply against them.
EXPECTED_SECTIONS="columns=c0801e1f7c3554582f56e10568b9eede57e7a06703de3d803936bc1efce5064f
constraints=994ff3444fff09d2060a6f3cf66e10d433c490a50e97ce00083b73fc7145b9e7
indexes=6c09f2bba2c432b20d1aa3d53bc81532b1e93c554d2e35abaaa286588f584df1
relation=db2e11fbf44214b7547ff801c90d3539fb60f5923788a6566db6627737ac4c81
table_acl=598c7a8f0e050d91f061f05609131f92897feb2cb64dc20e62183770ba43a54b
functions=1f3acc739781ed1eb142efd14279bed79dc2d01e5846a8710e7e347e30ce58fa
function_acl=5635c459265e8c99d22384083db40e89a1ba87c1ee7f3db2378073c1ae8c9532"

FUNCTIONS_SQL_LIST="'claim_ai_lab_topic','start_ai_lab_topic_provider','release_ai_lab_topic_claim','mark_ai_lab_topic_claim_ambiguous','settle_ai_lab_topic_claim_published'"
SIGNATURES_SQL_LIST="'public.claim_ai_lab_topic(uuid,jsonb,integer)','public.start_ai_lab_topic_provider(uuid,uuid,text)','public.release_ai_lab_topic_claim(uuid,uuid,text,text)','public.mark_ai_lab_topic_claim_ambiguous(uuid,uuid,text,text)','public.settle_ai_lab_topic_claim_published(uuid,uuid,text,text,text)'"

say() { printf '%s\n' "$*"; }
stop() { say "STOP[$1] $2"; exit "$1"; }
refuse() { say "REFUSED $1" >&2; exit 2; }

# ------------------------------------------------------------------------------------------- guards
guard_target() {
  local target="${AILAB_ROLLOUT_TARGET:-local}"
  local hook
  for hook in AILAB_ROLLOUT_TEST_MIGRATION AILAB_ROLLOUT_TEST_STAGE_A AILAB_ROLLOUT_TEST_AFTER_STAGE_A_SQL; do
    if [[ -n "${!hook:-}" && "$target" != local ]]; then refuse "test hook $hook is only allowed for a local target"; fi
  done
  [[ -n "${PGDATABASE:-}" && -n "${PGUSER:-}" && -n "${PGHOST:-}" ]] || refuse "PGHOST, PGUSER and PGDATABASE are required"
  [[ -n "${AILAB_EXPECTED_OWNER:-}" ]] || refuse "AILAB_EXPECTED_OWNER (the role that applies and owns the objects) is required"
  case "$target" in
    local)
      [[ "$AILAB_EXPECTED_OWNER" == "$PGUSER" ]] || refuse "PGUSER must be the expected owner role"
      case "$PGHOST" in
        /tmp/*|/private/tmp/*) ;;
        *) refuse "a local target must be a /tmp Unix-socket directory (set AILAB_ROLLOUT_TARGET=production deliberately for production)" ;;
      esac
      ;;
    production)
      [[ "${AILAB_ROLLOUT_ACK:-}" == "$PROD_ACK" ]] || refuse "production needs AILAB_ROLLOUT_ACK set to the exact phrase in the runbook"
      local ref="${AILAB_ROLLOUT_PROJECT_REF:-}"
      [[ "$ref" =~ ^[a-z]{20}$ ]] || refuse "production needs AILAB_ROLLOUT_PROJECT_REF (20 lowercase letters)"
      [[ "$PGHOST" == *"$ref"* || "$PGUSER" == *"$ref"* ]] || refuse "PGHOST/PGUSER does not belong to AILAB_ROLLOUT_PROJECT_REF"
      [[ "$PGHOST" != /* ]] || refuse "production must be a TCP host, not a local socket"
      case "${PGSSLMODE:-}" in require|verify-ca|verify-full) ;; *) refuse "production needs PGSSLMODE=require or stronger" ;; esac
      [[ "$AILAB_EXPECTED_OWNER" == postgres ]] || refuse "production objects must be owned by postgres"
      # direct host user "postgres", or the session pooler's "postgres.<project ref>"; current_user is checked after connecting
      [[ "$PGUSER" == postgres || "$PGUSER" == "postgres.$ref" ]] || refuse "production PGUSER must be postgres or postgres.<project ref>"
      [[ "${PGPORT:-5432}" != 6543 ]] || refuse "use a direct or session-mode connection, not the transaction pooler (6543)"
      ;;
    *) refuse "AILAB_ROLLOUT_TARGET must be local or production" ;;
  esac
}

psql_q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v owner="$AILAB_EXPECTED_OWNER" "$@"; }

# ------------------------------------------------------------------------------------------- catalog
# One row per section: name|sha256 of a normalized description. Read-only. Owner name, schema-qualified
# temp names and PostgreSQL-version-specific owner privilege letters are normalized out; non-owner grants
# are kept. Index validity (valid/ready/live) is part of the description.
descriptor_sql() {
  cat <<SQL
begin transaction read only;
-- Session-independent output: regprocedure/format_type render names relative to search_path, so pin it here
-- (the operator's or server's search_path, e.g. the Supabase default with public and extensions, must not change any section).
set local search_path = pg_catalog, public;
with t as (select to_regclass('public.ai_lab_topic_claims') as oid),
fns as (
  select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ($FUNCTIONS_SQL_LIST)
),
sections(name, body) as (
  select 'columns', (select string_agg(format('%s %s nn=%s def=%s', a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
                                              coalesce(pg_get_expr(d.adbin, d.adrelid), '-')), E'\n' order by a.attnum)
                       from t, pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                      where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped)
  union all
  select 'constraints', (select string_agg(format('%s %s %s', c.conname, c.contype, pg_get_constraintdef(c.oid)), E'\n' order by c.conname)
                           from t, pg_constraint c where c.conrelid = t.oid)
  union all
  select 'indexes', (select string_agg(format('%s valid=%s ready=%s live=%s %s', i.relname, x.indisvalid, x.indisready, x.indislive,
                                              pg_get_indexdef(i.oid)), E'\n' order by i.relname)
                       from t, pg_index x join pg_class i on i.oid = x.indexrelid where x.indrelid = t.oid)
  union all
  select 'relation', (select format('kind=%s persistence=%s rls=%s force=%s policies=%s triggers=%s comment=%s',
                                    c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity,
                                    (select count(*) from pg_policy where polrelid = c.oid),
                                    (select count(*) from pg_trigger where tgrelid = c.oid and not tgisinternal),
                                    md5(coalesce(obj_description(c.oid, 'pg_class'), '')))
                        from t join pg_class c on c.oid = t.oid)
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
                            from (select format('%s.%s(%s) %s %s %s', n.nspname, p.proname,
                                                (select coalesce(string_agg(format_type(u.t, null), ',' order by u.ord), '')
                                                   from unnest(p.proargtypes::oid[]) with ordinality as u(t, ord)),
                                                case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
                                                a.privilege_type, case when a.is_grantable then 't' else 'f' end) as line
                                    from fns f join pg_proc p on p.oid = f.oid join pg_namespace n on n.oid = p.pronamespace,
                                         lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                   where a.grantee <> p.proowner) acl)
)
select name || '=' || encode(sha256(convert_to(coalesce(body, '<absent>'), 'UTF8')), 'hex') from sections order by
  array_position(array['columns','constraints','indexes','relation','table_acl','functions','function_acl'], name);
commit;
SQL
}

# Environment-dependent checks that the descriptor cannot express. Each failure is one reason code.
semantic_sql() {
  cat <<SQL
begin transaction read only;
set local search_path = pg_catalog, public;
with api(role_name) as (select r from unnest(array['anon','authenticated','service_role']) r where exists (select 1 from pg_roles where rolname = r)),
privs(p) as (select unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']
                           || case when current_setting('server_version_num')::int >= 170000 then array['MAINTAIN'] else array[]::text[] end)),
sigs(sig) as (select unnest(array[$SIGNATURES_SQL_LIST]))
select reason from (
  select 'TABLE_OWNER_MISMATCH' as reason
   where (select pg_get_userbyid(relowner) from pg_class where oid = to_regclass('public.ai_lab_topic_claims')) is distinct from :'owner'
  union all
  select 'FUNCTION_MISSING:' || sig from sigs where to_regprocedure(sig) is null
  union all
  select 'FUNCTION_OWNER_MISMATCH:' || sig from sigs
   where to_regprocedure(sig) is not null and pg_get_userbyid((select proowner from pg_proc where oid = to_regprocedure(sig))) <> :'owner'
  union all
  select 'UNEXPECTED_OVERLOAD:' || p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ($FUNCTIONS_SQL_LIST)
     and p.oid::regprocedure::text not in (select replace(sig, 'public.', '') from sigs)
     and p.oid::regprocedure::text not in (select sig from sigs)
  union all
  select 'API_ROLE_MEMBER_OF_OWNER:' || role_name from api where pg_has_role(role_name, :'owner', 'MEMBER')
  union all
  select 'EFFECTIVE_TABLE_PRIVILEGE:' || role_name || ':' || p from api, privs
   where to_regclass('public.ai_lab_topic_claims') is not null and has_table_privilege(role_name, 'public.ai_lab_topic_claims', p)
  union all
  select 'EFFECTIVE_COLUMN_PRIVILEGE:' || role_name from api
   where to_regclass('public.ai_lab_topic_claims') is not null
     and (has_any_column_privilege(role_name, 'public.ai_lab_topic_claims', 'SELECT')
          or has_any_column_privilege(role_name, 'public.ai_lab_topic_claims', 'INSERT')
          or has_any_column_privilege(role_name, 'public.ai_lab_topic_claims', 'UPDATE')
          or has_any_column_privilege(role_name, 'public.ai_lab_topic_claims', 'REFERENCES'))
  union all
  select 'EFFECTIVE_EXECUTE:' || role_name || ':' || sig from api, sigs
   where to_regprocedure(sig) is not null
     and has_function_privilege(role_name, to_regprocedure(sig), 'EXECUTE') <> (role_name = 'service_role')
  union all
  select 'SUPERSEDED_TABLE_PRESENT' where to_regclass('public.ai_lab_topic_event_usage') is not null
) checks;
commit;
SQL
}

presence_sql() {
  cat <<SQL
begin transaction read only;
select (to_regclass('public.ai_lab_topic_claims') is not null)::int
     + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ($FUNCTIONS_SQL_LIST))::int
     + (to_regclass('public.ai_lab_topic_event_usage') is not null)::int;
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
      (select count(*) from supabase_migrations.schema_migrations
        where (name in ('$NAME', 'ai_lab_topic_event_usage') and version <> '$VERSION')) as stray) h)
end;
commit;
SQL
}

# Schema state: ABSENT / EXACT / UNSAFE (partial, drifted, superseded or unexpected objects).
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
  if [[ -n "${AILAB_ROLLOUT_TEST_MIGRATION:-}" ]]; then file="$AILAB_ROLLOUT_TEST_MIGRATION"; say "TEST HOOK: using a substitute migration file (local only)"; else
    [[ "$(shasum -a 256 "$MIGRATION" | cut -d' ' -f1)" == "$MIGRATION_SHA256" ]] || stop 10 "migration bytes differ from the accepted source (SHA-256 mismatch)"
  fi
  MIGRATION_FILE="$file"
}

# ------------------------------------------------------------------------------------------- stages
stage_a() {  # exact migration, its own BEGIN/COMMIT, nothing else in the session
  local rc
  case "${AILAB_ROLLOUT_TEST_STAGE_A:-}" in
    lost-before-apply) say "TEST HOOK: Stage A not sent, response reported lost"; rc=2 ;;
    lost-after-apply)
      set +e; psql -X -q -v ON_ERROR_STOP=1 -f "$MIGRATION_FILE" >/dev/null 2>&1; set -e
      say "TEST HOOK: Stage A sent, response reported lost"; rc=2 ;;
    "")
      set +e; psql -X -q -v ON_ERROR_STOP=1 -f "$MIGRATION_FILE" >/dev/null 2>"${TMPDIR:-/tmp}/ailab_stage_a.$$"; rc=$?; set -e
      grep -oE 'AI_LAB_TOPIC_CLAIMS_[A-Z_]+[^"]*' "${TMPDIR:-/tmp}/ailab_stage_a.$$" | head -3 | sed 's/^/  migration said: /' || true
      rm -f "${TMPDIR:-/tmp}/ailab_stage_a.$$" ;;
    *) refuse "unknown AILAB_ROLLOUT_TEST_STAGE_A" ;;
  esac
  if [[ -n "${AILAB_ROLLOUT_TEST_AFTER_STAGE_A_SQL:-}" ]]; then
    say "TEST HOOK: injecting catalog change after Stage A (local only)"
    psql_q -c "$AILAB_ROLLOUT_TEST_AFTER_STAGE_A_SQL" >/dev/null
  fi
  STAGE_A_RC=$rc
}

stage_b() {  # mandatory read-back from a fresh session; history is never written unless this passes
  local state
  state="$(schema_state)"
  if [[ "$state" != EXACT ]]; then
    say "Stage B: catalog read-back = $state"
    explain_mismatch
    stop 13 "catalog is not the exact reviewed state; history NOT written; no deploy; operator review required"
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
    stop 14 "schema present / history missing; no automatic retry, no repair, no deploy; operator review required"
  fi
  say "Stage C: history recorded ($VERSION $NAME)"
}

postflight() {
  local schema history
  schema="$(schema_state)"; history="$(history_state)"
  say "postflight: schema=$schema history=$history"
  [[ "$schema" == EXACT && "$history" == EXACT ]] || stop 15 "postflight read-back is not exact; no deploy; operator review required"
}

# After connecting, before anything else: the session really is the expected owner on PostgreSQL 17.
check_identity() {
  local identity
  identity="$(psql_q -c "select current_user || '|' || (current_setting('server_version_num')::int / 10000)")" \
    || stop 10 "cannot connect or read the session identity; nothing applied"
  [[ "${identity%%|*}" == "$AILAB_EXPECTED_OWNER" ]] || stop 10 "session role is not the expected owner; nothing applied"
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
      stage_b; stage_c; postflight; say "DONE (history-only resume). Next: deploy exact x-test-post per runbook."; exit 0 ;;
    ABSENT/NONE)
      [[ "$resume" != --resume-history ]] || stop 10 "--resume-history is only valid for schema present / history missing" ;;
    *) explain_mismatch; stop 10 "unexpected starting state (schema=$schema history=$history); nothing applied" ;;
  esac

  stage_a
  if [[ "$STAGE_A_RC" -ne 0 ]]; then
    # Never rerun Stage A here. Read the catalog first and report what is actually there.
    schema="$(schema_state)"; history="$(history_state)"
    say "Stage A: psql exit $STAGE_A_RC; read-back: schema=$schema history=$history"
    if [[ "$STAGE_A_RC" -eq 3 && "$schema" == ABSENT && "$history" == NONE ]]; then
      stop 11 "migration failed before COMMIT and rolled back; schema absent, history absent; fix the cause before any new attempt"
    fi
    case "$schema" in
      ABSENT) stop 12 "Stage A outcome unknown but schema is absent and history absent; a new attempt needs operator review" ;;
      EXACT) explain_mismatch; stop 12 "Stage A outcome unknown but the exact schema is present; history not written; resume with --resume-history only after review" ;;
      *) explain_mismatch; stop 12 "Stage A outcome unknown and the schema is partial or unsafe; no history, no deploy; operator review required" ;;
    esac
  fi
  say "Stage A: migration committed"
  stage_b
  stage_c
  postflight
  say "DONE. Next: deploy exact x-test-post per runbook."
}

# ------------------------------------------------------------------------------------------- proof
cmd_proof() {
  local host="${AILAB_PGHOST:?AILAB_PGHOST (local socket dir) required}"
  local port="${AILAB_PGPORT:?AILAB_PGPORT required}"
  local super="${AILAB_PGSUPER:?AILAB_PGSUPER required}"
  case "$host" in /tmp/*|/private/tmp/*) ;; *) refuse "proof runs only on a local /tmp socket cluster" ;; esac
  local owner="kb_ai_lab_rollout_owner"
  local db=""
  PROOF_DBS=""
  PROOF_SUPER=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
  local -a as_super=("${PROOF_SUPER[@]}")
  trap 'for d in $PROOF_DBS; do "${PROOF_SUPER[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true; done' EXIT
  "${as_super[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb nocreaterole; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_ai_lab_unrelated') then create role kb_ai_lab_unrelated nologin; end if;
  if pg_has_role('service_role', '$owner', 'MEMBER') then execute 'revoke $owner from service_role'; end if;
end \$\$;
SQL
  local pass=0
  ok() { say "PASS $1"; pass=$((pass + 1)); }
  bad() { say "FAIL $1"; exit 1; }
  fresh() {  # name -> disposable db with Supabase-like defaults and the production ledger shape
    db="kabumori_ailab_rollout_$1_$$"; PROOF_DBS="$PROOF_DBS $db"
    "${as_super[@]}" -d postgres -c "create database $db owner $owner" >/dev/null
    "${as_super[@]}" -d "$db" >/dev/null <<SQL
grant usage on schema public to anon, authenticated, service_role;
grant create on schema public to $owner;
alter default privileges for role $owner in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role $owner in schema public grant all on functions to anon, authenticated, service_role;
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (
  version text not null primary key, statements text[], name text, created_by text, idempotency_key text unique, rollback text[]);
grant usage on schema supabase_migrations to $owner;
grant select, insert on supabase_migrations.schema_migrations to $owner;
SQL
  }
  run() {  # args... -> runs this script against $db as the owner; sets RC and OUT
    set +e
    OUT="$(env AILAB_ROLLOUT_TARGET=local PGHOST="$host" PGPORT="$port" PGUSER="$owner" PGDATABASE="$db" AILAB_EXPECTED_OWNER="$owner" \
           ${PROOF_ENV[@]+"${PROOF_ENV[@]}"} bash "$0" "$@" 2>&1)"
    RC=$?
    set -e
    PROOF_ENV=()
  }
  q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -c "$1"; }
  hist() { q "select coalesce(string_agg(version || ':' || coalesce(name, '-'), ',' order by version), 'none') from supabase_migrations.schema_migrations"; }
  table_present() { q "select (to_regclass('public.ai_lab_topic_claims') is not null)::text"; }
  expect() { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 :: got [$2] want [$3]  -- $OUT"; }
  PROOF_ENV=()

  # 0. the pinned migration bytes and the pinned catalog sections match a fresh apply
  [[ "$(shasum -a 256 "$MIGRATION" | cut -d' ' -f1)" == "$MIGRATION_SHA256" ]] && ok "accepted migration bytes match the pinned SHA-256" || bad "migration SHA-256"

  # 1. clean success
  fresh clean
  run status; expect "clean: initial state" "$OUT" "STATE schema=ABSENT history=NONE"
  run apply
  expect "clean: apply exits 0" "$RC" "0"
  grep -q "Stage B: catalog read-back = EXACT" <<<"$OUT" && ok "clean: Stage B passed before history" || bad "clean Stage B :: $OUT"
  expect "clean: exactly one history row" "$(hist)" "$VERSION:$NAME"
  run status; expect "clean: postflight state" "$OUT" "STATE schema=EXACT history=EXACT"
  # catalog sections of this fresh apply equal the pinned expectation (guards runner/migration drift)
  local live; live="$(descriptor_sql | psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f -)"
  expect "clean: live catalog sections equal the pinned expectation" "$live" "$EXPECTED_SECTIONS"

  # 1a. the pinned function_acl is exactly the canonical text of the five reviewed grants (no names of parameters,
  #     explicit schema, C order) -- the same five rows production reported on 2026-10-05.
  local canonical_acl
  canonical_acl="$(printf '%s\n%s\n%s\n%s\n%s' \
    "public.claim_ai_lab_topic(uuid,jsonb,integer) service_role EXECUTE f" \
    "public.mark_ai_lab_topic_claim_ambiguous(uuid,uuid,text,text) service_role EXECUTE f" \
    "public.release_ai_lab_topic_claim(uuid,uuid,text,text) service_role EXECUTE f" \
    "public.settle_ai_lab_topic_claim_published(uuid,uuid,text,text,text) service_role EXECUTE f" \
    "public.start_ai_lab_topic_provider(uuid,uuid,text) service_role EXECUTE f" | shasum -a 256 | cut -d' ' -f1)"
  expect "function_acl pin = canonical five service_role EXECUTE grants" "function_acl=$canonical_acl" "$(grep '^function_acl=' <<<"$EXPECTED_SECTIONS")"

  # 1b. every section is independent of the session search_path (Supabase default, pg_catalog only, public only, empty)
  local sp sections_sp
  for sp in '"$user", public, extensions' 'pg_catalog' 'public' "''"; do
    sections_sp="$(PGOPTIONS="-c search_path=$(printf '%s' "$sp" | tr -d ' ')" descriptor_sql | \
      PGOPTIONS="-c search_path=$(printf '%s' "$sp" | tr -d ' ')" psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f -)"
    expect "catalog sections identical under search_path [$sp]" "$sections_sp" "$EXPECTED_SECTIONS"
    set +e
    OUT="$(env PGOPTIONS="-c search_path=$(printf '%s' "$sp" | tr -d ' ')" AILAB_ROLLOUT_TARGET=local PGHOST="$host" PGPORT="$port" PGUSER="$owner" PGDATABASE="$db" AILAB_EXPECTED_OWNER="$owner" bash "$0" status 2>&1)"
    set -e
    expect "status EXACT under search_path [$sp]" "$OUT" "STATE schema=EXACT history=EXACT"
  done

  # 1c. adverse function ACL changes are always detected (catalog hash and/or semantic check)
  local acl_change
  for acl_change in \
    "grant execute on function public.claim_ai_lab_topic(uuid,jsonb,integer) to anon" \
    "grant execute on function public.release_ai_lab_topic_claim(uuid,uuid,text,text) to authenticated" \
    "grant execute on function public.settle_ai_lab_topic_claim_published(uuid,uuid,text,text,text) to kb_ai_lab_unrelated" \
    "revoke execute on function public.start_ai_lab_topic_provider(uuid,uuid,text) from service_role" \
    "grant execute on function public.mark_ai_lab_topic_claim_ambiguous(uuid,uuid,text,text) to service_role with grant option" \
    "create function public.release_ai_lab_topic_claim(p_claim_id uuid) returns text language sql as 'select null::text'"; do
    fresh "acl_$RANDOM"
    run apply >/dev/null
    q "$acl_change" >/dev/null
    run status
    expect "ACL change detected: ${acl_change:0:70}" "$OUT" "STATE schema=UNSAFE history=EXACT"
    run apply; expect "ACL change blocks apply: ${acl_change:0:50}" "$RC" "10"
  done
  db="$(printf '%s' "$PROOF_DBS" | awk '{print $1}')"  # back to the clean, completed database

  # 6. completed state: rerun is a read-only no-op
  local before; before="$(q "select count(*) from supabase_migrations.schema_migrations")/$(q "select count(*) from pg_proc where proname = 'claim_ai_lab_topic'")"
  run apply
  expect "completed: rerun exits 0" "$RC" "0"
  grep -q "read-only no-op" <<<"$OUT" && ok "completed: reported as no-op" || bad "no-op :: $OUT"
  expect "completed: nothing duplicated" "$(q "select count(*) from supabase_migrations.schema_migrations")/$(q "select count(*) from pg_proc where proname = 'claim_ai_lab_topic'")" "$before"
  run apply --resume-history; expect "completed: --resume-history on a complete state is a no-op too" "$RC" "0"

  # 2. migration fails before COMMIT (its own preflight refuses: an API role inherits the owner)
  fresh fail_before_commit
  "${as_super[@]}" -d postgres -c "grant $owner to service_role" >/dev/null
  run apply
  "${as_super[@]}" -d postgres -c "revoke $owner from service_role" >/dev/null
  expect "fail-before-commit (preflight): STOP 11" "$RC" "11"
  expect "fail-before-commit (preflight): no table" "$(table_present)" "false"
  expect "fail-before-commit (preflight): no history" "$(hist)" "none"
  # late failure: every DDL statement ran, then an error just before COMMIT -> all rolled back
  fresh fail_late
  local late="${TMPDIR:-/tmp}/ailab_late_failure.$$.sql"
  awk '/^commit;$/ && !done { print "select 1/0; -- injected late failure"; done = 1 } { print }' "$MIGRATION" > "$late"
  PROOF_ENV=(AILAB_ROLLOUT_TEST_MIGRATION="$late"); run apply; rm -f "$late"
  expect "fail-before-commit (late): STOP 11" "$RC" "11"
  expect "fail-before-commit (late): no table" "$(table_present)" "false"
  expect "fail-before-commit (late): no functions" "$(q "select count(*) from pg_proc where proname like '%ai_lab_topic%'")" "0"
  expect "fail-before-commit (late): no history" "$(hist)" "none"

  # 3. Stage A response lost: read back first, never rerun
  fresh lost_before
  PROOF_ENV=(AILAB_ROLLOUT_TEST_STAGE_A=lost-before-apply); run apply
  expect "lost (nothing applied): STOP 12" "$RC" "12"
  grep -q "read-back: schema=ABSENT history=NONE" <<<"$OUT" && ok "lost (nothing applied): classified ABSENT" || bad "lost-before :: $OUT"
  expect "lost (nothing applied): no history" "$(hist)" "none"
  fresh lost_after
  PROOF_ENV=(AILAB_ROLLOUT_TEST_STAGE_A=lost-after-apply); run apply
  expect "lost (committed): STOP 12" "$RC" "12"
  grep -q "read-back: schema=EXACT history=NONE" <<<"$OUT" && ok "lost (committed): classified EXACT, history not written" || bad "lost-after :: $OUT"
  expect "lost (committed): no history" "$(hist)" "none"
  run apply; expect "lost (committed): plain rerun refuses (schema present / history missing)" "$RC" "14"
  expect "lost (committed): still no history" "$(hist)" "none"
  run apply --resume-history; expect "lost (committed): explicit history-only resume completes" "$RC" "0"
  expect "lost (committed): exactly one history row" "$(hist)" "$VERSION:$NAME"
  fresh lost_partial
  PROOF_ENV=(AILAB_ROLLOUT_TEST_STAGE_A=lost-before-apply AILAB_ROLLOUT_TEST_AFTER_STAGE_A_SQL="create table public.ai_lab_topic_claims (claim_id uuid primary key)")
  run apply
  expect "lost (partial): STOP 12" "$RC" "12"
  grep -q "read-back: schema=UNSAFE" <<<"$OUT" && ok "lost (partial): classified UNSAFE" || bad "lost-partial :: $OUT"
  expect "lost (partial): no history" "$(hist)" "none"

  # 4. Stage B mismatch: drift injected between Stage A and Stage B -> no history, no deploy
  local drift
  for drift in \
    "grant select on public.ai_lab_topic_claims to anon" \
    "create policy stale_allow_all on public.ai_lab_topic_claims for all to public using (true) with check (true)" \
    "drop index public.ai_lab_topic_claims_evergreen_idx; create index ai_lab_topic_claims_evergreen_idx on public.ai_lab_topic_claims (claimed_at)" \
    "alter function public.claim_ai_lab_topic(uuid,jsonb,integer) security invoker" \
    "grant execute on function public.start_ai_lab_topic_provider(uuid,uuid,text) to authenticated" \
    "create function public.claim_ai_lab_topic(p_scheduled_post_id uuid) returns jsonb language sql as 'select null::jsonb'" \
    "alter table public.ai_lab_topic_claims drop constraint ai_lab_topic_claims_reason_check" \
    "update pg_index set indisvalid = false where indexrelid = 'public.ai_lab_topic_claims_schedule_active_uidx'::regclass"; do
    fresh "stage_b_$RANDOM"
    if [[ "$drift" == update\ pg_index* ]]; then
      # catalog flag only a superuser can flip: apply normally, flip, then classify (same Stage B code path via status)
      run apply >/dev/null; "${as_super[@]}" -d "$db" -c "$drift" >/dev/null
      run status
      expect "Stage B detects an invalid index" "$OUT" "STATE schema=UNSAFE history=EXACT"
      run apply; expect "invalid index after completion: STOP 10" "$RC" "10"
      continue
    fi
    PROOF_ENV=(AILAB_ROLLOUT_TEST_AFTER_STAGE_A_SQL="$drift"); run apply
    expect "Stage B mismatch STOP 13: ${drift:0:60}" "$RC" "13"
    expect "Stage B mismatch wrote no history: ${drift:0:40}" "$(hist)" "none"
    grep -q "Next: deploy" <<<"$OUT" && bad "Stage B mismatch offered deploy" || ok "Stage B mismatch did not offer deploy: ${drift:0:40}"
  done

  # 5. Stage C history insert fails: schema stays exact, no retry, STOP; later explicit resume works
  fresh history_fail
  "${as_super[@]}" -d "$db" -c "revoke insert on supabase_migrations.schema_migrations from $owner" >/dev/null
  run apply
  expect "history failure: STOP 14" "$RC" "14"
  grep -q "schema=EXACT history=NONE" <<<"$OUT" && ok "history failure: schema exact, history missing" || bad "history-fail :: $OUT"
  expect "history failure: table kept (no automatic drop)" "$(table_present)" "true"
  expect "history failure: no history" "$(hist)" "none"
  run apply; expect "history failure: plain rerun still STOP 14 (no automatic retry)" "$RC" "14"
  "${as_super[@]}" -d "$db" -c "grant insert on supabase_migrations.schema_migrations to $owner" >/dev/null
  run apply --resume-history; expect "history failure: explicit resume after review completes" "$RC" "0"
  expect "history failure: exactly one history row after resume" "$(hist)" "$VERSION:$NAME"

  # 7. mismatches always STOP
  fresh wrong_name
  q "insert into supabase_migrations.schema_migrations (version, name) values ('$VERSION', 'something_else')" >/dev/null
  run apply; expect "wrong history name: STOP 10" "$RC" "10"; expect "wrong history name: no schema" "$(table_present)" "false"
  fresh wrong_version
  q "insert into supabase_migrations.schema_migrations (version, name) values ('20261004090001', '$NAME')" >/dev/null
  run apply; expect "wrong history version: STOP 10" "$RC" "10"; expect "wrong history version: no schema" "$(table_present)" "false"
  fresh history_without_schema
  q "insert into supabase_migrations.schema_migrations (version, name) values ('$VERSION', '$NAME')" >/dev/null
  run apply; expect "history without schema: STOP 10" "$RC" "10"; expect "history without schema: no schema created" "$(table_present)" "false"
  fresh superseded
  q "create table public.ai_lab_topic_event_usage (scheduled_post_id uuid primary key)" >/dev/null
  run apply; expect "superseded usage table present: STOP 10" "$RC" "10"
  fresh drift_after_complete
  run apply >/dev/null
  q "grant select on public.ai_lab_topic_claims to anon" >/dev/null
  run apply; expect "drifted object with exact history: STOP 10" "$RC" "10"
  expect "drifted object with exact history: history untouched" "$(hist)" "$VERSION:$NAME"
  fresh resume_misuse
  run apply --resume-history; expect "--resume-history on an empty database: STOP 10" "$RC" "10"; expect "--resume-history misuse: no schema" "$(table_present)" "false"
  fresh bad_bytes
  local altered="${TMPDIR:-/tmp}/ailab_altered.$$"
  mkdir -p "$altered/tests" "$altered/migrations"; cp "$0" "$altered/tests/"; sed 's/-- 会社員AIラボ/--  会社員AIラボ/' "$MIGRATION" > "$altered/migrations/${VERSION}_${NAME}.sql"
  set +e; OUT="$(env AILAB_ROLLOUT_TARGET=local PGHOST="$host" PGPORT="$port" PGUSER="$owner" PGDATABASE="$db" AILAB_EXPECTED_OWNER="$owner" bash "$altered/tests/$(basename "$0")" apply 2>&1)"; RC=$?; set -e
  rm -rf "$altered"
  expect "migration bytes differ from accepted SHA: STOP 10" "$RC" "10"; expect "altered bytes: nothing applied" "$(table_present)" "false"

  # guards: production is refused before any connection unless every switch is present
  local -a prod=(AILAB_ROLLOUT_TARGET=production PGHOST=db.abcdefghijklmnopqrst.supabase.invalid PGUSER=postgres PGDATABASE=postgres
                 AILAB_EXPECTED_OWNER=postgres PGSSLMODE=require AILAB_ROLLOUT_PROJECT_REF=abcdefghijklmnopqrst PGCONNECT_TIMEOUT=1)
  guard() {  # label, extra env... -> must exit 2 with REFUSED and must not try to connect
    local label="$1"; shift
    set +e; OUT="$(env -u PGPASSWORD "${prod[@]}" "$@" bash "$0" apply 2>&1)"; RC=$?; set -e
    [[ "$RC" == 2 && "$OUT" == *REFUSED* && "$OUT" != *"could not"* ]] && ok "guard refuses production: $label" || bad "guard $label :: rc=$RC $OUT"
  }
  guard "no acknowledgement"
  guard "wrong acknowledgement" AILAB_ROLLOUT_ACK="yes"
  guard "project ref missing" AILAB_ROLLOUT_ACK="$PROD_ACK" AILAB_ROLLOUT_PROJECT_REF=
  guard "host not in project" AILAB_ROLLOUT_ACK="$PROD_ACK" AILAB_ROLLOUT_PROJECT_REF=zyxwvutsrqponmlkjihg
  guard "socket host" AILAB_ROLLOUT_ACK="$PROD_ACK" PGHOST=/tmp/abcdefghijklmnopqrst
  guard "no TLS" AILAB_ROLLOUT_ACK="$PROD_ACK" PGSSLMODE=prefer
  guard "owner not postgres" AILAB_ROLLOUT_ACK="$PROD_ACK" PGUSER=other AILAB_EXPECTED_OWNER=other
  guard "test hook set" AILAB_ROLLOUT_ACK="$PROD_ACK" AILAB_ROLLOUT_TEST_STAGE_A=lost-before-apply
  guard "substitute migration set" AILAB_ROLLOUT_ACK="$PROD_ACK" AILAB_ROLLOUT_TEST_MIGRATION=/tmp/x.sql
  guard "transaction pooler port" AILAB_ROLLOUT_ACK="$PROD_ACK" PGPORT=6543
  guard "pooler user of another project" AILAB_ROLLOUT_ACK="$PROD_ACK" PGUSER=postgres.zyxwvutsrqponmlkjihg
  # every switch correct (session-pooler user shape): guards pass, then the identity check runs before any write.
  # The host is a reserved .invalid name, so the connection cannot succeed and nothing can be written.
  set +e; OUT="$(env -u PGPASSWORD "${prod[@]}" AILAB_ROLLOUT_ACK="$PROD_ACK" PGUSER=postgres.abcdefghijklmnopqrst bash "$0" apply 2>&1)"; RC=$?; set -e
  [[ "$RC" == 10 && "$OUT" == *"cannot connect or read the session identity"* && "$OUT" != *REFUSED* ]] \
    && ok "guard: a fully switched production target passes the guards and stops at the identity check" || bad "identity :: rc=$RC $OUT"
  set +e; OUT="$(env AILAB_ROLLOUT_TARGET=local PGHOST=db.example.invalid PGUSER=x PGDATABASE=x AILAB_EXPECTED_OWNER=x bash "$0" status 2>&1)"; RC=$?; set -e
  [[ "$RC" == 2 && "$OUT" == *REFUSED* ]] && ok "guard: a non-socket host is refused for the default local target" || bad "local guard :: $OUT"

  say "ALL AI LAB TOPIC CLAIMS ROLLOUT CHECKS PASSED ($pass)"
}

case "${1:-}" in
  status) cmd_status ;;
  apply) shift; cmd_apply "${1:-}" ;;
  proof) cmd_proof ;;
  print-sections)  # local only: prints the catalog sections of the target (used to pin EXPECTED_SECTIONS)
    guard_target; [[ "${AILAB_ROLLOUT_TARGET:-local}" == local ]] || refuse "print-sections is local only"
    descriptor_sql | psql_q -f - ;;
  *) say "usage: $0 status | apply [--resume-history] | proof"; exit 2 ;;
esac
