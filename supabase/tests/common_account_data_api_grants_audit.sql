-- G5-12 READ-ONLY audit (Issue #320 G5-01 task 12; the Supabase Data API change of 2026-10-30). SELECT only: no write, no grant, no lock beyond a
-- catalog read. For every table / partitioned table / view / materialized view / foreign table / sequence in schema public, one row per Data API role
-- (anon, authenticated, service_role) that holds ANY privilege on it -- table level or on any column -- with a flag, highest concern first:
--   DANGEROUS_PRIVILEGE  TRUNCATE, TRIGGER or REFERENCES (never needed by the Data API)
--   GRANT_WITHOUT_RLS    a table the role can reach whose RLS is off (every row is the role's)
--   ANON_PRIVILEGE       anon holds anything (allowed only by an explicit, reviewed public-read decision)
--   VIEW_PRIVILEGE       a view / materialized view (runs as its owner unless security_invoker: RLS of the base tables may not apply)
--   SEQUENCE_PRIVILEGE   USAGE / SELECT on a sequence (needed only to insert into a serial column through the API)
--   REVIEW               RLS on and nothing above: confirm the grant is the intended minimum
-- An object NO API role can reach does not appear (server-only, or not granted). Run it as any role that can read pg_catalog, e.g.
--   psql -X -A -F '|' -f supabase/tests/common_account_data_api_grants_audit.sql
with api as (
  select r.oid, r.rolname from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')
), rels as (
  select c.oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
         coalesce((select o.option_value::boolean from pg_catalog.pg_options_to_table(c.reloptions) o where o.option_name = 'security_invoker'), false) as security_invoker
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
), privs as (
  select r.oid as relid, a.rolname, p.priv
    from rels r cross join api a
    cross join lateral (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('USAGE')) as p(priv)
   where case
           when r.relkind = 'S' then p.priv in ('USAGE', 'SELECT', 'UPDATE') and pg_catalog.has_sequence_privilege(a.oid, r.oid, p.priv)
           when p.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') then pg_catalog.has_any_column_privilege(a.oid, r.oid, p.priv)
           when p.priv = 'USAGE' then false
           else pg_catalog.has_table_privilege(a.oid, r.oid, p.priv)
         end
)
select 'public.' || r.relname as object,
       case r.relkind when 'r' then 'table' when 'p' then 'table' when 'v' then 'view' when 'm' then 'matview' when 'f' then 'foreign' else 'sequence' end as kind,
       x.rolname as role,
       pg_catalog.string_agg(x.priv, ',' order by x.priv) as privileges,
       r.relrowsecurity as rls,
       (select pg_catalog.count(*) from pg_catalog.pg_policy pol where pol.polrelid = r.oid) as policies,
       case
         when pg_catalog.bool_or(x.priv in ('TRUNCATE', 'TRIGGER', 'REFERENCES')) then 'DANGEROUS_PRIVILEGE'
         when r.relkind in ('r', 'p', 'f') and not r.relrowsecurity then 'GRANT_WITHOUT_RLS'
         when x.rolname = 'anon' then 'ANON_PRIVILEGE'
         when r.relkind in ('v', 'm') and not r.security_invoker then 'VIEW_PRIVILEGE'
         when r.relkind = 'S' then 'SEQUENCE_PRIVILEGE'
         else 'REVIEW'
       end as flag
  from privs x join rels r on r.oid = x.relid
 group by r.oid, r.relname, r.relkind, r.relrowsecurity, r.security_invoker, x.rolname
 order by 1, 3;
