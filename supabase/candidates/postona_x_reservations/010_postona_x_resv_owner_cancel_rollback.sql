-- G3 SOURCE CANDIDATE (2026-10-29, Issue #318 G3-43): rollback of 010_postona_x_resv_owner_cancel.sql. NOT applied anywhere.
-- Restores 001's cancel verbatim (through lock_own: the service / account / G5 / G4 gate again) and drops the lease-expired audit trigger and
-- its function. Rows are not touched: cancelled rows stay cancelled, and the audit rows the trigger wrote stay (codes and times only).
-- Refuses (nothing changed) when: 010 is not applied, or only part of it is there; the caller is a superuser or does not own the schema, the
-- table and cancel. Postconditions: 001's cancel byte for byte, no trigger, cancel's and the table's owners and ACLs unchanged.

begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_cancel boolean := coalesce((select p.prosrc ~ 'G3_OWNER_CANCEL' from pg_catalog.pg_proc p
                                where p.oid = pg_catalog.to_regprocedure('postona_x_resv.cancel(uuid,integer)')), false);
  v_fn boolean := pg_catalog.to_regprocedure('postona_x_resv.audit_lease_expired()') is not null;
  v_trigger boolean := exists (select 1 from pg_catalog.pg_trigger t
                               where t.tgrelid = pg_catalog.to_regclass('postona_x_resv.reservations') and t.tgname = 'reservations_lease_expired_audit');
begin
  if not (v_cancel or v_fn or v_trigger) then
    raise exception 'G3_OWNER_CANCEL_ROLLBACK_NOT_APPLIED';
  end if;
  if not (v_cancel and v_fn and v_trigger) then
    raise exception 'G3_OWNER_CANCEL_ROLLBACK_PARTIAL_STATE';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from v_owner
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) is distinct from v_owner
     or (select p.proowner from pg_catalog.pg_proc p where p.oid = 'postona_x_resv.cancel(uuid,integer)'::pg_catalog.regprocedure) is distinct from v_owner then
    raise exception 'G3_OWNER_CANCEL_ROLLBACK_OWNER';
  end if;
  perform pg_catalog.set_config('postona_resv_owner_cancel.acl', (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      where p.oid = 'postona_x_resv.cancel(uuid,integer)'::pg_catalog.regprocedure
      union all
      select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) a), true);
end $$;

drop trigger reservations_lease_expired_audit on postona_x_resv.reservations;
drop function postona_x_resv.audit_lease_expired();

-- 001's cancel, verbatim
create or replace function postona_x_resv.cancel(p_reservation_id uuid, p_expected_revision integer)
returns setof postona_x_resv.reservation_view
language plpgsql volatile security definer set search_path = '' as $$
declare v_row postona_x_resv.reservations%rowtype;
begin
  v_row := postona_x_resv.lock_own(p_reservation_id, p_expected_revision);
  if v_row.status = 'claimed' then raise exception 'POSTONA_RESV_CANCEL_TOO_LATE' using errcode = 'P0001'; end if;
  if v_row.status <> 'planned' then raise exception 'POSTONA_RESV_ALREADY_FINAL' using errcode = 'P0001'; end if;
  update postona_x_resv.reservations r set status = 'cancelled', revision = r.revision + 1, updated_at = pg_catalog.now()
  where r.id = v_row.id;
  insert into postona_x_resv.audit (user_id, reservation_id, action, detail)
  values (v_row.user_id, v_row.id, 'cancel', pg_catalog.jsonb_build_object('from_revision', v_row.revision));
  return query select r.id, r.batch_id, r.draft_id, r.position, r.origin, r.mode, r.body, r.scheduled_at, r.fixed,
                      r.status, r.revision, r.consent_state from postona_x_resv.reservations r where r.id = v_row.id;
end $$;

do $$
declare v_acl text;
begin
  select pg_catalog.string_agg(x, '|' order by x) into v_acl from (
    select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
    where p.oid = 'postona_x_resv.cancel(uuid,integer)'::pg_catalog.regprocedure
    union all
    select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
    where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) a;
  if v_acl is distinct from pg_catalog.current_setting('postona_resv_owner_cancel.acl', true) then
    raise exception 'G3_OWNER_CANCEL_ROLLBACK_POSTCONDITION: an owner or ACL changed';
  end if;
  if pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = 'postona_x_resv.cancel(uuid,integer)'::pg_catalog.regprocedure))
       <> '9ac799ef3ee18dfad2800ed5557c1c0f'
     or exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'postona_x_resv.reservations'::pg_catalog.regclass
                and t.tgname = 'reservations_lease_expired_audit') then
    raise exception 'G3_OWNER_CANCEL_ROLLBACK_POSTCONDITION: not 001''s cancel';
  end if;
end $$;

commit;
