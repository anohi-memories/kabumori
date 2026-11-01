-- G3 SOURCE CANDIDATE (2026-10-29, Issue #318 G3-43): the person's own cancel without the service gate + an audit row when a lease runs out.
-- NOT applied anywhere. Applied after 001-006 (and 008 when the personal MVP profile is in use); rolled back with 010_..._rollback.sql.
--
-- 1. postona_x_resv.cancel: 001's cancel went through lock_own -> assert_account_access, so a person whose service ended (or whose X account
--    is no longer verified, or whose workspace changed) could not cancel their own planned row: it stayed planned, later expired, and kept
--    008's rollback refused (G3-42 finding). A cancel only ever stops a send, so it no longer asks G5 / G4 / the brand: the person session
--    (caller(), G5's S2-2 gate) is still required, the row must be the caller's own (another person's row: the same NOT_FOUND, never
--    locked), the revision must match, and only a planned row moves (to cancelled). claimed -> CANCEL_TOO_LATE; anything else ->
--    ALREADY_FINAL. Create, reschedule, reconfirm, claim and send keep every gate they had.
-- 2. reservations_lease_expired_audit: a claimed row whose lease ran out becomes uncertain (claim_due's sweep, single post's re-entry) with no
--    audit row today. Now each such change leaves one: action lease_expired_uncertain, the worker name and the lease end -- no post text.
--    What an uncertain row finally becomes (sent or not; kept or deleted) is NOT decided here (PENDING_POLICY); nothing is re-sent.
-- Refuses (nothing changed) when: 001's cancel is not there byte for byte (already applied, another version); the caller is a superuser or
-- does not own the schema, the table and cancel. Postconditions: cancel's and the table's owners and ACLs unchanged, the trigger function
-- reachable by no API / worker role.

begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_cancel oid := pg_catalog.to_regprocedure('postona_x_resv.cancel(uuid,integer)');
begin
  if v_cancel is null or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = v_cancel)) <> '9ac799ef3ee18dfad2800ed5557c1c0f'
     or pg_catalog.to_regprocedure('postona_x_resv.audit_lease_expired()') is not null then
    raise exception 'G3_OWNER_CANCEL_BASE_UNKNOWN';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from v_owner
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) is distinct from v_owner
     or (select p.proowner from pg_catalog.pg_proc p where p.oid = v_cancel) is distinct from v_owner then
    raise exception 'G3_OWNER_CANCEL_OWNER';
  end if;
  perform pg_catalog.set_config('postona_resv_owner_cancel.acl', (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      where p.oid = v_cancel
      union all
      select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) a), true);
end $$;

/** The person's own planned row -> cancelled. No service / account / G5 / G4 gate: a cancel only stops a send. */
create or replace function postona_x_resv.cancel(p_reservation_id uuid, p_expected_revision integer)
returns setof postona_x_resv.reservation_view
language plpgsql volatile security definer set search_path = '' as $$
-- G3_OWNER_CANCEL (G3-43)
declare v_user uuid := postona_x_resv.caller(); v_owner uuid; v_row postona_x_resv.reservations%rowtype;
begin
  -- 1. a plain read decides whose row this is (another person's row is never locked)
  select r.user_id into v_owner from postona_x_resv.reservations r where r.id = p_reservation_id;
  if not found or v_owner is distinct from v_user then
    raise exception 'POSTONA_RESV_NOT_FOUND' using errcode = 'P0001';
  end if;
  -- 2. the row under its lock, re-verified
  select r.* into v_row from postona_x_resv.reservations r where r.id = p_reservation_id for update;
  if not found or v_row.user_id is distinct from v_user then
    raise exception 'POSTONA_RESV_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_row.revision is distinct from p_expected_revision then
    raise exception 'POSTONA_RESV_STALE_REVISION' using errcode = 'P0001';
  end if;
  if v_row.status = 'claimed' then raise exception 'POSTONA_RESV_CANCEL_TOO_LATE' using errcode = 'P0001'; end if;
  if v_row.status <> 'planned' then raise exception 'POSTONA_RESV_ALREADY_FINAL' using errcode = 'P0001'; end if;
  update postona_x_resv.reservations r set status = 'cancelled', revision = r.revision + 1, updated_at = pg_catalog.now()
  where r.id = v_row.id;
  insert into postona_x_resv.audit (user_id, reservation_id, action, detail)
  values (v_row.user_id, v_row.id, 'cancel', pg_catalog.jsonb_build_object('from_revision', v_row.revision, 'gate', 'owner_only'));
  return query select r.id, r.batch_id, r.draft_id, r.position, r.origin, r.mode, r.body, r.scheduled_at, r.fixed,
                      r.status, r.revision, r.consent_state from postona_x_resv.reservations r where r.id = v_row.id;
end $$;

/** One audit row when a claimed row's lease ran out and it became uncertain. Codes and times only. */
create function postona_x_resv.audit_lease_expired() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
-- G3_LEASE_EXPIRED_AUDIT (G3-43)
begin
  insert into postona_x_resv.audit (user_id, reservation_id, action, detail)
  values (new.user_id, new.id, 'lease_expired_uncertain',
          pg_catalog.jsonb_build_object('worker', old.claimed_by, 'lease_expires_at', old.lease_expires_at));
  return null;
end $$;
revoke all on function postona_x_resv.audit_lease_expired() from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;

create trigger reservations_lease_expired_audit after update of status on postona_x_resv.reservations
for each row when (old.status = 'claimed' and new.status = 'uncertain' and new.outcome_code is not distinct from 'LEASE_EXPIRED')
execute function postona_x_resv.audit_lease_expired();

do $$
declare v_acl text; v_role text;
begin
  select pg_catalog.string_agg(x, '|' order by x) into v_acl from (
    select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
    where p.oid = 'postona_x_resv.cancel(uuid,integer)'::pg_catalog.regprocedure
    union all
    select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
    where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) a;
  if v_acl is distinct from pg_catalog.current_setting('postona_resv_owner_cancel.acl', true) then
    raise exception 'G3_OWNER_CANCEL_POSTCONDITION: an owner or ACL changed';
  end if;
  foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'postona_resv_api', 'postona_resv_worker'] loop
    if pg_catalog.has_function_privilege(v_role, 'postona_x_resv.audit_lease_expired()', 'EXECUTE') then
      raise exception 'G3_OWNER_CANCEL_POSTCONDITION: % executes the audit trigger function', v_role;
    end if;
  end loop;
  if (select p.prosrc !~ 'G3_OWNER_CANCEL' from pg_catalog.pg_proc p where p.oid = 'postona_x_resv.cancel(uuid,integer)'::pg_catalog.regprocedure)
     or not exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'postona_x_resv.reservations'::pg_catalog.regclass
                    and t.tgname = 'reservations_lease_expired_audit' and t.tgenabled = 'O') then
    raise exception 'G3_OWNER_CANCEL_POSTCONDITION: not applied';
  end if;
end $$;

commit;
