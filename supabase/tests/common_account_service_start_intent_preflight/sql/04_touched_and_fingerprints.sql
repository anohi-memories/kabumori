-- 04 (read-only, aggregates only): the eight objects the migration touches, one by one; everything else in
-- public/private folded into fingerprints that must be identical before and after the apply; lifecycle counts.
-- Names are schema-qualified explicitly (independent of search_path); owners are normalized to OWNER in ACLs.
-- Nothing here calls a function of the migration (05_smoke.sql does, after the apply only).
with touched(sig) as (values
  ('public.start_kabumori_service()'), ('public.start_x_autopost_service()'),
  ('private.account_lifecycle_start_service(uuid,text)'),
  ('private.account_lifecycle_service_refusal(text)'), ('private.account_lifecycle_active_answer(uuid,text,boolean)'),
  ('private.account_lifecycle_reactivate_service(uuid,text,bigint)'),
  ('public.reactivate_kabumori_service(bigint)'), ('public.reactivate_x_autopost_service(bigint)')),
untouched_fn as (
  select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as sig, md5(pg_get_functiondef(p.oid)) as def,
         coalesce(regexp_replace(p.proacl::text, pg_get_userbyid(p.proowner), 'OWNER', 'g'), '-') as acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.prokind in ('f', 'p')
     and not exists (select 1 from touched t where to_regprocedure(t.sig) = p.oid))
select jsonb_build_object(
  'history_target', (select coalesce(jsonb_agg(jsonb_build_object('version', version, 'name', name)), '[]')
                       from supabase_migrations.schema_migrations where version = '20261006230000'),
  'history_latest', (select max(version) from supabase_migrations.schema_migrations),
  'history_count', (select count(*) from supabase_migrations.schema_migrations),
  'touched', (select jsonb_agg(jsonb_build_object(
      'sig', t.sig, 'exists', p.oid is not null, 'owner', pg_get_userbyid(p.proowner), 'secdef', p.prosecdef,
      'config', p.proconfig, 'volatility', p.provolatile,
      'acl', regexp_replace(p.proacl::text, pg_get_userbyid(p.proowner), 'OWNER', 'g'),
      'exec', case when p.oid is null then null else jsonb_build_object(
          'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
          'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
          'service_role', has_function_privilege('service_role', p.oid, 'EXECUTE')) end,
      'def_md5', case when p.oid is null then null else md5(pg_get_functiondef(p.oid)) end) order by t.sig)
    from touched t left join pg_proc p on p.oid = to_regprocedure(t.sig)),
  'overloads', (select jsonb_object_agg(x.name, x.n) from (
      select n.nspname || '.' || p.proname as name, count(*) as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private')
         and p.proname in ('start_kabumori_service', 'start_x_autopost_service', 'account_lifecycle_start_service',
                           'account_lifecycle_service_refusal', 'account_lifecycle_active_answer',
                           'account_lifecycle_reactivate_service', 'reactivate_kabumori_service', 'reactivate_x_autopost_service')
       group by 1) x),
  'untouched_functions', (select jsonb_build_object('count', count(*), 'fingerprint', md5(string_agg(sig || ' ' || def || ' ' || acl, E'\n' order by sig))) from untouched_fn),
  'relations_fingerprint', (select md5(string_agg(x, E'\n' order by x)) from (
      select 'rel ' || n.nspname || '.' || c.relname || ' ' || c.relkind::text || ' ' || c.relrowsecurity || ' ' || coalesce(regexp_replace(c.relacl::text, pg_get_userbyid(c.relowner), 'OWNER', 'g'), '-') as x
        from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private')
      union all
      select 'col ' || n.nspname || '.' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(a.attacl::text, '-')
        from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'private') and a.attnum > 0 and not a.attisdropped
      union all
      select 'pol ' || n.nspname || '.' || c.relname || ' ' || po.polname || ' ' || coalesce(pg_get_expr(po.polqual, po.polrelid), '-') || ' ' || coalesce(pg_get_expr(po.polwithcheck, po.polrelid), '-')
        from pg_policy po join pg_class c on c.oid = po.polrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'private')
      union all
      select 'trg ' || n.nspname || '.' || c.relname || ' ' || tg.tgname || ' ' || tg.tgenabled::text || ' ' || fn.nspname || '.' || f.proname
        from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
        join pg_proc f on f.oid = tg.tgfoid join pg_namespace fn on fn.oid = f.pronamespace
       where not tg.tgisinternal and n.nspname in ('public', 'private')) y),
  'state', jsonb_build_object(
      'accounts', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from public.common_accounts group by 1) a),
      'entitlements', (select coalesce(jsonb_object_agg(service_key || '/' || status || '/' || source, n), '{}')
                         from (select service_key, status, source, count(*) n from public.service_entitlements group by 1, 2, 3) e),
      'operations', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from private.account_lifecycle_operations group by 1) o),
      'settings', (select jsonb_agg(auth_delete_guard || '/' || integration_state || '/' || requirement_epoch) from private.account_lifecycle_settings),
      'profiles', (select count(*) from public.profiles))
) as result;
