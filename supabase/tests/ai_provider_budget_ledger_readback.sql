-- AI provider budget ledger (migration 20261010050613): READ-ONLY read-back after the apply (Phase 1c runbook).
--
-- One SELECT over the catalogs plus row COUNTS of the ledger tables (no row content, no personal data, no secret).
-- Every value under "must_be_true" must be true. The migration's own postcondition already refused anything else at
-- commit time; this confirms that the commit happened and that nothing drifted since.
--
--   supabase db query --linked --project-ref <ref> -o json -f supabase/tests/ai_provider_budget_ledger_readback.sql
with rpc as (
  select p.oid, p.proname, p.prosecdef, p.proconfig, p.proowner
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname like 'ai\_ledger\_%'
),
ledger_rel as (
  select c.oid, c.relname, c.relkind, c.relrowsecurity, c.relowner, c.relacl
    from pg_class c where c.relnamespace = to_regnamespace('ai_ledger') and c.relkind in ('r', 'S', 'v', 'm')
),
helper as (
  select p.oid, p.prosecdef, p.proowner from pg_proc p where p.pronamespace = to_regnamespace('ai_ledger')
),
app(rolname) as (values ('anon'), ('authenticated'), ('service_role'))
select jsonb_build_object(
  'checked_at_jst', to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI:SS'),
  'must_be_true', jsonb_build_object(
    'schema_present', to_regnamespace('ai_ledger') is not null,
    'seven_rpcs', (select count(*) from rpc) = 7,
    'five_tables', (select count(*) from ledger_rel where relkind = 'r') = 5,
    'one_owner', (select count(distinct o) from (
                    select relowner o from ledger_rel union all select proowner from helper union all select proowner from rpc
                    union all select nspowner from pg_namespace where oid = to_regnamespace('ai_ledger')) owners) = 1,
    'rpcs_security_definer_empty_search_path', not exists (select 1 from rpc where not (prosecdef and proconfig = array['search_path=""'])),
    'helpers_not_security_definer', not exists (select 1 from helper where prosecdef),
    'rls_on_every_table', not exists (select 1 from ledger_rel where relkind = 'r' and not relrowsecurity),
    'no_policies', not exists (select 1 from pg_policy pol join ledger_rel r on r.oid = pol.polrelid),
    'no_direct_relation_grants', not exists (select 1 from ledger_rel r cross join lateral aclexplode(r.relacl) a where a.grantee <> r.relowner),
    'service_role_executes_rpcs', not exists (select 1 from rpc where not has_function_privilege('service_role', rpc.oid, 'EXECUTE')),
    'anon_authenticated_cannot_execute_rpcs', not exists (select 1 from rpc, app where app.rolname <> 'service_role'
                                                           and has_function_privilege(app.rolname, rpc.oid, 'EXECUTE')),
    'no_rpc_grant_option', not exists (select 1 from rpc, app where has_function_privilege(app.rolname, rpc.oid, 'EXECUTE WITH GRANT OPTION')),
    'app_roles_no_schema_access', not exists (select 1 from app where has_schema_privilege(app.rolname, 'ai_ledger', 'USAGE')
                                                               or has_schema_privilege(app.rolname, 'ai_ledger', 'CREATE')),
    'app_roles_no_table_access', not exists (select 1 from ledger_rel r, app, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) x(p)
                                              where r.relkind = 'r' and has_table_privilege(app.rolname, r.oid, x.p)),
    'app_roles_no_helper_execute', not exists (select 1 from helper, app where has_function_privilege(app.rolname, helper.oid, 'EXECUTE')),
    'reject_change_triggers', (select count(*) from pg_trigger t join ledger_rel r on r.oid = t.tgrelid
                                where not t.tgisinternal and t.tgfoid = 'ai_ledger.reject_change()'::regprocedure) = 6,
    'reservation_transition_trigger', exists (select 1 from pg_trigger t
                                               where t.tgrelid = 'ai_ledger.reservations'::regclass and not t.tgisinternal
                                                 and t.tgfoid = 'ai_ledger.reservation_transition()'::regprocedure)),
  'rows', jsonb_build_object(
    'budget_policies', (select count(*) from ai_ledger.budget_policies),
    'budget_policies_enabled', (select count(*) from ai_ledger.budget_policies where enabled),
    'budget_buckets', (select count(*) from ai_ledger.budget_buckets),
    'reservations', (select count(*) from ai_ledger.reservations),
    'usage_events', (select count(*) from ai_ledger.usage_events),
    'billing_observations', (select count(*) from ai_ledger.billing_observations)),
  'history_row', case when to_regclass('supabase_migrations.schema_migrations') is null then null
                      else (select count(*) from supabase_migrations.schema_migrations where version = '20261010050613') end
) as result;
