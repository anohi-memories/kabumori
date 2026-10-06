-- Production preflight / read-back (read-only). What the new objects need at apply time and at run time, beyond the
-- migration's own preflight: the owner's privileges on managed schemas, auth.uid(), the
-- profiles insert/delete done by the Kabumori start/withdrawal, the Storage shapes the
-- ownership probe reads, and the existing triggers that those writes will fire.
select jsonb_build_object(
  'owner_privileges', jsonb_build_object(
    'usage_auth', has_schema_privilege('postgres', 'auth', 'USAGE'),
    'usage_storage', has_schema_privilege('postgres', 'storage', 'USAGE'),
    'usage_private', has_schema_privilege('postgres', 'private', 'USAGE'),
    'create_public', has_schema_privilege('postgres', 'public', 'CREATE'),
    'create_private', has_schema_privilege('postgres', 'private', 'CREATE'),
    'auth_users_references', has_table_privilege('postgres', 'auth.users', 'REFERENCES'),
    'auth_users_select', has_table_privilege('postgres', 'auth.users', 'SELECT'),
    'auth_identities_select', has_table_privilege('postgres', 'auth.identities', 'SELECT'),
    'storage_objects_select', has_table_privilege('postgres', 'storage.objects', 'SELECT'),
    'storage_buckets_select', has_table_privilege('postgres', 'storage.buckets', 'SELECT'),
    'profiles_insert', has_table_privilege('postgres', 'public.profiles', 'INSERT'),
    'profiles_delete', has_table_privilege('postgres', 'public.profiles', 'DELETE'),
    'profiles_select', has_table_privilege('postgres', 'public.profiles', 'SELECT')),
  'auth_users_id_unique', (
    select coalesce(jsonb_agg(c.conname || ' ' || c.contype::text order by c.conname collate "C"), '[]'::jsonb)
      from pg_constraint c
     where c.conrelid = 'auth.users'::regclass and c.contype in ('p', 'u')
       and c.conkey = array[(select a.attnum from pg_attribute a where a.attrelid = 'auth.users'::regclass and a.attname = 'id')]::int2[]),
  'auth_users_owner', (select pg_get_userbyid(relowner) from pg_class where oid = 'auth.users'::regclass),
  'auth_users_user_triggers', (
    select coalesce(jsonb_agg(t.tgname || ' enabled=' || t.tgenabled::text order by t.tgname collate "C"), '[]'::jsonb)
      from pg_trigger t where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal),
  'auth_users_internal_triggers', (
    select count(*) from pg_trigger t where t.tgrelid = 'auth.users'::regclass and t.tgisinternal),
  'auth_users_referencing_fks', (
    select coalesce(jsonb_agg(c.conrelid::regclass::text || ' ' || c.conname || ' del=' || c.confdeltype::text
                              order by c.conrelid::regclass::text collate "C", c.conname collate "C"), '[]'::jsonb)
      from pg_constraint c where c.contype = 'f' and c.confrelid = 'auth.users'::regclass),
  'auth_uid', (
    select jsonb_build_object(
             'present', to_regprocedure('auth.uid()') is not null,
             'returns', (select format_type(p.prorettype, null) from pg_proc p where p.oid = to_regprocedure('auth.uid()')),
             'authenticated_execute', has_function_privilege('authenticated', to_regprocedure('auth.uid()'), 'EXECUTE'),
             'postgres_execute', has_function_privilege('postgres', to_regprocedure('auth.uid()'), 'EXECUTE'))),
  'gen_random_uuid', to_regprocedure('pg_catalog.gen_random_uuid()') is not null,
  'profiles_columns', (
    select jsonb_agg(jsonb_build_object('c', a.attname, 't', format_type(a.atttypid, a.atttypmod), 'nn', a.attnotnull,
                                        'has_default', d.adbin is not null, 'generated', a.attgenerated::text,
                                        'identity', a.attidentity::text)
                     order by a.attnum)
      from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = 'public.profiles'::regclass and a.attnum > 0 and not a.attisdropped),
  'profiles_unique_on_id', (
    select coalesce(jsonb_agg(c.conname || ' ' || c.contype::text order by c.conname collate "C"), '[]'::jsonb)
      from pg_constraint c
     where c.conrelid = 'public.profiles'::regclass and c.contype in ('p', 'u')
       and c.conkey = array[(select a.attnum from pg_attribute a where a.attrelid = 'public.profiles'::regclass and a.attname = 'id')]::int2[]),
  'profiles_checks', (
    select coalesce(jsonb_agg(c.conname || ' ' || pg_get_constraintdef(c.oid) order by c.conname collate "C"), '[]'::jsonb)
      from pg_constraint c where c.conrelid = 'public.profiles'::regclass and c.contype = 'c'),
  'profiles_owner', (select pg_get_userbyid(relowner) from pg_class where oid = 'public.profiles'::regclass),
  'profiles_rls', (select jsonb_build_object('rls', relrowsecurity, 'force', relforcerowsecurity) from pg_class where oid = 'public.profiles'::regclass),
  'profiles_triggers', (
    select coalesce(jsonb_agg(t.tgname || ' enabled=' || t.tgenabled::text || ' fn=' || t.tgfoid::regprocedure::text
                              order by t.tgname collate "C"), '[]'::jsonb)
      from pg_trigger t where t.tgrelid = 'public.profiles'::regclass and not t.tgisinternal),
  'storage_objects_columns', (
    select jsonb_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) order by a.attnum)
      from pg_attribute a where a.attrelid = 'storage.objects'::regclass and a.attnum > 0 and not a.attisdropped),
  'storage_buckets_columns', (
    select jsonb_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) order by a.attnum)
      from pg_attribute a where a.attrelid = 'storage.buckets'::regclass and a.attnum > 0 and not a.attisdropped),
  'storage_owners', (
    select jsonb_build_object('objects', pg_get_userbyid(o.relowner), 'buckets', pg_get_userbyid(b.relowner),
                              'objects_rls', o.relrowsecurity, 'objects_force_rls', o.relforcerowsecurity,
                              'buckets_rls', b.relrowsecurity, 'buckets_force_rls', b.relforcerowsecurity)
      from pg_class o, pg_class b where o.oid = 'storage.objects'::regclass and b.oid = 'storage.buckets'::regclass),
  'postgres_bypasses_rls', (select rolbypassrls or rolsuper from pg_roles where rolname = 'postgres'),
  'auth_identities_provider_column', (
    select format_type(a.atttypid, a.atttypmod) from pg_attribute a
     where a.attrelid = 'auth.identities'::regclass and a.attname = 'provider' and a.attnum > 0 and not a.attisdropped)
) as result;
