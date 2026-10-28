-- G4 SOURCE CANDIDATE ROLLBACK (2026-10-28, Issue #319 G4-46) for 005_x_connect_lifecycle_t13.sql. Disposable PG17 only.
-- Back to 002's begin / complete and 004's consume, copied verbatim (002 L73-L166, L169-L283; 004 L37-L83). CREATE OR REPLACE keeps
-- OID, owner and ACL. Refuses unless 005 is what is installed.
begin;

set local lock_timeout = '5s';

do $$
begin
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.begin_social_mobile_x_oauth_connection(text,text,timestamptz)'))
       is distinct from '6a8b35ee440846d9f0a1be275d0a5a07'
     or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)'))
       is distinct from '5a3eb3092920acae7875c8341cf5d772'
     or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.consume_social_mobile_x_oauth_state(text)'))
       is distinct from '391e389ede2f220cd4b9ee5875a8f765' then
    raise exception 'G4X_T13_ROLLBACK_NOT_APPLIED';
  end if;
end $$;

-- 002 L73-L166, verbatim
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
  v_verdict text;
  v_owner_epoch bigint;
  v_social_account_id text;
  v_connection_epoch bigint;
  v_state_id uuid;
  v_rows bigint;
begin
  if v_user_id is null then
    raise exception 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED';
  end if;
  if p_state_hash !~ '^[0-9a-f]{64}$' or p_expires_at <= now() then
    raise exception 'OAUTH_STATE_INPUT_INVALID';
  end if;

  v_brand_id := 'u_' || substr(md5(v_user_id::text), 1, 24);
  perform postona_g4_x_oauth.lock_workspace(v_brand_id);
  lock table public.social_accounts in row exclusive mode;  -- W3 (G4-40): before any row lock on social_accounts
  v_verdict := postona_g4_x_oauth.require_person(v_user_id);

  if v_verdict = 'absent' then
    insert into public.brands (id, display_name, is_active, publish_mode, code_profile_key)
    values (v_brand_id, 'My Workspace', false, 'disabled', 'social_mobile_user_v1')
    on conflict (id) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      -- someone else made the row between the verdict and here: never join it
      raise exception 'OWN_WORKSPACE_CONFLICT';
    end if;
    insert into public.brand_memberships (brand_id, user_id, role)
    values (v_brand_id, v_user_id, 'owner');
    -- the rule must hold after the write too
    if postona_g4_x_oauth.require_person(v_user_id) <> 'own' then
      raise exception 'OWN_WORKSPACE_CONFLICT';
    end if;
  end if;
  v_owner_epoch := postona_g4_x_oauth.require_owner_epoch(v_brand_id);

  select sa.id into v_social_account_id
  from public.social_accounts sa
  where sa.brand_id = v_brand_id and sa.platform = 'x'
  for update;
  if v_social_account_id is null then
    v_social_account_id := 'sa_' || substr(md5(v_brand_id || ':x'), 1, 24);
    insert into public.social_accounts
      (id, brand_id, platform, handle, publish_enabled, oauth_client_ref, connection_status)
    values (v_social_account_id, v_brand_id, 'x', 'pending', false, 'default', 'authorization_pending');
  else
    -- a reconnect refreshes the state but never demotes a verified identity before the callback
    update public.social_accounts sa
    set connection_status = case
          when sa.connection_status = 'identity_verified' then 'identity_verified'
          else 'authorization_pending'
        end,
        last_connection_error_code = null,
        updated_at = now()
    where sa.id = v_social_account_id;
  end if;

  insert into postona_g4_x_oauth.connections as c (social_account_id)
  values (v_social_account_id)
  on conflict on constraint g4x_connections_pkey do nothing;
  select c.connection_epoch into v_connection_epoch
  from postona_g4_x_oauth.connections c
  where c.social_account_id = v_social_account_id
  for update;

  insert into public.social_account_oauth_states
    (social_account_id, brand_id, state_hash, code_verifier_vault_secret_id, redirect_uri, expires_at, initiated_by_user_id)
  values (v_social_account_id, v_brand_id, p_state_hash, null, p_redirect_uri, p_expires_at, v_user_id)
  returning id into v_state_id;
  insert into postona_g4_x_oauth.state_bindings
    (oauth_state_id, initiated_by, brand_id, social_account_id, owner_epoch, connection_epoch)
  values (v_state_id, v_user_id, v_brand_id, v_social_account_id, v_owner_epoch, v_connection_epoch);
  -- the newest begin is the only one that may complete
  update postona_g4_x_oauth.connections c
  set latest_state_id = v_state_id, updated_at = now()
  where c.social_account_id = v_social_account_id;

  return query select v_brand_id, v_social_account_id;
end;
$$;

-- 002 L169-L283, verbatim
create or replace function public.complete_social_mobile_x_oauth_connection(
  p_oauth_state_id uuid,
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
  v_social_account_id text;
  v_state_brand text;
  v_account public.social_accounts%rowtype;
  v_binding postona_g4_x_oauth.state_bindings%rowtype;
  v_connection postona_g4_x_oauth.connections%rowtype;
  v_handle text := lower(regexp_replace(trim(p_handle), '^@', ''));
begin
  if v_user_id is null then
    raise exception 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED';
  end if;
  if coalesce(p_access_token, '') = '' or coalesce(p_refresh_token, '') = '' or coalesce(p_platform_user_id, '') = '' then
    raise exception 'OAUTH_TOKEN_OR_IDENTITY_INVALID';
  end if;
  -- the lock of the workspace the state names (a state of someone else's workspace fails the claim below anyway)
  select s.brand_id into v_state_brand from public.social_account_oauth_states s where s.id = p_oauth_state_id;
  if v_state_brand is not null then
    perform postona_g4_x_oauth.lock_workspace(v_state_brand);
  end if;
  lock table public.social_accounts in row exclusive mode;  -- W3 (G4-40): before any row lock on social_accounts

  update public.social_account_oauth_states
  set consumed_at = now()
  where id = p_oauth_state_id
    and initiated_by_user_id = v_user_id
    and consumed_at is null
    and expires_at > now()
  returning social_account_id into v_social_account_id;
  if v_social_account_id is null then
    raise exception 'OAUTH_STATE_NOT_CONSUMABLE';
  end if;

  select b.* into v_binding from postona_g4_x_oauth.state_bindings b where b.oauth_state_id = p_oauth_state_id;
  if not found or v_binding.initiated_by <> v_user_id or v_binding.social_account_id <> v_social_account_id
     or v_binding.brand_id <> v_state_brand then
    raise exception 'OAUTH_STATE_NOT_BOUND';
  end if;
  select c.* into v_connection from postona_g4_x_oauth.connections c
  where c.social_account_id = v_social_account_id
  for update;
  if not found or v_connection.latest_state_id is distinct from p_oauth_state_id then
    raise exception 'OAUTH_STATE_SUPERSEDED';
  end if;
  if v_connection.connection_epoch <> v_binding.connection_epoch then
    raise exception 'X_CONNECTION_CHANGED';
  end if;
  -- the callback re-asks G5 (Q13 proposal): live person, still exactly their own workspace, same owner epoch
  if v_binding.brand_id <> 'u_' || substr(md5(v_user_id::text), 1, 24)
     or postona_g4_x_oauth.require_person(v_user_id) <> 'own' then
    raise exception 'OWN_WORKSPACE_CONFLICT';
  end if;
  if postona_g4_x_oauth.require_owner_epoch(v_binding.brand_id) <> v_binding.owner_epoch then
    raise exception 'OWNER_EPOCH_CHANGED';
  end if;

  select sa.* into v_account
  from public.social_accounts sa
  join public.brand_memberships bm on bm.brand_id = sa.brand_id
  where sa.id = v_social_account_id and sa.brand_id = v_binding.brand_id and bm.user_id = v_user_id and bm.role = 'owner'
  for update of sa;
  if not found then
    raise exception 'SOCIAL_MOBILE_ACCOUNT_NOT_OWNED';
  end if;
  if v_account.platform_user_id is not null and v_account.platform_user_id <> p_platform_user_id then
    raise exception 'X_IDENTITY_ACCOUNT_MISMATCH';
  end if;

  if v_account.vault_access_token_secret_id is null then
    v_account.vault_access_token_secret_id := vault.create_secret(p_access_token, v_social_account_id || '_access_token', 'OAuth access token.');
  else
    perform vault.update_secret(v_account.vault_access_token_secret_id, p_access_token);
  end if;
  if v_account.vault_refresh_token_secret_id is null then
    v_account.vault_refresh_token_secret_id := vault.create_secret(p_refresh_token, v_social_account_id || '_refresh_token', 'OAuth refresh token.');
  else
    perform vault.update_secret(v_account.vault_refresh_token_secret_id, p_refresh_token);
  end if;

  update public.social_accounts set
    vault_access_token_secret_id = v_account.vault_access_token_secret_id,
    vault_refresh_token_secret_id = v_account.vault_refresh_token_secret_id,
    platform_user_id = p_platform_user_id,
    handle = v_handle,
    publish_enabled = false,
    connection_status = 'identity_verified',
    verified_at = now(),
    last_connection_error_code = null,
    updated_at = now()
  where id = v_social_account_id;

  -- a new token lineage: every older lease / token holder is now stale
  update postona_g4_x_oauth.connections c
  set connection_epoch = c.connection_epoch + 1, latest_state_id = null, updated_at = now()
  where c.social_account_id = v_social_account_id;
exception
  when unique_violation then
    update public.social_accounts
    set connection_status = 'failed', last_connection_error_code = 'X_ACCOUNT_ALREADY_CONNECTED', updated_at = now()
    where id = v_social_account_id;
    raise exception 'X_ACCOUNT_ALREADY_CONNECTED';
end;
$$;

-- 004 L37-L83, verbatim
create or replace function public.consume_social_mobile_x_oauth_state(p_state_hash text)
returns table (oauth_state_id uuid, redirect_uri text, brand_id text, social_account_id text)
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_user_id uuid := auth.uid();
  v_state public.social_account_oauth_states%rowtype;
  v_binding postona_g4_x_oauth.state_bindings%rowtype;
  v_connection postona_g4_x_oauth.connections%rowtype;
begin
  if v_user_id is null then
    raise exception 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED';
  end if;
  select * into v_state from public.social_account_oauth_states s
  where s.state_hash = p_state_hash;
  if not found or v_state.initiated_by_user_id is distinct from v_user_id then
    -- the same error for "no such state" and "someone else's" (main's rule)
    raise exception 'OAUTH_STATE_NOT_CONSUMABLE';
  end if;
  if v_state.consumed_at is not null or v_state.expires_at <= now() then
    raise exception 'OAUTH_STATE_NOT_CONSUMABLE';
  end if;
  -- G4-43: what complete will require, asked before the code is exchanged with X
  select b.* into v_binding from postona_g4_x_oauth.state_bindings b where b.oauth_state_id = v_state.id;
  if not found or v_binding.initiated_by <> v_user_id or v_binding.social_account_id <> v_state.social_account_id
     or v_binding.brand_id <> v_state.brand_id then
    raise exception 'OAUTH_STATE_NOT_BOUND';
  end if;
  select c.* into v_connection from postona_g4_x_oauth.connections c where c.social_account_id = v_state.social_account_id;
  if not found or v_connection.latest_state_id is distinct from v_state.id then
    raise exception 'OAUTH_STATE_SUPERSEDED';
  end if;
  if v_connection.connection_epoch <> v_binding.connection_epoch then
    raise exception 'X_CONNECTION_CHANGED';
  end if;
  if v_binding.brand_id <> 'u_' || substr(md5(v_user_id::text), 1, 24)
     or postona_g4_x_oauth.require_person(v_user_id) <> 'own' then
    raise exception 'OWN_WORKSPACE_CONFLICT';
  end if;
  if postona_g4_x_oauth.require_owner_epoch(v_binding.brand_id) <> v_binding.owner_epoch then
    raise exception 'OWNER_EPOCH_CHANGED';
  end if;
  return query select v_state.id, v_state.redirect_uri, v_state.brand_id, v_state.social_account_id;
end;
$$;

do $$
begin
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.begin_social_mobile_x_oauth_connection(text,text,timestamptz)'))
       is distinct from 'c6dae1198ed3cf9aecbc1f129a7ec1bd'
     or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)'))
       is distinct from 'da1e93d5731d2ffad4c634e687e47445'
     or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.consume_social_mobile_x_oauth_state(text)'))
       is distinct from '58beaeb51a72b55612c01f505077ee63' then
    raise exception 'G4X_T13_ROLLBACK_POSTCONDITION_BODY';
  end if;
end $$;

commit;
