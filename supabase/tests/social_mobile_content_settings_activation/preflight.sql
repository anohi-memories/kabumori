-- S0: read-only, metadata-only preflight for applying the social_mobile_content_settings chain
-- (20260922045046 candidate + 20261003120000 hardening) in one outer transaction.
-- Run inside BEGIN TRANSACTION READ ONLY as the role that will apply. No user rows, no secrets:
-- only catalog facts and counts. check.py decides PASS/STOP from this JSON.
with api as (
  select r.rolname, r.oid from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')
),
memberships_cols as (
  select string_agg(format('%s:%s:%s', a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull), ','
           order by a.attname collate "C") as v
  from pg_attribute a
  where a.attrelid = to_regclass('public.brand_memberships') and a.attnum > 0 and not a.attisdropped
    and a.attname in ('brand_id', 'user_id', 'role')
)
select jsonb_build_object(
  'database', current_database(),
  'current_user', current_user::text,
  'current_user_super', (select r.rolsuper from pg_roles r where r.rolname = current_user),
  'server_version_num', current_setting('server_version_num'),
  'transaction_read_only', current_setting('transaction_read_only'),

  -- Target objects must be absent.
  'target_table_present', to_regclass('public.social_mobile_content_settings') is not null,
  'target_function_count', (select count(*) from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname like 'social\_mobile\_content\_settings\_%'),
  'target_history_count', (select count(*) from supabase_migrations.schema_migrations
      where version in ('20260922045046', '20261003120000')),
  'history_count', (select count(*) from supabase_migrations.schema_migrations),
  'history_max', (select max(version) from supabase_migrations.schema_migrations),
  'history_not_null_columns', (select coalesce(jsonb_agg(column_name::text order by column_name), '[]'::jsonb)
      from information_schema.columns
      where table_schema = 'supabase_migrations' and table_name = 'schema_migrations' and is_nullable = 'NO'),
  'history_has_name_column', exists (select 1 from information_schema.columns
      where table_schema = 'supabase_migrations' and table_name = 'schema_migrations' and column_name = 'name'),

  -- Prerequisites the candidate/hardening and its RLS policies depend on.
  'brands_owner', (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = to_regclass('public.brands')),
  'brands_id_type', (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
      where a.attrelid = to_regclass('public.brands') and a.attname = 'id' and not a.attisdropped),
  'brands_pk', (select pg_get_constraintdef(c.oid) from pg_constraint c
      where c.conrelid = to_regclass('public.brands') and c.contype = 'p'),
  'brands_partitioned_or_inherited', exists (select 1 from pg_inherits i
      where i.inhrelid = to_regclass('public.brands') or i.inhparent = to_regclass('public.brands')),
  'memberships_columns', (select v from memberships_cols),
  'memberships_constraints', (select coalesce(jsonb_agg(pg_get_constraintdef(c.oid) order by pg_get_constraintdef(c.oid) collate "C"), '[]'::jsonb)
      from pg_constraint c where c.conrelid = to_regclass('public.brand_memberships') and c.contype in ('c', 'f')),
  'auth_uid_present', to_regprocedure('auth.uid()') is not null,

  -- Roles and inheritance: API roles must not reach the applying role or service_role.
  'api_roles', (select coalesce(jsonb_agg(rolname order by rolname), '[]'::jsonb) from api),
  'api_roles_super', (select coalesce(bool_or(r.rolsuper), false) from pg_roles r join api using (oid)),
  'api_reaches_applier', (select coalesce(bool_or(pg_has_role(api.oid, current_user, 'usage')
      or pg_has_role(api.oid, current_user, 'member')), false) from api),
  'anon_or_authenticated_reach_service_role', (select coalesce(bool_or(pg_has_role(api.oid, 'service_role', 'member')), false)
      from api where api.rolname in ('anon', 'authenticated')),

  -- Default privileges of the applying role (schema public and global): grantees by object type.
  'default_acl', (select coalesce(jsonb_agg(jsonb_build_object(
        'objtype', d.defaclobjtype,
        'scope', case when d.defaclnamespace = 0 then 'global' else d.defaclnamespace::regnamespace::text end,
        'grantees', (select jsonb_agg(distinct coalesce(r.rolname, 'PUBLIC'))
                     from aclexplode(d.defaclacl) x left join pg_roles r on r.oid = x.grantee
                     where x.grantee <> d.defaclrole))
      order by d.defaclobjtype, d.defaclnamespace), '[]'::jsonb)
      from pg_default_acl d
      where d.defaclrole = (select oid from pg_roles where rolname = current_user)
        and (d.defaclnamespace = 0 or d.defaclnamespace = 'public'::regnamespace)),

  'event_triggers', (select coalesce(jsonb_agg(jsonb_build_object('name', e.evtname, 'event', e.evtevent, 'enabled', e.evtenabled)
      order by e.evtname), '[]'::jsonb) from pg_event_trigger e),

  -- Concurrent writers: strong locks held by other sessions on the prerequisite tables right now.
  'foreign_strong_locks', (select count(*) from pg_locks l
      where l.pid <> pg_backend_pid() and l.granted
        and l.relation in (to_regclass('public.brands'), to_regclass('public.brand_memberships'))
        and l.mode in ('ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')),

  'social_mobile_brand_count', (select count(*) from public.brands where code_profile_key = 'social_mobile_user_v1')
) as preflight;
