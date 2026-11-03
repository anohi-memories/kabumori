-- G5 SOURCE CANDIDATE (2026-10-30, Issue #587 G5-02 task 3). NOT applied anywhere. The reversal of 001_brands_tenant_isolation.sql.
--
-- It restores exactly what the install recorded in private.postona_brands_isolation_prestate: the privileges PUBLIC / anon / authenticated
-- held on public.brands (table and column level, with their grant options) and its row security flag. It then drops the record. On the
-- world as built that RE-OPENS the cross-tenant paths G5-02 task 2 measured (a person reads, changes and deletes another workspace; anon
-- inserts brands): MVP_RELEASE_PREFLIGHT.sql reports PF_BRANDS FAIL again. Use it only to give a broken backend consumer back its old path
-- while the fix is corrected; the release stays stopped meanwhile.
--
-- Refusals (SQLSTATE P0001, nothing is changed):
--   BRANDS_ISOLATION_SUPERUSER / BRANDS_ISOLATION_NOT_OWNER   as the install
--   BRANDS_ISOLATION_NOT_INSTALLED                             no record (never installed, or already rolled back)
--   BRANDS_ROLLBACK_POSTCONDITION                              the API roles' privileges afterwards are not the recorded ones (someone changed
--                                                              them after the install: look before rolling back)

begin;
set local lock_timeout = '5s';
set local search_path = '';

do $rollback$
declare
  v_brands regclass := pg_catalog.to_regclass('public.brands');
  v_anon oid := pg_catalog.to_regrole('anon');
  v_auth oid := pg_catalog.to_regrole('authenticated');
  v_owner oid;
  v_pre record;
  v_entry record;
  v_want text[];
  v_got text[];
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'BRANDS_ISOLATION_SUPERUSER: run it as the owner of public.brands, not a superuser';
  end if;
  if v_brands is null or v_anon is null or v_auth is null or pg_catalog.to_regclass('private.postona_brands_isolation_prestate') is null then
    raise exception 'BRANDS_ISOLATION_NOT_INSTALLED: no record to restore';
  end if;
  select c.relowner into v_owner from pg_catalog.pg_class c where c.oid = v_brands;
  if not pg_catalog.pg_has_role(current_user, v_owner, 'USAGE') then
    raise exception 'BRANDS_ISOLATION_NOT_OWNER: % cannot act as %, the owner of public.brands', current_user, v_owner::regrole;
  end if;
  lock table public.brands in access exclusive mode;
  select * into v_pre from private.postona_brands_isolation_prestate where id = 1 for update;
  if not found then
    raise exception 'BRANDS_ISOLATION_NOT_INSTALLED: no record to restore';
  end if;

  for v_entry in select * from pg_catalog.jsonb_to_recordset(v_pre.table_acl) as e(grantee text, privilege text, grantable boolean) loop
    execute pg_catalog.format('grant %s on table public.brands to %s%s', v_entry.privilege, v_entry.grantee,
                              case when v_entry.grantable then ' with grant option' else '' end);
  end loop;
  for v_entry in select * from pg_catalog.jsonb_to_recordset(v_pre.column_acl) as e("column" text, grantee text, privilege text, grantable boolean) loop
    execute pg_catalog.format('grant %s (%I) on table public.brands to %s%s', v_entry.privilege, v_entry."column", v_entry.grantee,
                              case when v_entry.grantable then ' with grant option' else '' end);
  end loop;
  if not v_pre.row_security then
    alter table public.brands disable row level security;
  end if;

  -- the API roles' privileges are now exactly the recorded ones (grantor aside: the owner re-grants them)
  select coalesce(pg_catalog.array_agg(x order by x), '{}') into v_want from (
    select '' || (e ->> 'grantee') || ':' || (e ->> 'privilege') || ':' || (e ->> 'grantable') x from pg_catalog.jsonb_array_elements(v_pre.table_acl) e
    union all
    select (e ->> 'column') || ':' || (e ->> 'grantee') || ':' || (e ->> 'privilege') || ':' || (e ->> 'grantable') from pg_catalog.jsonb_array_elements(v_pre.column_acl) e) s;
  select coalesce(pg_catalog.array_agg(x order by x), '{}') into v_got from (
    select '' || (case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end) || ':' || a.privilege_type || ':' || a.is_grantable x
      from pg_catalog.pg_class c, pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
     where c.oid = v_brands and a.grantee in (0, v_anon, v_auth)
    union all
    select t.attname || ':' || (case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end) || ':' || a.privilege_type || ':' || a.is_grantable
      from pg_catalog.pg_attribute t, pg_catalog.aclexplode(t.attacl) a
     where t.attrelid = v_brands and t.attnum > 0 and not t.attisdropped and t.attacl is not null and a.grantee in (0, v_anon, v_auth)) s;
  if v_got is distinct from v_want
     or (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = v_brands) is distinct from v_pre.row_security then
    raise exception 'BRANDS_ROLLBACK_POSTCONDITION: privileges [%] are not the recorded [%]', pg_catalog.array_to_string(v_got, ' '), pg_catalog.array_to_string(v_want, ' ');
  end if;

  drop table private.postona_brands_isolation_prestate;
end;
$rollback$;

commit;
