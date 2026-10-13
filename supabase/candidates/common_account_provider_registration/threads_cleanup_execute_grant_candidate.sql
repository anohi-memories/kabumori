-- SOURCE CANDIDATE ONLY. NOT a migration, NOT applied anywhere. Apply as a single reviewed file, after F4's
-- Threads cleanup candidate (supabase/candidates/postona_threads_cleanup/, PR #169) and Phase 6
-- (20261013120000), in the same step as the registration (provider_registry.threads.candidate.ts).
--
-- G5's account-delete Edge function calls POSTONA's Threads cleanup through two owner-only database functions
-- over the Data API with its service credential. F4 ships them with EXECUTE for the owner only and asks G5 to
-- grant the deletion role; this file is that grant, and nothing else:
--
--   public.threads_provider_connection_state(uuid)    read: 'connected' | 'not_connected'
--   public.cleanup_threads_provider_footprint(uuid)   the one removal transaction
--
-- NOT granted: public.threads_cleanup_authorized(uuid) (an internal predicate of F4's function; it stays
-- owner-only). Not granted to anon, authenticated or PUBLIC, ever. Until applied, the adapter's calls are refused
-- and it answers "unreadable" (fail closed: the deletion stops, nothing is removed).
--
-- Guarded by the exact signatures: a missing function, one owned by someone else, or one already reachable by an
-- API role refuses the apply with a fixed code before any grant.
begin;

do $$
declare
  v_fn regprocedure;
  v_owner oid;
begin
  foreach v_fn in array array[
    to_regprocedure('public.threads_provider_connection_state(uuid)'),
    to_regprocedure('public.cleanup_threads_provider_footprint(uuid)'),
    to_regprocedure('public.threads_cleanup_authorized(uuid)')] loop
    if v_fn is null then
      raise exception 'THREADS_CLEANUP_GRANT_PRECONDITION_FUNCTION_MISSING';
    end if;
    select p.proowner into v_owner from pg_proc p where p.oid = v_fn;
    if v_owner is distinct from (select r.oid from pg_roles r where r.rolname = current_user) then
      raise exception 'THREADS_CLEANUP_GRANT_PRECONDITION_OWNER';
    end if;
    if exists (select 1 from pg_roles r
                where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                  and has_function_privilege(r.oid, v_fn, 'EXECUTE'))
       or has_function_privilege('public', v_fn, 'EXECUTE') then
      raise exception 'THREADS_CLEANUP_GRANT_PRECONDITION_ALREADY_REACHABLE';
    end if;
  end loop;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise exception 'THREADS_CLEANUP_GRANT_PRECONDITION_ROLE';
  end if;
end;
$$;

grant execute on function public.threads_provider_connection_state(uuid) to service_role;
grant execute on function public.cleanup_threads_provider_footprint(uuid) to service_role;

do $$
declare v_fn regprocedure;
begin
  foreach v_fn in array array[
    'public.threads_provider_connection_state(uuid)'::regprocedure,
    'public.cleanup_threads_provider_footprint(uuid)'::regprocedure] loop
    if not has_function_privilege('service_role', v_fn, 'EXECUTE')
       or exists (select 1 from pg_roles r where r.rolname in ('anon', 'authenticated', 'authenticator') and has_function_privilege(r.oid, v_fn, 'EXECUTE'))
       or has_function_privilege('public', v_fn, 'EXECUTE') then
      raise exception 'THREADS_CLEANUP_GRANT_POSTCONDITION';
    end if;
  end loop;
  if exists (select 1 from pg_roles r
              where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                and has_function_privilege(r.oid, 'public.threads_cleanup_authorized(uuid)'::regprocedure, 'EXECUTE')) then
    raise exception 'THREADS_CLEANUP_GRANT_POSTCONDITION_INTERNAL';
  end if;
end;
$$;

commit;
