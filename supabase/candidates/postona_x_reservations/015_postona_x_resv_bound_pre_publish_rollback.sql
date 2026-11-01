-- G3 SOURCE CANDIDATE (2026-10-30, Issue #318 G3-49): rollback of 015 (pre_publish_check_bound). NOT applied anywhere. Run BEFORE
-- 014's rollback. Drops only that function; 004 / 014 and everything else stay as they are. A worker built on x_bound_delivery.ts
-- then only throws at the pre-send check (never sends); worker.ts's verdict-only path is unchanged.
-- Refuses (nothing changed) when: 015 is not applied (NOT_APPLIED) or its function is not the one 015 created (UNKNOWN); the caller is
-- a superuser or does not own the schema and the function. Postcondition: owners and ACLs of everything else unchanged.

begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user); v_fn oid := pg_catalog.to_regprocedure('postona_x_resv.pre_publish_check_bound(uuid,uuid)');
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from v_owner
     or (v_fn is not null and (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner) then
    raise exception 'G3_X_BOUND_ROLLBACK_OWNER';
  end if;
  if v_fn is null then
    raise exception 'G3_X_BOUND_ROLLBACK_NOT_APPLIED';
  end if;
  if pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = v_fn)) is distinct from '1220c208d2b268e15ae67a1e6474f58c' then
    raise exception 'G3_X_BOUND_ROLLBACK_UNKNOWN';
  end if;
  perform pg_catalog.set_config('postona_x_bound.acl', (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'postona_x_resv' and p.oid <> v_fn
      union all
      select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'postona_x_resv'
      union all
      select n.nspname || ':' || n.nspowner::text || ':' || coalesce(n.nspacl::text, '-') from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') a), true);
end $$;

drop function postona_x_resv.pre_publish_check_bound(uuid, uuid);

do $$
begin
  if pg_catalog.to_regprocedure('postona_x_resv.pre_publish_check_bound(uuid,uuid)') is not null
     or (select pg_catalog.string_agg(x, '|' order by x) from (
      select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'postona_x_resv'
      union all
      select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'postona_x_resv'
      union all
      select n.nspname || ':' || n.nspowner::text || ':' || coalesce(n.nspacl::text, '-') from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') a)
     is distinct from pg_catalog.current_setting('postona_x_bound.acl', true) then
    raise exception 'G3_X_BOUND_ROLLBACK_POSTCONDITION: an owner or ACL changed';
  end if;
end $$;

commit;
