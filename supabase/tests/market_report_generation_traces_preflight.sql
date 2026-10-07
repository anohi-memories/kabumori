-- READ-ONLY preflight for 20261007120000_market_report_generation_traces.sql. Run it (SQL editor or
-- `supabase db query --linked -f`) BEFORE the migration is applied anywhere real. It changes nothing.
--
-- The migration refuses (and rolls back whole) if the new table or its append-only helper would be reachable by
-- anyone but the owner and service_role (SELECT + INSERT). Every query below shows one thing the refusal looks
-- at; each should return zero rows except the ones marked "expected".

-- 1. Who will own the objects, and is any application role a member of that owner or of a superuser?
select current_user as migration_runs_as,
       (select rolsuper from pg_roles where rolname = current_user) as owner_is_superuser;

select r.rolname as app_role, m.rolname as member_of, m.rolsuper as member_of_is_superuser
  from pg_roles r
  join pg_auth_members am on am.member = r.oid
  join pg_roles m on m.oid = am.roleid
 where r.rolname in ('anon', 'authenticated', 'service_role')
 order by 1, 2;                                   -- expected: none that name the owner or a superuser

-- 2. Default privileges that would be applied to a new table / function created by the migration's role in public.
select pg_get_userbyid(d.defaclrole) as defaults_of_role,
       case d.defaclobjtype when 'r' then 'tables' when 'f' then 'functions' else d.defaclobjtype::text end as object_kind,
       d.defaclacl
  from pg_default_acl d
  left join pg_namespace n on n.oid = d.defaclnamespace
 where (n.nspname = 'public' or d.defaclnamespace = 0)
   and d.defaclobjtype in ('r', 'f')
   and pg_get_userbyid(d.defaclrole) = current_user
 order by 1, 2;
-- expected: grants only to the owner, anon, authenticated, service_role. The migration revokes those four; a grant to
-- ANY OTHER role (or PUBLIC EXECUTE on functions is revoked too) makes it refuse.

-- 3. Is the target already there? (The migration is one-shot.)
select to_regclass('public.market_report_generation_traces') as trace_table_already_exists;   -- expected: null
