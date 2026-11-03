-- G3 SOURCE CANDIDATE (2026-11-03, Issue #589 G3-02 #15): one read-only field on the person's own list / get. NOT applied anywhere. Applied
-- last, after 001-006, 008, 010, 012, 014 and 015; rolled back FIRST with 017_..._rollback.sql.
-- G3-02 #14 stops a row of an earlier generation from being changed or sent, but list / get could not say which rows those are, so such a
-- row kept reading as reserved until its due time. Each row now carries connection_generation:
--   'earlier'  G5's MV answers SERVICE_GENERATION_CHANGED for the generation the row was made under. G5 gives that answer only while the
--              service is active, so it is proof that the row belongs to a generation before the current one. Such a row is never sent.
--   'current'  G5's MV answers 'active' for the row AND g4_x_account_verified(row's person, row's account) is true: exactly the two
--              generation / connection checks of row_publishable. It says nothing about consent, the due time or the send's result.
--   'unknown'  everything else, including an unbound row, a service not active, a disconnected account, a missing G4 / G5 function and any
--              exception. It is never a guess at 'current', and it never fails the read: list / get keep working as 012 made them.
-- Boundary: the same two functions, signatures, API role and row filters (the caller's own rows; another person's row or an unknown id is
-- still NOT_FOUND). Only the three words leave the database: no generation number, no token, no G4 / G5 code.
-- A function's result type cannot be replaced, and reservation_view is also the result of create / reschedule / reconfirm / cancel, which
-- are not touched. So the two functions are dropped and created again in this one transaction with a new result type and the same
-- ACL (compared before and after; any other result refuses). No new entry point or role. connection_generation_of is SECURITY INVOKER and
-- granted to nobody: it runs only as the owner, inside list / get.
-- Write answers keep reservation_view and carry no such field.
-- Refuses (nothing changed) when: 012's list / get or 014's g4_x_account_verified are not there byte for byte; the caller is a superuser or
-- does not own the schema, the table and both functions. Postconditions: ACLs unchanged; the helper reachable by no role but the owner.

begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  if pg_catalog.to_regprocedure('postona_x_resv.list_reservations(text)') is null or pg_catalog.to_regprocedure('postona_x_resv.get_reservation(uuid)') is null
     or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.list_reservations(text)'))) <> '862bde9e6f9fc6a633b8fc6c0088c814'
     or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.get_reservation(uuid)'))) <> '5d879684f11137dc3fb4ac9dd71f1188'
     or pg_catalog.to_regprocedure('postona_x_resv.g4_x_account_verified(uuid,text)') is null
     or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.g4_x_account_verified(uuid,text)'))) <> '6b0483845232219802aad0b0325869ae' then
    raise exception 'G3_CONNECTION_GENERATION_BASE_UNKNOWN';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from v_owner
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) is distinct from v_owner
     or exists (select 1 from pg_catalog.pg_proc p where p.oid in ('postona_x_resv.list_reservations(text)'::pg_catalog.regprocedure, 'postona_x_resv.get_reservation(uuid)'::pg_catalog.regprocedure)
                and p.proowner is distinct from v_owner) then
    raise exception 'G3_CONNECTION_GENERATION_OWNER';
  end if;
  perform pg_catalog.set_config('postona_resv_connection_generation.acl', (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.proname::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      where p.oid in ('postona_x_resv.list_reservations(text)'::pg_catalog.regprocedure, 'postona_x_resv.get_reservation(uuid)'::pg_catalog.regprocedure)) a), true);
end $$;

create type postona_x_resv.reservation_read_view as (
  reservation_id uuid, batch_id uuid, draft_id text, position integer, origin text, mode text, body text,
  scheduled_at timestamptz, fixed boolean, status text, revision integer, consent_state text, connection_generation text
);
revoke all on type postona_x_resv.reservation_read_view from public;

/** current / earlier / unknown for one row; see the head of this file. Internal: no grant. */
create function postona_x_resv.connection_generation_of(p_row postona_x_resv.reservations) returns text
language plpgsql stable set search_path = '' as $$
-- G3_CONNECTION_GENERATION (G3-02 #15)
declare v_state text;
begin
  v_state := postona_x_resv.g5_bound_state(p_row);
  if v_state = 'SERVICE_GENERATION_CHANGED' then
    return 'earlier';
  end if;
  if v_state = 'active' and postona_x_resv.g4_x_account_verified(p_row.user_id, p_row.social_account_id) is true then
    return 'current';
  end if;
  return 'unknown';
exception when others then
  return 'unknown';
end $$;
revoke all on function postona_x_resv.connection_generation_of(postona_x_resv.reservations) from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;

drop function postona_x_resv.list_reservations(text);
drop function postona_x_resv.get_reservation(uuid);

/** 012's list, plus the field. */
create function postona_x_resv.list_reservations(p_social_account_id text)
returns setof postona_x_resv.reservation_read_view
language plpgsql stable security definer set search_path = '' as $$
-- G3_OWNER_READ (G3-44); G3_CONNECTION_GENERATION (G3-02 #15)
declare v_user uuid := postona_x_resv.caller();
begin
  return query select r.id, r.batch_id, r.draft_id, r.position, r.origin, r.mode, r.body, r.scheduled_at, r.fixed,
                      r.status, r.revision, r.consent_state,
                      postona_x_resv.connection_generation_of(r)
               from postona_x_resv.reservations r
               where r.social_account_id = p_social_account_id and r.user_id = v_user
               order by r.scheduled_at, r.id;
end $$;

/** 012's get, plus the field. */
create function postona_x_resv.get_reservation(p_reservation_id uuid)
returns setof postona_x_resv.reservation_read_view
language plpgsql stable security definer set search_path = '' as $$
-- G3_OWNER_READ (G3-44); G3_CONNECTION_GENERATION (G3-02 #15)
declare v_user uuid := postona_x_resv.caller(); v_owner uuid;
begin
  select r.user_id into v_owner from postona_x_resv.reservations r where r.id = p_reservation_id;
  if not found or v_owner is distinct from v_user then
    raise exception 'POSTONA_RESV_NOT_FOUND' using errcode = 'P0001';
  end if;
  return query select r.id, r.batch_id, r.draft_id, r.position, r.origin, r.mode, r.body, r.scheduled_at, r.fixed,
                      r.status, r.revision, r.consent_state,
                      postona_x_resv.connection_generation_of(r)
               from postona_x_resv.reservations r where r.id = p_reservation_id and r.user_id = v_user;
end $$;

revoke all on function postona_x_resv.list_reservations(text), postona_x_resv.get_reservation(uuid) from public;
grant execute on function postona_x_resv.list_reservations(text), postona_x_resv.get_reservation(uuid) to postona_resv_api;

do $$
begin
  if (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.proname::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      where p.oid in ('postona_x_resv.list_reservations(text)'::pg_catalog.regprocedure, 'postona_x_resv.get_reservation(uuid)'::pg_catalog.regprocedure)) a) is distinct from pg_catalog.current_setting('postona_resv_connection_generation.acl', true) then
    raise exception 'G3_CONNECTION_GENERATION_POSTCONDITION: an owner or ACL changed';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p where p.oid = 'postona_x_resv.connection_generation_of(postona_x_resv.reservations)'::pg_catalog.regprocedure
             and (p.prosecdef or pg_catalog.array_length(p.proacl, 1) <> 1)) then
    raise exception 'G3_CONNECTION_GENERATION_POSTCONDITION: the helper is reachable';
  end if;
end $$;

commit;
