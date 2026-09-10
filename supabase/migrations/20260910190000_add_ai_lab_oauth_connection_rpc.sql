-- Phase 3C: only the service-role Edge Function may bridge OAuth values to
-- Vault. Public tables retain opaque UUID references and never token bodies.

create or replace function public.begin_ai_salaryman_lab_oauth_connection(
  p_handle text,
  p_state_hash text,
  p_code_verifier text,
  p_redirect_uri text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_handle text := lower(regexp_replace(trim(p_handle), '^@', ''));
  v_verifier_secret_id uuid;
begin
  if v_handle !~ '^[a-z0-9_]{1,15}$' then
    raise exception 'AI_LAB_HANDLE_INVALID';
  end if;
  if p_state_hash !~ '^[0-9a-f]{64}$' or length(p_code_verifier) < 43 or p_expires_at <= now() then
    raise exception 'OAUTH_STATE_INPUT_INVALID';
  end if;

  update public.brands
  set is_active = true, publish_mode = 'dry_run', updated_at = now()
  where id = 'ai_salaryman_lab';
  if not found then raise exception 'AI_LAB_BRAND_NOT_FOUND'; end if;

  insert into public.brand_settings (brand_id, fixed_hashtags, enabled_post_types)
  values ('ai_salaryman_lab', '[]'::jsonb, '[]'::jsonb)
  on conflict (brand_id) do nothing;

  insert into public.social_accounts
    (id, brand_id, platform, handle, publish_enabled, oauth_client_ref, connection_status)
  values ('ai_salaryman_lab_x', 'ai_salaryman_lab', 'x', v_handle, false, 'default', 'authorization_pending')
  on conflict (id) do update set
    handle = excluded.handle,
    publish_enabled = false,
    oauth_client_ref = 'default',
    connection_status = 'authorization_pending',
    last_connection_error_code = null,
    updated_at = now();

  v_verifier_secret_id := vault.create_secret(
    p_code_verifier,
    'ai_salaryman_lab_pkce_' || substring(p_state_hash from 1 for 16),
    'One-time PKCE verifier for the company AI lab OAuth callback.'
  );
  insert into public.social_account_oauth_states
    (social_account_id, brand_id, state_hash, code_verifier_vault_secret_id, redirect_uri, expires_at)
  values ('ai_salaryman_lab_x', 'ai_salaryman_lab', p_state_hash, v_verifier_secret_id, p_redirect_uri, p_expires_at);
end;
$$;

create or replace function public.consume_ai_salaryman_lab_oauth_state(p_state_hash text)
returns table (code_verifier text, redirect_uri text, expected_platform_user_id text)
language plpgsql
security definer
set search_path = public, vault
as $$
declare v_state public.social_account_oauth_states%rowtype;
begin
  select * into v_state from public.social_account_oauth_states
  where state_hash = p_state_hash and social_account_id = 'ai_salaryman_lab_x'
  for update;
  if not found or v_state.consumed_at is not null or v_state.expires_at <= now() then
    raise exception 'OAUTH_STATE_NOT_CONSUMABLE';
  end if;
  update public.social_account_oauth_states set consumed_at = now() where id = v_state.id;
  return query
    select s.decrypted_secret, v_state.redirect_uri, a.platform_user_id
    from vault.decrypted_secrets s
    join public.social_accounts a on a.id = v_state.social_account_id
    where s.id = v_state.code_verifier_vault_secret_id;
end;
$$;

create or replace function public.complete_ai_salaryman_lab_oauth_connection(
  p_access_token text,
  p_refresh_token text,
  p_platform_user_id text
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare v_account public.social_accounts%rowtype;
begin
  if p_access_token = '' or p_refresh_token = '' or p_platform_user_id = '' then
    raise exception 'OAUTH_TOKEN_OR_IDENTITY_INVALID';
  end if;
  select * into v_account from public.social_accounts where id = 'ai_salaryman_lab_x' for update;
  if not found or v_account.brand_id <> 'ai_salaryman_lab' or v_account.publish_enabled then
    raise exception 'AI_LAB_ACCOUNT_INVALID';
  end if;
  if v_account.platform_user_id is not null and v_account.platform_user_id <> p_platform_user_id then
    raise exception 'X_IDENTITY_ACCOUNT_MISMATCH';
  end if;
  if v_account.vault_access_token_secret_id is null then
    v_account.vault_access_token_secret_id := vault.create_secret(p_access_token, 'ai_salaryman_lab_x_access_token', 'OAuth access token.');
  else
    perform vault.update_secret(v_account.vault_access_token_secret_id, p_access_token);
  end if;
  if v_account.vault_refresh_token_secret_id is null then
    v_account.vault_refresh_token_secret_id := vault.create_secret(p_refresh_token, 'ai_salaryman_lab_x_refresh_token', 'OAuth refresh token.');
  else
    perform vault.update_secret(v_account.vault_refresh_token_secret_id, p_refresh_token);
  end if;
  update public.social_accounts set
    vault_access_token_secret_id = v_account.vault_access_token_secret_id,
    vault_refresh_token_secret_id = v_account.vault_refresh_token_secret_id,
    platform_user_id = p_platform_user_id,
    publish_enabled = false,
    connection_status = 'identity_verified',
    verified_at = now(),
    last_connection_error_code = null,
    updated_at = now()
  where id = 'ai_salaryman_lab_x';
end;
$$;

revoke all on function public.begin_ai_salaryman_lab_oauth_connection(text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.consume_ai_salaryman_lab_oauth_state(text) from public, anon, authenticated;
revoke all on function public.complete_ai_salaryman_lab_oauth_connection(text, text, text) from public, anon, authenticated;
grant execute on function public.begin_ai_salaryman_lab_oauth_connection(text, text, text, text, timestamptz) to service_role;
grant execute on function public.consume_ai_salaryman_lab_oauth_state(text) to service_role;
grant execute on function public.complete_ai_salaryman_lab_oauth_connection(text, text, text) to service_role;
