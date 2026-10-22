-- ISOLATED SOURCE CANDIDATE ONLY. NOT a migration, NOT applied anywhere, NOT adopted (G4-27, Issue #319,
-- postona-g4-threads-rotation-cas-lease-invalidation-isolated-source-candidate-20261023). Applied only to disposable
-- local PostgreSQL 17 databases by supabase/tests/postona_threads_lease_invalidation_run.sh. Adoption, an independent
-- security review and any production use are separate decisions.
--
-- Option A of docs/postona/threads-rotation-cas-remediation-options-20261022.md (G4-26): every write of a Threads
-- account's credential custody row ends that account's refresh lease. The rotation compare-and-set
-- (threads_credential_rotation_candidate.sql) compares the custody recorded_at, written with now() (the transaction
-- START). A reconnect whose transaction started in the same microsecond as the claimed version therefore carried the
-- same version and the stale refresh rotated over it (PR #453, R7 / collision). After this file the reconnect's custody
-- write deletes the lease in the reconnect's own transaction, so the stale rotate answers LEASE_NOT_HELD whatever the
-- clock says. It changes NO existing file, table or function: one new trigger function and two triggers on the custody
-- table. Apply only AFTER threads_credential_custody_candidate.sql and threads_credential_rotation_candidate.sql (the
-- reviewed bodies of claim / rotate / release are pinned by md5 below).
--
-- Choices (and why):
--   * SECURITY DEFINER, owned by the owner of the custody and lease tables, search_path = '', row_security = off:
--     the lease ends whoever writes custody. An invoker function run by a role that may DELETE leases but is subject to
--     the lease table's RLS (no policy) would delete nothing, silently; row_security = off turns any future forced RLS
--     into an error instead. The function is a trigger function (it cannot be called directly) and only DELETEs leases,
--     which can only make a refresh fail closed.
--   * AFTER INSERT OR UPDATE OR DELETE, FOR EACH ROW, plus AFTER TRUNCATE: every way the custody row changes.
--   * ENABLE ALWAYS: the triggers also fire under session_replication_role = replica.
--   * Lock order: the trigger runs after the custody row is written and locks only lease rows. Connect: account
--     (PR #124 complete) -> binding -> custody -> lease. claim / rotate: account FOR UPDATE -> custody -> lease. Every
--     path takes the account row first, so no new wait cycle.
--
-- Not closed here (and not claimed):
--   * The owner of the custody table (or a superuser) can DISABLE or DROP the trigger; while it is gone the finding
--     comes back. Detected only by the postcondition below and the audit in the runner, not at rotate time.
--   * A token change that writes no custody row (PR #124's complete on its own, an in-place Vault update) does not end
--     the lease. Option C (lease bound to bindings.oauth_state_id) or B (a version from a sequence) would; not adopted.
--   * H5 must read the token in the claim transaction and drop a refreshed token after a refusal (G4-26 §2.4).
begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_me oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_custody regclass := pg_catalog.to_regclass('public.threads_account_credential_custody');
  v_lease regclass := pg_catalog.to_regclass('public.threads_credential_refresh_leases');
begin
  if v_custody is null or v_lease is null then
    raise exception 'THREADS_LEASE_INVALIDATION_PRECONDITION_TABLES';
  end if;
  if (select c.relowner from pg_catalog.pg_class c where c.oid = v_custody) is distinct from v_me
     or (select c.relowner from pg_catalog.pg_class c where c.oid = v_lease) is distinct from v_me then
    raise exception 'THREADS_LEASE_INVALIDATION_PRECONDITION_OWNER';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
       where p.oid = pg_catalog.to_regprocedure('public.claim_threads_credential_refresh(text)')) is distinct from '2d5fdec6a3f9a1f7bab30e4f32b992ec'
     or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
          where p.oid = pg_catalog.to_regprocedure('public.rotate_threads_credential_custody(text,uuid,uuid,timestamp with time zone,timestamp with time zone)'))
        is distinct from '4de6764d8681c333c698a43fa0b8d01c'
     or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
          where p.oid = pg_catalog.to_regprocedure('public.release_threads_credential_refresh(text,uuid)')) is distinct from '94c68c16ac9563e1ca2ae3a39b8a4421' then
    raise exception 'THREADS_LEASE_INVALIDATION_PRECONDITION_ROTATION';
  end if;
  if pg_catalog.to_regprocedure('public.threads_credential_refresh_lease_invalidate()') is not null
     or exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = v_custody
                 and t.tgname in ('threads_credential_refresh_lease_invalidate_row', 'threads_credential_refresh_lease_invalidate_truncate')) then
    raise exception 'THREADS_LEASE_INVALIDATION_ALREADY_APPLIED';
  end if;
end $$;

create function public.threads_credential_refresh_lease_invalidate() returns trigger
language plpgsql security definer set search_path = '' set row_security = off as $$
begin
  if tg_op = 'TRUNCATE' then
    delete from public.threads_credential_refresh_leases;
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    delete from public.threads_credential_refresh_leases l where l.social_account_id = old.social_account_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    delete from public.threads_credential_refresh_leases l where l.social_account_id = new.social_account_id;
  end if;
  return null;
end $$;
revoke all on function public.threads_credential_refresh_lease_invalidate() from public, anon, authenticated, service_role;

create trigger threads_credential_refresh_lease_invalidate_row
  after insert or update or delete on public.threads_account_credential_custody
  for each row execute function public.threads_credential_refresh_lease_invalidate();
create trigger threads_credential_refresh_lease_invalidate_truncate
  after truncate on public.threads_account_credential_custody
  for each statement execute function public.threads_credential_refresh_lease_invalidate();
alter table public.threads_account_credential_custody enable always trigger threads_credential_refresh_lease_invalidate_row;
alter table public.threads_account_credential_custody enable always trigger threads_credential_refresh_lease_invalidate_truncate;

-- Postcondition: the function is the owner's alone, definer, with the fixed settings; both triggers exist on the
-- custody table, fire ALWAYS, and cover INSERT / UPDATE / DELETE (row) and TRUNCATE (statement); no API role can write
-- the custody table or touch the lease table.
do $$
declare
  v_fn regprocedure := 'public.threads_credential_refresh_lease_invalidate()'::regprocedure;
  v_custody regclass := 'public.threads_account_credential_custody'::regclass;
  v_lease regclass := 'public.threads_credential_refresh_leases'::regclass;
begin
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = v_fn and p.prosecdef and p.provolatile = 'v'
                    and p.proowner = (select c.relowner from pg_catalog.pg_class c where c.oid = v_custody)
                    and p.proconfig = array['search_path=""', 'row_security=off']
                    and not exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee <> p.proowner)) then
    raise exception 'THREADS_LEASE_INVALIDATION_POSTCONDITION_FUNCTION';
  end if;
  -- tgtype bits: 1 ROW, 4 INSERT, 8 DELETE, 16 UPDATE, 32 TRUNCATE; BEFORE (2) and INSTEAD (64) unset = AFTER.
  if not exists (select 1 from pg_catalog.pg_trigger t
                  where t.tgrelid = v_custody and t.tgname = 'threads_credential_refresh_lease_invalidate_row'
                    and t.tgfoid = v_fn and t.tgenabled = 'A' and t.tgtype = (1 | 4 | 8 | 16)
                    and not t.tgisinternal and t.tgqual is null and t.tgattr = ''::pg_catalog.int2vector)
     or not exists (select 1 from pg_catalog.pg_trigger t
                     where t.tgrelid = v_custody and t.tgname = 'threads_credential_refresh_lease_invalidate_truncate'
                       and t.tgfoid = v_fn and t.tgenabled = 'A' and t.tgtype = 32 and not t.tgisinternal) then
    raise exception 'THREADS_LEASE_INVALIDATION_POSTCONDITION_TRIGGER';
  end if;
  if exists (select 1 from pg_catalog.pg_roles r, unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p(priv)
              where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                and pg_catalog.has_table_privilege(r.oid, v_custody, p.priv))
     or exists (select 1 from pg_catalog.pg_roles r, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p(priv)
                 where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                   and pg_catalog.has_table_privilege(r.oid, v_lease, p.priv)) then
    raise exception 'THREADS_LEASE_INVALIDATION_POSTCONDITION_ACL';
  end if;
end $$;

commit;
