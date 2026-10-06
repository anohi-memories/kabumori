-- Production preflight / read-back (read-only). The accepted migration's own preflight, re-derived as one SELECT:
-- roles, the 17 relations, the 26 typed columns, the 14 exact foreign keys (columns, target,
-- delete action, validated, not deferrable, equal types), the profiles-child cascade rule and
-- the two reused helpers. Each item reports pass/fail plus what production actually has.
with tables(t) as (values
  ('auth.users'), ('auth.identities'), ('public.profiles'), ('public.admin_users'),
  ('public.tracked_stocks'), ('public.alert_settings'), ('public.alert_category_settings'),
  ('public.notifications'), ('public.device_push_tokens'), ('public.personalized_reports'),
  ('public.brands'), ('public.brand_memberships'), ('public.social_accounts'),
  ('public.social_account_oauth_states'), ('public.social_mobile_account_deletions'),
  ('storage.objects'), ('storage.buckets')),
cols as (
  select value as spec from jsonb_array_elements('[
    {"t": "auth.users", "c": "id", "type": "uuid"},
    {"t": "auth.identities", "c": "user_id", "type": "uuid"},
    {"t": "auth.identities", "c": "provider", "type": "text"},
    {"t": "public.profiles", "c": "id", "type": "uuid"},
    {"t": "public.profiles", "c": "created_at", "type": "timestamp with time zone"},
    {"t": "public.admin_users", "c": "user_id", "type": "uuid"},
    {"t": "public.tracked_stocks", "c": "user_id", "type": "uuid"},
    {"t": "public.alert_settings", "c": "user_id", "type": "uuid"},
    {"t": "public.alert_category_settings", "c": "user_id", "type": "uuid"},
    {"t": "public.notifications", "c": "user_id", "type": "uuid"},
    {"t": "public.device_push_tokens", "c": "user_id", "type": "uuid"},
    {"t": "public.personalized_reports", "c": "user_id", "type": "uuid"},
    {"t": "public.brands", "c": "id", "type": "text"},
    {"t": "public.brands", "c": "code_profile_key", "type": "text"},
    {"t": "public.brand_memberships", "c": "brand_id", "type": "text"},
    {"t": "public.brand_memberships", "c": "user_id", "type": "uuid"},
    {"t": "public.brand_memberships", "c": "role", "type": "text"},
    {"t": "public.brand_memberships", "c": "created_at", "type": "timestamp with time zone"},
    {"t": "public.social_accounts", "c": "brand_id", "type": "text"},
    {"t": "public.social_accounts", "c": "connection_status", "type": "text"},
    {"t": "public.social_account_oauth_states", "c": "brand_id", "type": "text"},
    {"t": "public.social_account_oauth_states", "c": "initiated_by_user_id", "type": "uuid"},
    {"t": "public.social_mobile_account_deletions", "c": "user_id", "type": "uuid"},
    {"t": "public.social_mobile_account_deletions", "c": "workspace_id", "type": "text"},
    {"t": "storage.objects", "c": "owner_id", "type": "text"},
    {"t": "storage.buckets", "c": "owner_id", "type": "text"}
  ]'::jsonb)),
fks as (
  select value as spec from jsonb_array_elements('[
    {"t": "public.profiles", "c": ["id"], "r": "auth.users", "rc": ["id"], "del": "c"},
    {"t": "public.admin_users", "c": ["user_id"], "r": "auth.users", "rc": ["id"], "del": "c"},
    {"t": "auth.identities", "c": ["user_id"], "r": "auth.users", "rc": ["id"], "del": "c"},
    {"t": "public.tracked_stocks", "c": ["user_id"], "r": "public.profiles", "rc": ["id"], "del": "c"},
    {"t": "public.alert_settings", "c": ["user_id"], "r": "public.profiles", "rc": ["id"], "del": "c"},
    {"t": "public.alert_category_settings", "c": ["user_id"], "r": "public.profiles", "rc": ["id"], "del": "c"},
    {"t": "public.notifications", "c": ["user_id"], "r": "public.profiles", "rc": ["id"], "del": "c"},
    {"t": "public.device_push_tokens", "c": ["user_id"], "r": "public.profiles", "rc": ["id"], "del": "c"},
    {"t": "public.personalized_reports", "c": ["user_id"], "r": "public.profiles", "rc": ["id"], "del": "c"},
    {"t": "public.brand_memberships", "c": ["user_id"], "r": "auth.users", "rc": ["id"], "del": "c"},
    {"t": "public.brand_memberships", "c": ["brand_id"], "r": "public.brands", "rc": ["id"], "del": "c"},
    {"t": "public.social_accounts", "c": ["brand_id"], "r": "public.brands", "rc": ["id"], "del": "a"},
    {"t": "public.social_account_oauth_states", "c": ["brand_id"], "r": "public.brands", "rc": ["id"], "del": "a"},
    {"t": "public.social_account_oauth_states", "c": ["initiated_by_user_id"], "r": "auth.users", "rc": ["id"], "del": "c"}
  ]'::jsonb))
select jsonb_build_object(
  'private_schema_present', to_regnamespace('private') is not null,
  'roles_present', (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')),
  'tables_missing', (
    select coalesce(jsonb_agg(t order by t collate "C"), '[]'::jsonb) from tables where to_regclass(t) is null),
  'tables_owner', (
    select jsonb_object_agg(t, pg_get_userbyid(c.relowner)) from tables join pg_class c on c.oid = to_regclass(t)),
  'columns_mismatch', (
    select coalesce(jsonb_agg((spec ->> 't') || '.' || (spec ->> 'c') || ' want ' || (spec ->> 'type') || ' got ' ||
                              coalesce((select format_type(a.atttypid, a.atttypmod) from pg_attribute a
                                         where a.attrelid = to_regclass(spec ->> 't') and a.attname = spec ->> 'c'
                                           and a.attnum > 0 and not a.attisdropped), 'absent')
                              order by (spec ->> 't') collate "C", (spec ->> 'c') collate "C"), '[]'::jsonb)
      from cols
     where not exists (
       select 1 from pg_attribute a
        where a.attrelid = to_regclass(spec ->> 't') and a.attname = spec ->> 'c'
          and a.attnum > 0 and not a.attisdropped
          and format_type(a.atttypid, a.atttypmod) = spec ->> 'type')),
  'columns_checked', (select count(*) from cols),
  'fk_mismatch', (
    select coalesce(jsonb_agg((spec ->> 't') || '(' || (spec -> 'c' ->> 0) || ')->' || (spec ->> 'r') || '(' || (spec -> 'rc' ->> 0) || ')'
                              order by (spec ->> 't') collate "C", (spec -> 'c' ->> 0) collate "C"), '[]'::jsonb)
      from fks
     where not exists (
       select 1 from pg_constraint c
        where c.contype = 'f'
          and c.conrelid = to_regclass(spec ->> 't')
          and c.confrelid = to_regclass(spec ->> 'r')
          and c.confdeltype::text = spec ->> 'del'
          and c.convalidated
          and not c.condeferrable
          and (select array_agg(a.attname::text order by k.ord)
                 from unnest(c.conkey) with ordinality k(attnum, ord)
                 join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
              = array(select jsonb_array_elements_text(spec -> 'c'))
          and (select array_agg(a.attname::text order by k.ord)
                 from unnest(c.confkey) with ordinality k(attnum, ord)
                 join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum)
              = array(select jsonb_array_elements_text(spec -> 'rc'))
          and not exists (
            select 1 from unnest(c.conkey, c.confkey) p(fk_attnum, pk_attnum)
              join pg_attribute fa on fa.attrelid = c.conrelid and fa.attnum = p.fk_attnum
              join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = p.pk_attnum
             where fa.atttypid <> pa.atttypid))),
  'fks_checked', (select count(*) from fks),
  'profiles_children', (
    select coalesce(jsonb_agg(c.conrelid::regclass::text || ' ' || c.conname || ' del=' || c.confdeltype::text ||
                              ' valid=' || c.convalidated || ' deferrable=' || c.condeferrable
                              order by c.conrelid::regclass::text collate "C", c.conname collate "C"), '[]'::jsonb)
      from pg_constraint c where c.contype = 'f' and c.confrelid = to_regclass('public.profiles')),
  'profiles_children_not_cascade', (
    select count(*) from pg_constraint c
     where c.contype = 'f' and c.confrelid = to_regclass('public.profiles') and c.confdeltype <> 'c'),
  'helpers', (
    select jsonb_object_agg(sig, case when to_regprocedure(sig) is null then jsonb_build_object('present', false)
      else (select jsonb_build_object(
              'present', true,
              'returns', format_type(p.prorettype, null),
              'owner', pg_get_userbyid(p.proowner),
              'secdef', p.prosecdef,
              'config', p.proconfig,
              'volatility', p.provolatile::text,
              'strict', p.proisstrict,
              'lang', (select l.lanname from pg_language l where l.oid = p.prolang),
              'prosrc_md5', md5(p.prosrc),
              'definition', pg_get_functiondef(p.oid),
              'postgres_execute', has_function_privilege('postgres', p.oid, 'EXECUTE'),
              'acl', (select coalesce(jsonb_agg(case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
                                                || ' ' || a.privilege_type
                                                order by (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) collate "C"), '[]'::jsonb)
                        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a))
              from pg_proc p where p.oid = to_regprocedure(sig)) end)
      from unnest(array['public.social_mobile_account_deletion_workspace(uuid)',
                        'public.social_mobile_account_deletion_subject(uuid)']) sig),
  'helper_overloads', (
    select coalesce(jsonb_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text collate "C"), '[]'::jsonb)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.proname in ('social_mobile_account_deletion_workspace', 'social_mobile_account_deletion_subject'))
) as result;
