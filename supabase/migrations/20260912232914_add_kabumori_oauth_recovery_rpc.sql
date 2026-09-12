-- Kabumori OAuth recovery uses the existing account-aware OAuth state table
-- and Vault-backed one-time PKCE storage. These RPCs are deliberately
-- account-specific so a caller cannot redirect credentials to another brand.

create or replace function public.begin_kabumori_oauth_recovery(
  p_state_hash text,
  p_code_verifier text,
  p_redirect_uri text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.social_accounts%rowtype;
  v_brand public.brands%rowtype;
  v_verifier_secret_id uuid;
begin
  if p_state_hash !~ '^[0-9a-f]{64}$'
    or length(p_code_verifier) < 43
    or p_redirect_uri = ''
    or p_expires_at <= now()
  then
    raise exception 'OAUTH_STATE_INPUT_INVALID';
  end if;

  select * into v_account
  from public.social_accounts
  where id = 'kabumori_x'
  for update;

  if not found
    or v_account.brand_id <> 'kabumori'
    or v_account.platform <> 'x'
    or lower(regexp_replace(v_account.handle, '^@', '')) <> 'kabumori'
    or not v_account.publish_enabled
    or v_account.oauth_client_ref <> 'default'
  then
    raise exception 'KABUMORI_ACCOUNT_INVALID';
  end if;

  select * into v_brand
  from public.brands
  where id = 'kabumori';

  if not found or not v_brand.is_active or v_brand.publish_mode <> 'live' then
    raise exception 'KABUMORI_BRAND_NOT_LIVE';
  end if;

  v_verifier_secret_id := vault.create_secret(
    p_code_verifier,
    'kabumori_x_pkce_' || substring(p_state_hash from 1 for 16),
    'One-time PKCE verifier for Kabumori OAuth recovery.'
  );

  insert into public.social_account_oauth_states
    (social_account_id, brand_id, state_hash, code_verifier_vault_secret_id, redirect_uri, expires_at)
  values
    ('kabumori_x', 'kabumori', p_state_hash, v_verifier_secret_id, p_redirect_uri, p_expires_at);

  update public.social_accounts
  set connection_status = 'authorization_pending',
      last_connection_error_code = null,
      updated_at = now()
  where id = 'kabumori_x';
end;
$$;

create or replace function public.consume_kabumori_oauth_recovery_state(
  p_state_hash text
)
returns table (
  code_verifier text,
  redirect_uri text,
  expected_platform_user_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state public.social_account_oauth_states%rowtype;
begin
  select * into v_state
  from public.social_account_oauth_states
  where state_hash = p_state_hash
    and social_account_id = 'kabumori_x'
    and brand_id = 'kabumori'
  for update;

  if not found or v_state.consumed_at is not null or v_state.expires_at <= now() then
    raise exception 'OAUTH_STATE_NOT_CONSUMABLE';
  end if;

  update public.social_account_oauth_states
  set consumed_at = now()
  where id = v_state.id;

  return query
  select secret.decrypted_secret,
         v_state.redirect_uri,
         account.platform_user_id
  from vault.decrypted_secrets as secret
  join public.social_accounts as account
    on account.id = v_state.social_account_id
  where secret.id = v_state.code_verifier_vault_secret_id
    and account.brand_id = 'kabumori'
    and account.platform = 'x'
    and lower(regexp_replace(account.handle, '^@', '')) = 'kabumori';
end;
$$;

create or replace function public.complete_kabumori_oauth_recovery(
  p_platform_user_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.social_accounts%rowtype;
begin
  if p_platform_user_id is null or p_platform_user_id = '' then
    raise exception 'OAUTH_IDENTITY_INVALID';
  end if;

  select * into v_account
  from public.social_accounts
  where id = 'kabumori_x'
  for update;

  if not found
    or v_account.brand_id <> 'kabumori'
    or v_account.platform <> 'x'
    or lower(regexp_replace(v_account.handle, '^@', '')) <> 'kabumori'
    or not v_account.publish_enabled
    or v_account.oauth_client_ref <> 'default'
    or v_account.connection_status <> 'authorization_pending'
  then
    raise exception 'KABUMORI_ACCOUNT_INVALID';
  end if;

  if v_account.platform_user_id is not null
    and v_account.platform_user_id <> p_platform_user_id
  then
    raise exception 'X_IDENTITY_ACCOUNT_MISMATCH';
  end if;

  update public.social_accounts
  set platform_user_id = p_platform_user_id,
      connection_status = 'identity_verified',
      verified_at = now(),
      last_connection_error_code = null,
      updated_at = now()
  where id = 'kabumori_x';
end;
$$;

revoke all on function public.begin_kabumori_oauth_recovery(text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.consume_kabumori_oauth_recovery_state(text)
  from public, anon, authenticated;
revoke all on function public.complete_kabumori_oauth_recovery(text)
  from public, anon, authenticated;

grant execute on function public.begin_kabumori_oauth_recovery(text, text, text, timestamptz)
  to service_role;
grant execute on function public.consume_kabumori_oauth_recovery_state(text)
  to service_role;
grant execute on function public.complete_kabumori_oauth_recovery(text)
  to service_role;
