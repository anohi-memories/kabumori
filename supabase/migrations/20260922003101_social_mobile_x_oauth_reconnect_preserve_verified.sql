-- Preserve a previously verified X identity when a user starts another OAuth
-- attempt.  The existing onboarding RPC remains the single write path; this
-- replacement only changes the reconnect status transition.
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
    v_brand_id := 'u_' || substr(md5(v_user_id::text), 1, 24);
    insert into public.brands (id, display_name, is_active, publish_mode, code_profile_key)
    values (v_brand_id, 'My Workspace', false, 'disabled', 'social_mobile_user_v1')
    on conflict (id) do nothing;
    insert into public.brand_memberships (brand_id, user_id, role)
    values (v_brand_id, v_user_id, 'owner')
    on conflict on constraint brand_memberships_pkey do nothing;
  end if;

  select sa.id into v_social_account_id
  from public.social_accounts sa
  where sa.brand_id = v_brand_id and sa.platform = 'x';
  if v_social_account_id is null then
    v_social_account_id := 'sa_' || substr(md5(v_brand_id || ':x'), 1, 24);
    insert into public.social_accounts
      (id, brand_id, platform, handle, publish_enabled, oauth_client_ref, connection_status)
    values (v_social_account_id, v_brand_id, 'x', 'pending', false, 'default', 'authorization_pending');
  else
    -- A reconnect may refresh the OAuth state, but must not demote a verified
    -- identity before the callback succeeds or fails.
    update public.social_accounts
    set connection_status = case
          when connection_status = 'identity_verified' then 'identity_verified'
          else 'authorization_pending'
        end,
        last_connection_error_code = null,
        updated_at = now()
    where id = v_social_account_id;
  end if;

  insert into public.social_account_oauth_states
    (social_account_id, brand_id, state_hash, code_verifier_vault_secret_id, redirect_uri, expires_at, initiated_by_user_id)
  values (v_social_account_id, v_brand_id, p_state_hash, null, p_redirect_uri, p_expires_at, v_user_id);

  return query select v_brand_id, v_social_account_id;
end;
$$;

revoke all on function public.begin_social_mobile_x_oauth_connection(text, text, timestamptz)
  from public, anon, service_role;
grant execute on function public.begin_social_mobile_x_oauth_connection(text, text, timestamptz)
  to authenticated;
