-- NOT A MIGRATION. G4 SOURCE CANDIDATE ONLY (G4-02 #7, Issue #561). Applies ON TOP OF the personal X build (001 + 002-004 + 005 g5pv).
-- The database's own answer to "does this database run G4's personal-MVP X SQL?", for the X Edge entry (x-oauth-connect-user): it
-- calls this first, with the caller's JWT, on every start and callback, BEFORE GoTrue, the X code exchange and any database write.
--
--   public.postona_x_connect_profile_v1() returns text   -- 'personal' or 'mismatch'; nothing else, never a reason
--
-- 'personal' only when ALL hold, read from the catalog in one statement:
--   * F5's owner epoch function does not exist (G5: the two profiles exclude each other);
--   * begin / complete / consume are exactly the reviewed 005 bodies, and require_owner_epoch is exactly the personal build's body
--     (the one thing that differs from the full profile: md5 of prosrc), each the only function of that name;
--   * G5's MV exists, and it and the helper are callable by their owner only;
--   * all of them share one owner, and that owner is not a superuser.
-- This function exists only in the personal build, so a FULL or a not-installed database answers PostgREST's 404 and the entry refuses.
--
-- New surface, and all of it: EXECUTE on this one function to `authenticated` (not anon, not service_role). SECURITY INVOKER, STABLE,
-- no table is read, nothing is written, and it reads only pg_catalog, which that role can already read: no new SECURITY DEFINER path,
-- no new data. A signed-in person learns one word about the deployment. Rollback: 006_x_connect_profile_fence_rollback.sql.

begin;
set local lock_timeout = '2s';
set local search_path = '';

do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
begin
  if (select rolsuper from pg_catalog.pg_roles where oid = v_me) then
    raise exception 'G4X_FENCE_PRECONDITION_OWNER';
  end if;
  if to_regprocedure('private.account_lifecycle_brand_owner_epoch(text)') is not null then
    raise exception 'G4X_FENCE_PRECONDITION_FULL_PROFILE';
  end if;
  if to_regprocedure('postona_g4_x_oauth.require_owner_epoch(text)') is null then
    raise exception 'G4X_FENCE_PRECONDITION_X_NOT_INSTALLED';
  end if;
  if to_regprocedure('public.postona_x_connect_profile_v1()') is not null then
    raise exception 'G4X_FENCE_ALREADY_APPLIED';
  end if;
end $$;

create function public.postona_x_connect_profile_v1() returns text
language sql stable security invoker set search_path = ''
as $$
  with expected (schema_name, function_name, body_md5) as (values
    ('public', 'begin_social_mobile_x_oauth_connection', '6a8b35ee440846d9f0a1be275d0a5a07'),
    ('public', 'complete_social_mobile_x_oauth_connection', '5a3eb3092920acae7875c8341cf5d772'),
    ('public', 'consume_social_mobile_x_oauth_state', '391e389ede2f220cd4b9ee5875a8f765'),
    ('postona_g4_x_oauth', 'require_owner_epoch', 'f29631045cfe8d8fa808eec17d5cd588'),
    ('private', 'postona_personal_worker_verdict', null)
  ), found as (
    select e.function_name, e.body_md5, p.oid, p.proowner, p.proacl, p.prosrc
      from expected e
      join pg_catalog.pg_namespace n on n.nspname = e.schema_name
      join pg_catalog.pg_proc p on p.pronamespace = n.oid and p.proname = e.function_name
  )
  select case when
    not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'private' and p.proname = 'account_lifecycle_brand_owner_epoch')
    and (select count(*) from found) = 5
    and (select count(distinct function_name) from found) = 5
    and not exists (select 1 from found f where f.body_md5 is not null and pg_catalog.md5(f.prosrc) is distinct from f.body_md5)
    and (select count(distinct proowner) from found) = 1
    and not exists (select 1 from found f join pg_catalog.pg_roles r on r.oid = f.proowner where r.rolsuper)
    and not exists (select 1 from found f where f.function_name in ('require_owner_epoch', 'postona_personal_worker_verdict') and f.proacl is null)
    and not exists (select 1 from found f, pg_catalog.aclexplode(f.proacl) a
                     where f.function_name in ('require_owner_epoch', 'postona_personal_worker_verdict') and a.grantee <> f.proowner)
  then 'personal' else 'mismatch' end
$$;

revoke all on function public.postona_x_connect_profile_v1() from public, anon, authenticated, service_role;
grant execute on function public.postona_x_connect_profile_v1() to authenticated;

do $$
declare
  v_fn regprocedure := to_regprocedure('public.postona_x_connect_profile_v1()');
begin
  if (select p.prosecdef or p.provolatile <> 's' from pg_catalog.pg_proc p where p.oid = v_fn) then
    raise exception 'G4X_FENCE_POSTCONDITION_FUNCTION';
  end if;
  if public.postona_x_connect_profile_v1() is distinct from 'personal' then
    raise exception 'G4X_FENCE_POSTCONDITION_NOT_PERSONAL';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
              where p.oid = v_fn and a.grantee not in (p.proowner, 'authenticated'::regrole))
     or pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception 'G4X_FENCE_POSTCONDITION_ACL';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
