-- SOURCE CANDIDATE ONLY. NOT applied to production. Independent review is
-- mandatory before any apply; apply as a single reviewed file (never db push).
-- Rollout order (supabase/tests/social_mobile_publish_permission.md, section 6):
-- the x-test-post build that calls assert_x_publish_permission_for_legacy_post
-- is deployed, read back and drained of older invocations FIRST; while this
-- file is not applied that call fails and every Vault-backed post fails
-- closed. Only then is this file applied. Applying it first would make the
-- switch usable (directly, with any caller JWT) while an older sender that
-- never asks for permission may still be running.
--
-- The one transactional boundary for per-account automatic publishing
-- (public.social_accounts.publish_enabled), plus the fresh permission check
-- the Vault-backed X send path runs immediately before each X write.
--
-- 1. set_social_account_publish_enabled(account, desired, expected)
--    Called through the Data API with the CALLER'S OWN JWT (role
--    `authenticated`), so auth.uid() is the real caller. In ONE transaction it
--    locks, in this order,
--      social_accounts table (ROW EXCLUSIVE) -> the account's brand row
--      (FOR SHARE) -> the caller's membership row for that brand (FOR SHARE)
--      -> the account row (FOR UPDATE)
--    and only then decides. A membership removal or demotion, a brand
--    disable, an account move and a concurrent toggle therefore either
--    happened before (and are seen) or wait until this transaction commits;
--    no decision is made on a snapshot that can change before the write.
--    The order matches the account-deletion functions (brand -> memberships
--    -> accounts). The table lock is taken first, before any row lock,
--    because the refresh commit functions take SHARE ROW EXCLUSIVE on
--    social_accounts and then the account row: taking the row first and the
--    table lock later (what a bare UPDATE does) could deadlock with a refresh
--    commit that has already rotated a single-use token.
--    Waiting is bounded (lock_timeout); a timeout, a deadlock or the
--    account-deletion guard is answered as 'busy', never as success.
--
--    SECURITY DEFINER because `authenticated` has no UPDATE privilege on
--    social_accounts and must not get one: this function is the only way an
--    app user changes that table, it changes one column of one row, and every
--    authority input comes from auth.uid() and locked rows, never from an
--    argument (there is no user id or brand id argument).
--
--    ON means "permission enabled and structurally eligible", not "the next
--    X request will succeed": Vault material is never read here; the publish
--    path may still refuse (expired or revoked token, rollout limits).
--    OFF is always available to a current owner/admin of the account's brand,
--    whatever the connection, credentials or brand state. It changes nothing
--    but publish_enabled (no revoke, no Vault, no posts, no history).
--    updated_at is deliberately not touched: it is the account-configuration
--    stamp that refresh leases snapshot.
--
-- 2. assert_x_publish_permission_for_legacy_post(post, account, brand)
--    service_role only. The existing exact-account contract
--    (x_legacy_post_account) plus, in ONE statement and therefore one
--    snapshot: post still running for this brand, brand active and live,
--    account publish_enabled, identity verified (status, non-blank platform
--    user id AND verified_at), credential references present and distinct,
--    no account deletion in progress, refresh state not blocked, and no
--    recorded connection error. Every structural condition ON requires is
--    therefore required again here, on the state at send time; the helper is
--    not relied on for any of them. A refresh in progress is not a refusal.
--    The publish path calls it directly before every X write, so a
--    brand/account context cached earlier in the dispatch cannot authorize a
--    send. A send is "in flight" from the moment this check returns; OFF or a
--    brand disable committed before the check's snapshot stops the send, one
--    committed after it does not recall a request already on its way to X.
--
-- 3. Privileges, exact and effective. Both functions are created by, and run
--    as, the role that owns x_legacy_post_account (whose EXECUTE is
--    owner-only); that role must not be a superuser. Whatever the creating
--    role's default privileges add on these two new functions is removed
--    from them (only them: no ALTER DEFAULT PRIVILEGES, no role membership
--    change). Before COMMIT the file proves the result, including privileges
--    inherited through role membership: PUBLIC and anon nothing,
--    authenticated only the switch, service_role only the check, and no
--    other role able to execute either one except the owner, roles that
--    inherit the owner, roles that inherit the intended grantee (they act as
--    that role) and superusers. Any other state aborts the whole file.
--
-- Transaction: one explicit transaction; apply alone with a tool that does NOT
-- wrap the file in another transaction; not re-runnable. A refusal at any
-- point leaves nothing behind.
begin;

do $$
begin
  if to_regclass('public.brands') is null or to_regclass('public.brand_memberships') is null
     or to_regclass('public.social_accounts') is null or to_regclass('public.scheduled_posts') is null
     or to_regclass('public.x_account_refresh_state_v2') is null
     or to_regclass('public.social_mobile_account_deletions') is null
     or to_regprocedure('public.x_legacy_post_account(uuid,text,text,boolean)') is null
     or to_regprocedure('auth.uid()') is null then
    raise exception 'PUBLISH_PERMISSION_PRECONDITION_MISSING';
  end if;
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'social_accounts'
        and column_name in ('id', 'brand_id', 'platform', 'publish_enabled', 'connection_status', 'platform_user_id',
                            'verified_at', 'last_connection_error_code', 'vault_access_token_secret_id',
                            'vault_refresh_token_secret_id')) <> 10
     or (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'brands'
           and column_name in ('id', 'is_active', 'publish_mode')) <> 3
     or (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'brand_memberships'
           and column_name in ('brand_id', 'user_id', 'role')) <> 3 then
    raise exception 'PUBLISH_PERMISSION_PRECONDITION_SHAPE';
  end if;
  if to_regprocedure('public.set_social_account_publish_enabled(text,boolean,boolean)') is not null
     or to_regprocedure('public.assert_x_publish_permission_for_legacy_post(uuid,text,text)') is not null then
    raise exception 'PUBLISH_PERMISSION_PRECONDITION_ALREADY_APPLIED';
  end if;
  if to_regrole('anon') is null or to_regrole('authenticated') is null or to_regrole('service_role') is null then
    raise exception 'PUBLISH_PERMISSION_PRECONDITION_ROLES';
  end if;
  -- The creator becomes the owner the two SECURITY DEFINER functions run as:
  -- the exact-account helper's owner, never a superuser.
  if (select p.proowner from pg_catalog.pg_proc p
      where p.oid = 'public.x_legacy_post_account(uuid,text,text,boolean)'::regprocedure)
       is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'PUBLISH_PERMISSION_PRECONDITION_OWNER';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false then
    raise exception 'PUBLISH_PERMISSION_PRECONDITION_OWNER';
  end if;
end $$;

-- 1. The publish switch. Returns a bounded jsonb:
--      {status: updated|unchanged, publish_enabled}
--      {status: stale, publish_enabled}          (authorized caller only)
--      {status: blocked, reason}                 (ON prerequisites, authorized caller only)
--      {status: not_found}                       (no such account, or not a member: identical)
--      {status: forbidden}                       (member, but not owner/admin)
--      {status: busy}                            (lock wait, deletion in progress, refresh in progress)
--      {status: auth_required} | {status: invalid}
create function public.set_social_account_publish_enabled(
  p_social_account_id text, p_desired_enabled boolean, p_expected_current_enabled boolean
) returns jsonb
language plpgsql security definer
set search_path = ''
set lock_timeout = '3s'
as $$
declare
  v_user uuid := auth.uid();
  v_brand_id text;
  v_brand public.brands%rowtype;
  v_role text;
  v_account public.social_accounts%rowtype;
  v_refresh_status text;
  v_reason text;
begin
  if v_user is null then
    return jsonb_build_object('status', 'auth_required');
  end if;
  if p_social_account_id is null or p_social_account_id !~ '^[A-Za-z0-9_-]{1,100}$'
     or p_desired_enabled is null or p_expected_current_enabled is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  -- Every statement below must see what was committed before it ran; under a
  -- snapshot isolation level the reads after the locks could be older than
  -- the locks. The Data API runs READ COMMITTED; anything else is refused.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'PUBLISH_SETTING_UNAVAILABLE' using errcode = 'P0001';
  end if;

  -- Unlocked pre-check: someone who is not a member of the account's brand
  -- gets the not-found answer without taking any lock on rows that are not
  -- theirs. Nothing is decided here; everything is re-read under locks below.
  select sa.brand_id into v_brand_id from public.social_accounts sa where sa.id = p_social_account_id;
  if not found or not exists (
    select 1 from public.brand_memberships bm where bm.brand_id = v_brand_id and bm.user_id = v_user
  ) then
    return jsonb_build_object('status', 'not_found');
  end if;

  begin
    lock table public.social_accounts in row exclusive mode;

    select b.* into v_brand from public.brands b where b.id = v_brand_id for share;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;

    -- The caller's CURRENT membership, held until commit: a removal or a role
    -- change either committed before this (and is what we read) or waits.
    select bm.role into v_role from public.brand_memberships bm
    where bm.brand_id = v_brand_id and bm.user_id = v_user for share;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;

    if v_role is null or v_role not in ('owner', 'admin') then
      -- A member without the right takes no write lock. If the account left
      -- the brand meanwhile it is not theirs to learn about.
      if not exists (
        select 1 from public.social_accounts sa where sa.id = p_social_account_id and sa.brand_id = v_brand_id
      ) then
        return jsonb_build_object('status', 'not_found');
      end if;
      return jsonb_build_object('status', 'forbidden');
    end if;

    select sa.* into v_account from public.social_accounts sa where sa.id = p_social_account_id for update;
    -- Moved to another brand (even one the caller also belongs to) or gone:
    -- the membership proven above is not for the row as it is now.
    if not found or v_account.brand_id is distinct from v_brand_id then
      return jsonb_build_object('status', 'not_found');
    end if;

    if v_account.publish_enabled is distinct from p_expected_current_enabled then
      return jsonb_build_object('status', 'stale', 'publish_enabled', v_account.publish_enabled);
    end if;
    if v_account.publish_enabled = p_desired_enabled then
      return jsonb_build_object('status', 'unchanged', 'publish_enabled', v_account.publish_enabled);
    end if;

    -- A workspace under account deletion accepts no change in either
    -- direction (its guard trigger would refuse the write below as well);
    -- the deletion itself already requires that nothing is being posted.
    if exists (select 1 from public.social_mobile_account_deletions d where d.workspace_id = v_brand_id) then
      return jsonb_build_object('status', 'busy');
    end if;

    if p_desired_enabled then
      -- Same rules as the exact-account publish contract (x_legacy_post_account),
      -- evaluated on the locked rows this transaction then writes.
      v_reason := case
        when v_account.platform is distinct from 'x' then 'PLATFORM_NOT_SUPPORTED'
        when v_brand.is_active is distinct from true then 'BRAND_INACTIVE'
        when v_brand.publish_mode is distinct from 'live' then 'BRAND_PUBLISHING_NOT_LIVE'
        when v_account.connection_status is distinct from 'identity_verified'
          or nullif(btrim(v_account.platform_user_id), '') is null
          or v_account.verified_at is null then 'CONNECTION_NOT_VERIFIED'
        when v_account.vault_access_token_secret_id is null
          or v_account.vault_refresh_token_secret_id is null then 'CREDENTIALS_MISSING'
        when v_account.vault_access_token_secret_id = v_account.vault_refresh_token_secret_id
          or exists (
            select 1 from public.social_accounts o
            where o.id <> v_account.id
              and (o.vault_access_token_secret_id in (v_account.vault_access_token_secret_id, v_account.vault_refresh_token_secret_id)
                or o.vault_refresh_token_secret_id in (v_account.vault_access_token_secret_id, v_account.vault_refresh_token_secret_id))
          ) then 'CREDENTIALS_INVALID'
        when nullif(btrim(v_account.last_connection_error_code), '') is not null then 'CONNECTION_DEGRADED'
        else null
      end;
      if v_reason is null then
        select st.status into v_refresh_status from public.x_account_refresh_state_v2 st
        where st.social_account_id = v_account.id;
        if v_refresh_status in ('uncertain', 'reauth_required') then
          v_reason := 'CONNECTION_DEGRADED';
        elsif v_refresh_status = 'refreshing' then
          return jsonb_build_object('status', 'busy');
        end if;
      end if;
      if v_reason is not null then
        return jsonb_build_object('status', 'blocked', 'reason', v_reason);
      end if;
    end if;

    -- The only write. Under the row lock the predicate cannot miss; if it
    -- ever does, nothing is reported as changed.
    update public.social_accounts sa
    set publish_enabled = p_desired_enabled
    where sa.id = v_account.id and sa.brand_id = v_brand_id and sa.publish_enabled = p_expected_current_enabled;
    if not found then
      raise exception 'PUBLISH_SETTING_UNAVAILABLE' using errcode = 'P0001';
    end if;
    return jsonb_build_object('status', 'updated', 'publish_enabled', p_desired_enabled);
  exception
    when lock_not_available or deadlock_detected then
      return jsonb_build_object('status', 'busy');
    when others then
      -- The account-deletion guard trigger refuses every writer of a
      -- workspace under deletion. Anything else is unexpected: fixed code,
      -- whole transaction aborted, no internal text.
      if sqlerrm = 'SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS' then
        return jsonb_build_object('status', 'busy');
      end if;
      raise exception 'PUBLISH_SETTING_UNAVAILABLE' using errcode = 'P0001';
  end;
end;
$$;

-- 2. Fresh permission for one X write of a running legacy (unbound) post.
--    Returns 'authorized' or raises a fixed code. Read-only.
create function public.assert_x_publish_permission_for_legacy_post(
  p_scheduled_post_id uuid, p_social_account_id text, p_brand_id text
) returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_account public.social_accounts%rowtype;
  v_code text;
begin
  -- Exact-account contract shared with the credential reader and the refresh
  -- functions: running unbound post of this brand, the brand's one X account,
  -- the account the caller named, verified, publish enabled, own distinct
  -- unshared credential references.
  v_account := public.x_legacy_post_account(p_scheduled_post_id, p_social_account_id, p_brand_id, false);

  -- The permission itself, from a single snapshot: every condition below held
  -- at the same instant, so no mix of an older brand read and a newer account
  -- read (or the reverse) can pass.
  select case
      when sp.id is null or sp.status is distinct from 'running' or sp.brand_id is distinct from sa.brand_id
        then 'X_LEGACY_POST_NOT_RUNNING'
      when b.id is null then 'BRAND_NOT_FOUND'
      when b.is_active is distinct from true then 'BRAND_DISABLED'
      when b.publish_mode = 'dry_run' then 'BRAND_PUBLISH_MODE_DRY_RUN'
      when b.publish_mode is distinct from 'live' then 'BRAND_PUBLISH_MODE_DISABLED'
      when sa.publish_enabled is distinct from true then 'X_ACCOUNT_PUBLISH_DISABLED'
      when sa.platform is distinct from 'x' or sa.connection_status is distinct from 'identity_verified'
        or nullif(btrim(sa.platform_user_id), '') is null
        or sa.verified_at is null then 'X_ACCOUNT_NOT_VERIFIED'
      when sa.vault_access_token_secret_id is null or sa.vault_refresh_token_secret_id is null
        or sa.vault_access_token_secret_id = sa.vault_refresh_token_secret_id then 'X_CREDENTIAL_NOT_CONFIGURED'
      when exists (select 1 from public.social_mobile_account_deletions d where d.workspace_id = sa.brand_id)
        then 'SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS'
      when st.status = 'uncertain' then 'X_REFRESH_BLOCKED_UNCERTAIN'
      when st.status = 'reauth_required' then 'X_REFRESH_REAUTH_REQUIRED'
      -- A recorded connection error (an unauthorized access token, a refresh
      -- the token endpoint refused): the same state ON refuses. A completed
      -- reconnection clears it; until then no send is authorized, so no
      -- refresh is attempted for this account either.
      when nullif(btrim(sa.last_connection_error_code), '') is not null then 'X_ACCOUNT_CONNECTION_DEGRADED'
      else 'authorized'
    end
  into v_code
  from public.social_accounts sa
  left join public.scheduled_posts sp on sp.id = p_scheduled_post_id
  left join public.brands b on b.id = sa.brand_id
  left join public.x_account_refresh_state_v2 st on st.social_account_id = sa.id
  where sa.id = v_account.id and sa.brand_id = p_brand_id;
  if not found then
    raise exception 'X_CLAIM_ACCOUNT_MISMATCH' using errcode = 'P0001';
  end if;
  if v_code is distinct from 'authorized' then
    raise exception '%', v_code using errcode = 'P0001';
  end if;
  return 'authorized';
exception
  when sqlstate 'P0001' then raise;
  when others then raise exception 'X_PUBLISH_PERMISSION_UNAVAILABLE' using errcode = 'P0001';
end;
$$;

-- 3. Least privilege. The switch is for signed-in app users only (it is
-- useless without auth.uid(), so service_role is deliberately not granted);
-- the permission check is for the publishing service only.
revoke all on function public.set_social_account_publish_enabled(text, boolean, boolean),
  public.assert_x_publish_permission_for_legacy_post(uuid, text, text)
from public, anon, authenticated, service_role;

-- Any other grantee the creating role's default privileges put on these two
-- functions (any role, with or without grant option) is removed from them.
do $$
declare
  r record;
begin
  for r in
    select distinct f.signature, a.grantee
    from (values ('public.set_social_account_publish_enabled(text,boolean,boolean)'),
                 ('public.assert_x_publish_permission_for_legacy_post(uuid,text,text)')) f (signature)
    join pg_catalog.pg_proc p on p.oid = f.signature::regprocedure
    cross join pg_catalog.aclexplode(p.proacl) a
    where a.grantee <> p.proowner
  loop
    execute format('revoke all on function %s from %s', r.signature,
      case when r.grantee = 0 then 'public' else quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) end);
  end loop;
end $$;

grant execute on function public.set_social_account_publish_enabled(text, boolean, boolean) to authenticated;
grant execute on function public.assert_x_publish_permission_for_legacy_post(uuid, text, text) to service_role;

-- Postcondition: exact and effective EXECUTE. Raises (and so aborts the whole
-- file) unless the privileges are exactly the intended ones.
do $$
declare
  v_switch oid := 'public.set_social_account_publish_enabled(text,boolean,boolean)'::regprocedure;
  v_check oid := 'public.assert_x_publish_permission_for_legacy_post(uuid,text,text)'::regprocedure;
  v_owner oid := (select p.proowner from pg_catalog.pg_proc p
                  where p.oid = 'public.x_legacy_post_account(uuid,text,text,boolean)'::regprocedure);
  v_authenticated oid := 'authenticated'::regrole;
  v_service oid := 'service_role'::regrole;
begin
  -- Definition: owned by the exact-account helper's owner, SECURITY DEFINER, empty search_path.
  if (select count(*) from pg_catalog.pg_proc p
      where p.oid in (v_switch, v_check) and p.proowner = v_owner and p.prosecdef
        and p.proconfig @> array['search_path=""']) <> 2 then
    raise exception 'PUBLISH_PERMISSION_EFFECTIVE_ACL';
  end if;
  -- Direct grants: besides the owner, exactly one plain EXECUTE each, nothing for PUBLIC.
  if exists (
       select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
       where p.oid in (v_switch, v_check) and a.grantee <> p.proowner
         and not (a.privilege_type = 'EXECUTE' and not a.is_grantable
                  and ((p.oid = v_switch and a.grantee = v_authenticated) or (p.oid = v_check and a.grantee = v_service))))
     or (select count(*) from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
         where p.oid = v_switch and a.grantee = v_authenticated) <> 1
     or (select count(*) from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
         where p.oid = v_check and a.grantee = v_service) <> 1 then
    raise exception 'PUBLISH_PERMISSION_EFFECTIVE_ACL';
  end if;
  -- Effective privileges of the app roles, inherited ones included.
  if has_function_privilege('anon', v_switch, 'execute') or has_function_privilege('anon', v_check, 'execute')
     or not has_function_privilege('authenticated', v_switch, 'execute')
     or has_function_privilege('authenticated', v_check, 'execute')
     or not has_function_privilege('service_role', v_check, 'execute')
     or has_function_privilege('service_role', v_switch, 'execute') then
    raise exception 'PUBLISH_PERMISSION_EFFECTIVE_ACL';
  end if;
  -- Every other role: only by inheriting the owner or the intended grantee.
  if exists (
       select 1 from pg_catalog.pg_roles r
       where not r.rolsuper and not pg_has_role(r.oid, v_owner, 'usage')
         and ((has_function_privilege(r.oid, v_switch, 'execute') and not pg_has_role(r.oid, v_authenticated, 'usage'))
           or (has_function_privilege(r.oid, v_check, 'execute') and not pg_has_role(r.oid, v_service, 'usage')))) then
    raise exception 'PUBLISH_PERMISSION_EFFECTIVE_ACL';
  end if;
end $$;

commit;
