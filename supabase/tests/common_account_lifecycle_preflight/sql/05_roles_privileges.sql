-- Production preflight / read-back (read-only). Role graph, schema privileges and default privileges that decide
-- which rights the new tables, view and functions receive at CREATE time (before the
-- migration's explicit revokes) and whether an API role could inherit the owner's rights.
with api(r) as (values ('anon'), ('authenticated'), ('service_role'), ('authenticator'), ('postgres')),
schemas(s) as (values ('public'), ('private'), ('auth'), ('storage'), ('extensions'), ('graphql_public'),
                      ('supabase_migrations'))
select jsonb_build_object(
  'member_of', (
    select jsonb_object_agg(api.r, (
             select coalesce(jsonb_agg(g.rolname order by g.rolname collate "C"), '[]'::jsonb)
               from pg_roles g
              where g.rolname <> api.r and pg_has_role(api.r, g.oid, 'MEMBER')))
      from api where exists (select 1 from pg_roles where rolname = api.r)),
  'members_of', (
    select jsonb_object_agg(api.r, (
             select coalesce(jsonb_agg(m.rolname order by m.rolname collate "C"), '[]'::jsonb)
               from pg_roles m
              where m.rolname <> api.r and pg_has_role(m.oid, (select oid from pg_roles where rolname = api.r), 'MEMBER')))
      from api where exists (select 1 from pg_roles where rolname = api.r)),
  'direct_memberships', (
    select coalesce(jsonb_agg(pg_get_userbyid(am.member) || ' in ' || pg_get_userbyid(am.roleid) ||
                              ' admin=' || am.admin_option || ' inherit=' || am.inherit_option || ' set=' || am.set_option
                              order by pg_get_userbyid(am.member) collate "C", pg_get_userbyid(am.roleid) collate "C"), '[]'::jsonb)
      from pg_auth_members am
     where pg_get_userbyid(am.member) in (select r from api) or pg_get_userbyid(am.roleid) in (select r from api)),
  'schemas', (
    select jsonb_object_agg(n.nspname, jsonb_build_object(
             'owner', pg_get_userbyid(n.nspowner),
             'acl', (select coalesce(jsonb_agg((case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) || ' ' ||
                                                a.privilege_type || case when a.is_grantable then ' grantable' else '' end
                                                order by (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) collate "C",
                                                         a.privilege_type collate "C"), '[]'::jsonb)
                       from aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a)))
      from pg_namespace n where n.nspname in (select s from schemas)),
  'default_acls', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'role', pg_get_userbyid(d.defaclrole),
             'schema', coalesce((select nspname from pg_namespace where oid = d.defaclnamespace), '*'),
             'objtype', d.defaclobjtype::text,
             'acl', (select jsonb_agg((case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) || ' ' ||
                                       a.privilege_type || case when a.is_grantable then ' grantable' else '' end
                                       order by (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) collate "C",
                                                a.privilege_type collate "C")
                       from aclexplode(d.defaclacl) a))
           order by pg_get_userbyid(d.defaclrole) collate "C",
                    coalesce((select nspname from pg_namespace where oid = d.defaclnamespace), '*') collate "C",
                    d.defaclobjtype::text collate "C"), '[]'::jsonb)
      from pg_default_acl d),
  'existing_owner_counts', (
    select jsonb_build_object(
             'relations', (select jsonb_object_agg(k, v) from (
                select n.nspname || ':' || pg_get_userbyid(c.relowner) as k, count(*) as v
                  from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname in ('public', 'private') and c.relkind in ('r', 'v', 'm', 'p', 'f')
                 group by 1) x),
             'functions', (select jsonb_object_agg(k, v) from (
                select n.nspname || ':' || pg_get_userbyid(p.proowner) as k, count(*) as v
                  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname in ('public', 'private')
                 group by 1) y)))
) as result;
