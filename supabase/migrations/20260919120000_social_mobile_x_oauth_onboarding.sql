-- Phase 9 candidate: general (non-admin) social-mobile users connect their own X account.
--
-- NOT applied to production by this task (Phase C explicitly forbids production apply before K2).
-- Written and preflight-checked against the CURRENT real production schema (read-only verified via
-- information_schema during Phase A inventory, 2026-09-19) rather than against this repo's own
-- migration history, which is known to lag behind what is actually applied in production (see
-- .agent/CURRENT_STATE.md known_issue). Before ever applying: re-run the same read-only preflight this
-- task performed (column/constraint/RPC signature check), never blind `supabase db push`, never repair
-- migration history.
--
-- Scope: purely additive. Does not touch brands/social_accounts/brand_memberships rows belonging to
-- kabumori, ai_salaryman_lab, or mio; does not touch any existing x-oauth-connect RPC
-- (begin/consume/complete_ai_salaryman_lab_oauth_connection, begin/consume/complete_kabumori_oauth_recovery);
-- does not touch RLS/admin policies/grants added by the Phase 5 social-mobile membership rollout.
--
-- Architecture note: unlike the existing admin-only flows (which run entirely under the service_role key
-- and never know which human is acting), every RPC here is called with the CONNECTING USER'S OWN JWT
-- forwarded through (by the new x-oauth-connect-user Edge Function, or directly by the mobile client for
-- the read-only parts) so that auth.uid() inside each SECURITY DEFINER function reflects the real caller
-- -- never a client-supplied brand_id/social_account_id/user_id. Calling any of these three functions
-- with the service_role key instead would make auth.uid() resolve to NULL and every one of them would
-- correctly refuse with SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED; that fail-closed behavior is intentional, not
-- a bug to work around by granting them to service_role.
--
-- The PKCE code_verifier is generated and held by the mobile client itself (in memory across the OAuth
-- browser round-trip via expo-web-browser + a deep link back into the app), the same way any public
-- OAuth client does PKCE -- so, unlike the existing admin flows, it is never sent to or stored by this
-- database at all. Only the resulting state_hash is recorded here, to bind one begin() call to one
-- consume() call.

-- 1. Close a real gap found during Phase A inventory: no constraint today prevents the same X account
--    (platform_user_id) from being linked to two different social_accounts rows (two different brands /
--    two different users). A partial unique index (only once an identity is actually verified) makes
--    "duplicate X platform user id collision" fail at the database layer, not just in application code.
create unique index if not exists social_accounts_platform_user_id_key
  on public.social_accounts (platform, platform_user_id)
  where platform_user_id is not null;

-- 2. The existing social_account_oauth_states table (used today only by the two hardcoded
--    admin-initiated flows, where code_verifier_vault_secret_id is always set) has no notion of "which
--    authenticated user started this". General-user onboarding needs that binding so consume-time can
--    verify the caller owns the state they are consuming, not just that the state hash matches. Both
--    columns are nullable and additive: existing admin-flow rows are unaffected and keep using
--    code_verifier_vault_secret_id; social-mobile rows use initiated_by_user_id instead and leave
--    code_verifier_vault_secret_id null, since the verifier never reaches this database.
alter table public.social_account_oauth_states
  add column if not exists initiated_by_user_id uuid references auth.users(id) on delete cascade;

-- 3. begin_social_mobile_x_oauth_connection: the only entry point a general user's connect request goes
--    through. SECURITY DEFINER so it can write brands/social_accounts/social_account_oauth_states (which
--    `authenticated` otherwise has no direct write grant on -- the RLS+RPC-only pattern already
--    established by the Phase 5 membership rollout), but every decision is derived from auth.uid() as
--    resolved by Postgres from the caller's own forwarded JWT. On a user's first connection this creates
--    their own brand + owner membership + a fresh, not-yet-connected social_accounts row; on a retry it
--    reuses whatever they already own. It never touches a brand/account it did not itself create for
--    this user.
create or replace function public.begin_social_mobile_x_oauth_connection(
  p_state_hash text,
  p_redirect_uri text,
  p_expires_at timestamptz
)
returns table (brand_id text, social_account_id text)
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_user_id uuid := auth.uid();
  v_brand_id text;
  v_owner_brand_count int;
  v_social_account_id text;
begin
  if v_user_id is null then
    raise exception 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED';
  end if;
  if p_state_hash !~ '^[0-9a-f]{64}$' or p_expires_at <= now() then
    raise exception 'OAUTH_STATE_INPUT_INVALID';
  end if;

  -- A user is expected to own at most one brand in this phase. Count (not just LIMIT 1) so an
  -- unexpected multi-brand-owner state fails closed instead of silently picking one.
  select count(*) into v_owner_brand_count
  from public.brand_memberships bm
  where bm.user_id = v_user_id and bm.role = 'owner';
  if v_owner_brand_count > 1 then
    raise exception 'SOCIAL_MOBILE_MULTIPLE_OWNED_BRANDS_UNSUPPORTED';
  end if;

  if v_owner_brand_count = 1 then
    select bm.brand_id into v_brand_id
    from public.brand_memberships bm
    where bm.user_id = v_user_id and bm.role = 'owner';
  else
    -- Deterministic, collision-resistant, satisfies brands_id_check (^[a-z][a-z0-9_]{1,40}$).
    v_brand_id := 'u_' || substr(md5(v_user_id::text), 1, 24);
    insert into public.brands (id, display_name, is_active, publish_mode, code_profile_key)
    -- code_profile_key is a deliberate placeholder: no code profile named this exists yet in
    -- _shared/brand/brand_profiles.ts, so resolveBrandCodeProfile()/loadBrandContext() will correctly
    -- fail closed (BRAND_CODE_PROFILE_NOT_FOUND) if any content-generation path ever tries to load this
    -- brand before that profile is deliberately added. This phase only establishes ownership; it does
    -- not wire generation/publishing for general users.
    values (v_brand_id, 'My Workspace', false, 'disabled', 'social_mobile_user_v1')
    on conflict (id) do nothing;
    insert into public.brand_memberships (brand_id, user_id, role)
    values (v_brand_id, v_user_id, 'owner')
    on conflict (brand_id, user_id) do nothing;
  end if;

  select sa.id into v_social_account_id
  from public.social_accounts sa
  where sa.brand_id = v_brand_id and sa.platform = 'x';
  if v_social_account_id is null then
    -- Satisfies social_accounts_id_check (^[a-z][a-z0-9_]{1,80}$); handle is a placeholder until the
    -- real X identity is verified in the callback.
    v_social_account_id := 'sa_' || substr(md5(v_brand_id || ':x'), 1, 24);
    insert into public.social_accounts
      (id, brand_id, platform, handle, publish_enabled, oauth_client_ref, connection_status)
    values (v_social_account_id, v_brand_id, 'x', 'pending', false, 'default', 'authorization_pending');
  else
    update public.social_accounts
    set connection_status = 'authorization_pending', last_connection_error_code = null, updated_at = now()
    where id = v_social_account_id;
  end if;

  insert into public.social_account_oauth_states
    (social_account_id, brand_id, state_hash, code_verifier_vault_secret_id, redirect_uri, expires_at, initiated_by_user_id)
  values (v_social_account_id, v_brand_id, p_state_hash, null, p_redirect_uri, p_expires_at, v_user_id);

  return query select v_brand_id, v_social_account_id;
end;
$$;

-- 4. consume_social_mobile_x_oauth_state: the ownership checkpoint. A state hash matching the row is not
--    enough -- the row's initiated_by_user_id must equal the CURRENT caller's auth.uid(). This is what
--    makes "cross-user connect denied" and "state replay denied" true even if a state value ever leaked
--    to a different authenticated session. The code_verifier itself is not read from here (see the
--    architecture note above) -- the caller (the Edge Function, forwarding what the mobile app already
--    holds) supplies it directly to X's token endpoint; this function only returns what it is safe to
--    look up server-side (the redirect_uri this state was opened with, and which brand/account it maps
--    to for this user).
create or replace function public.consume_social_mobile_x_oauth_state(p_state_hash text)
returns table (redirect_uri text, brand_id text, social_account_id text)
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_user_id uuid := auth.uid();
  v_state public.social_account_oauth_states%rowtype;
begin
  if v_user_id is null then
    raise exception 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED';
  end if;
  select * into v_state from public.social_account_oauth_states
  where state_hash = p_state_hash
  for update;
  if not found or v_state.initiated_by_user_id is distinct from v_user_id then
    -- Deliberately the same error for "no such state" and "belongs to someone else": do not let the
    -- error message itself reveal whether a given state hash exists for another user.
    raise exception 'OAUTH_STATE_NOT_CONSUMABLE';
  end if;
  if v_state.consumed_at is not null or v_state.expires_at <= now() then
    raise exception 'OAUTH_STATE_NOT_CONSUMABLE';
  end if;
  update public.social_account_oauth_states set consumed_at = now() where id = v_state.id;
  return query select v_state.redirect_uri, v_state.brand_id, v_state.social_account_id;
end;
$$;

-- 5. complete_social_mobile_x_oauth_connection: writes the verified identity + tokens. Ownership is
--    re-checked here too (defense in depth, not just at consume time) via brand_memberships, and the new
--    partial unique index (added in step 1) is what turns "this X account is already connected
--    elsewhere" into a real, atomic failure rather than a check-then-act race.
create or replace function public.complete_social_mobile_x_oauth_connection(
  p_social_account_id text,
  p_platform_user_id text,
  p_handle text,
  p_access_token text,
  p_refresh_token text
)
returns void
language plpgsql
security definer
set search_path = 'public', 'vault'
as $$
declare
  v_user_id uuid := auth.uid();
  v_account public.social_accounts%rowtype;
  v_handle text := lower(regexp_replace(trim(p_handle), '^@', ''));
begin
  if v_user_id is null then
    raise exception 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED';
  end if;
  if p_access_token = '' or p_refresh_token = '' or p_platform_user_id = '' then
    raise exception 'OAUTH_TOKEN_OR_IDENTITY_INVALID';
  end if;

  select sa.* into v_account
  from public.social_accounts sa
  join public.brand_memberships bm on bm.brand_id = sa.brand_id
  where sa.id = p_social_account_id and bm.user_id = v_user_id and bm.role = 'owner'
  for update of sa;
  if not found then
    raise exception 'SOCIAL_MOBILE_ACCOUNT_NOT_OWNED';
  end if;
  if v_account.platform_user_id is not null and v_account.platform_user_id <> p_platform_user_id then
    raise exception 'X_IDENTITY_ACCOUNT_MISMATCH';
  end if;

  if v_account.vault_access_token_secret_id is null then
    v_account.vault_access_token_secret_id := vault.create_secret(p_access_token, p_social_account_id || '_access_token', 'OAuth access token.');
  else
    perform vault.update_secret(v_account.vault_access_token_secret_id, p_access_token);
  end if;
  if v_account.vault_refresh_token_secret_id is null then
    v_account.vault_refresh_token_secret_id := vault.create_secret(p_refresh_token, p_social_account_id || '_refresh_token', 'OAuth refresh token.');
  else
    perform vault.update_secret(v_account.vault_refresh_token_secret_id, p_refresh_token);
  end if;

  -- The partial unique index from step 1 makes this UPDATE raise a real unique_violation (caught below)
  -- if p_platform_user_id is already bound to a different social_accounts row -- fail-closed, atomic,
  -- not a separate check-then-act SELECT that a race could slip past.
  update public.social_accounts set
    vault_access_token_secret_id = v_account.vault_access_token_secret_id,
    vault_refresh_token_secret_id = v_account.vault_refresh_token_secret_id,
    platform_user_id = p_platform_user_id,
    handle = v_handle,
    -- publish_enabled is never set true by OAuth success alone -- an explicit, separate, later action is
    -- required before this account can ever be posted to.
    publish_enabled = false,
    connection_status = 'identity_verified',
    verified_at = now(),
    last_connection_error_code = null,
    updated_at = now()
  where id = p_social_account_id;
exception
  when unique_violation then
    update public.social_accounts
    set connection_status = 'failed', last_connection_error_code = 'X_ACCOUNT_ALREADY_CONNECTED', updated_at = now()
    where id = p_social_account_id;
    raise exception 'X_ACCOUNT_ALREADY_CONNECTED';
end;
$$;

-- Called with the connecting user's own forwarded JWT (role `authenticated`), never with service_role --
-- see the architecture note at the top of this file for why that is load-bearing, not incidental.
revoke all on function public.begin_social_mobile_x_oauth_connection(text, text, timestamptz) from public, anon;
revoke all on function public.consume_social_mobile_x_oauth_state(text) from public, anon;
revoke all on function public.complete_social_mobile_x_oauth_connection(text, text, text, text, text) from public, anon;
grant execute on function public.begin_social_mobile_x_oauth_connection(text, text, timestamptz) to authenticated;
grant execute on function public.consume_social_mobile_x_oauth_state(text) to authenticated;
grant execute on function public.complete_social_mobile_x_oauth_connection(text, text, text, text, text) to authenticated;
