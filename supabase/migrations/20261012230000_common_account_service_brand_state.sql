-- SOURCE CANDIDATE ONLY. NOT applied to production. Independent review is mandatory before any apply;
-- apply as a single reviewed file (never db push), after the Phase 4 service fence (20261012130000).
--
-- Common account Phase 5 (F5): the service entitlement as seen from a WORKSPACE (brand), for workers that
-- act with no person's session.
--
-- Why. The X publish pipeline (supabase/functions/_shared/brand/vault_account_brand_post.ts, "Common-account
-- (G5) boundary -- NOT enforced here") is driven by service-role workers: public.check_x_account_publish_
-- authority (a STABLE SECURITY INVOKER predicate, evaluated before generation and again right before the X
-- create), public.set_x_account_publish_authority('enabled') and the due-post claim. None of them knows
-- whether the workspace owner's `x_autopost` entitlement is still active or whether the common account is
-- being deleted, and the Phase 3b writer guard cannot serve them: it needs the person's own JWT and live
-- session. This file gives them, as G5-owned primitives, the one decision they lack. It changes none of
-- their functions (those belong to the POSTONA owners); the exact call points are in
-- docs/common-account/phase5-app-integration.md.
--
--   1. private.account_lifecycle_brand_owner(p_brand_id) -> uuid
--        The person a workspace belongs to: ONLY a user workspace (code_profile_key 'social_mobile_user_v1')
--        with exactly one 'owner' membership. Zero or several owners, another kind of workspace, an unknown
--        brand: null (a refusal, never a guess).
--   2. private.account_lifecycle_service_state_readonly(p_user_id, p_service_key) -> text
--        The same decision as the Phase 4 locking one (null = active, else a fixed code), as a STABLE plain
--        read: no row lock, so it can sit inside a STABLE predicate or filter a planner scan. ADVISORY: a
--        freeze committing right after it is not seen by this call; it orders nothing.
--   3. public.common_account_brand_service_state(p_brand_id, p_service_key default 'x_autopost') -> text
--        brand -> owner -> readonly decision: 'active' or a fixed code (WORKSPACE_OWNER_UNKNOWN,
--        ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND, ACCOUNT_DELETION_IN_PROGRESS, ACCOUNT_LOCKED,
--        SERVICE_NOT_REGISTERED, SERVICE_DELETION_IN_PROGRESS, SERVICE_NOT_ACTIVE,
--        ACCOUNT_LIFECYCLE_SERVICE_INVALID). service_role only. For the predicate and the planner filter.
--   4. private.account_lifecycle_assert_brand_service_active(p_brand_id, p_service_key) -> void
--        The ordering variant for a VOLATILE reviewed writer (set_x_account_publish_authority 'enabled', a
--        claim that updates a row): resolves the owner and takes the Phase 4 lock order (login KEY SHARE ->
--        account FOR UPDATE -> entitlement FOR UPDATE), keeps the locks to the end of the caller's
--        transaction, raises a fixed code (SQLSTATE 42501; a timed-out lock wait is ACCOUNT_LIFECYCLE_BUSY,
--        SQLSTATE 55P03, retryable). Owner-only EXECUTE: reachable only from a definer writer owned by the
--        lifecycle owner.
--
-- What it does not do: it does not change any existing object, grant, policy or row; it does not stop a post
-- the X API already accepted (no database lock spans the HTTP call); it does not revoke an authority row (the
-- service-only deletion saga must, and is the POSTONA owners'). Nothing here touches Auth, Storage or Vault.

begin;

do $$
declare
  v_state regprocedure := to_regprocedure('private.account_lifecycle_service_state_refusal(uuid,text)');
begin
  if v_state is null
     or to_regclass('public.common_accounts') is null
     or to_regclass('public.service_entitlements') is null
     or to_regclass('private.account_lifecycle_operations') is null
     or to_regclass('public.brands') is null
     or to_regclass('public.brand_memberships') is null then
    raise exception 'COMMON_ACCOUNT_BRAND_STATE_PREFLIGHT_FOUNDATION_MISSING';
  end if;
  if (select count(*) from pg_attribute a
       where not a.attisdropped
         and ((a.attrelid = 'public.brands'::regclass and a.attname in ('id', 'code_profile_key'))
           or (a.attrelid = 'public.brand_memberships'::regclass and a.attname in ('brand_id', 'user_id', 'role')))) <> 5 then
    raise exception 'COMMON_ACCOUNT_BRAND_STATE_PREFLIGHT_BRAND_SHAPE';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (n.nspname = 'private' and p.proname in ('account_lifecycle_brand_owner', 'account_lifecycle_service_state_readonly',
                                                            'account_lifecycle_assert_brand_service_active'))
                 or (n.nspname = 'public' and p.proname = 'common_account_brand_service_state')) then
    raise exception 'COMMON_ACCOUNT_BRAND_STATE_ALREADY_APPLIED';
  end if;
  if not has_function_privilege(current_user, v_state, 'EXECUTE')
     or exists (select 1 from pg_roles r
                 where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                   and has_function_privilege(r.oid, v_state, 'EXECUTE')) then
    raise exception 'COMMON_ACCOUNT_BRAND_STATE_PREFLIGHT_DECISION_ACL_CHANGED';
  end if;
end;
$$;

-- 1. The person a workspace belongs to.
create function private.account_lifecycle_brand_owner(p_brand_id text)
returns uuid language sql stable security definer set search_path = ''
as $$
  select m.user_id
    from public.brands b
    join public.brand_memberships m on m.brand_id = b.id and m.role = 'owner'
   where b.id = p_brand_id
     and b.code_profile_key = 'social_mobile_user_v1'
     and (select count(*) from public.brand_memberships o where o.brand_id = b.id and o.role = 'owner') = 1
$$;

-- 2. The decision as a plain, advisory read. Null = active; otherwise the fixed code.
create function private.account_lifecycle_service_state_readonly(p_user_id uuid, p_service_key text)
returns text language plpgsql stable security definer set search_path = ''
as $$
declare
  v_account_status text;
  v_status text;
begin
  if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then
    return 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    return 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND';
  end if;
  select a.status into v_account_status from public.common_accounts a where a.user_id = p_user_id;
  if not found then
    return 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND';
  end if;
  if v_account_status = 'deleting'
     or exists (select 1 from private.account_lifecycle_operations o
                 where o.user_id = p_user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress') then
    return 'ACCOUNT_DELETION_IN_PROGRESS';
  end if;
  if v_account_status <> 'active' then
    return 'ACCOUNT_LOCKED';
  end if;
  select e.status into v_status from public.service_entitlements e
   where e.user_id = p_user_id and e.service_key = p_service_key;
  if not found then
    return 'SERVICE_NOT_REGISTERED';
  end if;
  if v_status = 'deleting'
     or exists (select 1 from private.account_lifecycle_operations o
                 where o.user_id = p_user_id and o.operation_type = 'service_deletion'
                   and o.service_key = p_service_key and o.status = 'in_progress') then
    return 'SERVICE_DELETION_IN_PROGRESS';
  end if;
  if v_status <> 'active' then
    return 'SERVICE_NOT_ACTIVE';
  end if;
  return null;
end;
$$;

-- 3. The workspace's service state for service-role workers: 'active' or a fixed code.
create function public.common_account_brand_service_state(p_brand_id text, p_service_key text default 'x_autopost')
returns text language plpgsql stable security definer set search_path = ''
as $$
declare
  v_owner uuid;
  v_refusal text;
begin
  if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then
    return 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  v_owner := private.account_lifecycle_brand_owner(p_brand_id);
  if v_owner is null then
    return 'WORKSPACE_OWNER_UNKNOWN';
  end if;
  v_refusal := private.account_lifecycle_service_state_readonly(v_owner, p_service_key);
  return coalesce(v_refusal, 'active');
end;
$$;

-- 4. The ordering variant for a reviewed volatile writer: the Phase 4 lock order, locks kept to commit.
create function private.account_lifecycle_assert_brand_service_active(p_brand_id text, p_service_key text)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_owner uuid := private.account_lifecycle_brand_owner(p_brand_id);
  v_refusal text;
begin
  if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then
    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID' using errcode = '42501';
  end if;
  if v_owner is null then
    raise exception 'WORKSPACE_OWNER_UNKNOWN' using errcode = '42501';
  end if;
  v_refusal := private.account_lifecycle_service_state_refusal(v_owner, p_service_key);
  if v_refusal is not null then
    raise exception '%', v_refusal using errcode = case when v_refusal = 'ACCOUNT_LIFECYCLE_BUSY' then '55P03' else '42501' end;
  end if;
end;
$$;

revoke all on function private.account_lifecycle_brand_owner(text) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_service_state_readonly(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_assert_brand_service_active(text, text) from public, anon, authenticated, service_role;
revoke all on function public.common_account_brand_service_state(text, text) from public, anon, authenticated, service_role;
grant execute on function public.common_account_brand_service_state(text, text) to service_role;

-- Postcondition: the three private functions are owner-only (no API role, no membership); the public one is
-- executable by service_role and by no other API role; all four are definer with an empty search_path.
do $$
declare
  v_private regprocedure[] := array[
    'private.account_lifecycle_brand_owner(text)'::regprocedure,
    'private.account_lifecycle_service_state_readonly(uuid,text)'::regprocedure,
    'private.account_lifecycle_assert_brand_service_active(text,text)'::regprocedure];
  v_public regprocedure := 'public.common_account_brand_service_state(text,text)'::regprocedure;
  v_fn regprocedure;
begin
  foreach v_fn in array v_private loop
    if (select array_to_string(p.proacl::text[], ',') from pg_proc p where p.oid = v_fn)
         is distinct from format('%s=X/%s', quote_ident(current_user), quote_ident(current_user))
       or exists (select 1 from pg_roles r
                   where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                     and (has_function_privilege(r.oid, v_fn, 'EXECUTE') or pg_has_role(r.oid, current_user, 'USAGE')))
       or not exists (select 1 from pg_proc p where p.oid = v_fn and p.prosecdef and p.proconfig @> array['search_path=""']) then
      raise exception 'COMMON_ACCOUNT_BRAND_STATE_POSTCONDITION_ACL';
    end if;
  end loop;
  if not has_function_privilege('service_role', v_public, 'EXECUTE')
     or exists (select 1 from pg_roles r
                 where r.rolname in ('anon', 'authenticated', 'authenticator') and has_function_privilege(r.oid, v_public, 'EXECUTE'))
     or has_function_privilege('public', v_public, 'EXECUTE')
     or not exists (select 1 from pg_proc p where p.oid = v_public and p.prosecdef and p.provolatile = 's'
                      and p.proconfig @> array['search_path=""']) then
    raise exception 'COMMON_ACCOUNT_BRAND_STATE_POSTCONDITION_PUBLIC_ACL';
  end if;
end;
$$;

commit;
