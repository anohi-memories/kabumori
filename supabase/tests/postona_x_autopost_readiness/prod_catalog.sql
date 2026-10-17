-- POSTONA X autopost Stage 3B: READ-ONLY production catalog inventory (run inside BEGIN TRANSACTION READ ONLY).
-- Catalog facts, owners, column/index shapes and aggregate counts only: no user rows, no message/text
-- columns, no tokens, no Vault, no cron command text.
with names(n) as (values
  ('public.scheduled_posts'), ('public.social_accounts'), ('public.brands'), ('public.brand_settings'),
  ('public.brand_memberships'), ('public.post_execution_logs'), ('public.published_content_fingerprints'),
  ('public.social_mobile_content_settings'), ('public.x_account_refresh_rollout'), ('public.x_account_refresh_state_v2'),
  ('public.x_account_publish_authority'), ('public.service_entitlements'), ('public.common_accounts'),
  ('private.service_entitlements'), ('private.common_accounts'))
select jsonb_build_object(
  'current_user', current_user::text,
  'current_user_super', (select rolsuper from pg_roles where rolname = current_user),
  'transaction_read_only', current_setting('transaction_read_only'),
  'server_version_num', current_setting('server_version_num'),
  'relations', (select jsonb_object_agg(n, case when to_regclass(n) is null then null else jsonb_build_object(
        'owner', (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = to_regclass(n)),
        'rls', (select c.relrowsecurity from pg_class c where c.oid = to_regclass(n))) end) from names),
  'history', (select coalesce(jsonb_agg(version order by version), '[]'::jsonb) from supabase_migrations.schema_migrations
      where version in ('20260924023133', '20260925140000', '20260926032054', '20260922045046', '20261003120000',
                        '20261006160000', '20261006160100', '20261006160200', '20261006230000', '20261010051938')),
  'stage3b_routines', (select coalesce(jsonb_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' order by p.proname), '[]'::jsonb)
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in
        ('complete_vault_account_brand_post', 'read_social_mobile_publish_settings',
         'check_x_account_publish_authority', 'set_x_account_publish_authority')),
  'stage3a_routines', (select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
      from pg_proc p where p.pronamespace = 'public'::regnamespace
        and (p.proname like '%x\_account\_refresh%' or p.proname like 'begin\_x\_account%' or p.proname like '%vault\_account%')),
  'g5_routines', (select coalesce(jsonb_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname), '[]'::jsonb)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')
        and (p.proname like '%x\_autopost\_service%' or p.proname like 'account\_lifecycle%' or p.proname like '%entitlement%'
             or p.proname like '%common\_account%')),
  'brand_post_writers', (select coalesce(jsonb_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname), '[]'::jsonb)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('pg_catalog', 'information_schema')
        and p.prosrc ~* 'brand_post' and p.prosrc ~* 'insert\s+into\s+(public\.)?scheduled_posts'),
  'claim_routines', (select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'claim\_%'),
  'columns', (select jsonb_object_agg(t, cols) from (
      select table_name::text as t, jsonb_agg(column_name::text || ':' || data_type || ':' || is_nullable order by ordinal_position) as cols
      from information_schema.columns
      where table_schema = 'public' and table_name in ('scheduled_posts', 'social_accounts', 'post_execution_logs',
        'published_content_fingerprints', 'brand_settings', 'brands')
      group by table_name) c),
  'fingerprint_indexes', (select coalesce(jsonb_agg(indexdef order by indexdef), '[]'::jsonb) from pg_indexes
      where schemaname = 'public' and tablename = 'published_content_fingerprints'),
  'social_accounts_fks_in', (select coalesce(jsonb_agg(conrelid::regclass::text || ':' || confdeltype::text order by conrelid::regclass::text), '[]'::jsonb)
      from pg_constraint where contype = 'f' and confrelid = to_regclass('public.social_accounts')),
  'api_role_paths', jsonb_build_object(
      'anon_to_applier', pg_has_role('anon', current_user, 'usage'),
      'authenticated_to_applier', pg_has_role('authenticated', current_user, 'usage'),
      'anon_to_service_role', pg_has_role('anon', 'service_role', 'usage'),
      'authenticated_to_service_role', pg_has_role('authenticated', 'service_role', 'usage')),
  'service_role_on_content_settings', case when to_regclass('public.social_mobile_content_settings') is null then null
      else has_table_privilege('service_role', 'public.social_mobile_content_settings', 'SELECT,INSERT,UPDATE,DELETE') end,
  'default_acl', (select coalesce(jsonb_agg(jsonb_build_object('objtype', d.defaclobjtype,
        'grantees', (select jsonb_agg(distinct coalesce(r.rolname, 'PUBLIC')) from aclexplode(d.defaclacl) x
                     left join pg_roles r on r.oid = x.grantee where x.grantee <> d.defaclrole))), '[]'::jsonb)
      from pg_default_acl d where d.defaclrole = (select oid from pg_roles where rolname = current_user)
        and (d.defaclnamespace = 0 or d.defaclnamespace = 'public'::regnamespace)),
  'cron_jobs', (select coalesce(jsonb_agg(jsonb_build_object('name', j.jobname, 'schedule', j.schedule, 'active', j.active)
        order by j.jobname), '[]'::jsonb) from cron.job j),
  'counts', jsonb_build_object(
      'social_mobile_brands', (select count(*) from public.brands where code_profile_key = 'social_mobile_user_v1'),
      'social_mobile_brands_live', (select count(*) from public.brands where code_profile_key = 'social_mobile_user_v1'
                                      and is_active and publish_mode = 'live'),
      'social_mobile_x_accounts', (select count(*) from public.social_accounts sa join public.brands b on b.id = sa.brand_id
                                     where b.code_profile_key = 'social_mobile_user_v1' and sa.platform = 'x'),
      'social_mobile_x_verified', (select count(*) from public.social_accounts sa join public.brands b on b.id = sa.brand_id
                                     where b.code_profile_key = 'social_mobile_user_v1' and sa.platform = 'x'
                                       and sa.connection_status = 'identity_verified'),
      'social_mobile_x_publish_enabled', (select count(*) from public.social_accounts sa join public.brands b on b.id = sa.brand_id
                                     where b.code_profile_key = 'social_mobile_user_v1' and sa.platform = 'x' and sa.publish_enabled),
      'social_mobile_brand_post_enabled', (select count(*) from public.brand_settings bs join public.brands b on b.id = bs.brand_id
                                     where b.code_profile_key = 'social_mobile_user_v1' and to_jsonb(bs.enabled_post_types) ? 'brand_post'),
      'social_mobile_scheduled_posts', (select count(*) from public.scheduled_posts s join public.brands b on b.id = s.brand_id
                                     where b.code_profile_key = 'social_mobile_user_v1'),
      'refresh_rollout_rows', (select count(*) from public.x_account_refresh_rollout),
      'content_settings_rows', (select count(*) from public.social_mobile_content_settings),
      'content_settings_auto_post', (select count(*) from public.social_mobile_content_settings
                                     where settings ->> 'approvalMode' = 'auto_post_preference'))
) as catalog;
