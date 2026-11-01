-- G3 SOURCE CANDIDATE (2026-10-29, Issue #318 G3-43): one audit row when a Threads lease runs out. NOT applied anywhere.
-- Applied after 007 (and 009 when the personal MVP profile is in use); rolled back with 011_..._rollback.sql.
-- claim_due fences a claimed row whose lease ran out to uncertain (it may have reached Threads; never claimed again) with no audit row
-- today. Now each such change leaves one: action lease_expired_uncertain, the worker name and the lease end -- no post text, no token.
-- What an uncertain row finally becomes (sent or not; kept or deleted) is NOT decided here (PENDING_POLICY); nothing is re-sent.
-- The person's cancel is unchanged: 007's cancel_reservation already needs only the person session and the own planned row, so it works
-- after the service ended too.
-- Refuses (nothing changed) when: already applied; the caller is a superuser or does not own the schema and the table.
-- Postconditions: the table's owner and ACL unchanged, the trigger function reachable by no API / worker role.

begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  if pg_catalog.to_regclass('postona_threads_resv.reservations') is null
     or pg_catalog.to_regprocedure('postona_threads_resv.audit_lease_expired()') is not null
     or exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'postona_threads_resv.reservations'::pg_catalog.regclass
                and t.tgname = 'reservations_lease_expired_audit') then
    raise exception 'G3_THREADS_LEASE_AUDIT_BASE_UNKNOWN';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_threads_resv') is distinct from v_owner
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'postona_threads_resv.reservations'::pg_catalog.regclass) is distinct from v_owner then
    raise exception 'G3_THREADS_LEASE_AUDIT_OWNER';
  end if;
  perform pg_catalog.set_config('postona_threads_lease_audit.acl', (
    select c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
    where c.oid = 'postona_threads_resv.reservations'::pg_catalog.regclass), true);
end $$;

/** One audit row when a claimed row's lease ran out and it became uncertain. Codes and times only. */
create function postona_threads_resv.audit_lease_expired() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
-- G3_LEASE_EXPIRED_AUDIT (G3-43)
begin
  insert into postona_threads_resv.audit (user_id, reservation_id, action, detail)
  values (new.user_id, new.id, 'lease_expired_uncertain',
          pg_catalog.jsonb_build_object('worker', old.claimed_by, 'lease_expires_at', old.lease_expires_at));
  return null;
end $$;
revoke all on function postona_threads_resv.audit_lease_expired() from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;

create trigger reservations_lease_expired_audit after update of status on postona_threads_resv.reservations
for each row when (old.status = 'claimed' and new.status = 'uncertain' and new.outcome_code is not distinct from 'LEASE_EXPIRED')
execute function postona_threads_resv.audit_lease_expired();

do $$
declare v_role text;
begin
  if (select c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      where c.oid = 'postona_threads_resv.reservations'::pg_catalog.regclass)
     is distinct from pg_catalog.current_setting('postona_threads_lease_audit.acl', true) then
    raise exception 'G3_THREADS_LEASE_AUDIT_POSTCONDITION: an owner or ACL changed';
  end if;
  foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'postona_resv_api', 'postona_resv_worker'] loop
    if pg_catalog.has_function_privilege(v_role, 'postona_threads_resv.audit_lease_expired()', 'EXECUTE') then
      raise exception 'G3_THREADS_LEASE_AUDIT_POSTCONDITION: % executes the audit trigger function', v_role;
    end if;
  end loop;
  if not exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'postona_threads_resv.reservations'::pg_catalog.regclass
                 and t.tgname = 'reservations_lease_expired_audit' and t.tgenabled = 'O') then
    raise exception 'G3_THREADS_LEASE_AUDIT_POSTCONDITION: not applied';
  end if;
end $$;

commit;
