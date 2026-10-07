-- 02 (read-only): what the migration relies on but does not change, and who calls the start helper.
with deps(sig) as (values
  ('private.account_lifecycle_lock(uuid,boolean,boolean)'), ('public.ensure_my_profile()'))
select jsonb_build_object(
  'dependencies', (select jsonb_object_agg(d.sig, case when p.oid is null then null else jsonb_build_object(
      'owner', pg_get_userbyid(p.proowner), 'secdef', p.prosecdef, 'config', p.proconfig,
      'def_md5', md5(pg_get_functiondef(p.oid)),
      'exec', jsonb_build_object('anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
                                 'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                                 'service_role', has_function_privilege('service_role', p.oid, 'EXECUTE'))) end)
    from deps d left join pg_proc p on p.oid = to_regprocedure(d.sig)),
  'callers', (select coalesce(jsonb_agg(n.nspname || '.' || p.proname order by 1), '[]')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname not in ('pg_catalog', 'information_schema')
       and p.prosrc ~ '(account_lifecycle_start_service|account_lifecycle_reactivate_service)'),
  'default_function_acl_postgres', (select coalesce(jsonb_object_agg(coalesce(n.nspname, '*'), d.defaclacl::text), '{}')
      from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
     where d.defaclobjtype = 'f' and pg_get_userbyid(d.defaclrole) = 'postgres'),
  'api_role_memberships', (select count(*) from pg_auth_members am join pg_roles r on r.oid = am.member
                            where r.rolname in ('anon', 'authenticated', 'service_role'))
) as result;
