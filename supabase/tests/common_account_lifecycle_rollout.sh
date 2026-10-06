#!/usr/bin/env bash
# Operator runner for applying 20261001150000_common_account_lifecycle_foundation.sql:
#   schema first -> mandatory catalog read-back -> migration history second.
# Same mechanism as supabase/tests/ai_lab_topic_claims_rollout.sh (PR #86 / #88), pinned to this file.
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
# Stage A runs the file unchanged in its own session after one session setting, lock_timeout
# (5s in production): the new foreign key to auth.users needs a SHARE ROW EXCLUSIVE lock there, and
# a bounded wait turns "blocked behind a long transaction" into a clean rollback instead of a queue
# that holds back every sign-in.
#
# Connection: libpq environment only (PGHOST, PGPORT, PGUSER, PGDATABASE, PGSSLMODE; password via
# ~/.pgpass or PGPASSWORD). No URL, password, token or project ref is accepted as an argument, stored
# in this file, or printed. Default target is LOCAL and only a /tmp Unix-socket host is accepted.
# Production needs every switch documented in common_account_lifecycle_rollout.md and is NOT run here.
#
# Exit codes: 0 done / already complete / status printed, 2 refused by a guard, 10 STOP precondition,
# 11 STOP Stage A failed (schema confirmed absent), 12 STOP Stage A outcome unknown or inconsistent,
# 13 STOP Stage B catalog mismatch, 14 STOP schema present / history missing, 15 STOP postflight mismatch.
set -euo pipefail

VERSION="20261001150000"
NAME="common_account_lifecycle_foundation"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATION="$HERE/../migrations/${VERSION}_${NAME}.sql"
# Accepted source (PR #70 merge 44121914, fixed source aa4d2d42). Stage A refuses any other bytes.
MIGRATION_SHA256="e632214b5602c12ee73d9a7475af36791138099a1a7fdba7e8fb521afc01cde3"
PROD_ACK="apply ${VERSION}_${NAME} to production after a same-day read-only preflight"
PROD_LOCK_TIMEOUT="5s"

# Expected catalog sections after an exact apply (PostgreSQL 17; owner and environment normalized away).
# Regenerated only together with a reviewed migration change; `proof` checks a fresh local apply against them.
EXPECTED_SECTIONS="columns=2b7e6cfcb9afec0340b3c18b5dd01749ea2555607479192edaf8cdf3745be101
constraints=c950b02da317fa477c32203d11e061c41d5cedca6ba5909df5e33324dd191aee
indexes=6d2006348e3cfce68c471b26a811d6c7c4afa0f55daede2959c7dd520952b4cf
relations=45a51629c55c94a839688c2c7d8ea2085feb03ef0f77c3c37661d14975c4d49c
policies=fc05e8d8fffc1f12bfdb702ac5ba13f654a05e2d32bfcc129dced871b888d10d
triggers=ac8c0d599de3c81e2dfa997001ebf55af710952118ccf8aeb32a7e5bc0482b57
table_acl=4f0ef1474ad1cfdb42f7b62cfedc2a5ffc3e4c3e7cca5f09c532c51ee141a7bd
functions=83cf16c4ab3d5a276cab79959ab571adf5f823e9068a3701972fefe3a05b263c
function_acl=648c2db395b81391aa148d0c59b1d7d99aea1a0bcf4125b9e9e70848fdef04e1
state=0ab6f4291ab71e8edcd713e758f46b002a33f296b70d24a3e8046a5dbcd314cf"

RELATIONS_SQL_LIST="'public.common_accounts','public.service_entitlements','private.account_lifecycle_operations','private.account_lifecycle_settings','private.account_lifecycle_managed_checkpoints','private.account_lifecycle_backfill_plan'"
RELATION_NAMES_SQL_LIST="'common_accounts','common_accounts_pkey','service_entitlements','service_entitlements_pkey','account_lifecycle_operations','account_lifecycle_operations_pkey','account_lifecycle_operations_one_in_progress','account_lifecycle_settings','account_lifecycle_settings_pkey','account_lifecycle_managed_checkpoints','account_lifecycle_managed_checkpoints_pkey','account_lifecycle_backfill_plan'"
CLIENT_SIGNATURES="'public.start_kabumori_service()','public.start_x_autopost_service()'"
BACKEND_SIGNATURES="'public.abort_common_account_deletion(uuid,uuid)','public.abort_service_deletion(uuid,text,uuid)','public.begin_common_account_deletion(uuid,bigint)','public.begin_service_deletion(uuid,text)','public.clear_common_account_deletion_checkpoint(uuid,uuid,text)','public.common_account_deletion_eligibility(uuid)','public.finish_service_deletion(uuid,text,uuid)','public.prepare_common_account_auth_delete(uuid,uuid)','public.record_common_account_deletion_checkpoint(uuid,uuid,text)','public.withdraw_kabumori_service(uuid)'"
INTERNAL_SIGNATURES="'private.account_lifecycle_account_changed()','private.account_lifecycle_authorization_problems(uuid,uuid)','private.account_lifecycle_backfill(boolean)','private.account_lifecycle_builtin_checkpoints()','private.account_lifecycle_deletion_blockers(uuid,text)','private.account_lifecycle_footprint(uuid)','private.account_lifecycle_guard_account_delete()','private.account_lifecycle_guard_checkpoint_registry()','private.account_lifecycle_guard_entitlement_identity()','private.account_lifecycle_invalidate_readiness(uuid,text)','private.account_lifecycle_lock(uuid,boolean,boolean)','private.account_lifecycle_managed_ownership(uuid)','private.account_lifecycle_readiness_refusal(uuid,jsonb)','private.account_lifecycle_required_checkpoints(uuid)','private.account_lifecycle_requirements_changed()','private.account_lifecycle_requirements_valid()','private.account_lifecycle_settings_changed()','private.account_lifecycle_start_service(uuid,text)','private.account_lifecycle_touch_account()','private.account_lifecycle_touch_entitlement()','private.account_lifecycle_touch_settings()'"
SIGNATURES_SQL_LIST="$CLIENT_SIGNATURES,$BACKEND_SIGNATURES,$INTERNAL_SIGNATURES"
# The client-readable columns (column SELECT for authenticated, own rows via RLS). Nothing else is readable.
CLIENT_COLUMNS_SQL_LIST="'public.common_accounts.user_id','public.common_accounts.status','public.common_accounts.lifecycle_version','public.common_accounts.created_at','public.common_accounts.updated_at','public.service_entitlements.user_id','public.service_entitlements.service_key','public.service_entitlements.status','public.service_entitlements.activated_at','public.service_entitlements.ended_at','public.service_entitlements.updated_at'"

say() { printf '%s\n' "$*"; }
stop() { say "STOP[$1] $2"; exit "$1"; }
refuse() { say "REFUSED $1" >&2; exit 2; }

# ------------------------------------------------------------------------------------------- guards
guard_target() {
  local target="${CAL_ROLLOUT_TARGET:-local}"
  local hook
  for hook in CAL_ROLLOUT_TEST_MIGRATION CAL_ROLLOUT_TEST_STAGE_A CAL_ROLLOUT_TEST_AFTER_STAGE_A_SQL CAL_ROLLOUT_TEST_LOCK_TIMEOUT; do
    if [[ -n "${!hook:-}" && "$target" != local ]]; then refuse "test hook $hook is only allowed for a local target"; fi
  done
  [[ -n "${PGDATABASE:-}" && -n "${PGUSER:-}" && -n "${PGHOST:-}" ]] || refuse "PGHOST, PGUSER and PGDATABASE are required"
  [[ -n "${CAL_EXPECTED_OWNER:-}" ]] || refuse "CAL_EXPECTED_OWNER (the role that applies and owns the objects) is required"
  case "$target" in
    local)
      [[ "$CAL_EXPECTED_OWNER" == "$PGUSER" ]] || refuse "PGUSER must be the expected owner role"
      case "$PGHOST" in
        /tmp/*|/private/tmp/*) ;;
        *) refuse "a local target must be a /tmp Unix-socket directory (set CAL_ROLLOUT_TARGET=production deliberately for production)" ;;
      esac
      LOCK_TIMEOUT="${CAL_ROLLOUT_TEST_LOCK_TIMEOUT:-$PROD_LOCK_TIMEOUT}"
      ;;
    production)
      [[ "${CAL_ROLLOUT_ACK:-}" == "$PROD_ACK" ]] || refuse "production needs CAL_ROLLOUT_ACK set to the exact phrase in the runbook"
      local ref="${CAL_ROLLOUT_PROJECT_REF:-}"
      [[ "$ref" =~ ^[a-z]{20}$ ]] || refuse "production needs CAL_ROLLOUT_PROJECT_REF (20 lowercase letters)"
      [[ "$PGHOST" == *"$ref"* || "$PGUSER" == *"$ref"* ]] || refuse "PGHOST/PGUSER does not belong to CAL_ROLLOUT_PROJECT_REF"
      [[ "$PGHOST" != /* ]] || refuse "production must be a TCP host, not a local socket"
      case "${PGSSLMODE:-}" in require|verify-ca|verify-full) ;; *) refuse "production needs PGSSLMODE=require or stronger" ;; esac
      [[ "$CAL_EXPECTED_OWNER" == postgres ]] || refuse "production objects must be owned by postgres"
      # direct host user "postgres", or the session pooler's "postgres.<project ref>"; current_user is checked after connecting
      [[ "$PGUSER" == postgres || "$PGUSER" == "postgres.$ref" ]] || refuse "production PGUSER must be postgres or postgres.<project ref>"
      [[ "${PGPORT:-5432}" != 6543 ]] || refuse "use a direct or session-mode connection, not the transaction pooler (6543)"
      LOCK_TIMEOUT="$PROD_LOCK_TIMEOUT"
      ;;
    *) refuse "CAL_ROLLOUT_TARGET must be local or production" ;;
  esac
}

psql_q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v owner="$CAL_EXPECTED_OWNER" "$@"; }

# ------------------------------------------------------------------------------------------- catalog
# One row per section: name=sha256 of a normalized description. Read-only. The owner and the owner's
# own privilege rows are normalized out; every non-owner grant (table, column, function) is kept.
# Index validity is part of the description. Every aggregate has an explicit C-collation order and
# the search_path is pinned, so neither the session nor the plan can change a hash.
descriptor_sql() {
  cat <<SQL
begin transaction read only;
set local search_path = pg_catalog, public;
with rels as (
  select r as name, to_regclass(r) as oid from unnest(array[$RELATIONS_SQL_LIST]) r
),
fns as (
  select s as sig, to_regprocedure(s) as oid from unnest(array[$SIGNATURES_SQL_LIST]) s
),
canon(oid, sig) as (
  select p.oid, n.nspname || '.' || p.proname || '(' ||
         coalesce((select string_agg(format_type(u.t, null), ',' order by u.ord)
                     from unnest(p.proargtypes::oid[]) with ordinality as u(t, ord)), '') || ')'
    from fns f join pg_proc p on p.oid = f.oid join pg_namespace n on n.oid = p.pronamespace
),
sections(name, body) as (
  select 'columns', (select string_agg(format('%s %s %s nn=%s def=%s', r.name, a.attname, format_type(a.atttypid, a.atttypmod),
                                              a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), '-')),
                                       E'\n' order by r.name collate "C", a.attnum)
                       from rels r join pg_attribute a on a.attrelid = r.oid
                       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                      where a.attnum > 0 and not a.attisdropped)
  union all
  select 'constraints', (select string_agg(format('%s %s %s %s valid=%s deferrable=%s', r.name, c.conname, c.contype,
                                                  pg_get_constraintdef(c.oid), c.convalidated, c.condeferrable),
                                           E'\n' order by r.name collate "C", c.conname collate "C")
                           from rels r join pg_constraint c on c.conrelid = r.oid)
  union all
  select 'indexes', (select string_agg(format('%s %s valid=%s ready=%s live=%s %s', r.name, i.relname, x.indisvalid, x.indisready,
                                              x.indislive, pg_get_indexdef(i.oid)),
                                       E'\n' order by r.name collate "C", i.relname collate "C")
                       from rels r join pg_index x on x.indrelid = r.oid join pg_class i on i.oid = x.indexrelid)
  union all
  select 'relations', (select string_agg(format('%s kind=%s persistence=%s rls=%s force=%s policies=%s triggers=%s internal_triggers=%s options=%s view=%s comment=%s',
                                                r.name, c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity,
                                                (select count(*) from pg_policy where polrelid = c.oid),
                                                (select count(*) from pg_trigger where tgrelid = c.oid and not tgisinternal),
                                                (select count(*) from pg_trigger where tgrelid = c.oid and tgisinternal),
                                                coalesce(array_to_string(c.reloptions, ','), '-'),
                                                case when c.relkind = 'v' then md5(pg_get_viewdef(c.oid)) else '-' end,
                                                md5(coalesce(obj_description(c.oid, 'pg_class'), ''))),
                                         E'\n' order by r.name collate "C")
                         from rels r join pg_class c on c.oid = r.oid)
  union all
  select 'policies', (select string_agg(format('%s %s permissive=%s cmd=%s roles=%s using=%s check=%s', r.name, p.polname,
                                               p.polpermissive, p.polcmd,
                                               (select string_agg(case when ro = 0 then 'PUBLIC' else pg_get_userbyid(ro) end, ','
                                                                  order by (case when ro = 0 then 'PUBLIC' else pg_get_userbyid(ro) end) collate "C")
                                                  from unnest(p.polroles) ro),
                                               coalesce(pg_get_expr(p.polqual, p.polrelid), '-'),
                                               coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-')),
                                        E'\n' order by r.name collate "C", p.polname collate "C")
                        from rels r join pg_policy p on p.polrelid = r.oid)
  union all
  select 'triggers', (select string_agg(format('%s %s enabled=%s %s', r.name, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid)),
                                        E'\n' order by r.name collate "C", t.tgname collate "C")
                        from rels r join pg_trigger t on t.tgrelid = r.oid where not t.tgisinternal)
  union all
  select 'table_acl', (select coalesce(string_agg(line, E'\n' order by line collate "C"), 'none') from (
                         select format('%s %s %s %s', r.name, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
                                       a.privilege_type, case when a.is_grantable then 't' else 'f' end) as line
                           from rels r join pg_class c on c.oid = r.oid,
                                lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                          where a.grantee <> c.relowner
                         union all
                         select format('%s.%s %s %s %s', r.name, att.attname, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
                                       a.privilege_type, case when a.is_grantable then 't' else 'f' end)
                           from rels r join pg_class c on c.oid = r.oid join pg_attribute att on att.attrelid = c.oid,
                                lateral aclexplode(att.attacl) a
                          where att.attnum > 0 and not att.attisdropped and att.attacl is not null and a.grantee <> c.relowner) acl)
  union all
  select 'functions', (select string_agg(format('%s kind=%s secdef=%s config=%s lang=%s volatility=%s strict=%s returns=%s def=%s',
                                                k.sig, p.prokind, p.prosecdef, p.proconfig, l.lanname, p.provolatile, p.proisstrict,
                                                pg_get_function_result(p.oid), md5(pg_get_functiondef(p.oid))),
                                         E'\n' order by k.sig collate "C")
                         from canon k join pg_proc p on p.oid = k.oid join pg_language l on l.oid = p.prolang)
  union all
  select 'function_acl', (select coalesce(string_agg(line, E'\n' order by line collate "C"), 'none') from (
                            select format('%s %s %s %s', k.sig, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
                                          a.privilege_type, case when a.is_grantable then 't' else 'f' end) as line
                              from canon k join pg_proc p on p.oid = k.oid,
                                   lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                             where a.grantee <> p.proowner) acl)
  union all
  select 'state', (select format('settings=%s registry=%s accounts=%s entitlements=%s operations=%s',
                                 (select string_agg(format('%s/%s/%s', s.auth_delete_guard, s.integration_state, s.requirement_epoch), ';'
                                                    order by s.requirement_epoch)
                                    from private.account_lifecycle_settings s),
                                 (select string_agg(m.checkpoint_key || ':' || m.requirement, ',' order by m.checkpoint_key collate "C")
                                    from private.account_lifecycle_managed_checkpoints m),
                                 (select count(*) from public.common_accounts),
                                 (select count(*) from public.service_entitlements),
                                 (select count(*) from private.account_lifecycle_operations))
                    where (select count(*) from rels where oid is null) = 0)
)
select name || '=' || encode(sha256(convert_to(coalesce(body, '<absent>'), 'UTF8')), 'hex') from sections order by
  array_position(array['columns','constraints','indexes','relations','policies','triggers','table_acl','functions','function_acl','state'], name);
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
rels(name) as (select unnest(array[$RELATIONS_SQL_LIST])),
sigs(sig, audience) as (
  select s, 'authenticated' from unnest(array[$CLIENT_SIGNATURES]) s
  union all select s, 'service_role' from unnest(array[$BACKEND_SIGNATURES]) s
  union all select s, 'none' from unnest(array[$INTERNAL_SIGNATURES]) s),
cols(rel, col) as (
  select r.name, a.attname from rels r join pg_attribute a on a.attrelid = to_regclass(r.name)
   where a.attnum > 0 and not a.attisdropped),
client_cols(q) as (select unnest(array[$CLIENT_COLUMNS_SQL_LIST]))
select reason from (
  select 'RELATION_MISSING:' || name as reason from rels where to_regclass(name) is null
  union all
  select 'RELATION_OWNER_MISMATCH:' || name from rels
   where to_regclass(name) is not null and (select pg_get_userbyid(relowner) from pg_class where oid = to_regclass(name)) <> :'owner'
  union all
  select 'FUNCTION_MISSING:' || sig from sigs where to_regprocedure(sig) is null
  union all
  select 'FUNCTION_OWNER_MISMATCH:' || sig from sigs
   where to_regprocedure(sig) is not null and pg_get_userbyid((select proowner from pg_proc where oid = to_regprocedure(sig))) <> :'owner'
  union all
  select 'UNEXPECTED_OVERLOAD:' || n.nspname || '.' || p.proname || '/' || p.pronargs
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname in (select split_part(split_part(sig, '(', 1), '.', 2) from sigs)
     and p.oid not in (select to_regprocedure(sig) from sigs where to_regprocedure(sig) is not null)
  union all
  select 'UNEXPECTED_RELATION:' || n.nspname || '.' || c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relname in ($RELATION_NAMES_SQL_LIST)
     and c.oid not in (select to_regclass(name) from rels where to_regclass(name) is not null)
     and c.oid not in (select x.indexrelid from pg_index x where x.indrelid in (select to_regclass(name) from rels where to_regclass(name) is not null))
  union all
  select 'API_ROLE_MEMBER_OF_OWNER:' || role_name from api where pg_has_role(role_name, :'owner', 'MEMBER')
  union all
  select 'EFFECTIVE_TABLE_PRIVILEGE:' || role_name || ':' || name || ':' || p from api, rels, privs
   where to_regclass(name) is not null and has_table_privilege(role_name, name, p)
  union all
  select 'EFFECTIVE_COLUMN_PRIVILEGE:' || role_name || ':' || rel || '.' || col || ':' || cp
    from api, cols, unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) cp
   where has_column_privilege(role_name, rel, col, cp)
         <> (role_name = 'authenticated' and cp = 'SELECT' and (rel || '.' || col) in (select q from client_cols))
  union all
  select 'EFFECTIVE_EXECUTE:' || role_name || ':' || sig from api, sigs
   where to_regprocedure(sig) is not null
     and has_function_privilege(role_name, to_regprocedure(sig), 'EXECUTE') <> (role_name = audience)
  union all
  select 'RLS_NOT_ENABLED:' || name from rels
   where to_regclass(name) is not null and (select relkind from pg_class where oid = to_regclass(name)) = 'r'
     and not (select relrowsecurity from pg_class where oid = to_regclass(name))
) checks;
commit;
SQL
}

presence_sql() {
  cat <<SQL
begin transaction read only;
select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public', 'private') and c.relname in ($RELATION_NAMES_SQL_LIST))::int
     + (select count(*) from pg_proc p
         where p.proname in (select split_part(split_part(s, '(', 1), '.', 2) from unnest(array[$SIGNATURES_SQL_LIST]) s))::int;
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
        where name = '$NAME' and version <> '$VERSION') as stray) h)
end;
commit;
SQL
}

# Fingerprint of everything else in schemas public and private (this migration's names excluded):
# relations with columns, defaults, column ACLs and table ACLs; constraints; indexes; policies;
# triggers; functions with definition, settings and ACL; types; schema ACLs and default privileges.
# Taken right before Stage A and again in Stage B: any difference means the apply (or someone
# else, during the apply) changed an existing object -> STOP without history.
existing_fingerprint_sql() {
  cat <<SQL
begin transaction read only;
set local search_path = pg_catalog, public;
with rel as (
  select c.oid, n.nspname || '.' || c.relname as qname, c.relkind
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private') and c.relkind in ('r', 'v', 'm', 'p', 'f', 'S')
     and c.relname not in ($RELATION_NAMES_SQL_LIST)),
acl(oid, txt) as (
  select c.oid, coalesce((select string_agg(k, ',' order by k collate "C")
                            from (select (case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end) || ':' ||
                                         x.privilege_type || ':' || x.is_grantable as k
                                    from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x) z), '')
    from pg_class c where c.oid in (select oid from rel)),
sections(name, body) as (
  select 'relations', string_agg(
           r.qname || ' kind=' || r.relkind::text || ' owner=' || pg_get_userbyid(c.relowner) ||
           ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity || ' opts=' || coalesce(array_to_string(c.reloptions, ','), '') ||
           ' comment=' || md5(coalesce(obj_description(c.oid, 'pg_class'), '')) ||
           ' view=' || case when c.relkind in ('v', 'm') then md5(pg_get_viewdef(c.oid)) else '-' end ||
           ' cols=' || coalesce((select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull || ':' ||
                                                   coalesce(pg_get_expr(d.adbin, d.adrelid), '-') || ':' ||
                                                   coalesce(array_to_string(a.attacl::text[], ';'), '-'), '|' order by a.attnum)
                                   from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                                  where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '') ||
           ' acl=' || md5(g.txt), E'\n' order by r.qname collate "C")
    from rel r join pg_class c on c.oid = r.oid join acl g on g.oid = r.oid
  union all
  select 'constraints', string_agg(r.qname || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid) || ' valid=' || k.convalidated ||
                                   ' defer=' || k.condeferrable, E'\n' order by r.qname collate "C", k.conname collate "C")
    from rel r join pg_constraint k on k.conrelid = r.oid
  union all
  select 'indexes', string_agg(r.qname || ' ' || i.relname || ' ' || x.indisvalid || x.indisready || x.indislive || ' ' || pg_get_indexdef(i.oid),
                               E'\n' order by r.qname collate "C", i.relname collate "C")
    from rel r join pg_index x on x.indrelid = r.oid join pg_class i on i.oid = x.indexrelid
  union all
  select 'policies', string_agg(r.qname || ' ' || p.polname || ' ' || p.polpermissive || p.polcmd::text || ' ' ||
                                coalesce(array_to_string(p.polroles::regrole[]::text[], ','), '') || ' ' ||
                                coalesce(pg_get_expr(p.polqual, p.polrelid), '-') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-'),
                                E'\n' order by r.qname collate "C", p.polname collate "C")
    from rel r join pg_policy p on p.polrelid = r.oid
  union all
  select 'triggers', string_agg(r.qname || ' ' || t.tgname || ' ' || t.tgenabled::text || ' ' || pg_get_triggerdef(t.oid),
                                E'\n' order by r.qname collate "C", t.tgname collate "C")
    from rel r join pg_trigger t on t.tgrelid = r.oid where not t.tgisinternal
  union all
  select 'functions', string_agg(p.oid::regprocedure::text || ' owner=' || pg_get_userbyid(p.proowner) || ' ' || p.prosecdef || ' ' ||
                                 coalesce(array_to_string(p.proconfig, ','), '-') || ' ' ||
                                 md5(case when p.prokind = 'a' then p.proname else pg_get_functiondef(p.oid) end) || ' ' ||
                                 coalesce(array_to_string(p.proacl::text[], ';'), '-'),
                                 E'\n' order by p.oid::regprocedure::text collate "C")
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private')
     and p.proname not in (select split_part(split_part(s, '(', 1), '.', 2) from unnest(array[$SIGNATURES_SQL_LIST]) s)
  union all
  select 'types', string_agg(n.nspname || '.' || t.typname || ' ' || t.typtype::text || ' ' ||
                             coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid), '-') ||
                             ' ' || coalesce(array_to_string(t.typacl::text[], ';'), '-'),
                             E'\n' order by n.nspname collate "C", t.typname collate "C")
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
   where n.nspname in ('public', 'private') and t.typtype in ('e', 'd', 'r', 'm')
  union all
  select 'acls', string_agg(line, E'\n' order by line collate "C")
    from (select 'schema ' || nspname || ' ' || pg_get_userbyid(nspowner) || ' ' || coalesce(array_to_string(nspacl::text[], ';'), '-') as line
            from pg_namespace where nspname in ('public', 'private')
          union all
          select 'default ' || pg_get_userbyid(defaclrole) || ' ' || coalesce((select nspname from pg_namespace where oid = defaclnamespace), '*') ||
                 ' ' || defaclobjtype::text || ' ' || array_to_string(defaclacl::text[], ';')
            from pg_default_acl) s
)
select encode(sha256(convert_to(string_agg(name || '=' || coalesce(body, '<empty>'), E'\n' order by name collate "C"), 'UTF8')), 'hex')
  from sections;
commit;
SQL
}

# Schema state: ABSENT / EXACT / UNSAFE (partial, drifted or unexpected objects).
schema_state() {
  local present descriptor semantic
  present="$(presence_sql | psql_q -f -)" || { say "UNKNOWN"; return; }
  if [[ "$present" == 0 ]]; then say "ABSENT"; return; fi
  descriptor="$(descriptor_sql | psql_q -f - 2>/dev/null)" || { say "UNSAFE"; return; }
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
existing_fingerprint() { existing_fingerprint_sql | psql_q -f - 2>/dev/null || say "UNKNOWN"; }

verify_migration_bytes() {
  local file="$MIGRATION"
  if [[ -n "${CAL_ROLLOUT_TEST_MIGRATION:-}" ]]; then file="$CAL_ROLLOUT_TEST_MIGRATION"; say "TEST HOOK: using a substitute migration file (local only)"; else
    [[ "$(shasum -a 256 "$MIGRATION" | cut -d' ' -f1)" == "$MIGRATION_SHA256" ]] || stop 10 "migration bytes differ from the accepted source (SHA-256 mismatch)"
  fi
  MIGRATION_FILE="$file"
}

# ------------------------------------------------------------------------------------------- stages
stage_a() {  # exact migration, its own BEGIN/COMMIT, nothing else in the session but lock_timeout
  local rc err="${TMPDIR:-/tmp}/cal_stage_a.$$"
  case "${CAL_ROLLOUT_TEST_STAGE_A:-}" in
    lost-before-apply) say "TEST HOOK: Stage A not sent, response reported lost"; rc=2 ;;
    lost-after-apply)
      set +e; psql -X -q -v ON_ERROR_STOP=1 -c "set lock_timeout = '$LOCK_TIMEOUT'" -f "$MIGRATION_FILE" >/dev/null 2>&1; set -e
      say "TEST HOOK: Stage A sent, response reported lost"; rc=2 ;;
    "")
      set +e; psql -X -q -v ON_ERROR_STOP=1 -c "set lock_timeout = '$LOCK_TIMEOUT'" -f "$MIGRATION_FILE" >/dev/null 2>"$err"; rc=$?; set -e
      grep -oE 'COMMON_ACCOUNT_[A-Z_]+[^"]*|canceling statement due to lock timeout' "$err" | head -3 | sed 's/^/  migration said: /' || true
      rm -f "$err" ;;
    *) refuse "unknown CAL_ROLLOUT_TEST_STAGE_A" ;;
  esac
  if [[ -n "${CAL_ROLLOUT_TEST_AFTER_STAGE_A_SQL:-}" ]]; then
    say "TEST HOOK: injecting catalog change after Stage A (local only)"
    psql_q -c "$CAL_ROLLOUT_TEST_AFTER_STAGE_A_SQL" >/dev/null
  fi
  STAGE_A_RC=$rc
}

stage_b() {  # mandatory read-back from a fresh session; history is never written unless this passes
  local state after
  state="$(schema_state)"
  if [[ "$state" != EXACT ]]; then
    say "Stage B: catalog read-back = $state"
    explain_mismatch
    stop 13 "catalog is not the exact reviewed state; history NOT written; operator review required"
  fi
  if [[ -n "${BEFORE_FINGERPRINT:-}" ]]; then
    after="$(existing_fingerprint)"
    if [[ "$after" != "$BEFORE_FINGERPRINT" ]]; then
      say "Stage B: existing objects in public/private changed during the apply"
      stop 13 "an existing object differs from right before Stage A; history NOT written; operator review required"
    fi
    say "Stage B: existing objects unchanged (fingerprint ${after:0:16})"
  else
    say "Stage B: existing-object fingerprint now ${BEFORE_FINGERPRINT_NOTE:-$(existing_fingerprint | cut -c1-16)} (no in-run baseline; compare with the preflight)"
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

# After connecting, before anything else: the session really is the expected owner on PostgreSQL 17.
check_identity() {
  local identity
  identity="$(psql_q -c "select current_user || '|' || (current_setting('server_version_num')::int / 10000)")" \
    || stop 10 "cannot connect or read the session identity; nothing applied"
  [[ "${identity%%|*}" == "$CAL_EXPECTED_OWNER" ]] || stop 10 "session role is not the expected owner; nothing applied"
  [[ "${identity##*|}" == 17 ]] || stop 10 "the pinned catalog expectation is for PostgreSQL 17; nothing applied"
}

cmd_status() {
  guard_target
  check_identity
  say "STATE schema=$(schema_state) history=$(history_state)"
  say "EXISTING fingerprint=$(existing_fingerprint)"
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
      stage_b; stage_c; postflight; say "DONE (history-only resume). Next: read-only production read-back per runbook."; exit 0 ;;
    ABSENT/NONE)
      [[ "$resume" != --resume-history ]] || stop 10 "--resume-history is only valid for schema present / history missing" ;;
    *) explain_mismatch; stop 10 "unexpected starting state (schema=$schema history=$history); nothing applied" ;;
  esac

  BEFORE_FINGERPRINT="$(existing_fingerprint)"
  [[ "$BEFORE_FINGERPRINT" =~ ^[0-9a-f]{64}$ ]] || stop 10 "cannot read the existing-object fingerprint; nothing applied"
  say "preflight: existing-object fingerprint ${BEFORE_FINGERPRINT:0:16}"

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
      *) explain_mismatch; stop 12 "Stage A outcome unknown and the schema is partial or unsafe; no history; operator review required" ;;
    esac
  fi
  say "Stage A: migration committed"
  stage_b
  stage_c
  postflight
  say "DONE. Next: read-only production read-back per runbook. No backfill, no deploy."
}

# ------------------------------------------------------------------------------------------- proof
cmd_proof() {
  local host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
  local port="${CAL_PGPORT:?CAL_PGPORT required}"
  local super="${CAL_PGSUPER:?CAL_PGSUPER required}"
  case "$host" in /tmp/*|/private/tmp/*) ;; *) refuse "proof runs only on a local /tmp socket cluster" ;; esac
  local owner="kb_cal_rollout_owner"
  local tpl="kabumori_cal_rollout_tpl_$$"
  local db=""
  PROOF_DBS="$tpl"
  PROOF_SUPER=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
  PROOF_BG=""
  local -a as_super=("${PROOF_SUPER[@]}")
  trap 'if [[ -n "$PROOF_BG" ]]; then kill "$PROOF_BG" 2>/dev/null || true; fi; for d in $PROOF_DBS; do "${PROOF_SUPER[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true; done' EXIT
  "${as_super[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb nocreaterole; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_unrelated') then create role kb_cal_unrelated nologin; end if;
  if pg_has_role('service_role', '$owner', 'MEMBER') then execute 'revoke $owner from service_role'; end if;
end \$\$;
SQL
  # Production-shaped baseline, built once (the lifecycle runner's sequence) plus the production ledger
  # shape; each case copies it. The fixtures leave Supabase's pre-2026-10-30 worst case in place:
  # every new object in public and private is granted to the API roles by default.
  "${as_super[@]}" -d postgres -c "create database $tpl owner $owner" >/dev/null
  local -a as_tpl=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$tpl")
  "${as_tpl[@]}" -f "$HERE/social_mobile_account_deletion_fixture.sql" >/dev/null
  "${as_tpl[@]}" -f "$HERE/../migrations/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
  "${as_tpl[@]}" -f "$HERE/../migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
  "${as_tpl[@]}" -f "$HERE/../migrations/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
  "${as_tpl[@]}" -f "$HERE/common_account_lifecycle_fixture.sql" >/dev/null
  "${as_tpl[@]}" >/dev/null <<SQL
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (
  version text not null primary key, statements text[], name text, created_by text, idempotency_key text unique, rollback text[]);
insert into supabase_migrations.schema_migrations (version, name) values ('20261004090000', 'ai_lab_topic_claims');
SQL
  local pass=0
  ok() { say "PASS $1"; pass=$((pass + 1)); }
  bad() { say "FAIL $1"; exit 1; }
  fresh() {  # name -> disposable copy of the baseline
    db="kabumori_cal_rollout_$1_$$"; PROOF_DBS="$PROOF_DBS $db"
    "${as_super[@]}" -d postgres -c "create database $db template $tpl owner $owner" >/dev/null
  }
  run() {  # args... -> runs this script against $db as the owner; sets RC and OUT
    set +e
    OUT="$(env CAL_ROLLOUT_TARGET=local PGHOST="$host" PGPORT="$port" PGUSER="$owner" PGDATABASE="$db" CAL_EXPECTED_OWNER="$owner" \
           ${PROOF_ENV[@]+"${PROOF_ENV[@]}"} bash "$0" "$@" 2>&1)"
    RC=$?
    set -e
    PROOF_ENV=()
  }
  q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -c "$1"; }
  hist() { q "select coalesce(string_agg(version || ':' || coalesce(name, '-'), ',' order by version), 'none') from supabase_migrations.schema_migrations where version <> '20261004090000'"; }
  table_present() { q "select (to_regclass('public.common_accounts') is not null)::text"; }
  objects() { q "select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','private') and c.relname in ($RELATION_NAMES_SQL_LIST)) || '/' || (select count(*) from pg_proc where proname like '%account_lifecycle%' or proname like '%common_account%' or proname like '%service_deletion%' or proname in ('start_kabumori_service','start_x_autopost_service','withdraw_kabumori_service'))"; }
  expect() { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 :: got [$2] want [$3]  -- $OUT"; }
  PROOF_ENV=()

  # 0. the pinned migration bytes match
  [[ "$(shasum -a 256 "$MIGRATION" | cut -d' ' -f1)" == "$MIGRATION_SHA256" ]] && ok "accepted migration bytes match the pinned SHA-256" || bad "migration SHA-256"

  # 1. clean success
  fresh clean
  run status; expect "clean: initial state" "$(head -1 <<<"$OUT")" "STATE schema=ABSENT history=NONE"
  local fp_before; fp_before="$(sed -n 's/^EXISTING fingerprint=//p' <<<"$OUT")"
  run apply
  expect "clean: apply exits 0" "$RC" "0"
  grep -q "Stage B: existing objects unchanged" <<<"$OUT" && ok "clean: existing objects unchanged across the apply" || bad "clean fingerprint :: $OUT"
  grep -q "Stage B: catalog read-back = EXACT" <<<"$OUT" && ok "clean: Stage B passed before history" || bad "clean Stage B :: $OUT"
  expect "clean: exactly one new history row" "$(hist)" "$VERSION:$NAME"
  run status
  expect "clean: postflight state" "$(head -1 <<<"$OUT")" "STATE schema=EXACT history=EXACT"
  expect "clean: existing fingerprint equals the pre-apply value" "$(sed -n 's/^EXISTING fingerprint=//p' <<<"$OUT")" "$fp_before"
  local live; live="$(descriptor_sql | psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f -)"
  expect "clean: live catalog sections equal the pinned expectation" "$live" "$EXPECTED_SECTIONS"
  expect "clean: foundation defaults (settings, registry, empty tables)" \
    "$(q "select (select auth_delete_guard || '/' || integration_state || '/' || requirement_epoch from private.account_lifecycle_settings) || ' ' || (select string_agg(checkpoint_key || ':' || requirement, ',' order by checkpoint_key) from private.account_lifecycle_managed_checkpoints) || ' ' || (select count(*) from public.common_accounts) || (select count(*) from public.service_entitlements) || (select count(*) from private.account_lifecycle_operations)")" \
    "shadow/not_started/1 apple_revocation:apple_identity,session_revocation:always,storage_cleanup:always 000"

  # 1a. the pinned function_acl is exactly the 12 reviewed grants in canonical form
  local canonical_acl
  canonical_acl="$(printf '%s\n' \
    "public.abort_common_account_deletion(uuid,uuid) service_role EXECUTE f" \
    "public.abort_service_deletion(uuid,text,uuid) service_role EXECUTE f" \
    "public.begin_common_account_deletion(uuid,bigint) service_role EXECUTE f" \
    "public.begin_service_deletion(uuid,text) service_role EXECUTE f" \
    "public.clear_common_account_deletion_checkpoint(uuid,uuid,text) service_role EXECUTE f" \
    "public.common_account_deletion_eligibility(uuid) service_role EXECUTE f" \
    "public.finish_service_deletion(uuid,text,uuid) service_role EXECUTE f" \
    "public.prepare_common_account_auth_delete(uuid,uuid) service_role EXECUTE f" \
    "public.record_common_account_deletion_checkpoint(uuid,uuid,text) service_role EXECUTE f" \
    "public.start_kabumori_service() authenticated EXECUTE f" \
    "public.start_x_autopost_service() authenticated EXECUTE f" \
    "public.withdraw_kabumori_service(uuid) service_role EXECUTE f" | LC_ALL=C sort | perl -pe 'chomp if eof' | shasum -a 256 | cut -d' ' -f1)"
  expect "function_acl pin = the 12 reviewed EXECUTE grants, nothing else" "function_acl=$canonical_acl" "$(grep '^function_acl=' <<<"$EXPECTED_SECTIONS")"
  local canonical_table_acl
  canonical_table_acl="$(printf '%s\n' \
    "public.common_accounts.created_at authenticated SELECT f" "public.common_accounts.lifecycle_version authenticated SELECT f" \
    "public.common_accounts.status authenticated SELECT f" "public.common_accounts.updated_at authenticated SELECT f" \
    "public.common_accounts.user_id authenticated SELECT f" "public.service_entitlements.activated_at authenticated SELECT f" \
    "public.service_entitlements.ended_at authenticated SELECT f" "public.service_entitlements.service_key authenticated SELECT f" \
    "public.service_entitlements.status authenticated SELECT f" "public.service_entitlements.updated_at authenticated SELECT f" \
    "public.service_entitlements.user_id authenticated SELECT f" | LC_ALL=C sort | perl -pe 'chomp if eof' | shasum -a 256 | cut -d' ' -f1)"
  expect "table_acl pin = the 11 client column SELECT grants, no table grant" "table_acl=$canonical_table_acl" "$(grep '^table_acl=' <<<"$EXPECTED_SECTIONS")"

  # 1b. every section is independent of the session search_path
  local sp sections_sp
  for sp in '"$user",public,extensions' 'pg_catalog' 'public' "''"; do
    sections_sp="$(descriptor_sql | PGOPTIONS="-c search_path=$sp" psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f -)"
    expect "catalog sections identical under search_path [$sp]" "$sections_sp" "$EXPECTED_SECTIONS"
    set +e
    OUT="$(env PGOPTIONS="-c search_path=$sp" CAL_ROLLOUT_TARGET=local PGHOST="$host" PGPORT="$port" PGUSER="$owner" PGDATABASE="$db" CAL_EXPECTED_OWNER="$owner" bash "$0" status 2>&1)"
    set -e
    expect "status EXACT under search_path [$sp]" "$(head -1 <<<"$OUT")" "STATE schema=EXACT history=EXACT"
  done

  # 1c. Supabase's 2026-10-30 default (no automatic grants to API roles) gives the identical result
  fresh no_default_grants
  q "alter default privileges in schema public revoke all on tables from anon, authenticated, service_role;
     alter default privileges in schema public revoke execute on functions from anon, authenticated, service_role;
     alter default privileges in schema private revoke all on tables from anon, authenticated, service_role;
     alter default privileges in schema private revoke execute on functions from anon, authenticated, service_role;" >/dev/null
  run apply
  expect "no default grants: apply exits 0 with the same pinned sections" "$RC" "0"
  local db_completed="$db"

  # 1e. production (read-only preflight 2026-10-06) carries Supabase's ensure_rls event trigger, which
  #     enables RLS on every table created in public at ddl_command_end. Same pins, existing objects unchanged.
  fresh ensure_rls
  "${as_super[@]}" -d "$db" >/dev/null <<'SQL'
create function public.rls_auto_enable() returns event_trigger language plpgsql security definer set search_path = pg_catalog as $$
declare cmd record;
begin
  for cmd in select * from pg_event_trigger_ddl_commands()
              where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') and object_type in ('table', 'partitioned table')
  loop
    if cmd.schema_name = 'public' then
      execute format('alter table if exists %s enable row level security', cmd.object_identity);
    end if;
  end loop;
end;
$$;
create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.rls_auto_enable();
SQL
  run apply
  expect "ensure_rls event trigger: apply exits 0 with the same pinned sections" "$RC" "0"
  grep -q "Stage B: existing objects unchanged" <<<"$OUT" && ok "ensure_rls event trigger: existing objects unchanged" || bad "ensure_rls :: $OUT"

  # 1d. adverse privilege changes after completion are always detected and block a rerun
  local acl_change
  for acl_change in \
    "grant select on public.common_accounts to anon" \
    "grant select (source) on public.service_entitlements to authenticated" \
    "grant update (status) on public.common_accounts to authenticated" \
    "grant select on private.account_lifecycle_operations to service_role" \
    "grant select on private.account_lifecycle_backfill_plan to authenticated" \
    "grant execute on function public.prepare_common_account_auth_delete(uuid,uuid) to authenticated" \
    "grant execute on function private.account_lifecycle_backfill(boolean) to service_role" \
    "grant execute on function public.begin_service_deletion(uuid,text) to kb_cal_unrelated" \
    "revoke execute on function public.start_kabumori_service() from authenticated" \
    "grant execute on function public.withdraw_kabumori_service(uuid) to service_role with grant option" \
    "create function public.start_kabumori_service(p uuid) returns jsonb language sql as 'select null::jsonb'" \
    "create function private.common_account_deletion_eligibility(p uuid) returns jsonb language sql as 'select null::jsonb'" \
    "alter table public.service_entitlements disable row level security" \
    "alter function public.begin_common_account_deletion(uuid,bigint) security invoker" \
    "alter function private.account_lifecycle_lock(uuid,boolean,boolean) reset search_path"; do
    fresh "acl_$RANDOM"
    run apply >/dev/null
    q "$acl_change" >/dev/null
    run status
    expect "change detected: ${acl_change:0:70}" "$(head -1 <<<"$OUT")" "STATE schema=UNSAFE history=EXACT"
    run apply; expect "change blocks apply: ${acl_change:0:50}" "$RC" "10"
  done

  # 6. completed state: rerun is a read-only no-op
  db="$db_completed"
  local before; before="$(hist)/$(objects)"
  run apply
  expect "completed: rerun exits 0" "$RC" "0"
  grep -q "read-only no-op" <<<"$OUT" && ok "completed: reported as no-op" || bad "no-op :: $OUT"
  expect "completed: nothing duplicated" "$(hist)/$(objects)" "$before"
  run apply --resume-history; expect "completed: --resume-history on a complete state is a no-op too" "$RC" "0"

  # 2. migration fails before COMMIT: its own preflight refuses, and a late injected error
  fresh fail_before_commit
  q "alter table public.social_account_oauth_states rename column initiated_by_user_id to initiated_by_user_id_x" >/dev/null
  run apply
  expect "fail-before-commit (preflight): STOP 11" "$RC" "11"
  grep -q "COMMON_ACCOUNT_PREFLIGHT_COLUMN_MISMATCH" <<<"$OUT" && ok "fail-before-commit (preflight): the migration's reason is shown" || bad "reason :: $OUT"
  expect "fail-before-commit (preflight): nothing created" "$(objects)" "0/0"
  expect "fail-before-commit (preflight): no history" "$(hist)" "none"
  fresh fail_late
  local late="${TMPDIR:-/tmp}/cal_late_failure.$$.sql"
  awk '/^commit;$/ && !done { print "select 1/0; -- injected late failure"; done = 1 } { print }' "$MIGRATION" > "$late"
  PROOF_ENV=(CAL_ROLLOUT_TEST_MIGRATION="$late"); run apply; rm -f "$late"
  expect "fail-before-commit (late, after every DDL): STOP 11" "$RC" "11"
  expect "fail-before-commit (late): nothing created" "$(objects)" "0/0"
  expect "fail-before-commit (late): no history" "$(hist)" "none"

  # 2b. a long transaction writing auth.users: Stage A gives up after lock_timeout and rolls back
  fresh lock_wait
  ( psql -X -q -h "$host" -p "$port" -U "$super" -d "$db" \
      -c "begin; lock table auth.users in row exclusive mode; select pg_sleep(30); commit;" >/dev/null 2>&1 & echo $! > "${TMPDIR:-/tmp}/cal_lock_holder.$$" )
  PROOF_BG="$(cat "${TMPDIR:-/tmp}/cal_lock_holder.$$")"; rm -f "${TMPDIR:-/tmp}/cal_lock_holder.$$"
  local tries=0
  until [[ "$(q "select count(*) from pg_locks l join pg_class c on c.oid = l.relation where c.relname = 'users' and l.mode = 'RowExclusiveLock' and l.granted")" -gt 0 ]]; do
    tries=$((tries + 1)); [[ $tries -lt 50 ]] || bad "lock holder did not start"; sleep 0.1
  done
  local t0=$SECONDS
  PROOF_ENV=(CAL_ROLLOUT_TEST_LOCK_TIMEOUT=1s); run apply
  "${as_super[@]}" -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$db' and pid <> pg_backend_pid()" >/dev/null
  kill "$PROOF_BG" 2>/dev/null || true; PROOF_BG=""
  expect "lock wait: STOP 11 (rolled back, nothing applied)" "$RC" "11"
  grep -q "canceling statement due to lock timeout" <<<"$OUT" && ok "lock wait: reason is the lock timeout" || bad "lock reason :: $OUT"
  [[ $((SECONDS - t0)) -lt 20 ]] && ok "lock wait: gave up quickly instead of queueing" || bad "lock wait took $((SECONDS - t0))s"
  expect "lock wait: nothing created" "$(objects)" "0/0"
  expect "lock wait: no history" "$(hist)" "none"

  # 3. Stage A response lost: read back first, never rerun
  fresh lost_before
  PROOF_ENV=(CAL_ROLLOUT_TEST_STAGE_A=lost-before-apply); run apply
  expect "lost (nothing applied): STOP 12" "$RC" "12"
  grep -q "read-back: schema=ABSENT history=NONE" <<<"$OUT" && ok "lost (nothing applied): classified ABSENT" || bad "lost-before :: $OUT"
  expect "lost (nothing applied): no history" "$(hist)" "none"
  fresh lost_after
  PROOF_ENV=(CAL_ROLLOUT_TEST_STAGE_A=lost-after-apply); run apply
  expect "lost (committed): STOP 12" "$RC" "12"
  grep -q "read-back: schema=EXACT history=NONE" <<<"$OUT" && ok "lost (committed): classified EXACT, history not written" || bad "lost-after :: $OUT"
  expect "lost (committed): no history" "$(hist)" "none"
  run apply; expect "lost (committed): plain rerun refuses (schema present / history missing)" "$RC" "14"
  expect "lost (committed): still no history" "$(hist)" "none"
  run apply --resume-history; expect "lost (committed): explicit history-only resume completes" "$RC" "0"
  expect "lost (committed): exactly one history row" "$(hist)" "$VERSION:$NAME"
  fresh lost_partial
  PROOF_ENV=(CAL_ROLLOUT_TEST_STAGE_A=lost-before-apply CAL_ROLLOUT_TEST_AFTER_STAGE_A_SQL="create table public.common_accounts (user_id uuid primary key)")
  run apply
  expect "lost (partial): STOP 12" "$RC" "12"
  grep -q "read-back: schema=UNSAFE" <<<"$OUT" && ok "lost (partial): classified UNSAFE" || bad "lost-partial :: $OUT"
  expect "lost (partial): no history" "$(hist)" "none"

  # 4. Stage B mismatch: drift injected between Stage A and Stage B -> no history
  local drift
  for drift in \
    "grant select on public.common_accounts to anon" \
    "create policy stale_allow_all on public.service_entitlements for all to public using (true) with check (true)" \
    "drop index private.account_lifecycle_operations_one_in_progress; create index account_lifecycle_operations_one_in_progress on private.account_lifecycle_operations (user_id)" \
    "alter function public.prepare_common_account_auth_delete(uuid,uuid) security invoker" \
    "grant execute on function public.begin_common_account_deletion(uuid,bigint) to authenticated" \
    "create function public.begin_service_deletion(p_user_id uuid) returns jsonb language sql as 'select null::jsonb'" \
    "alter table private.account_lifecycle_settings drop constraint account_lifecycle_settings_auth_delete_guard_check" \
    "alter table public.common_accounts disable trigger account_lifecycle_guard_account_delete" \
    "update private.account_lifecycle_settings set integration_state = 'started'" \
    "insert into private.account_lifecycle_managed_checkpoints values ('extra_cleanup', 'always')" \
    "grant select on public.profiles to kb_cal_unrelated" \
    "create or replace function public.social_mobile_account_deletion_subject(p_user_id uuid) returns text language sql as 'select null::text'"; do
    fresh "stage_b_$RANDOM"
    PROOF_ENV=(CAL_ROLLOUT_TEST_AFTER_STAGE_A_SQL="$drift"); run apply
    expect "Stage B mismatch STOP 13: ${drift:0:60}" "$RC" "13"
    expect "Stage B mismatch wrote no history: ${drift:0:40}" "$(hist)" "none"
  done
  fresh invalid_index
  run apply >/dev/null
  "${as_super[@]}" -d "$db" -c "update pg_index set indisvalid = false where indexrelid = 'private.account_lifecycle_operations_one_in_progress'::regclass" >/dev/null
  run status
  expect "Stage B detects an invalid index" "$(head -1 <<<"$OUT")" "STATE schema=UNSAFE history=EXACT"
  run apply; expect "invalid index after completion: STOP 10" "$RC" "10"

  # 5. Stage C history insert fails: schema stays exact, no retry, STOP; later explicit resume works
  fresh history_fail
  "${as_super[@]}" -d "$db" -c "alter table supabase_migrations.schema_migrations owner to $super; grant usage on schema supabase_migrations to $owner; grant select on supabase_migrations.schema_migrations to $owner" >/dev/null
  run apply
  expect "history failure: STOP 14" "$RC" "14"
  grep -q "schema=EXACT history=NONE" <<<"$OUT" && ok "history failure: schema exact, history missing" || bad "history-fail :: $OUT"
  expect "history failure: objects kept (no automatic drop)" "$(table_present)" "true"
  expect "history failure: no history" "$(hist)" "none"
  run apply; expect "history failure: plain rerun still STOP 14 (no automatic retry)" "$RC" "14"
  "${as_super[@]}" -d "$db" -c "grant insert on supabase_migrations.schema_migrations to $owner" >/dev/null
  run apply --resume-history; expect "history failure: explicit resume after review completes" "$RC" "0"
  expect "history failure: exactly one history row after resume" "$(hist)" "$VERSION:$NAME"

  # 7. mismatching starting states always STOP before anything is written
  fresh wrong_name
  q "insert into supabase_migrations.schema_migrations (version, name) values ('$VERSION', 'something_else')" >/dev/null
  run apply; expect "wrong history name: STOP 10" "$RC" "10"; expect "wrong history name: nothing created" "$(objects)" "0/0"
  fresh wrong_version
  q "insert into supabase_migrations.schema_migrations (version, name) values ('20261001150001', '$NAME')" >/dev/null
  run apply; expect "same name under another version: STOP 10" "$RC" "10"; expect "wrong history version: nothing created" "$(objects)" "0/0"
  fresh history_without_schema
  q "insert into supabase_migrations.schema_migrations (version, name) values ('$VERSION', '$NAME')" >/dev/null
  run apply; expect "history without schema: STOP 10" "$RC" "10"; expect "history without schema: nothing created" "$(objects)" "0/0"
  fresh stray_object
  q "create function public.withdraw_kabumori_service() returns jsonb language sql as 'select null::jsonb'" >/dev/null
  run apply; expect "stray object under a target name: STOP 10" "$RC" "10"
  expect "stray object: nothing else created" "$(table_present)" "false"
  fresh drift_after_complete
  run apply >/dev/null
  q "grant select on public.common_accounts to anon" >/dev/null
  run apply; expect "drifted object with exact history: STOP 10" "$RC" "10"
  expect "drifted object with exact history: history untouched" "$(hist)" "$VERSION:$NAME"
  fresh resume_misuse
  run apply --resume-history; expect "--resume-history on an empty database: STOP 10" "$RC" "10"; expect "--resume-history misuse: nothing created" "$(objects)" "0/0"
  fresh bad_bytes
  local altered="${TMPDIR:-/tmp}/cal_altered.$$"
  mkdir -p "$altered/tests" "$altered/migrations"; cp "$0" "$altered/tests/"
  sed 's/^-- Common account v1, Phase 1/--  Common account v1, Phase 1/' "$MIGRATION" > "$altered/migrations/${VERSION}_${NAME}.sql"
  set +e; OUT="$(env CAL_ROLLOUT_TARGET=local PGHOST="$host" PGPORT="$port" PGUSER="$owner" PGDATABASE="$db" CAL_EXPECTED_OWNER="$owner" bash "$altered/tests/$(basename "$0")" apply 2>&1)"; RC=$?; set -e
  rm -rf "$altered"
  expect "migration bytes differ from accepted SHA: STOP 10" "$RC" "10"; expect "altered bytes: nothing applied" "$(objects)" "0/0"

  # 8. guards: production is refused before any connection unless every switch is present
  local -a prod=(CAL_ROLLOUT_TARGET=production PGHOST=db.abcdefghijklmnopqrst.supabase.invalid PGUSER=postgres PGDATABASE=postgres
                 CAL_EXPECTED_OWNER=postgres PGSSLMODE=require CAL_ROLLOUT_PROJECT_REF=abcdefghijklmnopqrst PGCONNECT_TIMEOUT=1)
  guard() {  # label, extra env... -> must exit 2 with REFUSED and must not try to connect
    local label="$1"; shift
    set +e; OUT="$(env -u PGPASSWORD "${prod[@]}" "$@" bash "$0" apply 2>&1)"; RC=$?; set -e
    [[ "$RC" == 2 && "$OUT" == *REFUSED* && "$OUT" != *"could not"* ]] && ok "guard refuses production: $label" || bad "guard $label :: rc=$RC $OUT"
  }
  guard "no acknowledgement"
  guard "wrong acknowledgement" CAL_ROLLOUT_ACK="yes"
  guard "project ref missing" CAL_ROLLOUT_ACK="$PROD_ACK" CAL_ROLLOUT_PROJECT_REF=
  guard "host not in project" CAL_ROLLOUT_ACK="$PROD_ACK" CAL_ROLLOUT_PROJECT_REF=zyxwvutsrqponmlkjihg
  guard "socket host" CAL_ROLLOUT_ACK="$PROD_ACK" PGHOST=/tmp/abcdefghijklmnopqrst
  guard "no TLS" CAL_ROLLOUT_ACK="$PROD_ACK" PGSSLMODE=prefer
  guard "owner not postgres" CAL_ROLLOUT_ACK="$PROD_ACK" PGUSER=other CAL_EXPECTED_OWNER=other
  guard "test hook set" CAL_ROLLOUT_ACK="$PROD_ACK" CAL_ROLLOUT_TEST_STAGE_A=lost-before-apply
  guard "substitute migration set" CAL_ROLLOUT_ACK="$PROD_ACK" CAL_ROLLOUT_TEST_MIGRATION=/tmp/x.sql
  guard "lock timeout override set" CAL_ROLLOUT_ACK="$PROD_ACK" CAL_ROLLOUT_TEST_LOCK_TIMEOUT=60s
  guard "transaction pooler port" CAL_ROLLOUT_ACK="$PROD_ACK" PGPORT=6543
  guard "pooler user of another project" CAL_ROLLOUT_ACK="$PROD_ACK" PGUSER=postgres.zyxwvutsrqponmlkjihg
  # every switch correct (session-pooler user shape): guards pass, then the identity check runs before any write.
  # The host is a reserved .invalid name, so the connection cannot succeed and nothing can be written.
  set +e; OUT="$(env -u PGPASSWORD "${prod[@]}" CAL_ROLLOUT_ACK="$PROD_ACK" PGUSER=postgres.abcdefghijklmnopqrst bash "$0" apply 2>&1)"; RC=$?; set -e
  [[ "$RC" == 10 && "$OUT" == *"cannot connect or read the session identity"* && "$OUT" != *REFUSED* ]] \
    && ok "guard: a fully switched production target passes the guards and stops at the identity check" || bad "identity :: rc=$RC $OUT"
  set +e; OUT="$(env CAL_ROLLOUT_TARGET=local PGHOST=db.example.invalid PGUSER=x PGDATABASE=x CAL_EXPECTED_OWNER=x bash "$0" status 2>&1)"; RC=$?; set -e
  [[ "$RC" == 2 && "$OUT" == *REFUSED* ]] && ok "guard: a non-socket host is refused for the default local target" || bad "local guard :: $OUT"

  say "ALL COMMON ACCOUNT LIFECYCLE ROLLOUT CHECKS PASSED ($pass)"
}

case "${1:-}" in
  status) cmd_status ;;
  apply) shift; cmd_apply "${1:-}" ;;
  proof) cmd_proof ;;
  print-sections)  # local only: prints the catalog sections of the target (used to pin EXPECTED_SECTIONS)
    guard_target; [[ "${CAL_ROLLOUT_TARGET:-local}" == local ]] || refuse "print-sections is local only"
    descriptor_sql | psql_q -f - ;;
  *) say "usage: $0 status | apply [--resume-history] | proof"; exit 2 ;;
esac
