-- SOURCE CANDIDATE ONLY. Do not apply until a separately reviewed activation.
--
-- Universal exact-account X credential refresh core. Applies on its own on top
-- of the current production baseline (it does NOT require Phase1B..1H): it only
-- needs public.social_accounts (production shape), public.scheduled_posts and
-- Supabase Vault. Phase1I (20260925150000) later adds the v2-attempt lease kind
-- on top of this same table, so there is exactly one single-flight lease per
-- account for every publish path.
--
-- This file serves the live (legacy, unbound) dispatcher: the authority is the
-- running scheduled post being published, and the account is the post brand's
-- one and only X account (social_accounts is UNIQUE (brand_id, platform); the
-- functions re-check that exactly one exists and that it is the caller's).
-- Tokens are written only to that account's own Vault secrets. X refresh
-- tokens are single-use: any refresh whose result was not durably stored
-- leaves the account blocked ('uncertain') for operator review.
--
-- Transaction: one explicit transaction; apply alone with a tool that does NOT
-- wrap the file in another transaction; not re-runnable.
begin;

do $$
begin
  if to_regprocedure('vault.update_secret(uuid,text,text,text,uuid)') is null
     or to_regclass('vault.decrypted_secrets') is null
     or to_regclass('public.scheduled_posts') is null then
    raise exception 'CORE_PRECONDITION_VAULT_OR_QUEUE_MISSING';
  end if;
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'social_accounts'
        and column_name in ('oauth_client_ref', 'updated_at', 'vault_access_token_secret_id',
                            'vault_refresh_token_secret_id', 'connection_status', 'platform_user_id',
                            'publish_enabled', 'last_connection_error_code', 'verified_at')) <> 9 then
    raise exception 'CORE_PRECONDITION_SOCIAL_ACCOUNTS_SHAPE';
  end if;
  if to_regclass('public.x_account_refresh_state_v2') is not null then
    raise exception 'CORE_PRECONDITION_ALREADY_APPLIED';
  end if;
end $$;

-- 1. One refresh state row per account (created on first use).
create table public.x_account_refresh_state_v2 (
  social_account_id text primary key references public.social_accounts (id),
  status text not null default 'idle'
    check (status in ('idle', 'refreshing', 'uncertain', 'reauth_required')),
  generation bigint not null default 0,
  lease_token uuid,
  lease_kind text check (lease_kind in ('legacy_post', 'v2_attempt')),
  lease_post_id uuid references public.scheduled_posts (id),
  lease_post_attempt integer,
  lease_attempt_id uuid,  -- Phase1I adds the FK to post_queue_attempts_v2
  leased_at timestamptz,
  account_updated_at timestamptz,
  leased_brand_id text,
  leased_platform_user_id text,
  leased_oauth_client_ref text,
  leased_access_secret_id uuid,
  leased_refresh_secret_id uuid,
  legacy_refreshed_post_id uuid,
  legacy_refreshed_post_attempt integer,
  access_expires_at timestamptz,
  last_refreshed_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,99}$'),
  constraint x_account_refresh_state_v2_lease_status check ((status = 'refreshing') = (lease_token is not null)),
  constraint x_account_refresh_state_v2_lease_shape check (
    (lease_token is null and lease_kind is null and lease_post_id is null and lease_post_attempt is null
       and lease_attempt_id is null and leased_at is null)
    or (lease_token is not null and leased_at is not null and lease_kind = 'legacy_post'
       and lease_post_id is not null and lease_post_attempt is not null and lease_attempt_id is null)
    or (lease_token is not null and leased_at is not null and lease_kind = 'v2_attempt'
       and lease_attempt_id is not null and lease_post_id is null and lease_post_attempt is null))
);
alter table public.x_account_refresh_state_v2 enable row level security;
revoke all on public.x_account_refresh_state_v2 from public, anon, authenticated, service_role;
grant select on public.x_account_refresh_state_v2 to service_role;

-- 2. Internal: the account a running legacy post publishes to. Returns the
--    locked account row or raises a fixed code. Never picks among several.
create function public.x_legacy_post_account(
  p_scheduled_post_id uuid, p_social_account_id text, p_brand_id text, p_lock boolean
) returns public.social_accounts language plpgsql security definer set search_path = '' as $$
declare v_post public.scheduled_posts%rowtype;
        v_account public.social_accounts%rowtype;
begin
  if p_scheduled_post_id is null or nullif(btrim(p_social_account_id), '') is null
     or nullif(btrim(p_brand_id), '') is null then
    raise exception 'X_CREDENTIAL_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  if p_lock then
    select s.* into v_post from public.scheduled_posts s where s.id = p_scheduled_post_id for update;
  else
    select s.* into v_post from public.scheduled_posts s where s.id = p_scheduled_post_id;
  end if;
  -- Unbound (legacy) rows only; a Phase1B-bound row belongs to the v2 path.
  if not found or v_post.status is distinct from 'running' or v_post.brand_id is distinct from p_brand_id
     or (pg_catalog.to_jsonb(v_post) ->> 'social_account_id') is not null then
    raise exception 'X_LEGACY_POST_NOT_RUNNING' using errcode = 'P0001';
  end if;
  if (select count(*) from public.social_accounts sa where sa.brand_id = v_post.brand_id and sa.platform = 'x') <> 1 then
    raise exception 'X_ACCOUNT_NOT_UNIQUE_FOR_BRAND' using errcode = 'P0001';
  end if;
  if p_lock then
    select sa.* into v_account from public.social_accounts sa
    where sa.brand_id = v_post.brand_id and sa.platform = 'x' for update;
  else
    select sa.* into v_account from public.social_accounts sa
    where sa.brand_id = v_post.brand_id and sa.platform = 'x';
  end if;
  if v_account.id is distinct from p_social_account_id then
    raise exception 'X_CLAIM_ACCOUNT_MISMATCH' using errcode = 'P0001';
  end if;
  if v_account.connection_status is distinct from 'identity_verified'
     or nullif(btrim(v_account.platform_user_id), '') is null then
    raise exception 'X_ACCOUNT_NOT_VERIFIED' using errcode = 'P0001';
  end if;
  if v_account.publish_enabled is distinct from true then
    raise exception 'X_ACCOUNT_PUBLISH_DISABLED' using errcode = 'P0001';
  end if;
  if v_account.vault_access_token_secret_id is null or v_account.vault_refresh_token_secret_id is null
     or v_account.vault_access_token_secret_id = v_account.vault_refresh_token_secret_id then
    raise exception 'X_CREDENTIAL_NOT_CONFIGURED' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.social_accounts o
    where o.id <> v_account.id
      and (o.vault_access_token_secret_id in (v_account.vault_access_token_secret_id, v_account.vault_refresh_token_secret_id)
        or o.vault_refresh_token_secret_id in (v_account.vault_access_token_secret_id, v_account.vault_refresh_token_secret_id))
  ) then
    raise exception 'X_REFRESH_SECRET_REF_SHARED' using errcode = 'P0001';
  end if;
  return v_account;
end;
$$;

-- 3. Access token for the running legacy post's own account. Refuses (before
--    any content generation) while the account is being refreshed or is
--    blocked; re-authorization is reflected as connection_status 'failed'.
create function public.read_x_publish_credential_for_legacy_post(
  p_scheduled_post_id uuid, p_social_account_id text, p_brand_id text
) returns table (social_account_id text, brand_id text, platform_user_id text, access_token text, access_expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_account public.social_accounts%rowtype;
        v_state public.x_account_refresh_state_v2%rowtype;
        v_token text;
begin
  v_account := public.x_legacy_post_account(p_scheduled_post_id, p_social_account_id, p_brand_id, false);
  select st.* into v_state from public.x_account_refresh_state_v2 st where st.social_account_id = v_account.id;
  if v_state.status = 'refreshing' then raise exception 'X_REFRESH_IN_PROGRESS' using errcode = 'P0001'; end if;
  if v_state.status = 'uncertain' then raise exception 'X_REFRESH_BLOCKED_UNCERTAIN' using errcode = 'P0001'; end if;
  if v_state.status = 'reauth_required' then raise exception 'X_REFRESH_REAUTH_REQUIRED' using errcode = 'P0001'; end if;
  begin
    select ds.decrypted_secret into v_token from vault.decrypted_secrets ds where ds.id = v_account.vault_access_token_secret_id;
  exception when others then
    raise exception 'X_CREDENTIAL_UNAVAILABLE' using errcode = 'P0001';
  end;
  if nullif(v_token, '') is null then raise exception 'X_CREDENTIAL_UNAVAILABLE' using errcode = 'P0001'; end if;
  social_account_id := v_account.id;
  brand_id := v_account.brand_id;
  platform_user_id := v_account.platform_user_id;
  access_token := v_token;
  access_expires_at := v_state.access_expires_at;
  return next;
exception
  when sqlstate 'P0001' then raise;
  when others then raise exception 'X_CREDENTIAL_UNAVAILABLE' using errcode = 'P0001';
end;
$$;

-- 4. Begin a refresh for the running legacy post's account: at most one per
--    post attempt, single-flight per account, snapshot of everything commit
--    re-checks. The refresh token goes to the server refresh helper only.
create function public.begin_x_account_refresh_legacy_post(
  p_scheduled_post_id uuid, p_social_account_id text, p_brand_id text
) returns table (lease_token uuid, oauth_client_ref text, refresh_token text)
language plpgsql security definer set search_path = '' as $$
declare v_account public.social_accounts%rowtype;
        v_attempt integer;
        v_state public.x_account_refresh_state_v2%rowtype;
        v_refresh text;
        v_lease uuid;
begin
  -- Post -> account -> state: the same lock order as commit.
  v_account := public.x_legacy_post_account(p_scheduled_post_id, p_social_account_id, p_brand_id, true);
  if nullif(btrim(v_account.oauth_client_ref), '') is null then
    raise exception 'X_REFRESH_CLIENT_NOT_CONFIGURED' using errcode = 'P0001';
  end if;
  select s.attempt_count into v_attempt from public.scheduled_posts s where s.id = p_scheduled_post_id;
  insert into public.x_account_refresh_state_v2 (social_account_id) values (v_account.id)
  on conflict (social_account_id) do nothing;
  select st.* into v_state from public.x_account_refresh_state_v2 st
  where st.social_account_id = v_account.id for update;
  if v_state.status = 'refreshing' then raise exception 'X_REFRESH_IN_PROGRESS' using errcode = 'P0001'; end if;
  if v_state.status = 'uncertain' then raise exception 'X_REFRESH_BLOCKED_UNCERTAIN' using errcode = 'P0001'; end if;
  if v_state.status = 'reauth_required' then raise exception 'X_REFRESH_REAUTH_REQUIRED' using errcode = 'P0001'; end if;
  if v_state.legacy_refreshed_post_id = p_scheduled_post_id and v_state.legacy_refreshed_post_attempt = v_attempt then
    raise exception 'X_REFRESH_ALREADY_USED_FOR_ATTEMPT' using errcode = 'P0001';
  end if;
  begin
    select ds.decrypted_secret into v_refresh from vault.decrypted_secrets ds where ds.id = v_account.vault_refresh_token_secret_id;
  exception when others then
    raise exception 'X_REFRESH_CREDENTIAL_UNAVAILABLE' using errcode = 'P0001';
  end;
  if nullif(v_refresh, '') is null then raise exception 'X_REFRESH_CREDENTIAL_UNAVAILABLE' using errcode = 'P0001'; end if;

  v_lease := gen_random_uuid();
  update public.x_account_refresh_state_v2 st
  set status = 'refreshing', lease_token = v_lease, lease_kind = 'legacy_post',
      lease_post_id = p_scheduled_post_id, lease_post_attempt = v_attempt, leased_at = now(),
      account_updated_at = v_account.updated_at, leased_brand_id = v_account.brand_id,
      leased_platform_user_id = v_account.platform_user_id, leased_oauth_client_ref = v_account.oauth_client_ref,
      leased_access_secret_id = v_account.vault_access_token_secret_id,
      leased_refresh_secret_id = v_account.vault_refresh_token_secret_id,
      legacy_refreshed_post_id = p_scheduled_post_id, legacy_refreshed_post_attempt = v_attempt,
      last_error_code = null
  where st.social_account_id = v_account.id;
  lease_token := v_lease;
  oauth_client_ref := v_account.oauth_client_ref;
  refresh_token := v_refresh;
  return next;
exception
  when sqlstate 'P0001' then raise;
  when others then raise exception 'X_REFRESH_UNAVAILABLE' using errcode = 'P0001';
end;
$$;

-- 5. Commit: current legacy lease only; the post is still the same running
--    attempt; the account (identity, brand, client, both refs, publish,
--    updated_at) is unchanged and still exclusively owns its refs. Secrets and
--    lease release are one transaction; any mismatch turns the lease
--    'uncertain' because X has already rotated the token.
create function public.commit_x_account_refresh_legacy_post(
  p_lease_token uuid, p_social_account_id text, p_access_token text,
  p_refresh_token text default null, p_expires_in integer default null
) returns text language plpgsql security definer set search_path = '' as $$
declare v_state public.x_account_refresh_state_v2%rowtype;
        v_post public.scheduled_posts%rowtype;
        v_account public.social_accounts%rowtype;
        v_ok boolean;
begin
  if p_lease_token is null or nullif(btrim(p_social_account_id), '') is null
     or nullif(btrim(p_access_token), '') is null
     or (p_refresh_token is not null and nullif(btrim(p_refresh_token), '') is null)
     or (p_expires_in is not null and (p_expires_in < 1 or p_expires_in > 2592000)) then
    raise exception 'X_REFRESH_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  -- Freeze account/ref membership while validating and writing Vault. Self-
  -- conflicting so two commits (whose health mirror may update the account)
  -- serialize instead of deadlocking on a SHARE -> ROW EXCLUSIVE upgrade.
  lock table public.social_accounts in share row exclusive mode;
  select st.* into v_state from public.x_account_refresh_state_v2 st
  where st.social_account_id = p_social_account_id and st.status = 'refreshing'
    and st.lease_token = p_lease_token and st.lease_kind = 'legacy_post';
  if not found then return 'lease_lost'; end if;
  select s.* into v_post from public.scheduled_posts s where s.id = v_state.lease_post_id for update;
  select sa.* into v_account from public.social_accounts sa where sa.id = p_social_account_id for update;
  select st.* into v_state from public.x_account_refresh_state_v2 st
  where st.social_account_id = p_social_account_id for update;
  if v_state.status <> 'refreshing' or v_state.lease_token is distinct from p_lease_token
     or v_state.lease_kind is distinct from 'legacy_post' then
    return 'lease_lost';
  end if;
  v_ok := v_post.id is not null and v_post.status = 'running'
    and v_post.attempt_count = v_state.lease_post_attempt
    and v_post.brand_id is not distinct from v_state.leased_brand_id
    and (pg_catalog.to_jsonb(v_post) ->> 'social_account_id') is null
    and v_account.id is not null and v_account.platform = 'x'
    and v_account.brand_id is not distinct from v_state.leased_brand_id
    and v_account.connection_status = 'identity_verified'
    and v_account.platform_user_id is not distinct from v_state.leased_platform_user_id
    and v_account.publish_enabled is true
    and v_account.oauth_client_ref is not distinct from v_state.leased_oauth_client_ref
    and v_account.vault_access_token_secret_id is not distinct from v_state.leased_access_secret_id
    and v_account.vault_refresh_token_secret_id is not distinct from v_state.leased_refresh_secret_id
    and v_account.vault_access_token_secret_id <> v_account.vault_refresh_token_secret_id
    and v_account.updated_at is not distinct from v_state.account_updated_at
    and not exists (
      select 1 from public.social_accounts o where o.id <> p_social_account_id
        and (o.vault_access_token_secret_id in (v_state.leased_access_secret_id, v_state.leased_refresh_secret_id)
          or o.vault_refresh_token_secret_id in (v_state.leased_access_secret_id, v_state.leased_refresh_secret_id)))
    and (select count(*) from public.social_accounts sa where sa.brand_id = v_state.leased_brand_id and sa.platform = 'x') = 1;
  if not v_ok then
    update public.x_account_refresh_state_v2 st
    set status = 'uncertain', lease_token = null, lease_kind = null, lease_post_id = null, lease_post_attempt = null,
        lease_attempt_id = null, leased_at = null, last_error_code = 'X_REFRESH_ACCOUNT_CHANGED'
    where st.social_account_id = p_social_account_id;
    return 'account_changed';
  end if;
  begin
    perform vault.update_secret(v_account.vault_access_token_secret_id, p_access_token);
    if p_refresh_token is not null then
      perform vault.update_secret(v_account.vault_refresh_token_secret_id, p_refresh_token);
    end if;
  exception when others then
    raise exception 'X_REFRESH_PERSIST_FAILED' using errcode = 'P0001';
  end;
  update public.x_account_refresh_state_v2 st
  set status = 'idle', generation = st.generation + 1, lease_token = null, lease_kind = null,
      lease_post_id = null, lease_post_attempt = null, lease_attempt_id = null, leased_at = null,
      access_expires_at = case when p_expires_in is null then null else now() + make_interval(secs => p_expires_in) end,
      last_refreshed_at = now(), last_error_code = null
  where st.social_account_id = p_social_account_id;
  return 'committed';
exception
  when sqlstate 'P0001' then raise;
  when others then raise exception 'X_REFRESH_PERSIST_FAILED' using errcode = 'P0001';
end;
$$;

-- 6. Release any lease (legacy or v2) without new tokens. 'not_rotated' only
--    when X answered that it issued nothing; 'reauth_required' when X rejected
--    the grant; 'uncertain' whenever X may have rotated the token.
create function public.release_x_account_refresh_v2(
  p_lease_token uuid, p_social_account_id text, p_outcome text, p_error_code text
) returns text language plpgsql security definer set search_path = '' as $$
declare v_state public.x_account_refresh_state_v2%rowtype;
begin
  if p_lease_token is null or nullif(btrim(p_social_account_id), '') is null
     or p_outcome is null or p_outcome not in ('not_rotated', 'reauth_required', 'uncertain')
     or p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{1,99}$' then
    raise exception 'X_REFRESH_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  select st.* into v_state from public.x_account_refresh_state_v2 st
  where st.social_account_id = p_social_account_id for update;
  if not found or v_state.status <> 'refreshing' or v_state.lease_token is distinct from p_lease_token then
    return 'lease_lost';
  end if;
  update public.x_account_refresh_state_v2 st
  set status = case p_outcome when 'not_rotated' then 'idle' else p_outcome end,
      lease_token = null, lease_kind = null, lease_post_id = null, lease_post_attempt = null,
      lease_attempt_id = null, leased_at = null, last_error_code = p_error_code
  where st.social_account_id = p_social_account_id;
  return case p_outcome when 'not_rotated' then 'idle' else p_outcome end;
end;
$$;

-- 7. X rejected a freshly refreshed token for this very post attempt: the
--    grant is no longer usable. Mark re-authorization required (no retry).
create function public.record_x_account_rejected_after_refresh(
  p_scheduled_post_id uuid, p_social_account_id text, p_brand_id text
) returns text language plpgsql security definer set search_path = '' as $$
declare v_account public.social_accounts%rowtype;
        v_attempt integer;
        v_state public.x_account_refresh_state_v2%rowtype;
begin
  v_account := public.x_legacy_post_account(p_scheduled_post_id, p_social_account_id, p_brand_id, true);
  select s.attempt_count into v_attempt from public.scheduled_posts s where s.id = p_scheduled_post_id;
  select st.* into v_state from public.x_account_refresh_state_v2 st
  where st.social_account_id = v_account.id for update;
  if not found or v_state.status <> 'idle' or v_state.legacy_refreshed_post_id is distinct from p_scheduled_post_id
     or v_state.legacy_refreshed_post_attempt is distinct from v_attempt or v_state.last_refreshed_at is null
     or v_state.last_refreshed_at < now() - interval '15 minutes' then
    return 'not_applicable';
  end if;
  update public.x_account_refresh_state_v2 st
  set status = 'reauth_required', last_error_code = 'X_ACCESS_TOKEN_REJECTED_AFTER_REFRESH'
  where st.social_account_id = v_account.id;
  return 'reauth_required';
exception
  when sqlstate 'P0001' then raise;
  when others then raise exception 'X_REFRESH_UNAVAILABLE' using errcode = 'P0001';
end;
$$;

-- 8. X rejected the access token and no refresh may run for this attempt
--    (refresh gate off, or this attempt already used its one refresh): make
--    the 401 visible on the account without judging the refresh credential.
--    Never while a lease is held; never changes connection_status.
create function public.record_x_account_access_unauthorized(
  p_scheduled_post_id uuid, p_social_account_id text, p_brand_id text
) returns text language plpgsql security definer set search_path = '' as $$
declare v_account public.social_accounts%rowtype;
        v_status text;
begin
  v_account := public.x_legacy_post_account(p_scheduled_post_id, p_social_account_id, p_brand_id, true);
  select st.status into v_status from public.x_account_refresh_state_v2 st
  where st.social_account_id = v_account.id for update;
  if v_status is not null and v_status <> 'idle' then return 'not_applicable'; end if;
  update public.social_accounts sa set last_connection_error_code = 'X_ACCESS_TOKEN_UNAUTHORIZED'
  where sa.id = v_account.id and sa.last_connection_error_code is distinct from 'X_ACCESS_TOKEN_UNAUTHORIZED';
  return 'recorded';
exception
  when sqlstate 'P0001' then raise;
  when others then raise exception 'X_REFRESH_UNAVAILABLE' using errcode = 'P0001';
end;
$$;

-- 9. Account health mirror. connection_status keeps the production CHECK set
--    (unconnected / authorization_pending / connected / identity_verified /
--    failed): re-authorization required -> 'failed' + fixed error code, which
--    stops the legacy reader and the v2 claim before any generation. Other
--    outcomes only set/clear last_connection_error_code. updated_at (the
--    account-configuration stamp that leases snapshot) changes only with
--    connection_status. verified_at is never touched: a refresh is not an
--    identity verification.
create function public.x_account_refresh_health_mirror() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  if new.status = 'reauth_required' and old.status is distinct from 'reauth_required' then
    update public.social_accounts sa
    set connection_status = 'failed', last_connection_error_code = new.last_error_code, updated_at = now()
    where sa.id = new.social_account_id;
    return null;
  end if;
  if new.status = 'uncertain' and old.status is distinct from 'uncertain' then
    v_code := new.last_error_code;
  elsif new.status = 'idle' and old.status = 'refreshing' then
    -- committed refresh clears the code; not_rotated shows why nothing changed
    v_code := case when new.generation > old.generation then null else new.last_error_code end;
  else
    return null;
  end if;
  update public.social_accounts sa set last_connection_error_code = v_code
  where sa.id = new.social_account_id and sa.last_connection_error_code is distinct from v_code;
  return null;
end;
$$;
create trigger x_account_refresh_state_v2_health
after update of status on public.x_account_refresh_state_v2
for each row execute function public.x_account_refresh_health_mirror();

-- 10. A completed OAuth (re)connection writes a fresh token pair and stamps
--     verified_at: that resolves 'uncertain' / 'reauth_required'. A lease that
--     is still 'refreshing' is left alone (its commit sees the account change).
create function public.x_account_refresh_reset_on_reconnect() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.x_account_refresh_state_v2 st
  set status = 'idle', last_error_code = null
  where st.social_account_id = new.id and st.status in ('uncertain', 'reauth_required');
  return null;
end;
$$;
create trigger social_accounts_x_refresh_reset_on_reconnect
after update of verified_at on public.social_accounts
for each row when (new.connection_status = 'identity_verified' and new.verified_at is distinct from old.verified_at)
execute function public.x_account_refresh_reset_on_reconnect();

revoke all on function public.x_legacy_post_account(uuid, text, text, boolean),
  public.read_x_publish_credential_for_legacy_post(uuid, text, text),
  public.begin_x_account_refresh_legacy_post(uuid, text, text),
  public.commit_x_account_refresh_legacy_post(uuid, text, text, text, integer),
  public.release_x_account_refresh_v2(uuid, text, text, text),
  public.record_x_account_rejected_after_refresh(uuid, text, text),
  public.record_x_account_access_unauthorized(uuid, text, text),
  public.x_account_refresh_health_mirror(),
  public.x_account_refresh_reset_on_reconnect()
from public, anon, authenticated, service_role;
grant execute on function
  public.read_x_publish_credential_for_legacy_post(uuid, text, text),
  public.begin_x_account_refresh_legacy_post(uuid, text, text),
  public.commit_x_account_refresh_legacy_post(uuid, text, text, text, integer),
  public.release_x_account_refresh_v2(uuid, text, text, text),
  public.record_x_account_rejected_after_refresh(uuid, text, text),
  public.record_x_account_access_unauthorized(uuid, text, text)
to service_role;

commit;
