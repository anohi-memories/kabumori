-- G5 SOURCE CANDIDATE (2026-10-28, Issue #320 G5-01 task 46). NOT in supabase/migrations/, NOT applied anywhere. Part of the PERSONAL MVP
-- profile (../MVP_INSTALL.sql); installable alone for tests. Production NO_GO without one independent review of this profile, the G5 担当ちゃ's
-- acceptance and the owner's explicit production approval.
--
-- MV  private.postona_personal_worker_verdict(uuid, text, text, bigint) -> text            EXECUTE: the lifecycle owner ONLY (no grant)
--     The personal-MVP fence for a job that runs WITHOUT the person (a scheduled X / Threads post): may the job made for (user, workspace) at
--     lifecycle_version V still run now? 'active' only when ALL of:
--       1. the workspace is the user's PERSONAL one ('u_' || substr(md5(user), 1, 24)) -- the binding is derived, never stored;
--       2. S2-3 answers 'own' for the user: kind social_mobile_user_v1, exactly ONE membership (the user as owner), no other owned brand;
--       3. F5 P5's workspace service state is 'active' (account active, not deleting / locked, x_autopost active, no service deletion);
--       4. the service generation is still V (common_accounts.lifecycle_version: every account / entitlement change bumps it, so an end, a
--          restart, a lock or a deletion makes every earlier job stale) and its two triggers are exactly P1's (generation_covered);
--     otherwise the first failing reason. One snapshot (STABLE), every row visible (row_security = off), no lock, no write.
--     It does NOT use the brand owner epoch (PR #285 / #303 / #457): in the personal MVP the owner is fixed by the derived id and the exact
--     single membership, checked on every call. What that cannot see -- an owner change that is UNDONE between the job's creation and its run
--     (A -> B -> A, only possible today through service_role or the owner writing public.brand_memberships) -- is the MVP's stated residual
--     (docs/common-account/g5-46-postona-personal-mvp-auth.md section 3).
--     Not covered here (their owners' fences): a session ending (P-4, user decision), the SNS connection generation (G4), duplicate sends (G3).
-- Rollback: RM10_personal_worker_verdict_rollback.sql (refuses while anything calls it).
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'MV_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if pg_catalog.to_regprocedure('private.postona_personal_worker_verdict(uuid,text,text,bigint)') is not null then
    raise exception 'MV_PRECONDITION_NAME_TAKEN';
  end if;
  -- what it reads: S2-3, P5's state, the generation coverage -- each the lifecycle owner's, definer, empty search_path, executable by its owner only
  foreach v_fn in array array['private.postona_personal_workspace_eligibility(uuid)', 'public.common_account_brand_service_state(text,text)',
                              'private.account_lifecycle_generation_covered()']::regprocedure[] loop
    if v_fn is null or not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.proowner = v_owner and p.prosecdef
                                     and p.proconfig @> array['search_path=""']) then
      raise exception 'MV_PRECONDITION_DEPENDENCY %', v_fn;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) x
              where p.oid in ('private.postona_personal_workspace_eligibility(uuid)'::regprocedure, 'private.account_lifecycle_generation_covered()'::regprocedure)
                and x.grantee <> p.proowner)
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.oid in ('private.postona_personal_workspace_eligibility(uuid)'::regprocedure, 'private.account_lifecycle_generation_covered()'::regprocedure)
                   and p.proacl is null) then
    raise exception 'MV_PRECONDITION_DEPENDENCY_ACL';
  end if;
  if pg_catalog.to_regclass('public.common_accounts') is null
     or not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = 'public.common_accounts'::pg_catalog.regclass and not a.attisdropped
                     and a.attname = 'lifecycle_version' and a.atttypid = 'bigint'::pg_catalog.regtype) then
    raise exception 'MV_PRECONDITION_GENERATION_COLUMN';
  end if;
  if not private.account_lifecycle_generation_covered() then
    raise exception 'MV_PRECONDITION_LIFECYCLE_TRIGGERS';
  end if;
end $$;

create function private.postona_personal_worker_verdict(p_user_id uuid, p_brand_id text, p_service_key text, p_expected_lifecycle_version bigint)
returns text language plpgsql stable security definer set search_path = '' set row_security = off as $$
declare
  v_eligibility text;
  v_state text;
  v_lifecycle bigint;
  v_covered boolean;
begin
  if p_user_id is null or p_brand_id is null then
    return 'PERSONAL_WORKER_INPUT_REQUIRED';
  end if;
  if p_service_key is distinct from 'x_autopost' then
    return 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  if p_expected_lifecycle_version is null or p_expected_lifecycle_version < 1 then
    return 'EXPECTED_LIFECYCLE_VERSION_REQUIRED';
  end if;
  -- 1. the job's workspace must be the user's personal one (derived, as S2-3, the begin RPC and the deletion saga name it)
  if p_brand_id is distinct from 'u_' || pg_catalog.substr(pg_catalog.md5(p_user_id::text), 1, 24) then
    return 'NOT_PERSONAL_WORKSPACE';
  end if;
  -- 2-4. every fact in this one STABLE snapshot
  select private.postona_personal_workspace_eligibility(p_user_id),
         public.common_account_brand_service_state(p_brand_id, p_service_key),
         (select a.lifecycle_version from public.common_accounts a where a.user_id = p_user_id),
         private.account_lifecycle_generation_covered()
    into v_eligibility, v_state, v_lifecycle, v_covered;
  if v_eligibility is distinct from 'own' then
    return case v_eligibility when 'absent' then 'WORKSPACE_ABSENT' when 'WORKSPACE_OWNER_UNKNOWN' then 'WORKSPACE_OWNER_UNKNOWN'
                              else 'OWN_WORKSPACE_CONFLICT' end;
  end if;
  if v_state is distinct from 'active' then
    return case when v_state in ('WORKSPACE_OWNER_UNKNOWN', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', 'ACCOUNT_DELETION_IN_PROGRESS', 'ACCOUNT_LOCKED',
                                 'SERVICE_NOT_REGISTERED', 'SERVICE_DELETION_IN_PROGRESS', 'SERVICE_NOT_ACTIVE', 'ACCOUNT_LIFECYCLE_SERVICE_INVALID')
                then v_state else 'SERVICE_STATE_UNKNOWN' end;
  end if;
  if v_covered is not true then
    return 'SERVICE_GENERATION_UNAVAILABLE';
  end if;
  if v_lifecycle is distinct from p_expected_lifecycle_version then
    return 'SERVICE_GENERATION_CHANGED';
  end if;
  return 'active';
end $$;

revoke all on function private.postona_personal_worker_verdict(uuid, text, text, bigint) from public, anon, authenticated, service_role;

do $$
declare v_fn regprocedure := 'private.postona_personal_worker_verdict(uuid,text,text,bigint)'::regprocedure;
begin
  if (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from pg_catalog.format('%s=X/%s', current_user, current_user)
     or exists (select 1 from pg_catalog.pg_roles a join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
                 where a.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') and pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE')) then
    raise exception 'MV_POSTCONDITION_ACL';
  end if;
end $$;

commit;
