-- Production preflight / read-back (read-only). Every object the foundation creates must be absent before the first
-- apply, in any schema and with any argument list. The exact names come from a local PostgreSQL 17
-- apply of the accepted file (12 relations, 12 types, 33 functions, 10 triggers, 2 policies).
-- The broad section catches partial or manual installs under neighbouring names.
with rel_names(n) as (values
  ('common_accounts'), ('common_accounts_pkey'), ('service_entitlements'), ('service_entitlements_pkey'),
  ('account_lifecycle_operations'), ('account_lifecycle_operations_pkey'),
  ('account_lifecycle_operations_one_in_progress'), ('account_lifecycle_settings'),
  ('account_lifecycle_settings_pkey'), ('account_lifecycle_managed_checkpoints'),
  ('account_lifecycle_managed_checkpoints_pkey'), ('account_lifecycle_backfill_plan')),
fn_names(n) as (values
  ('account_lifecycle_builtin_checkpoints'), ('account_lifecycle_lock'), ('account_lifecycle_invalidate_readiness'),
  ('account_lifecycle_touch_account'), ('account_lifecycle_account_changed'),
  ('account_lifecycle_guard_entitlement_identity'), ('account_lifecycle_touch_entitlement'),
  ('account_lifecycle_guard_checkpoint_registry'), ('account_lifecycle_requirements_changed'),
  ('account_lifecycle_touch_settings'), ('account_lifecycle_settings_changed'), ('account_lifecycle_footprint'),
  ('account_lifecycle_deletion_blockers'), ('account_lifecycle_managed_ownership'),
  ('account_lifecycle_requirements_valid'), ('account_lifecycle_required_checkpoints'),
  ('account_lifecycle_readiness_refusal'), ('account_lifecycle_authorization_problems'),
  ('account_lifecycle_start_service'), ('account_lifecycle_guard_account_delete'), ('account_lifecycle_backfill'),
  ('start_kabumori_service'), ('start_x_autopost_service'), ('common_account_deletion_eligibility'),
  ('begin_service_deletion'), ('finish_service_deletion'), ('abort_service_deletion'),
  ('withdraw_kabumori_service'), ('begin_common_account_deletion'),
  ('record_common_account_deletion_checkpoint'), ('clear_common_account_deletion_checkpoint'),
  ('abort_common_account_deletion'), ('prepare_common_account_auth_delete')),
trg_names(n) as (values
  ('account_lifecycle_touch_account'), ('account_lifecycle_account_changed'),
  ('account_lifecycle_guard_entitlement_identity'), ('account_lifecycle_touch_entitlement'),
  ('account_lifecycle_guard_checkpoint_registry'), ('account_lifecycle_guard_checkpoint_registry_truncate'),
  ('account_lifecycle_requirements_changed'), ('account_lifecycle_touch_settings'),
  ('account_lifecycle_settings_changed'), ('account_lifecycle_guard_account_delete')),
pol_names(n) as (values ('common_accounts_select_own'), ('service_entitlements_select_own'))
select jsonb_build_object(
  'exact_relations', (
    select coalesce(jsonb_agg(n.nspname || '.' || c.relname || ' ' || c.relkind::text order by (n.nspname || '.' || c.relname || ' ' || c.relkind::text) collate "C"), '[]'::jsonb)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relname in (select n from rel_names)),
  'exact_types', (
    select coalesce(jsonb_agg(n.nspname || '.' || t.typname || ' ' || t.typtype::text order by (n.nspname || '.' || t.typname || ' ' || t.typtype::text) collate "C"), '[]'::jsonb)
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
     where t.typname in (select n from rel_names) or t.typname in (select '_' || n from rel_names)),
  'exact_functions', (
    select coalesce(jsonb_agg(p.oid::regprocedure::text || ' ' || p.prokind::text order by (p.oid::regprocedure::text || ' ' || p.prokind::text) collate "C"), '[]'::jsonb)
      from pg_proc p where p.proname in (select n from fn_names)),
  'exact_triggers', (
    select coalesce(jsonb_agg(t.tgrelid::regclass::text || ' ' || t.tgname order by (t.tgrelid::regclass::text || ' ' || t.tgname) collate "C"), '[]'::jsonb)
      from pg_trigger t where t.tgname in (select n from trg_names)),
  'exact_policies', (
    select coalesce(jsonb_agg(p.polrelid::regclass::text || ' ' || p.polname order by (p.polrelid::regclass::text || ' ' || p.polname) collate "C"), '[]'::jsonb)
      from pg_policy p where p.polname in (select n from pol_names)),
  'broad_relations', (
    select coalesce(jsonb_agg(n.nspname || '.' || c.relname || ' ' || c.relkind::text order by (n.nspname || '.' || c.relname || ' ' || c.relkind::text) collate "C"), '[]'::jsonb)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
       and c.relname ~ '(common_account|service_entitlement|account_lifecycle)'),
  'broad_functions', (
    select coalesce(jsonb_agg(p.oid::regprocedure::text order by (p.oid::regprocedure::text) collate "C"), '[]'::jsonb)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname not in ('pg_catalog', 'information_schema')
       and p.proname ~ '(common_account|service_entitlement|account_lifecycle|_service_deletion|kabumori_service|x_autopost_service)'),
  'broad_policies', (
    select coalesce(jsonb_agg(p.polrelid::regclass::text || ' ' || p.polname order by (p.polrelid::regclass::text || ' ' || p.polname) collate "C"), '[]'::jsonb)
      from pg_policy p where p.polname ~ '(common_account|service_entitlement|account_lifecycle)'),
  'broad_triggers', (
    select coalesce(jsonb_agg(t.tgrelid::regclass::text || ' ' || t.tgname order by (t.tgrelid::regclass::text || ' ' || t.tgname) collate "C"), '[]'::jsonb)
      from pg_trigger t where not t.tgisinternal and t.tgname ~ '(common_account|service_entitlement|account_lifecycle)'),
  'private_schema', (
    select jsonb_build_object('present', true, 'owner', pg_get_userbyid(n.nspowner),
             'relations', (select count(*) from pg_class c where c.relnamespace = n.oid),
             'functions', (select count(*) from pg_proc p where p.pronamespace = n.oid))
      from pg_namespace n where n.nspname = 'private')
) as result;
