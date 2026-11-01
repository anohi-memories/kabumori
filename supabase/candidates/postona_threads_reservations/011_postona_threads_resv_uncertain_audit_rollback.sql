-- G3 SOURCE CANDIDATE (2026-10-29, Issue #318 G3-43): rollback of 011_postona_threads_resv_uncertain_audit.sql. NOT applied anywhere.
-- Drops the lease-expired audit trigger and its function. Rows are not touched; the audit rows the trigger wrote stay (codes and times only).
-- Refuses (nothing changed) when: 011 is not applied, or only part of it is there; the caller is a superuser or does not own the schema and
-- the table. Postconditions: no trigger, no function, the table's owner and ACL unchanged.

begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn boolean := pg_catalog.to_regprocedure('postona_threads_resv.audit_lease_expired()') is not null;
  v_trigger boolean := exists (select 1 from pg_catalog.pg_trigger t
                               where t.tgrelid = pg_catalog.to_regclass('postona_threads_resv.reservations') and t.tgname = 'reservations_lease_expired_audit');
begin
  if not (v_fn or v_trigger) then
    raise exception 'G3_THREADS_LEASE_AUDIT_ROLLBACK_NOT_APPLIED';
  end if;
  if not (v_fn and v_trigger) then
    raise exception 'G3_THREADS_LEASE_AUDIT_ROLLBACK_PARTIAL_STATE';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_threads_resv') is distinct from v_owner
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'postona_threads_resv.reservations'::pg_catalog.regclass) is distinct from v_owner then
    raise exception 'G3_THREADS_LEASE_AUDIT_ROLLBACK_OWNER';
  end if;
  perform pg_catalog.set_config('postona_threads_lease_audit.acl', (
    select c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
    where c.oid = 'postona_threads_resv.reservations'::pg_catalog.regclass), true);
end $$;

drop trigger reservations_lease_expired_audit on postona_threads_resv.reservations;
drop function postona_threads_resv.audit_lease_expired();

do $$
begin
  if (select c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      where c.oid = 'postona_threads_resv.reservations'::pg_catalog.regclass)
     is distinct from pg_catalog.current_setting('postona_threads_lease_audit.acl', true) then
    raise exception 'G3_THREADS_LEASE_AUDIT_ROLLBACK_POSTCONDITION: an owner or ACL changed';
  end if;
  if pg_catalog.to_regprocedure('postona_threads_resv.audit_lease_expired()') is not null
     or exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'postona_threads_resv.reservations'::pg_catalog.regclass
                and t.tgname = 'reservations_lease_expired_audit') then
    raise exception 'G3_THREADS_LEASE_AUDIT_ROLLBACK_POSTCONDITION: still applied';
  end if;
end $$;

commit;
