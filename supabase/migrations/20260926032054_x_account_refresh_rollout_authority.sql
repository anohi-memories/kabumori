-- SOURCE CANDIDATE ONLY. Do not apply until a separately reviewed activation.
--
-- Stage 3A: per-account rollout authority for the universal X OAuth refresh.
-- Requires the refresh core (20260925140000, live in production since
-- 2026-09-26 but NOT recorded in supabase_migrations.schema_migrations).
-- Refuses to run twice and never re-creates core objects, so it cannot replay
-- the core SQL.
--
-- One explicit source of truth per X account: public.x_account_refresh_rollout
-- (no row = 'off'). The Edge env gate X_VAULT_ACCOUNT_REFRESH stays a global
-- kill switch; it is never enough on its own. Every refresh path calls
-- public.x_account_refresh_authority(account) before reading Vault:
--   off      -> never refresh
--   pilot    -> refresh only inside a time box, under a refresh-count ceiling,
--               and only while the account has no unresolved refresh error
--   enabled  -> normal automatic refresh
-- Only a validated service-side setter changes the mode; API roles cannot.
--
-- Accounts whose refresh is already proven in production (a committed
-- refresh, state idle) are grandfathered to 'enabled' so applying this file
-- does not silently stop an account that works today. No account is chosen
-- by name, brand, e-mail or row order.
--
-- Transaction: one explicit transaction; apply alone with a tool that does NOT
-- wrap the file in another transaction; not re-runnable.
begin;

do $$
begin
  if to_regclass('public.x_account_refresh_state_v2') is null
     or to_regprocedure('public.begin_x_account_refresh_legacy_post(uuid,text,text)') is null
     or to_regprocedure('public.release_x_account_refresh_v2(uuid,text,text,text)') is null
     or to_regprocedure('public.x_account_refresh_health_mirror()') is null then
    raise exception 'STAGE3A_PRECONDITION_REFRESH_CORE_MISSING';
  end if;
  if to_regclass('public.x_account_refresh_rollout') is not null
     or to_regprocedure('public.x_account_refresh_authority(text)') is not null then
    raise exception 'STAGE3A_PRECONDITION_ALREADY_APPLIED';
  end if;
end $$;

-- 1. Rollout authority, one row per X account (absent = off).
create table public.x_account_refresh_rollout (
  social_account_id text primary key references public.social_accounts (id),
  mode text not null check (mode in ('off', 'pilot', 'enabled')),
  pilot_expires_at timestamptz,
  pilot_max_generation bigint check (pilot_max_generation is null or pilot_max_generation >= 1),
  reason_code text not null check (reason_code ~ '^[A-Z][A-Z0-9_]{1,99}$'),
  updated_at timestamptz not null default now(),
  constraint x_account_refresh_rollout_pilot_shape check (
    (mode = 'pilot') = (pilot_expires_at is not null and pilot_max_generation is not null))
);
alter table public.x_account_refresh_rollout enable row level security;
revoke all on public.x_account_refresh_rollout from public, anon, authenticated, service_role;
grant select on public.x_account_refresh_rollout to service_role;

-- 2. The one refresh-eligibility predicate. NULL = this exact account may
--    refresh now; otherwise a fixed refusal code. Callers hold the account and
--    state row locks. Never reads Vault; never looks at any other account's
--    rollout row.
create function public.x_account_refresh_authority(p_social_account_id text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_account public.social_accounts%rowtype;
        v_state public.x_account_refresh_state_v2%rowtype;
        v_rollout public.x_account_refresh_rollout%rowtype;
begin
  select sa.* into v_account from public.social_accounts sa where sa.id = p_social_account_id;
  if not found then return 'X_ACCOUNT_NOT_FOUND'; end if;
  if v_account.platform is distinct from 'x' then return 'X_ACCOUNT_NOT_X'; end if;
  if v_account.connection_status is distinct from 'identity_verified'
     or nullif(btrim(v_account.platform_user_id), '') is null then
    return 'X_ACCOUNT_NOT_VERIFIED';
  end if;
  if v_account.publish_enabled is distinct from true then return 'X_ACCOUNT_PUBLISH_DISABLED'; end if;
  if nullif(btrim(v_account.oauth_client_ref), '') is null then return 'X_REFRESH_CLIENT_NOT_CONFIGURED'; end if;
  if v_account.vault_access_token_secret_id is null or v_account.vault_refresh_token_secret_id is null
     or v_account.vault_access_token_secret_id = v_account.vault_refresh_token_secret_id then
    return 'X_REFRESH_CREDENTIAL_NOT_CONFIGURED';
  end if;
  if exists (
    select 1 from public.social_accounts o
    where o.id <> v_account.id
      and (o.vault_access_token_secret_id in (v_account.vault_access_token_secret_id, v_account.vault_refresh_token_secret_id)
        or o.vault_refresh_token_secret_id in (v_account.vault_access_token_secret_id, v_account.vault_refresh_token_secret_id))
  ) then
    return 'X_REFRESH_SECRET_REF_SHARED';
  end if;
  select st.* into v_state from public.x_account_refresh_state_v2 st where st.social_account_id = v_account.id;
  if v_state.status = 'refreshing' then return 'X_REFRESH_IN_PROGRESS'; end if;
  if v_state.status = 'uncertain' then return 'X_REFRESH_BLOCKED_UNCERTAIN'; end if;
  if v_state.status = 'reauth_required' then return 'X_REFRESH_REAUTH_REQUIRED'; end if;
  select r.* into v_rollout from public.x_account_refresh_rollout r where r.social_account_id = v_account.id;
  if not found or v_rollout.mode = 'off' then return 'X_REFRESH_ROLLOUT_OFF'; end if;
  if v_rollout.mode = 'pilot' then
    if v_rollout.pilot_expires_at <= now() then return 'X_REFRESH_PILOT_EXPIRED'; end if;
    if coalesce(v_state.generation, 0) >= v_rollout.pilot_max_generation then return 'X_REFRESH_PILOT_LIMIT_REACHED'; end if;
    if v_state.last_error_code is not null then return 'X_REFRESH_PILOT_BLOCKED_BY_ERROR'; end if;
  end if;
  return null;
end;
$$;

-- 3. Legacy begin: unchanged except for the authority check before the Vault read.
create or replace function public.begin_x_account_refresh_legacy_post(
  p_scheduled_post_id uuid, p_social_account_id text, p_brand_id text
) returns table (lease_token uuid, oauth_client_ref text, refresh_token text)
language plpgsql security definer set search_path = '' as $$
declare v_account public.social_accounts%rowtype;
        v_attempt integer;
        v_state public.x_account_refresh_state_v2%rowtype;
        v_refresh text;
        v_lease uuid;
        v_block text;
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
  -- Stage 3A: exact-account rollout authority, before any Vault read.
  v_block := public.x_account_refresh_authority(v_account.id);
  if v_block is not null then raise exception '%', v_block using errcode = 'P0001'; end if;
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

-- 4. The only mutation path for rollout authority (service side). 'pilot' is
--    time-boxed (<= 30 days) with a refresh budget (1..24 committed refreshes
--    from now); 'pilot'/'enabled' require the account's own, distinct,
--    unshared Vault refs and a client ref. 'off' is always allowed.
create function public.set_x_account_refresh_rollout(
  p_social_account_id text, p_mode text, p_reason_code text,
  p_pilot_expires_at timestamptz default null, p_pilot_refresh_budget integer default null
) returns text language plpgsql security definer set search_path = '' as $$
declare v_account public.social_accounts%rowtype;
        v_generation bigint;
begin
  if nullif(btrim(p_social_account_id), '') is null or p_mode is null or p_mode not in ('off', 'pilot', 'enabled')
     or p_reason_code is null or p_reason_code !~ '^[A-Z][A-Z0-9_]{1,99}$'
     or (p_mode = 'pilot') <> (p_pilot_expires_at is not null and p_pilot_refresh_budget is not null)
     or (p_mode = 'pilot' and (p_pilot_expires_at <= now() or p_pilot_expires_at > now() + interval '30 days'
                               or p_pilot_refresh_budget < 1 or p_pilot_refresh_budget > 24)) then
    raise exception 'X_REFRESH_ROLLOUT_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  select sa.* into v_account from public.social_accounts sa where sa.id = p_social_account_id for update;
  if not found or v_account.platform is distinct from 'x' then
    raise exception 'X_ACCOUNT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_mode <> 'off' then
    if nullif(btrim(v_account.oauth_client_ref), '') is null then
      raise exception 'X_REFRESH_CLIENT_NOT_CONFIGURED' using errcode = 'P0001';
    end if;
    if v_account.vault_access_token_secret_id is null or v_account.vault_refresh_token_secret_id is null
       or v_account.vault_access_token_secret_id = v_account.vault_refresh_token_secret_id then
      raise exception 'X_REFRESH_CREDENTIAL_NOT_CONFIGURED' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from public.social_accounts o
      where o.id <> v_account.id
        and (o.vault_access_token_secret_id in (v_account.vault_access_token_secret_id, v_account.vault_refresh_token_secret_id)
          or o.vault_refresh_token_secret_id in (v_account.vault_access_token_secret_id, v_account.vault_refresh_token_secret_id))
    ) then
      raise exception 'X_REFRESH_SECRET_REF_SHARED' using errcode = 'P0001';
    end if;
  end if;
  select coalesce((select st.generation from public.x_account_refresh_state_v2 st where st.social_account_id = v_account.id), 0)
    into v_generation;
  insert into public.x_account_refresh_rollout as r
    (social_account_id, mode, pilot_expires_at, pilot_max_generation, reason_code, updated_at)
  values (v_account.id, p_mode,
          case when p_mode = 'pilot' then p_pilot_expires_at end,
          case when p_mode = 'pilot' then v_generation + p_pilot_refresh_budget end,
          p_reason_code, now())
  on conflict (social_account_id) do update
  set mode = excluded.mode, pilot_expires_at = excluded.pilot_expires_at,
      pilot_max_generation = excluded.pilot_max_generation, reason_code = excluded.reason_code, updated_at = now();
  return p_mode;
exception
  when sqlstate 'P0001' then raise;
  when others then raise exception 'X_REFRESH_ROLLOUT_UNAVAILABLE' using errcode = 'P0001';
end;
$$;

-- 5. Operator health view as an RPC (service side). No token, secret id,
--    lease token or provider body. stuck_refreshing: a lease older than 10
--    minutes (the token request itself times out after 15 seconds).
create function public.get_x_account_refresh_health(p_social_account_id text default null)
returns table (
  social_account_id text, brand_id text, connection_status text, publish_enabled boolean,
  last_connection_error_code text, credential_refs_configured boolean,
  rollout_mode text, pilot_expires_at timestamptz, pilot_max_generation bigint,
  refresh_status text, generation bigint, last_refreshed_at timestamptz, access_expires_at timestamptz,
  refresh_last_error_code text, lease_age_seconds integer, stuck_refreshing boolean,
  reauth_required boolean, refresh_block_code text
) language sql stable security definer set search_path = '' as $$
  select sa.id, sa.brand_id, sa.connection_status, sa.publish_enabled, sa.last_connection_error_code,
         (sa.vault_access_token_secret_id is not null and sa.vault_refresh_token_secret_id is not null
          and sa.vault_access_token_secret_id <> sa.vault_refresh_token_secret_id),
         coalesce(r.mode, 'off'), r.pilot_expires_at, r.pilot_max_generation,
         coalesce(st.status, 'idle'), coalesce(st.generation, 0), st.last_refreshed_at, st.access_expires_at,
         st.last_error_code,
         case when st.status = 'refreshing' then extract(epoch from now() - st.leased_at)::integer end,
         coalesce(st.status = 'refreshing' and st.leased_at < now() - interval '10 minutes', false),
         coalesce(st.status = 'reauth_required', false) or sa.connection_status = 'failed',
         public.x_account_refresh_authority(sa.id)
  from public.social_accounts sa
  left join public.x_account_refresh_state_v2 st on st.social_account_id = sa.id
  left join public.x_account_refresh_rollout r on r.social_account_id = sa.id
  where sa.platform = 'x' and (p_social_account_id is null or sa.id = p_social_account_id)
  order by sa.id
$$;

-- 6. Owner-only manual intervention for a stale lease (a worker died between
--    begin and commit/release). X may already have rotated the token, so the
--    lease becomes 'uncertain' (never 'idle'); re-connecting the account
--    resolves it (core reconnect trigger). Not granted to any API role.
create function public.resolve_stale_x_account_refresh_lease(
  p_social_account_id text, p_min_age interval default interval '10 minutes'
) returns text language plpgsql security definer set search_path = '' as $$
declare v_state public.x_account_refresh_state_v2%rowtype;
begin
  if nullif(btrim(p_social_account_id), '') is null or p_min_age is null or p_min_age < interval '5 minutes' then
    raise exception 'X_REFRESH_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  select st.* into v_state from public.x_account_refresh_state_v2 st
  where st.social_account_id = p_social_account_id for update;
  if not found or v_state.status <> 'refreshing' then return 'not_refreshing'; end if;
  if v_state.leased_at > now() - p_min_age then return 'not_stale'; end if;
  update public.x_account_refresh_state_v2 st
  set status = 'uncertain', lease_token = null, lease_kind = null, lease_post_id = null, lease_post_attempt = null,
      lease_attempt_id = null, leased_at = null, last_error_code = 'X_REFRESH_LEASE_STALE'
  where st.social_account_id = p_social_account_id;
  return 'uncertain';
end;
$$;

-- 7. Grandfather accounts whose refresh is already proven in production.
insert into public.x_account_refresh_rollout (social_account_id, mode, reason_code)
select st.social_account_id, 'enabled', 'GRANDFATHERED_PROVEN_REFRESH'
from public.x_account_refresh_state_v2 st
join public.social_accounts sa on sa.id = st.social_account_id
where st.generation > 0 and st.status = 'idle' and st.last_error_code is null
  and sa.platform = 'x' and sa.connection_status = 'identity_verified';

revoke all on function public.x_account_refresh_authority(text),
  public.set_x_account_refresh_rollout(text, text, text, timestamptz, integer),
  public.get_x_account_refresh_health(text),
  public.resolve_stale_x_account_refresh_lease(text, interval)
from public, anon, authenticated, service_role;
-- begin keeps its existing grants; restated so the file is self-describing.
revoke all on function public.begin_x_account_refresh_legacy_post(uuid, text, text) from public, anon, authenticated;
grant execute on function public.begin_x_account_refresh_legacy_post(uuid, text, text) to service_role;
grant execute on function
  public.set_x_account_refresh_rollout(text, text, text, timestamptz, integer),
  public.get_x_account_refresh_health(text)
to service_role;

commit;
