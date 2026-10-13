-- READ-ONLY release preflight probe for the common-account chain (F5 Phase 7). SOURCE ONLY.
--
-- Run it ONLY against a DISPOSABLE database (local PostgreSQL, or a disposable managed project an approved operator
-- created for this purpose); NEVER against production. It writes nothing: one read-only transaction, one SELECT,
-- no function call that has a side effect. Its output is one line per check:
--
--     <id>|<status>|<detail>            status in PASS | FAIL | WARN | INFO | STOP
--     RELEASE_PREFLIGHT|<PASS|FAIL>|fail=<n> warn=<n> stop=<n>
--
-- The release gate is the LAST line: anything other than `PASS` with fail=0 stop=0 is a STOP. WARN rows are things a
-- read-only SQL session cannot decide (managed-only objects absent, GoTrue settings): they are answered by the manual
-- checklist in docs/common-account/phase7-release-preflight.md, never assumed.
--
-- Disposable gate (a plain accident cannot pass it): the operator must have created the marker table
--     create table public.kabumori_disposable_marker (project_ref text primary key, created_at timestamptz default now());
-- in the disposable database AND must start the session with   PGOPTIONS='-c kabumori.disposable_probe=yes'.
-- Without both, the probe prints one STOP line and nothing else.
--
-- Usage:   PGOPTIONS='-c kabumori.disposable_probe=yes' psql -X -A -t -v ON_ERROR_STOP=1 -f \
--            supabase/preflight/common_account_release_probe.sql "<connection string of the DISPOSABLE database>"
--
-- Expected inventory: the 76 functions, 7 relations, 11 triggers and 2 policies the chain creates (Phase 1, 2, 3a,
-- 3b, 4, 5, 6, 8), reviewed by hand from a clean apply on PostgreSQL 17 (docs/common-account/phase7-release-preflight.md
-- section 3). A function that is not in the list, or whose security attributes differ, is a FAIL.
begin read only;
set local search_path = pg_catalog;
set local statement_timeout = '30s';
set local lock_timeout = '2s';

with
gate as (
  select coalesce(current_setting('kabumori.disposable_probe', true) = 'yes', false) as setting_ok,
         pg_catalog.to_regclass('public.kabumori_disposable_marker') is not null as marker_ok
),
owner_role as (
  select c.relowner as oid, pg_get_userbyid(c.relowner) as name
    from pg_class c where c.oid = pg_catalog.to_regclass('public.common_accounts')
),
exp_fn(sig, sec, cfg, roles, vol, ret) as (values
    ('private.account_lifecycle_abort_service_deletion(uuid,text,uuid)', 'definer', 'search_path=""', '', 'v', 'jsonb'),
    ('private.account_lifecycle_account_changed()', 'definer', 'search_path=""', '', 'v', 'trigger'),
    ('private.account_lifecycle_active_answer(uuid,text,boolean)', 'definer', 'search_path=""', '', 's', 'jsonb'),
    ('private.account_lifecycle_assert_active_service_write(uuid,text)', 'definer', 'search_path=""', '', 'v', 'void'),
    ('private.account_lifecycle_assert_brand_service_active(text,text)', 'definer', 'search_path=""', '', 'v', 'void'),
    ('private.account_lifecycle_authorization_problems(uuid,uuid)', 'definer', 'search_path=""', '', 'v', 'text[]'),
    ('private.account_lifecycle_backfill(boolean)', 'definer', 'search_path=""', '', 'v', 'jsonb'),
    ('private.account_lifecycle_brand_owner(text)', 'definer', 'search_path=""', '', 's', 'uuid'),
    ('private.account_lifecycle_builtin_checkpoints()', 'definer', 'search_path=""', '', 'i', 'record'),
    ('private.account_lifecycle_cleanup_authorized(uuid)', 'definer', 'search_path=""', '', 's', 'boolean'),
    ('private.account_lifecycle_deletion_blockers(uuid,text)', 'definer', 'search_path=""', '', 'v', 'text[]'),
    ('private.account_lifecycle_finish_service_deletion(uuid,text,uuid)', 'definer', 'search_path=""', '', 'v', 'jsonb'),
    ('private.account_lifecycle_footprint(uuid)', 'definer', 'search_path=""', '', 'v', 'jsonb'),
    ('private.account_lifecycle_gate_open(text)', 'definer', 'search_path=""', '', 's', 'boolean'),
    ('private.account_lifecycle_guard_account_delete()', 'definer', 'search_path=""', '', 'v', 'trigger'),
    ('private.account_lifecycle_guard_checkpoint_registry()', 'definer', 'search_path=""', '', 'v', 'trigger'),
    ('private.account_lifecycle_guard_entitlement_identity()', 'definer', 'search_path=""', '', 'v', 'trigger'),
    ('private.account_lifecycle_invalidate_readiness(uuid,text)', 'definer', 'search_path=""', '', 'v', 'void'),
    ('private.account_lifecycle_lock(uuid,boolean,boolean)', 'definer', 'search_path=""', '', 'v', 'public.common_accounts'),
    ('private.account_lifecycle_managed_ownership(uuid)', 'definer', 'search_path=""', '', 'v', 'text[]'),
    ('private.account_lifecycle_owned_operation(uuid,uuid,uuid)', 'definer', 'search_path=""', '', 'v', 'private.account_lifecycle_operations'),
    ('private.account_lifecycle_owned_service_operation(uuid,text,uuid,uuid)', 'definer', 'search_path=""', '', 'v', 'private.account_lifecycle_operations'),
    ('private.account_lifecycle_reactivate_service(uuid,text,bigint)', 'definer', 'search_path=""', '', 'v', 'jsonb'),
    ('private.account_lifecycle_readiness_refusal(uuid,jsonb)', 'definer', 'search_path=""', '', 'v', 'jsonb'),
    ('private.account_lifecycle_required_checkpoints(uuid)', 'definer', 'search_path=""', '', 'v', 'text[]'),
    ('private.account_lifecycle_requirements_changed()', 'definer', 'search_path=""', '', 'v', 'trigger'),
    ('private.account_lifecycle_requirements_valid()', 'definer', 'search_path=""', '', 'v', 'boolean'),
    ('private.account_lifecycle_residue(uuid)', 'definer', 'search_path=""', '', 'v', 'text'),
    ('private.account_lifecycle_service_insert_fence()', 'definer', 'search_path=""', '', 'v', 'trigger'),
    ('private.account_lifecycle_service_refusal(text)', 'definer', 'search_path=""', '', 'i', 'jsonb'),
    ('private.account_lifecycle_service_state_readonly(uuid,text)', 'definer', 'search_path=""', '', 's', 'text'),
    ('private.account_lifecycle_service_state_refusal(uuid,text)', 'definer', 'lock_timeout=3s;search_path=""', '', 'v', 'text'),
    ('private.account_lifecycle_settings_changed()', 'definer', 'search_path=""', '', 'v', 'trigger'),
    ('private.account_lifecycle_start_service(uuid,text)', 'definer', 'search_path=""', '', 'v', 'jsonb'),
    ('private.account_lifecycle_storage_inventory(uuid,integer)', 'definer', 'search_path=""', '', 'v', 'jsonb'),
    ('private.account_lifecycle_touch_account()', 'definer', 'search_path=""', '', 'v', 'trigger'),
    ('private.account_lifecycle_touch_entitlement()', 'definer', 'search_path=""', '', 'v', 'trigger'),
    ('private.account_lifecycle_touch_settings()', 'definer', 'search_path=""', '', 'v', 'trigger'),
    ('public.abort_common_account_deletion(uuid,uuid)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.abort_owned_service_deletion(uuid,text,uuid,uuid)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.abort_service_deletion(uuid,text,uuid)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.acknowledge_owned_remote_unverified(uuid,text,uuid,uuid,text[])', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.begin_common_account_deletion(uuid,bigint)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.begin_common_account_deletion_external_step(uuid,uuid,uuid,text)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.begin_service_deletion(uuid,text)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.claim_common_account_deletion(uuid,uuid,integer)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.claim_service_deletion(uuid,text,uuid,uuid,uuid,integer)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.clear_common_account_deletion_checkpoint(uuid,uuid,text)', 'definer', 'search_path=""', '', 'v', 'jsonb'),
    ('public.common_account_brand_service_state(text,text)', 'definer', 'search_path=""', 'service_role', 's', 'text'),
    ('public.common_account_deletion_eligibility(uuid)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.common_account_deletion_release_gate()', 'definer', 'search_path=""', 'service_role', 's', 'jsonb'),
    ('public.common_account_deletion_storage_objects(uuid,integer)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.common_account_provider_snapshot(uuid)', 'definer', 'search_path=""', 'service_role', 's', 'jsonb'),
    ('public.complete_common_account_deletion(uuid,uuid)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.ensure_my_profile()', 'definer', 'search_path=""', 'authenticated', 'v', 'uuid'),
    ('public.finish_owned_service_deletion(uuid,text,uuid,uuid)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.finish_service_deletion(uuid,text,uuid)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.prepare_common_account_auth_delete(uuid,uuid)', 'definer', 'search_path=""', '', 'v', 'jsonb'),
    ('public.prepare_owned_common_account_auth_delete(uuid,uuid,uuid)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.reactivate_kabumori_service(bigint)', 'definer', 'search_path=""', 'authenticated', 'v', 'jsonb'),
    ('public.reactivate_x_autopost_service(bigint)', 'definer', 'search_path=""', 'authenticated', 'v', 'jsonb'),
    ('public.record_common_account_deletion_checkpoint(uuid,uuid,text)', 'definer', 'search_path=""', '', 'v', 'jsonb'),
    ('public.record_common_account_deletion_error(uuid,uuid,text)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.record_owned_service_deletion_provider_result(uuid,text,uuid,uuid,text,text)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.record_owned_service_deletion_reconciliation(uuid,text,uuid,uuid,text,integer)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.common_account_service_end_result(uuid,text)', 'definer', 'search_path=""', 'service_role', 's', 'jsonb'),
    ('public.release_common_account_deletion_claim(uuid,uuid,uuid)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.release_service_deletion_claim(uuid,text,uuid,uuid)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.renew_common_account_deletion_claim(uuid,uuid,uuid,integer)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.renew_service_deletion_claim(uuid,text,uuid,uuid,integer)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.resolve_common_account_deletion_external_step(uuid,uuid,text)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.set_owned_common_account_deletion_checkpoint(uuid,uuid,uuid,text,boolean)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.settle_common_account_deletion_external_step(uuid,uuid,uuid,text,text)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb'),
    ('public.start_kabumori_service()', 'definer', 'search_path=""', 'authenticated', 'v', 'jsonb'),
    ('public.start_x_autopost_service()', 'definer', 'search_path=""', 'authenticated', 'v', 'jsonb'),
    ('public.withdraw_kabumori_service(uuid)', 'definer', 'search_path=""', 'service_role', 'v', 'jsonb')
),
cat_fn as (
  select n.nspname || '.' || p.proname || '(' || array_to_string(p.proargtypes::regtype[], ',') || ')' as sig,
         case when p.prosecdef then 'definer' else 'invoker' end as sec,
         coalesce((select string_agg(c, ';' order by c) from unnest(p.proconfig) c), '') as cfg,
         coalesce((select string_agg(r.rolname, ',' order by r.rolname) from pg_roles r
                    where r.rolname in ('anon', 'authenticated', 'service_role')
                      and has_function_privilege(r.oid, p.oid, 'EXECUTE')), '') as roles,
         has_function_privilege('public', p.oid, 'EXECUTE') as public_exec,
         p.provolatile::text as vol,
         p.prorettype::regtype::text as ret,
         p.proowner as owner_oid,
         n.nspname, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.prokind in ('f', 'p')
),
exp_rel(rel, kind, cols_auth, policies) as (values
  ('private.account_lifecycle_backfill_plan', 'v', '', 0),
  ('private.account_lifecycle_managed_checkpoints', 'r', '', 0),
  ('private.account_lifecycle_operations', 'r', '', 0),
  ('private.account_lifecycle_release_gates', 'r', '', 0),
  ('private.account_lifecycle_settings', 'r', '', 0),
  ('public.common_accounts', 'r', 'created_at,lifecycle_version,status,updated_at,user_id', 1),
  ('public.service_entitlements', 'r', 'activated_at,ended_at,service_key,status,updated_at,user_id', 1)
),
cat_rel as (
  select n.nspname || '.' || c.relname as rel, c.relkind::text as kind, c.relrowsecurity as rls, c.relforcerowsecurity as force_rls,
         c.relowner as owner_oid,
         -- any table-level privilege held by an API role or PUBLIC (grantee 0)
         (select count(*) from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
           where a.grantee = 0 or a.grantee in (select r.oid from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role'))) as api_table_grants,
         coalesce((select string_agg(a.attname, ',' order by a.attname) from pg_attribute a
                    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                      and exists (select 1 from aclexplode(a.attacl) x where x.grantee = (select oid from pg_roles where rolname = 'authenticated') and x.privilege_type = 'SELECT')), '') as cols_auth,
         coalesce((select string_agg(distinct pg_get_userbyid(x.grantee) || ':' || x.privilege_type, ',') from pg_attribute a
                    cross join lateral aclexplode(a.attacl) x
                    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                      and not (x.grantee = (select oid from pg_roles where rolname = 'authenticated') and x.privilege_type = 'SELECT')
                      and x.grantee <> c.relowner), '') as other_col_grants,
         (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private') and c.relkind in ('r', 'v', 'm', 'p')
),
exp_trg(rel, name, fn) as (values
  ('private.account_lifecycle_managed_checkpoints', 'account_lifecycle_guard_checkpoint_registry', 'private.account_lifecycle_guard_checkpoint_registry'),
  ('private.account_lifecycle_managed_checkpoints', 'account_lifecycle_guard_checkpoint_registry_truncate', 'private.account_lifecycle_guard_checkpoint_registry'),
  ('private.account_lifecycle_managed_checkpoints', 'account_lifecycle_requirements_changed', 'private.account_lifecycle_requirements_changed'),
  ('private.account_lifecycle_settings', 'account_lifecycle_settings_changed', 'private.account_lifecycle_settings_changed'),
  ('private.account_lifecycle_settings', 'account_lifecycle_touch_settings', 'private.account_lifecycle_touch_settings'),
  ('public.common_accounts', 'account_lifecycle_account_changed', 'private.account_lifecycle_account_changed'),
  ('public.common_accounts', 'account_lifecycle_guard_account_delete', 'private.account_lifecycle_guard_account_delete'),
  ('public.common_accounts', 'account_lifecycle_touch_account', 'private.account_lifecycle_touch_account'),
  ('public.profiles', 'account_lifecycle_profile_root_fence', 'private.account_lifecycle_service_insert_fence'),
  ('public.service_entitlements', 'account_lifecycle_guard_entitlement_identity', 'private.account_lifecycle_guard_entitlement_identity'),
  ('public.service_entitlements', 'account_lifecycle_touch_entitlement', 'private.account_lifecycle_touch_entitlement')
),
cat_trg as (
  select (select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = t.tgrelid) as rel,
         t.tgname as name,
         (select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.oid = t.tgfoid) as fn,
         t.tgenabled::text as enabled
    from pg_trigger t where not t.tgisinternal
),
markers(phase, ord, fn) as (values
  ('P1', 1, 'public.start_kabumori_service()'),
  ('P2', 2, 'public.reactivate_kabumori_service(bigint)'),
  ('P3a', 3, 'public.claim_common_account_deletion(uuid,uuid,integer)'),
  ('P3b', 4, 'private.account_lifecycle_assert_active_service_write(uuid,text)'),
  ('P4', 5, 'private.account_lifecycle_service_state_refusal(uuid,text)'),
  ('P5', 6, 'public.common_account_brand_service_state(text,text)'),
  ('P6', 7, 'public.claim_service_deletion(uuid,text,uuid,uuid,uuid,integer)'),
  ('P8', 8, 'public.common_account_service_end_result(uuid,text)')
),
phase_state as (
  select m.phase, m.ord, exists (select 1 from cat_fn f where f.sig = m.fn) as present from markers m
),
chain_versions(ord, version) as (values
  (1, '20261001150000'), (2, '20261006230000'), (3, '20261009120000'), (4, '20261010051938'),
  (5, '20261012130000'), (6, '20261012230000'), (7, '20261013120000'), (8, '20261013140000')
),
ledger as (
  select pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null as present
),
-- Values read from relations that may not exist yet (the chain not applied) or never exist locally (the managed
-- ledger): each is fetched by a guarded dynamic query, so an absent relation is a FAIL / WARN line, never an error.
dyn as (
  select
    case when pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null then
      coalesce((xpath('/row/v/text()', query_to_xml($q$select coalesce(string_agg(version::text, ',' order by version::text), '') as v
                                                          from supabase_migrations.schema_migrations$q$, true, true, '')))[1]::text, '')
    end as ledger_versions,
    case when pg_catalog.to_regclass('private.account_lifecycle_release_gates') is not null then
      (xpath('/row/n/text()', query_to_xml($q$select count(*) as n from private.account_lifecycle_release_gates
                                               where gate = 'managed_auth_delete' and state = 'blocked'$q$, true, true, '')))[1]::text::int
    end as gate_blocked,
    case when pg_catalog.to_regclass('private.account_lifecycle_release_gates') is not null then
      (xpath('/row/n/text()', query_to_xml($q$select count(*) as n from private.account_lifecycle_release_gates$q$, true, true, '')))[1]::text::int
    end as gate_rows,
    case when pg_catalog.to_regclass('private.account_lifecycle_settings') is not null then
      (xpath('/row/n/text()', query_to_xml($q$select count(*) as n from private.account_lifecycle_settings
                                               where auth_delete_guard = 'shadow' and integration_state = 'not_started'$q$, true, true, '')))[1]::text::int
    end as settings_affirmed,
    case when pg_catalog.to_regclass('private.account_lifecycle_settings') is not null then
      (xpath('/row/n/text()', query_to_xml($q$select count(*) as n from private.account_lifecycle_settings$q$, true, true, '')))[1]::text::int
    end as settings_rows,
    case when pg_catalog.to_regclass('private.account_lifecycle_managed_checkpoints') is not null then
      (xpath('/row/n/text()', query_to_xml($q$select count(*) as n from private.account_lifecycle_managed_checkpoints$q$, true, true, '')))[1]::text::int
    end as checkpoint_rows,
    case when pg_catalog.to_regclass('private.account_lifecycle_managed_checkpoints') is not null then
      (xpath('/row/n/text()', query_to_xml($q$select count(*) as n from private.account_lifecycle_managed_checkpoints
                                               where (checkpoint_key, requirement) in (('apple_revocation', 'apple_identity'),
                                                     ('session_revocation', 'always'), ('storage_cleanup', 'always'))$q$, true, true, '')))[1]::text::int
    end as checkpoint_exact,
    case when pg_catalog.to_regclass('public.common_accounts') is not null then
      (xpath('/row/n/text()', query_to_xml($q$select count(*) as n from public.common_accounts$q$, true, true, '')))[1]::text
    end as accounts,
    case when pg_catalog.to_regclass('public.service_entitlements') is not null then
      (xpath('/row/n/text()', query_to_xml($q$select count(*) as n from public.service_entitlements$q$, true, true, '')))[1]::text
    end as entitlements,
    case when pg_catalog.to_regclass('private.account_lifecycle_operations') is not null then
      (xpath('/row/n/text()', query_to_xml($q$select count(*) as n from private.account_lifecycle_operations where status = 'in_progress'$q$, true, true, '')))[1]::text
    end as operations_in_progress
),
checks(ord, id, status, detail) as (
  -- ---- A. chain order -------------------------------------------------------------------------------------
  select 100, 'A1_phase_prefix',
         case when (select count(*) from phase_state s where s.present and exists
                     (select 1 from phase_state p where p.ord < s.ord and not p.present)) = 0 then 'PASS' else 'FAIL' end,
         'present: ' || coalesce((select string_agg(phase, ',' order by ord) from phase_state where present), '-')
         || '; missing before a present phase: '
         || coalesce((select string_agg(distinct p.phase, ',') from phase_state p
                       where not p.present and exists (select 1 from phase_state s where s.present and s.ord > p.ord)), '-')
  union all
  select 101, 'A2_phase_all_present',
         case when (select count(*) from phase_state where not present) = 0 then 'PASS' else 'FAIL' end,
         'absent: ' || coalesce((select string_agg(phase, ',' order by ord) from phase_state where not present), '-')
  union all
  select 102, 'A3_ledger',
         case when (select ledger_versions from dyn) is null then 'WARN'
              when (select count(*) from chain_versions v
                     where v.version <> all (string_to_array((select ledger_versions from dyn), ','))) = 0 then 'PASS'
              else 'FAIL' end,
         case when (select ledger_versions from dyn) is null then 'migration ledger absent (managed-only): check the ledger by hand'
              else 'chain versions missing from the ledger: '
                   || coalesce((select string_agg(v.version, ',' order by v.ord) from chain_versions v
                                 where v.version <> all (string_to_array((select ledger_versions from dyn), ','))), '-') end
  union all
  select 103, 'A4_ledger_no_gap',
         case when (select ledger_versions from dyn) is null then 'WARN'
              when (select count(*) from chain_versions a
                     where a.version <> all (string_to_array((select ledger_versions from dyn), ','))
                       and exists (select 1 from chain_versions b where b.ord > a.ord
                                    and b.version = any (string_to_array((select ledger_versions from dyn), ',')))) = 0 then 'PASS'
              else 'FAIL' end,
         'a later chain version in the ledger while an earlier one is missing is a gap'
  union all
  -- ---- B. functions ---------------------------------------------------------------------------------------
  select 200, 'B1_functions_present',
         case when (select count(*) from exp_fn e where not exists (select 1 from cat_fn c where c.sig = e.sig)) = 0 then 'PASS' else 'FAIL' end,
         'expected ' || (select count(*) from exp_fn) || '; missing: '
         || coalesce((select string_agg(e.sig, ', ' order by e.sig) from exp_fn e where not exists (select 1 from cat_fn c where c.sig = e.sig)), '-')
  union all
  select 201, 'B2_function_attributes',
         case when (select count(*) from exp_fn e join cat_fn c on c.sig = e.sig
                     where (c.sec, c.cfg, c.roles, c.vol, c.ret) is distinct from (e.sec, e.cfg, e.roles, e.vol, e.ret)) = 0 then 'PASS' else 'FAIL' end,
         'differing: ' || coalesce((select string_agg(e.sig || ' [' || c.sec || '/' || c.cfg || '/exec=' || c.roles || '/' || c.vol || '/' || c.ret || ']', '; ' order by e.sig)
                                    from exp_fn e join cat_fn c on c.sig = e.sig
                                    where (c.sec, c.cfg, c.roles, c.vol, c.ret) is distinct from (e.sec, e.cfg, e.roles, e.vol, e.ret)), '-')
  union all
  select 202, 'B3_function_public_execute',
         case when (select count(*) from exp_fn e join cat_fn c on c.sig = e.sig where c.public_exec) = 0 then 'PASS' else 'FAIL' end,
         'PUBLIC EXECUTE on: ' || coalesce((select string_agg(e.sig, ', ') from exp_fn e join cat_fn c on c.sig = e.sig where c.public_exec), '-')
  union all
  select 203, 'B4_function_unknown',
         case when (select count(*) from cat_fn c
                     where not exists (select 1 from exp_fn e where e.sig = c.sig)
                       and ((c.nspname = 'private' and c.proname like 'account\_lifecycle\_%')
                            or (c.nspname = 'public' and (c.proname like '%common\_account%' or c.proname like '%service\_deletion%'
                                                         or c.proname like 'start\_%\_service' or c.proname like 'reactivate\_%\_service'
                                                         or c.proname like 'withdraw\_%\_service' or c.proname = 'ensure_my_profile')))) = 0
              then 'PASS' else 'FAIL' end,
         'not in the reviewed inventory: ' || coalesce((select string_agg(c.sig, ', ' order by c.sig) from cat_fn c
                     where not exists (select 1 from exp_fn e where e.sig = c.sig)
                       and ((c.nspname = 'private' and c.proname like 'account\_lifecycle\_%')
                            or (c.nspname = 'public' and (c.proname like '%common\_account%' or c.proname like '%service\_deletion%'
                                                         or c.proname like 'start\_%\_service' or c.proname like 'reactivate\_%\_service'
                                                         or c.proname like 'withdraw\_%\_service' or c.proname = 'ensure_my_profile')))), '-')
  union all
  select 204, 'B5_owner_uniform',
         case when (select count(*) from exp_fn e join cat_fn c on c.sig = e.sig where c.owner_oid <> (select oid from owner_role)) = 0
                   and (select oid from owner_role) is not null then 'PASS' else 'FAIL' end,
         'owner of public.common_accounts = ' || coalesce((select name from owner_role), '?')
  union all
  select 205, 'B6_owner_is_not_an_api_role_member',
         case when (select count(*) from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                      and pg_has_role(r.oid, (select oid from owner_role), 'MEMBER')) = 0 then 'PASS' else 'FAIL' end,
         'an API role that is a member of the owner would inherit its privileges'
  union all
  select 206, 'B7_owner_is_superuser',
         'INFO', coalesce((select r.rolsuper::text from pg_roles r where r.oid = (select oid from owner_role)), '?')
  union all
  -- ---- C. relations ---------------------------------------------------------------------------------------
  select 300, 'C1_relations',
         case when (select count(*) from exp_rel e where not exists (select 1 from cat_rel c where c.rel = e.rel and c.kind = e.kind)) = 0 then 'PASS' else 'FAIL' end,
         'missing: ' || coalesce((select string_agg(e.rel, ', ') from exp_rel e where not exists (select 1 from cat_rel c where c.rel = e.rel and c.kind = e.kind)), '-')
  union all
  select 301, 'C2_rls_enabled_on_tables',
         case when (select count(*) from exp_rel e join cat_rel c on c.rel = e.rel where e.kind = 'r' and not c.rls) = 0 then 'PASS' else 'FAIL' end,
         'without RLS: ' || coalesce((select string_agg(e.rel, ', ') from exp_rel e join cat_rel c on c.rel = e.rel where e.kind = 'r' and not c.rls), '-')
  union all
  select 302, 'C3_no_table_level_api_grants',
         case when (select count(*) from exp_rel e join cat_rel c on c.rel = e.rel where c.api_table_grants > 0) = 0 then 'PASS' else 'FAIL' end,
         'table privileges held by an API role or PUBLIC on: ' || coalesce((select string_agg(e.rel, ', ') from exp_rel e join cat_rel c on c.rel = e.rel where c.api_table_grants > 0), '-')
  union all
  select 303, 'C4_authenticated_column_select_exact',
         case when (select count(*) from exp_rel e join cat_rel c on c.rel = e.rel where c.cols_auth is distinct from e.cols_auth or c.other_col_grants <> '') = 0 then 'PASS' else 'FAIL' end,
         'differing: ' || coalesce((select string_agg(e.rel || ' [' || c.cols_auth || '|' || c.other_col_grants || ']', '; ') from exp_rel e join cat_rel c on c.rel = e.rel
                                     where c.cols_auth is distinct from e.cols_auth or c.other_col_grants <> ''), '-')
  union all
  select 304, 'C5_policies_exact',
         case when (select count(*) from exp_rel e join cat_rel c on c.rel = e.rel where c.policies <> e.policies) = 0
                   and (select count(*) from pg_policy p where p.polrelid in (pg_catalog.to_regclass('public.common_accounts'), pg_catalog.to_regclass('public.service_entitlements'))
                          and (p.polcmd <> 'r' or p.polroles <> array[(select oid from pg_roles where rolname = 'authenticated')]
                               or pg_get_expr(p.polqual, p.polrelid) not like '%auth.uid()%user_id%')) = 0 then 'PASS' else 'FAIL' end,
         'one SELECT policy per public table, to authenticated, own rows only (auth.uid() = user_id)'
  union all
  select 305, 'C6_relation_owner_uniform',
         case when (select count(*) from exp_rel e join cat_rel c on c.rel = e.rel where c.owner_oid <> (select oid from owner_role)) = 0 then 'PASS' else 'FAIL' end,
         'all chain relations are owned by the owner of public.common_accounts'
  union all
  -- ---- D. triggers ----------------------------------------------------------------------------------------
  select 400, 'D1_triggers_present_and_enabled',
         case when (select count(*) from exp_trg e where not exists (select 1 from cat_trg c where c.rel = e.rel and c.name = e.name and c.fn = e.fn and c.enabled = 'O')) = 0 then 'PASS' else 'FAIL' end,
         'missing / disabled / different function: ' || coalesce((select string_agg(e.rel || '.' || e.name, ', ') from exp_trg e
                where not exists (select 1 from cat_trg c where c.rel = e.rel and c.name = e.name and c.fn = e.fn and c.enabled = 'O')), '-')
  union all
  select 401, 'D2_no_extra_lifecycle_trigger',
         case when (select count(*) from cat_trg c where c.fn like 'private.account\_lifecycle\_%'
                       and not exists (select 1 from exp_trg e where e.rel = c.rel and e.name = c.name)) = 0 then 'PASS' else 'FAIL' end,
         'a trigger that runs a lifecycle function but is not in the inventory'
  union all
  select 402, 'D3_no_chain_trigger_on_auth_users',
         case when (select count(*) from cat_trg c where c.rel = 'auth.users' and c.fn like 'private.account\_lifecycle\_%') = 0 then 'PASS' else 'FAIL' end,
         'the chain installs no trigger on auth.users (the Auth cascade reaches common_accounts through its foreign key)'
  union all
  -- ---- E. state -------------------------------------------------------------------------------------------
  select 500, 'E1_release_gate_blocked',
         case when (select gate_rows from dyn) is null then 'FAIL'
              when (select gate_blocked from dyn) = 1 and (select gate_rows from dyn) = 1 then 'PASS'
              else 'FAIL' end,
         'managed_auth_delete must stay blocked until a separately approved release'
  union all
  select 501, 'E2_settings_affirmed',
         case when (select settings_rows from dyn) is null then 'FAIL'
              when (select settings_affirmed from dyn) = 1 and (select settings_rows from dyn) = 1 then 'PASS'
              else 'WARN' end,
         'expected the pre-integration state: guard shadow, integration not_started'
  union all
  select 502, 'E3_builtin_checkpoints_exact',
         case when (select checkpoint_rows from dyn) is null then 'FAIL'
              when (select checkpoint_rows from dyn) = 3 and (select checkpoint_exact from dyn) = 3 then 'PASS'
              else 'FAIL' end,
         'the three built-in checkpoints with their built-in meaning, nothing else'
  union all
  select 503, 'E4_phase6_columns',
         case when (select count(*) from pg_attribute a where a.attrelid = pg_catalog.to_regclass('private.account_lifecycle_operations') and not a.attisdropped
                      and a.attname in ('provider_results', 'remote_unverified_ack_at', 'remote_unverified_ack_providers', 'owner_lease', 'owner_lease_expires_at', 'owner_fence')) = 6
              then 'PASS' else 'FAIL' end,
         'owner lease / fence and provider results / acknowledgement columns on private.account_lifecycle_operations'
  union all
  select 504, 'E4_phase8_column',
         case when (select count(*) from pg_attribute a where a.attrelid = pg_catalog.to_regclass('private.account_lifecycle_operations') and not a.attisdropped
                      and a.attname = 'reconciliation' and a.atttypid = 'jsonb'::regtype and a.attnotnull) = 1
                   and exists (select 1 from pg_constraint c where c.conrelid = pg_catalog.to_regclass('private.account_lifecycle_operations')
                                 and c.conname = 'account_lifecycle_operations_reconciliation_shape' and c.contype = 'c')
              then 'PASS' else 'FAIL' end,
         'the durable reconciliation facts (x_posts_unconfirmed) column and its shape constraint on private.account_lifecycle_operations'
  union all
  -- ---- H. Auth (read only) ----------------------------------------------------------------------------------
  select 600, 'H1_auth_sessions_shape',
         case when pg_catalog.to_regclass('auth.sessions') is null then 'FAIL'
              when (select count(*) from pg_attribute a where a.attrelid = pg_catalog.to_regclass('auth.sessions') and not a.attisdropped
                      and ((a.attname = 'id' and a.atttypid = 'uuid'::regtype) or (a.attname = 'user_id' and a.atttypid = 'uuid'::regtype)
                           or (a.attname = 'not_after' and a.atttypid = 'timestamptz'::regtype))) = 3 then 'PASS' else 'FAIL' end,
         'auth.sessions (id, user_id, not_after) as the Phase 3b guard reads it'
  union all
  select 601, 'H2_owner_can_read_auth_sessions',
         case when pg_catalog.to_regclass('auth.sessions') is null then 'FAIL'
              when has_table_privilege((select oid from owner_role), pg_catalog.to_regclass('auth.sessions'), 'SELECT') then 'PASS' else 'FAIL' end,
         'the definer functions run as the owner'
  union all
  select 602, 'H3_common_accounts_fk_cascades_from_auth_users',
         case when (select count(*) from pg_constraint c where c.conrelid = pg_catalog.to_regclass('public.common_accounts') and c.contype = 'f'
                      and c.confrelid = pg_catalog.to_regclass('auth.users') and c.confdeltype = 'c') = 1 then 'PASS' else 'FAIL' end,
         'deleting the login cascades to common_accounts (the guard decides it)'
  union all
  select 603, 'H4_anonymous_users',
         case when pg_catalog.to_regclass('auth.users') is null then 'WARN'
              when not exists (select 1 from pg_attribute a where a.attrelid = pg_catalog.to_regclass('auth.users') and a.attname = 'is_anonymous' and not a.attisdropped) then 'WARN'
              else 'INFO' end,
         case when pg_catalog.to_regclass('auth.users') is null then 'auth.users not readable'
              when not exists (select 1 from pg_attribute a where a.attrelid = pg_catalog.to_regclass('auth.users') and a.attname = 'is_anonymous' and not a.attisdropped) then 'auth.users.is_anonymous absent: confirm the anonymous sign-in setting by hand'
              else 'column present; whether anonymous sign-ins are ENABLED is a GoTrue setting (manual checklist item M3)' end
  union all
  -- ---- I. Storage (read only) -------------------------------------------------------------------------------
  select 700, 'I1_storage_objects_readable_by_owner',
         case when pg_catalog.to_regclass('storage.objects') is null then 'WARN'
              when has_table_privilege((select oid from owner_role), pg_catalog.to_regclass('storage.objects'), 'SELECT')
                   and (select count(*) from pg_attribute a where a.attrelid = pg_catalog.to_regclass('storage.objects') and not a.attisdropped
                          and a.attname in ('bucket_id', 'name', 'owner_id')) = 3 then 'PASS' else 'FAIL' end,
         'the deletion inventory reads storage.objects (bucket_id, name, owner_id)'
  union all
  -- ---- K. Data API exposure -----------------------------------------------------------------------------------
  select 800, 'K1_private_schema_not_exposed',
         case when exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
                            where r.rolname = 'authenticator' and exists (select 1 from unnest(s.setconfig) c where c like 'pgrst.db_schemas=%private%')) then 'FAIL'
              when exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
                            where r.rolname = 'authenticator' and exists (select 1 from unnest(s.setconfig) c where c like 'pgrst.db_schemas=%')) then 'PASS'
              else 'WARN' end,
         'the Data API must not expose schema private (pgrst.db_schemas of role authenticator); absent here = confirm in the project settings'
  union all
  select 802, 'K3_social_accounts_platform_rule',
         'INFO',
         coalesce((select string_agg(c.conname || ': ' || pg_get_constraintdef(c.oid), '; ' order by c.conname) from pg_constraint c
                    where c.conrelid = pg_catalog.to_regclass('public.social_accounts') and c.contype = 'c' and c.conname like 'social\_accounts\_platform%'),
                  'no platform constraint found')
         || ' (Threads rows exist only after the multi-provider migration 20261007150000; a platform rule of x only means no Threads account can be stored)'
  union all
  select 801, 'K2_default_privileges',
         'INFO', 'default ACL rows: ' || (select count(*) from pg_default_acl d where d.defaclnamespace in ('public'::regnamespace, 'private'::regnamespace))
                 || ' (the chain functions revoke them explicitly; see B2/B3)'
  union all
  -- ---- G. data hygiene (disposable projects are expected to be fresh) --------------------------------------------------
  select 900, 'G1_counts',
         'INFO',
         'common_accounts=' || coalesce((select accounts from dyn), '?')
         || ' service_entitlements=' || coalesce((select entitlements from dyn), '?')
         || ' operations_in_progress=' || coalesce((select operations_in_progress from dyn), '?')
),
shown as (
  select ord, id, status, detail from checks where (select setting_ok and marker_ok from gate)
  union all
  select 0, 'G0_disposable_gate', 'STOP',
         'not a disposable database: need session setting kabumori.disposable_probe=yes AND table public.kabumori_disposable_marker'
    from gate where not (setting_ok and marker_ok)
)
select id || '|' || status || '|' || detail from shown
union all
select 'RELEASE_PREFLIGHT|' || case when count(*) filter (where status in ('FAIL', 'STOP')) = 0 then 'PASS' else 'FAIL' end
       || '|fail=' || count(*) filter (where status = 'FAIL')
       || ' warn=' || count(*) filter (where status = 'WARN')
       || ' stop=' || count(*) filter (where status = 'STOP')
  from shown
order by 1;

rollback;
