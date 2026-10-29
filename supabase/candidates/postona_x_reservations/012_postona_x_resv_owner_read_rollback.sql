-- G3 SOURCE CANDIDATE (2026-10-29, Issue #318 G3-44): rollback of 012_postona_x_resv_owner_read.sql. NOT applied anywhere.
-- Restores 001's list_reservations and 002's get_reservation verbatim (through assert_account_access: the service / account / G5 / G4
-- gate again, so a person whose service ended cannot read their rows any more). Rows are not touched.
-- Refuses (nothing changed) when: 012 is not applied, or only part of it is there; the caller is a superuser or does not own the schema,
-- the table and both functions. Postconditions: both bodies byte for byte (md5), owners and ACLs unchanged.

begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_list boolean := coalesce((select p.prosrc ~ 'G3_OWNER_READ' from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.list_reservations(text)')), false);
  v_get boolean := coalesce((select p.prosrc ~ 'G3_OWNER_READ' from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.get_reservation(uuid)')), false);
begin
  if not (v_list or v_get) then
    raise exception 'G3_OWNER_READ_ROLLBACK_NOT_APPLIED';
  end if;
  if not (v_list and v_get) then
    raise exception 'G3_OWNER_READ_ROLLBACK_PARTIAL_STATE';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from v_owner
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) is distinct from v_owner
     or exists (select 1 from pg_catalog.pg_proc p where p.oid in ('postona_x_resv.list_reservations(text)'::pg_catalog.regprocedure, 'postona_x_resv.get_reservation(uuid)'::pg_catalog.regprocedure)
                and p.proowner is distinct from v_owner) then
    raise exception 'G3_OWNER_READ_ROLLBACK_OWNER';
  end if;
  perform pg_catalog.set_config('postona_resv_owner_read.acl', (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      where p.oid in ('postona_x_resv.list_reservations(text)'::pg_catalog.regprocedure, 'postona_x_resv.get_reservation(uuid)'::pg_catalog.regprocedure)
      union all
      select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) a), true);
end $$;

-- 001's list_reservations, verbatim
create or replace function postona_x_resv.list_reservations(p_social_account_id text)
returns setof postona_x_resv.reservation_view
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller();
begin
  perform postona_x_resv.assert_account_access(v_user, p_social_account_id);
  return query select r.id, r.batch_id, r.draft_id, r.position, r.origin, r.mode, r.body, r.scheduled_at, r.fixed,
                      r.status, r.revision, r.consent_state
               from postona_x_resv.reservations r
               where r.social_account_id = p_social_account_id and r.user_id = v_user
               order by r.scheduled_at, r.id;
end $$;

-- 002's get_reservation, verbatim
create or replace function postona_x_resv.get_reservation(p_reservation_id uuid)
returns setof postona_x_resv.reservation_view
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller(); v_row postona_x_resv.reservations%rowtype;
begin
  select r.* into v_row from postona_x_resv.reservations r where r.id = p_reservation_id;
  if not found or v_row.user_id <> v_user then
    raise exception 'POSTONA_RESV_NOT_FOUND' using errcode = 'P0001';
  end if;
  perform postona_x_resv.assert_account_access(v_user, v_row.social_account_id);
  return query select r.id, r.batch_id, r.draft_id, r.position, r.origin, r.mode, r.body, r.scheduled_at, r.fixed,
                      r.status, r.revision, r.consent_state from postona_x_resv.reservations r where r.id = v_row.id;
end $$;

do $$
begin
  if (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      where p.oid in ('postona_x_resv.list_reservations(text)'::pg_catalog.regprocedure, 'postona_x_resv.get_reservation(uuid)'::pg_catalog.regprocedure)
      union all
      select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) a) is distinct from pg_catalog.current_setting('postona_resv_owner_read.acl', true) then
    raise exception 'G3_OWNER_READ_ROLLBACK_POSTCONDITION: an owner or ACL changed';
  end if;
  if pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.list_reservations(text)'))) <> 'ccf161cb8f6dcd9023271ccfc0b9748c'
     or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.get_reservation(uuid)'))) <> '301f7792d1e1b8a7b703d2977a2c0914' then
    raise exception 'G3_OWNER_READ_ROLLBACK_POSTCONDITION: not 001''s list / 002''s get';
  end if;
end $$;

commit;
