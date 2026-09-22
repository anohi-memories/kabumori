-- Phase 19 source candidate only. Do not apply to production without a separate
-- rollout approval. This is a server-only, access-token-only history reader.
-- The service-role caller supplies the Auth user id obtained by getUser() and
-- the account id already resolved through the user's owner-scoped session;
-- ownership is independently checked below before any Vault plaintext read.

do $$
begin
  if to_regclass('public.social_accounts') is null
     or to_regclass('public.brand_memberships') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise exception 'SOCIAL_MOBILE_HISTORY_READER_SCHEMA_MISSING';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'social_accounts'
      and column_name = 'vault_access_token_secret_id' and udt_name = 'uuid'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'social_accounts'
      and column_name = 'vault_refresh_token_secret_id' and udt_name = 'uuid'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'vault' and table_name = 'decrypted_secrets'
      and column_name = 'id' and udt_name = 'uuid'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'vault' and table_name = 'decrypted_secrets'
      and column_name = 'decrypted_secret'
  ) then
    raise exception 'SOCIAL_MOBILE_HISTORY_READER_SCHEMA_MISMATCH';
  end if;
  if to_regprocedure('public.read_social_mobile_history_access_token(uuid,text)') is not null then
    raise exception 'SOCIAL_MOBILE_HISTORY_READER_RPC_ALREADY_EXISTS';
  end if;
end;
$$;

create function public.read_social_mobile_history_access_token(
  p_user_id uuid,
  p_social_account_id text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_brand_id text;
  v_platform text;
  v_connection_status text;
  v_platform_user_id text;
  v_access_secret_id uuid;
  v_x_account_count integer;
  v_verified_x_account_count integer;
  v_access_token text;
begin
  if p_user_id is null or p_social_account_id is null or btrim(p_social_account_id) = '' then
    raise exception 'HISTORY_ACCESS_TOKEN_UNAVAILABLE' using errcode = 'P0001';
  end if;

  -- Resolve only a server-trusted user/account pair and prove ownership first.
  select sa.brand_id, sa.platform, sa.connection_status, sa.platform_user_id
    into v_brand_id, v_platform, v_connection_status, v_platform_user_id
  from public.social_accounts as sa
  join public.brand_memberships as bm
    on bm.brand_id = sa.brand_id
   and bm.user_id = p_user_id
   and bm.role = 'owner'
  where sa.id = p_social_account_id;

  if not found then
    raise exception 'HISTORY_ACCESS_TOKEN_UNAVAILABLE' using errcode = 'P0001';
  end if;

  -- Fail closed if the owned brand has multiple X accounts, even if only one
  -- currently looks usable. Phase 16 also enforces exactly-one before calling.
  select count(*)::integer,
         count(*) filter (
           where sa.connection_status = 'identity_verified'
             and nullif(btrim(sa.platform_user_id), '') is not null
         )::integer
    into v_x_account_count, v_verified_x_account_count
  from public.social_accounts as sa
  where sa.brand_id = v_brand_id and sa.platform = 'x';

  if v_x_account_count <> 1
     or v_verified_x_account_count <> 1
     or v_platform <> 'x'
     or v_connection_status <> 'identity_verified'
     or nullif(btrim(v_platform_user_id), '') is null then
    raise exception 'HISTORY_ACCESS_TOKEN_UNAVAILABLE' using errcode = 'P0001';
  end if;

  -- Do not select any Vault reference until ownership, platform, identity,
  -- and one-X-account checks have all passed. Refresh refs are never selected.
  select sa.vault_access_token_secret_id
    into v_access_secret_id
  from public.social_accounts as sa
  where sa.id = p_social_account_id
    and sa.brand_id = v_brand_id
    and sa.platform = 'x'
    and sa.connection_status = 'identity_verified'
    and nullif(btrim(sa.platform_user_id), '') is not null;

  if v_access_secret_id is null then
    raise exception 'HISTORY_ACCESS_TOKEN_UNAVAILABLE' using errcode = 'P0001';
  end if;

  select ds.decrypted_secret
    into v_access_token
  from vault.decrypted_secrets as ds
  where ds.id = v_access_secret_id;

  if not found or nullif(v_access_token, '') is null then
    raise exception 'HISTORY_ACCESS_TOKEN_UNAVAILABLE' using errcode = 'P0001';
  end if;
  return v_access_token;
exception
  when sqlstate 'P0001' then
    raise;
  when others then
    -- Never include database errors or secret values in the PostgREST error.
    raise exception 'HISTORY_ACCESS_TOKEN_UNAVAILABLE' using errcode = 'P0001';
end;
$$;

revoke all on function public.read_social_mobile_history_access_token(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.read_social_mobile_history_access_token(uuid, text)
  to service_role;
