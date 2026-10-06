-- Production preflight / read-back (read-only). Renderer canary: production (PostgreSQL 17.6) and the local proof cluster
-- (17.11) must print catalog text identically, because the rollout runner's Stage B compares hashes
-- pinned locally. The objects of 20260928160000 (applied to production unchanged, H2 2026-09-29) are
-- hashed with the same deparsers the runner uses: column types/defaults, CHECK/PK/FK/UNIQUE text,
-- index text and validity, trigger text, function definitions, settings and ACLs. Hashes only.
with rel(oid, name) as (
  select c.oid, n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('social_mobile_account_deletions', 'social_mobile_account_deletion_audit')),
fns as (
  select p.oid, n.nspname || '.' || p.proname || '(' ||
         coalesce((select string_agg(format_type(u.t, null), ',' order by u.ord)
                     from unnest(p.proargtypes::oid[]) with ordinality as u(t, ord)), '') || ')' as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'social\_mobile\_account\_deletion%'),
sections(name, cnt, body) as (
  select 'columns', count(*), string_agg(r.name || ' ' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' ||
                                         a.attnotnull || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-'),
                                         E'\n' order by r.name collate "C", a.attnum)
    from rel r join pg_attribute a on a.attrelid = r.oid
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attnum > 0 and not a.attisdropped
  union all
  select 'constraints', count(*), string_agg(r.name || ' ' || c.conname || ' ' || c.contype::text || ' ' || pg_get_constraintdef(c.oid) ||
                                             ' ' || c.convalidated || ' ' || c.condeferrable,
                                             E'\n' order by r.name collate "C", c.conname collate "C")
    from rel r join pg_constraint c on c.conrelid = r.oid
  union all
  select 'indexes', count(*), string_agg(r.name || ' ' || i.relname || ' ' || x.indisvalid || ' ' || pg_get_indexdef(i.oid),
                                         E'\n' order by r.name collate "C", i.relname collate "C")
    from rel r join pg_index x on x.indrelid = r.oid join pg_class i on i.oid = x.indexrelid
  union all
  select 'relations', count(*), string_agg(r.name || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity ||
                                           ' policies=' || (select count(*) from pg_policy where polrelid = c.oid),
                                           E'\n' order by r.name collate "C")
    from rel r join pg_class c on c.oid = r.oid
  union all
  select 'triggers', count(*), string_agg(t.tgrelid::regclass::text || ' ' || t.tgname || ' ' || t.tgenabled::text || ' ' || pg_get_triggerdef(t.oid),
                                          E'\n' order by t.tgrelid::regclass::text collate "C", t.tgname collate "C")
    from pg_trigger t where t.tgname = 'social_mobile_deletion_guard' and not t.tgisinternal
  union all
  select 'functions', count(*), string_agg(f.sig || ' ' || p.prosecdef || ' ' || coalesce(array_to_string(p.proconfig, ','), '-') || ' ' ||
                                           p.provolatile::text || ' ' || pg_get_function_result(p.oid) || ' ' || md5(pg_get_functiondef(p.oid)),
                                           E'\n' order by f.sig collate "C")
    from fns f join pg_proc p on p.oid = f.oid
  union all
  select 'function_acl', count(*), string_agg(line, E'\n' order by line collate "C")
    from (select f.sig || ' ' || (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) || ' ' || a.privilege_type as line
            from fns f join pg_proc p on p.oid = f.oid, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           where a.grantee <> p.proowner) z
)
select jsonb_build_object(
  'sections', (select jsonb_object_agg(name, jsonb_build_object('count', cnt,
                        'sha256', encode(sha256(convert_to(coalesce(body, '<empty>'), 'UTF8')), 'hex'))) from sections),
  'search_path', current_setting('search_path')
) as result;
