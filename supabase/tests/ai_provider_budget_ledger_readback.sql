-- AI provider budget ledger (migration 20261010050613): READ-ONLY read-back after the apply (Phase 1c, extended in 1d).
--
-- One SELECT over the catalogs, the ledger's policy rows (configuration, not personal data) and row COUNTS of the
-- other ledger tables (no row content, no secret). Every value under "must_be_true" must be true. The migration's
-- own postcondition already refused anything else at commit time; this confirms that the commit happened, that the
-- exact objects exist and that nothing drifted since. Only meaningful once the schema exists (before the apply,
-- use the preflight). The effect on existing business objects is judged separately by comparing
-- ai_provider_budget_ledger_existing_fingerprint.sql before and after.
--
--   supabase db query --linked --project-ref <ref> -o json -f supabase/tests/ai_provider_budget_ledger_readback.sql
--   (or through supabase/tests/ai_provider_budget_ledger_rollout.sh status, which also judges it)
with rpc as (
  select p.oid, p.proname, p.prosecdef, p.proconfig, p.proowner,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') -> ' || format_type(p.prorettype, null) as sig
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
app(rolname) as (values ('anon'), ('authenticated'), ('service_role')),
expected_rpc(sig) as (values
  ('ai_ledger_budget_status(p jsonb) -> jsonb'), ('ai_ledger_mark_sent(p jsonb) -> jsonb'),
  ('ai_ledger_recover_stale(p jsonb) -> jsonb'), ('ai_ledger_release(p jsonb) -> jsonb'),
  ('ai_ledger_reserve(p jsonb) -> jsonb'), ('ai_ledger_settle(p jsonb) -> jsonb'),
  ('ai_ledger_usage_summary(p jsonb) -> jsonb')),
expected_table(relname) as (values
  ('billing_observations'), ('budget_buckets'), ('budget_policies'), ('reservations'), ('usage_events'))
select jsonb_build_object(
  'checked_at_jst', to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI:SS'),
  'must_be_true', jsonb_build_object(
    'schema_present', to_regnamespace('ai_ledger') is not null,
    'exact_seven_rpcs', (select array_agg(sig order by sig) from rpc) = (select array_agg(sig order by sig) from expected_rpc),
    'exact_five_tables', (select array_agg(relname::text order by relname) from ledger_rel where relkind = 'r')
                         = (select array_agg(relname order by relname) from expected_table),
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
    'open_reserved', (select count(*) from ai_ledger.reservations where status = 'reserved'),
    'open_sent', (select count(*) from ai_ledger.reservations where status = 'sent'),
    'usage_events', (select count(*) from ai_ledger.usage_events),
    'billing_observations', (select count(*) from ai_ledger.billing_observations)),
  -- Configuration rows only (keys, scopes, caps). Never user / brand ids of calls.
  'policies', (select coalesce(jsonb_agg(jsonb_build_object(
                 'policy_key', b.policy_key, 'provider', b.scope_provider, 'model', b.scope_model,
                 'application', b.scope_application, 'feature', b.scope_feature, 'logical_role', b.scope_logical_role,
                 'subject_kind', b.scope_subject_kind, 'brand_scoped', b.scope_brand_id is not null,
                 'user_scoped', b.scope_user_id is not null, 'per_brand', b.per_brand, 'per_user', b.per_user,
                 'period', b.period, 'max_estimated_usd', b.max_estimated_usd, 'max_calls', b.max_calls,
                 'max_usd_per_call', b.max_usd_per_call, 'enabled', b.enabled) order by b.policy_key), '[]'::jsonb)
                 from ai_ledger.budget_policies b),
  'history_row', (select count(*) from supabase_migrations.schema_migrations where version = '20261010050613')
) as result;
