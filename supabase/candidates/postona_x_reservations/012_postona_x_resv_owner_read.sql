-- G3 SOURCE CANDIDATE (2026-10-29, Issue #318 G3-44): the person reads their own reservations without the service gate. NOT applied
-- anywhere. Applied after 001-006 (and 008 / 010 when in use); rolled back with 012_..._rollback.sql (before 002's / 001's rollbacks).
-- 001's list_reservations and 002's get_reservation went through assert_account_access (G5 service, G4 account, brand ownership), so after
-- the person's service ended -- or their X account was no longer verified, or a restart moved the generation -- they could not read their
-- own rows: the app could not learn a row's current state or revision, and a cancel (010: own planned row, no service gate) with a stale
-- revision could not be recovered from. Both now need exactly what 010's cancel needs, no more and no less:
--   - the person session (caller(): G5's S2-2 gate -- a live, non-anonymous session of this subject; missing gate -> AUTH_REQUIRED);
--   - the row is the caller's own (user_id). get: another person's row and an unknown id give the same NOT_FOUND. list: only the caller's
--     own rows of that account id; any other account id gives an empty list (no error, so no oracle on whose account it is).
-- Same signatures, same result shape (reservation_view), same grants (the API role only); no new function, no new grant, no read audit
-- (there was none). Create, reschedule, reconfirm, claim and send keep every gate they had.
-- Refuses (nothing changed) when: 001's list / 002's get are not there byte for byte (already applied, another version); the caller is a
-- superuser or does not own the schema, the table and both functions. Postconditions: owners and ACLs of both functions and the table
-- unchanged.

begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  if pg_catalog.to_regprocedure('postona_x_resv.list_reservations(text)') is null or pg_catalog.to_regprocedure('postona_x_resv.get_reservation(uuid)') is null
     or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.list_reservations(text)'))) <> 'ccf161cb8f6dcd9023271ccfc0b9748c'
     or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.get_reservation(uuid)'))) <> '301f7792d1e1b8a7b703d2977a2c0914' then
    raise exception 'G3_OWNER_READ_BASE_UNKNOWN';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from v_owner
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) is distinct from v_owner
     or exists (select 1 from pg_catalog.pg_proc p where p.oid in ('postona_x_resv.list_reservations(text)'::pg_catalog.regprocedure, 'postona_x_resv.get_reservation(uuid)'::pg_catalog.regprocedure)
                and p.proowner is distinct from v_owner) then
    raise exception 'G3_OWNER_READ_OWNER';
  end if;
  perform pg_catalog.set_config('postona_resv_owner_read.acl', (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      where p.oid in ('postona_x_resv.list_reservations(text)'::pg_catalog.regprocedure, 'postona_x_resv.get_reservation(uuid)'::pg_catalog.regprocedure)
      union all
      select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) a), true);
end $$;

/** The caller's own rows of one account (empty for an account with none of theirs). The person session only; no service / account gate. */
create or replace function postona_x_resv.list_reservations(p_social_account_id text)
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

/** One reservation of the caller (another person's row or an unknown id: NOT_FOUND). The person session only; no service / account gate. */
create or replace function postona_x_resv.get_reservation(p_reservation_id uuid)
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

do $$
begin
  if (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      where p.oid in ('postona_x_resv.list_reservations(text)'::pg_catalog.regprocedure, 'postona_x_resv.get_reservation(uuid)'::pg_catalog.regprocedure)
      union all
      select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) a) is distinct from pg_catalog.current_setting('postona_resv_owner_read.acl', true) then
    raise exception 'G3_OWNER_READ_POSTCONDITION: an owner or ACL changed';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p where p.oid in ('postona_x_resv.list_reservations(text)'::pg_catalog.regprocedure, 'postona_x_resv.get_reservation(uuid)'::pg_catalog.regprocedure)
             and (p.prosrc !~ 'G3_OWNER_READ' or not p.prosecdef or p.provolatile <> 's')) then
    raise exception 'G3_OWNER_READ_POSTCONDITION: not applied';
  end if;
end $$;

commit;
