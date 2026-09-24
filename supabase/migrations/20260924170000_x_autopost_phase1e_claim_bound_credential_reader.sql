-- SOURCE CANDIDATE ONLY. Do not apply until a separately reviewed activation.
-- Requires Phase1B (20260924023133) and Phase1D (20260924160000).
-- Read-only: no table, column, trigger, grant on existing objects, or data
-- change. Legacy credential paths (oauth_token_store, the AI Lab Vault RPC,
-- the social-mobile history reader) are untouched.
--
-- Exact-account invariant: the only authority for which X credential a v2
-- publish may use is the open pre-X attempt identified by
-- (p_attempt_id, p_claim_token). The account is taken from that attempt; the
-- caller's account/brand must match it exactly. There is no brand-only lookup,
-- no first-row selection, no hardcoded account, no shared/legacy token, and no
-- fallback to any other account. Only the access token is returned; refresh
-- tokens and Vault references never leave the database.
create function public.read_x_publish_credential_for_claim_v2(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_social_account_id text,
  p_expected_brand_id text,
  p_require_publish_enabled boolean default true
)
returns table (social_account_id text, brand_id text, platform_user_id text, access_token text)
language plpgsql security definer set search_path = '' as $$
declare
  v_attempt public.post_queue_attempts_v2%rowtype;
  v_account record;
  v_access_secret_id uuid;
  v_access_token text;
begin
  if p_attempt_id is null or p_claim_token is null
     or nullif(btrim(p_social_account_id), '') is null
     or nullif(btrim(p_expected_brand_id), '') is null
     or p_require_publish_enabled is null then
    raise exception 'X_CREDENTIAL_REQUEST_INVALID' using errcode = 'P0001';
  end if;

  -- 1. Claim authority: an open pre-X attempt for exactly this account/brand
  --    whose post is still running.
  select a.* into v_attempt from public.post_queue_attempts_v2 a
  where a.id = p_attempt_id and a.claim_token = p_claim_token;
  if not found or v_attempt.phase <> 'pre_x' then
    raise exception 'X_CLAIM_NOT_PRE_X' using errcode = 'P0001';
  end if;
  if v_attempt.social_account_id <> p_social_account_id
     or v_attempt.brand_id <> p_expected_brand_id then
    raise exception 'X_CLAIM_ACCOUNT_MISMATCH' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.scheduled_posts s
    where s.id = v_attempt.scheduled_post_id and s.status = 'running'
      and s.brand_id = v_attempt.brand_id
      and s.social_account_id = v_attempt.social_account_id
  ) then
    raise exception 'X_CLAIM_NOT_RUNNING' using errcode = 'P0001';
  end if;

  -- 2. Account metadata by primary key only. No Vault reference is read
  --    until every metadata check has passed.
  select sa.id, sa.brand_id, sa.platform, sa.connection_status,
         sa.platform_user_id, sa.publish_enabled
    into v_account
  from public.social_accounts sa
  where sa.id = v_attempt.social_account_id;
  if not found then
    raise exception 'X_ACCOUNT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_account.platform is distinct from 'x' then
    raise exception 'X_ACCOUNT_NOT_X' using errcode = 'P0001';
  end if;
  if v_account.brand_id is distinct from v_attempt.brand_id then
    raise exception 'X_ACCOUNT_BRAND_MISMATCH' using errcode = 'P0001';
  end if;
  if v_account.connection_status is distinct from 'identity_verified'
     or nullif(btrim(v_account.platform_user_id), '') is null then
    raise exception 'X_ACCOUNT_NOT_VERIFIED' using errcode = 'P0001';
  end if;
  if p_require_publish_enabled and v_account.publish_enabled is distinct from true then
    raise exception 'X_ACCOUNT_PUBLISH_DISABLED' using errcode = 'P0001';
  end if;

  -- 3. Secret retrieval: the access-token reference stored on this exact row.
  select sa.vault_access_token_secret_id into v_access_secret_id
  from public.social_accounts sa
  where sa.id = v_account.id and sa.brand_id = v_account.brand_id and sa.platform = 'x';
  if v_access_secret_id is null then
    raise exception 'X_CREDENTIAL_NOT_CONFIGURED' using errcode = 'P0001';
  end if;
  select ds.decrypted_secret into v_access_token
  from vault.decrypted_secrets ds where ds.id = v_access_secret_id;
  if not found or nullif(v_access_token, '') is null then
    raise exception 'X_CREDENTIAL_UNAVAILABLE' using errcode = 'P0001';
  end if;

  social_account_id := v_account.id;
  brand_id := v_account.brand_id;
  platform_user_id := v_account.platform_user_id;
  access_token := v_access_token;
  return next;
exception
  when sqlstate 'P0001' then
    raise;
  when others then
    -- Never surface database errors, references, or secret values.
    raise exception 'X_CREDENTIAL_UNAVAILABLE' using errcode = 'P0001';
end;
$$;

revoke all on function public.read_x_publish_credential_for_claim_v2(uuid, uuid, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.read_x_publish_credential_for_claim_v2(uuid, uuid, text, text, boolean)
  to service_role;
