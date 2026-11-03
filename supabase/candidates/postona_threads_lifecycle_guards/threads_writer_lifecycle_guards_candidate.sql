-- SOURCE CANDIDATE ONLY. NOT a migration, NOT applied anywhere (F4,
-- postona-f4-threads-t13-authenticated-writer-integration-20261013). Apply as a single reviewed file AFTER:
-- G5 Phase 3b writer guard (20261010051938), G5 Phase 4 (20261012130000), F5 workspace service state
-- (20261012230000, PR #165), and the G4 publish stack (custody -> manual publish -> release). Refuses to install
-- without them, or over a drifted copy of the two functions it replaces.
--
-- POSTONA Threads: every AUTHENTICATED Threads writer and its lifecycle guard (full inventory:
-- docs/postona/threads-t13-writer-guards-v1.md):
--
--   OAuth begin / consume / complete (PR #124, called through H5's owner channel with the person's claims)
--     T13 first (already, in each function and in H5's assert_actor) -> session FOR SHARE (H5) -> workspace.
--     The workspace is the caller's own deterministic one and PR #124's provisioner refuses a shared one, so
--     the caller IS the workspace owner: the F5 owner check would decide nothing new. Unchanged here; proven
--     against the real G5 guard by supabase/tests/postona_threads_t13_run.sh.
--   Manual publish permission ON, begin, release (the step that hands the token out)
--     T13 for the CALLER (already) + NEW here: the F5 decision for the WORKSPACE OWNER
--     (private.account_lifecycle_assert_brand_service_active, PR #165), taken BEFORE any workspace or account
--     row lock, so the lifecycle locks come first as in G5's Phase 4 order, and kept to COMMIT. An admin whose
--     own POSTONA is active can no longer publish to (or enable publishing on) a workspace whose owner's
--     POSTONA ended, is suspended, is being deleted or whose owner is ambiguous.
--   Manual publish permission OFF, record result — no lifecycle refusal (withdrawing and recording the facts
--     of a post that may exist must stay possible). Unchanged.
--   Threads disconnect (threads_disconnect_candidate.sql) — G5's Phase 4 decision with a REMOVAL policy:
--     allowed while POSTONA is active, suspended, ended or not registered; refused while a deletion is open
--     (its cleanup owns the removal under G5's lease) or the account is locked.
--   Deletion cleanup (threads_provider_cleanup_candidate.sql) — G5's lease, no T13. Unchanged.
--
-- Codes: the F5 refusals map onto the publish contract's existing fixed codes (no new client code):
--   WORKSPACE_OWNER_UNKNOWN -> WORKSPACE_INACTIVE; SERVICE_NOT_REGISTERED / SERVICE_NOT_ACTIVE /
--   ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND -> SERVICE_NOT_ACTIVE; ACCOUNT_LIFECYCLE_BUSY or any lock timeout /
--   deadlock -> BUSY; everything else (deletion in progress, locked, invalid) -> ACCOUNT_LIFECYCLE_BLOCKED.
--
-- A caller who is not a member of the account's workspace is refused BEFORE the owner's lifecycle rows are
-- touched: naming another workspace's account never queues on its owner's account row (G5's rule).
--
-- Not closed (and not claimed): no database lock spans the Threads HTTP call. A freeze that commits after the
-- release committed cannot stop that one released request; every later step needs a new release.
begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_owner oid;
  v_fn regprocedure;
begin
  if pg_catalog.to_regprocedure('public.threads_manual_publish_owner_fence(text)') is not null then
    raise exception 'THREADS_GUARDS_PRECONDITION_ALREADY_APPLIED';
  end if;
  select c.relowner into v_owner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass;
  if v_owner is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
     or (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'THREADS_GUARDS_PRECONDITION_OWNER';
  end if;
  -- G5: the caller's writer guard (T13) and the workspace owner's ordering decision (F5), owned by the table
  -- owner and reachable by no API role, directly or through a membership.
  foreach v_fn in array array[pg_catalog.to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)'),
                              pg_catalog.to_regprocedure('private.account_lifecycle_assert_brand_service_active(text,text)')] loop
    if v_fn is null
       or (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner
       or (select p.prorettype from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from 'void'::regtype
       or exists (select 1 from pg_catalog.pg_roles r
                  where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                    and (pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE') or pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER'))) then
      raise exception 'THREADS_GUARDS_PRECONDITION_G5';
    end if;
  end loop;
  -- The publish stack, exactly as G4's release candidate left it (the two replaced bodies are pinned).
  if pg_catalog.to_regprocedure('public.release_threads_manual_publish_step(uuid,text,bigint,text,text)') is null
     or pg_catalog.to_regprocedure('public.begin_threads_manual_publish(text,uuid,text)') is null
     or pg_catalog.to_regprocedure('public.threads_manual_publish_fence(uuid)') is null
     or pg_catalog.to_regprocedure('public.threads_manual_publish_refused(text)') is null
     or pg_catalog.to_regprocedure('public.threads_account_credential_expires_at(text)') is null then
    raise exception 'THREADS_GUARDS_PRECONDITION_PUBLISH_STACK';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure('public.threads_manual_publish_authorize(uuid,text,boolean)'))
       is distinct from '8e97121f49f5b934dda0408f9b4044e9'
     or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
         where p.oid = pg_catalog.to_regprocedure('public.set_threads_manual_publish_permission(text,boolean,boolean)'))
       is distinct from '8efb2377340025b9d3b37e3e198c83e6' then
    raise exception 'THREADS_GUARDS_PRECONDITION_DRIFT';
  end if;
end $$;

-- The workspace OWNER's POSTONA service (F5), as one of the publish contract's fixed codes, or null. Its locks
-- (owner login KEY SHARE -> owner common account FOR UPDATE -> owner entitlement FOR UPDATE) are kept to the
-- end of the caller's transaction when it answers null; a refusal changes nothing.
create function public.threads_manual_publish_owner_fence(p_brand_id text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform private.account_lifecycle_assert_brand_service_active(p_brand_id, 'x_autopost');
  exception
    when sqlstate '42501' or sqlstate 'P0001' then
      return case
        when sqlerrm = 'WORKSPACE_OWNER_UNKNOWN' then 'WORKSPACE_INACTIVE'
        when sqlerrm in ('SERVICE_NOT_REGISTERED', 'SERVICE_NOT_ACTIVE', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND') then 'SERVICE_NOT_ACTIVE'
        else 'ACCOUNT_LIFECYCLE_BLOCKED' end;
    when lock_not_available or deadlock_detected then
      -- ACCOUNT_LIFECYCLE_BUSY (55P03) or any other timed-out wait: retryable, nothing was decided.
      return 'BUSY';
    when others then
      return 'ACCOUNT_LIFECYCLE_BLOCKED';
  end;
  return null;
end;
$$;

-- G4's release-candidate rule, unchanged except for the owner check (marked F4) before the first row lock.
create or replace function public.threads_manual_publish_authorize(p_user uuid, p_social_account_id text, p_require_permission boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_brand_id text;
  v_brand public.brands%rowtype;
  v_role text;
  v_account public.social_accounts%rowtype;
  v_code text;
begin
  select a.brand_id into v_brand_id from public.social_accounts a where a.id = p_social_account_id;
  if v_brand_id is null then return 'ACCOUNT_NOT_FOUND'; end if;
  -- F4: a non-member never reaches the owner's lifecycle rows; then the workspace owner's POSTONA (F5),
  -- lifecycle locks before the workspace / account row locks below.
  if not exists (select 1 from public.brand_memberships m where m.brand_id = v_brand_id and m.user_id = p_user) then
    return 'ACCOUNT_NOT_FOUND';
  end if;
  v_code := public.threads_manual_publish_owner_fence(v_brand_id);
  if v_code is not null then return v_code; end if;
  select b.* into v_brand from public.brands b where b.id = v_brand_id for share;
  select m.role into v_role from public.brand_memberships m where m.brand_id = v_brand_id and m.user_id = p_user for share;
  if v_role is null then return 'ACCOUNT_NOT_FOUND'; end if;
  select a.* into v_account from public.social_accounts a where a.id = p_social_account_id for share;
  if v_account.id is null or v_account.brand_id is distinct from v_brand_id then return 'ACCOUNT_NOT_FOUND'; end if;
  if v_role not in ('owner', 'admin') then return 'PUBLISH_FORBIDDEN'; end if;
  if v_brand.code_profile_key is distinct from 'social_mobile_user_v1' then return 'WORKSPACE_INACTIVE'; end if;
  if v_account.platform is distinct from 'threads' then return 'PLATFORM_NOT_SUPPORTED'; end if;
  if v_account.connection_status is distinct from 'identity_verified' or v_account.verified_at is null
     or coalesce(v_account.platform_user_id, '') !~ '^[1-9][0-9]{0,31}$' then
    return 'CONNECTION_NOT_VERIFIED';
  end if;
  if v_account.vault_access_token_secret_id is null then return 'CREDENTIALS_MISSING'; end if;
  if coalesce(public.threads_account_credential_expires_at(p_social_account_id), '-infinity') <= pg_catalog.now() + interval '5 minutes' then
    return 'CREDENTIALS_EXPIRED';
  end if;
  if p_require_permission and not exists (
       select 1 from public.social_account_manual_publish_permissions p
       where p.social_account_id = p_social_account_id and p.brand_id = v_brand_id for share) then
    return 'MANUAL_PUBLISH_NOT_PERMITTED';
  end if;
  return null;
end;
$$;

-- PR #140's permission switch, unchanged except for the owner check (marked F4) when turning it ON, before the
-- workspace row lock. Turning it OFF stays possible in every lifecycle state.
create or replace function public.set_threads_manual_publish_permission(p_social_account_id text, p_desired boolean, p_expected boolean)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_user uuid := auth.uid();
  v_code text;
  v_brand_id text;
  v_role text;
  v_current boolean;
begin
  if v_user is null then return public.threads_manual_publish_refused('AUTH_REQUIRED'); end if;
  if p_social_account_id is null or p_social_account_id !~ '^[a-z][a-z0-9_]{1,80}$' or p_desired is null or p_expected is null then
    return public.threads_manual_publish_refused('REQUEST_INVALID');
  end if;
  if p_desired then
    v_code := public.threads_manual_publish_fence(v_user);
    if v_code is not null then return public.threads_manual_publish_refused(v_code); end if;
  end if;
  select a.brand_id into v_brand_id from public.social_accounts a where a.id = p_social_account_id;
  if v_brand_id is null then return public.threads_manual_publish_refused('ACCOUNT_NOT_FOUND'); end if;
  if p_desired then
    -- F4: the workspace owner's POSTONA (F5), for a member only, before the workspace row lock.
    if not exists (select 1 from public.brand_memberships m where m.brand_id = v_brand_id and m.user_id = v_user) then
      return public.threads_manual_publish_refused('ACCOUNT_NOT_FOUND');
    end if;
    v_code := public.threads_manual_publish_owner_fence(v_brand_id);
    if v_code is not null then return public.threads_manual_publish_refused(v_code); end if;
  end if;
  perform 1 from public.brands b where b.id = v_brand_id for share;
  select m.role into v_role from public.brand_memberships m where m.brand_id = v_brand_id and m.user_id = v_user for share;
  if v_role is null then return public.threads_manual_publish_refused('ACCOUNT_NOT_FOUND'); end if;
  if v_role not in ('owner', 'admin') then return public.threads_manual_publish_refused('PUBLISH_FORBIDDEN'); end if;
  perform 1 from public.social_accounts a where a.id = p_social_account_id and a.brand_id = v_brand_id for share;
  if not found then return public.threads_manual_publish_refused('ACCOUNT_NOT_FOUND'); end if;
  v_current := exists (select 1 from public.social_account_manual_publish_permissions p
                       where p.social_account_id = p_social_account_id for update);
  if v_current is distinct from p_expected then
    return pg_catalog.jsonb_build_object('status', 'stale', 'permitted', v_current);
  end if;
  if v_current = p_desired then
    return pg_catalog.jsonb_build_object('status', 'unchanged', 'permitted', v_current);
  end if;
  if not p_desired then
    -- Withdrawing is always possible for an owner/admin; it cancels nothing already sent.
    delete from public.social_account_manual_publish_permissions p where p.social_account_id = p_social_account_id;
    return pg_catalog.jsonb_build_object('status', 'updated', 'permitted', false);
  end if;
  v_code := public.threads_manual_publish_authorize(v_user, p_social_account_id, false);
  if v_code is not null then return public.threads_manual_publish_refused(v_code); end if;
  insert into public.social_account_manual_publish_permissions (social_account_id, brand_id, granted_by)
  values (p_social_account_id, v_brand_id, v_user);
  return pg_catalog.jsonb_build_object('status', 'updated', 'permitted', true);
exception
  when lock_not_available or deadlock_detected or unique_violation then
    return public.threads_manual_publish_refused('BUSY');
  when raise_exception then
    -- The deletion guard (SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS) or another reviewed guard.
    return public.threads_manual_publish_refused('ACCOUNT_LIFECYCLE_BLOCKED');
end;
$$;

revoke all on function public.threads_manual_publish_owner_fence(text) from public, anon, authenticated, service_role;

-- Postcondition: the new fence and the replaced rule are owner-only; the permission switch keeps exactly its
-- previous reach (authenticated, nobody else); all three are definer with an empty search_path.
do $$
begin
  if exists (select 1 from (values ('anon'::name), ('authenticated'::name), ('service_role'::name)) a(app),
                           (values ('public.threads_manual_publish_owner_fence(text)'),
                                   ('public.threads_manual_publish_authorize(uuid,text,boolean)')) f(fn)
             where pg_catalog.has_function_privilege(a.app, f.fn::regprocedure, 'EXECUTE'))
     or not pg_catalog.has_function_privilege('authenticated', 'public.set_threads_manual_publish_permission(text,boolean,boolean)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.set_threads_manual_publish_permission(text,boolean,boolean)', 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', 'public.set_threads_manual_publish_permission(text,boolean,boolean)', 'EXECUTE')
     or exists (select 1 from pg_catalog.pg_proc p
                where p.oid in ('public.threads_manual_publish_owner_fence(text)'::regprocedure,
                                'public.threads_manual_publish_authorize(uuid,text,boolean)'::regprocedure,
                                'public.set_threads_manual_publish_permission(text,boolean,boolean)'::regprocedure)
                  and (not p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'], false))) then
    raise exception 'THREADS_GUARDS_POSTCONDITION_ACL';
  end if;
end $$;

commit;
