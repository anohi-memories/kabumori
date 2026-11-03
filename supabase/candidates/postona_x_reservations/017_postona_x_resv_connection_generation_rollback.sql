-- G3 SOURCE CANDIDATE (2026-11-03, Issue #589 G3-02 #15): removes 017. NOT applied anywhere. Run FIRST, before 015's and every other rollback.
-- list / get are dropped and created again as 012 made them, byte for byte (same result type as before 017, reservation_view), with the ACL
-- they have now; the helper and reservation_read_view are dropped. No row is touched.
-- Refuses (nothing changed) when: 017 is not there byte for byte; the caller is a superuser or does not own the schema and both functions.

begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  if pg_catalog.to_regtype('postona_x_resv.reservation_read_view') is null
     or pg_catalog.to_regprocedure('postona_x_resv.connection_generation_of(postona_x_resv.reservations)') is null then
    raise exception 'G3_CONNECTION_GENERATION_ROLLBACK_NOT_APPLIED';
  end if;
  if pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.list_reservations(text)'))) is distinct from '11072a3f672194978d0726ef9b1aee07'
     or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.get_reservation(uuid)'))) is distinct from '92cb23ba829777aaab61f0e80e466a46' then
    raise exception 'G3_CONNECTION_GENERATION_ROLLBACK_UNKNOWN';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from v_owner
     or exists (select 1 from pg_catalog.pg_proc p where p.oid in ('postona_x_resv.list_reservations(text)'::pg_catalog.regprocedure, 'postona_x_resv.get_reservation(uuid)'::pg_catalog.regprocedure)
                and p.proowner is distinct from v_owner) then
    raise exception 'G3_CONNECTION_GENERATION_ROLLBACK_OWNER';
  end if;
  perform pg_catalog.set_config('postona_resv_connection_generation.acl', (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.proname::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      where p.oid in ('postona_x_resv.list_reservations(text)'::pg_catalog.regprocedure, 'postona_x_resv.get_reservation(uuid)'::pg_catalog.regprocedure)) a), true);
end $$;

drop function postona_x_resv.list_reservations(text);
drop function postona_x_resv.get_reservation(uuid);
drop function postona_x_resv.connection_generation_of(postona_x_resv.reservations);
drop type postona_x_resv.reservation_read_view;

create function postona_x_resv.list_reservations(p_social_account_id text)
returns setof postona_x_resv.reservation_view
language plpgsql stable security definer set search_path = '' as $$
-- G3_OWNER_READ (G3-44)
declare v_user uuid := postona_x_resv.caller();
begin
  return query select r.id, r.batch_id, r.draft_id, r.position, r.origin, r.mode, r.body, r.scheduled_at, r.fixed,
                      r.status, r.revision, r.consent_state
               from postona_x_resv.reservations r
               where r.social_account_id = p_social_account_id and r.user_id = v_user
               order by r.scheduled_at, r.id;
end $$;

create function postona_x_resv.get_reservation(p_reservation_id uuid)
returns setof postona_x_resv.reservation_view
language plpgsql stable security definer set search_path = '' as $$
-- G3_OWNER_READ (G3-44)
declare v_user uuid := postona_x_resv.caller(); v_owner uuid;
begin
  select r.user_id into v_owner from postona_x_resv.reservations r where r.id = p_reservation_id;
  if not found or v_owner is distinct from v_user then
    raise exception 'POSTONA_RESV_NOT_FOUND' using errcode = 'P0001';
  end if;
  return query select r.id, r.batch_id, r.draft_id, r.position, r.origin, r.mode, r.body, r.scheduled_at, r.fixed,
                      r.status, r.revision, r.consent_state from postona_x_resv.reservations r where r.id = p_reservation_id and r.user_id = v_user;
end $$;

revoke all on function postona_x_resv.list_reservations(text), postona_x_resv.get_reservation(uuid) from public;
grant execute on function postona_x_resv.list_reservations(text), postona_x_resv.get_reservation(uuid) to postona_resv_api;

do $$
begin
  if (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.proname::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      where p.oid in ('postona_x_resv.list_reservations(text)'::pg_catalog.regprocedure, 'postona_x_resv.get_reservation(uuid)'::pg_catalog.regprocedure)) a) is distinct from pg_catalog.current_setting('postona_resv_connection_generation.acl', true) then
    raise exception 'G3_CONNECTION_GENERATION_ROLLBACK_POSTCONDITION: an owner or ACL changed';
  end if;
  if pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.list_reservations(text)'))) <> '862bde9e6f9fc6a633b8fc6c0088c814'
     or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.get_reservation(uuid)'))) <> '5d879684f11137dc3fb4ac9dd71f1188' then
    raise exception 'G3_CONNECTION_GENERATION_ROLLBACK_POSTCONDITION: not 012';
  end if;
end $$;

commit;
