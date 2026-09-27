-- SOURCE CANDIDATE ONLY. Do not apply until a separately reviewed activation.
--
-- Stage 3B publish authority for the generic Vault-backed brand_post path
-- (_shared/brand/vault_account_brand_post.ts). Separate from Stage 3A's
-- refresh rollout (which only gates token refresh) and never consulted by the
-- AI Lab or Kabumori paths.
--
-- x_account_publish_authority: one row per X account; no row = no publishing.
--   enabled  -> may publish only inside [starts_at, expires_at) (<= 30 days)
--   off      -> operator pause
--   revoked  -> consent/operator revocation
-- check_x_account_publish_authority(post, account, brand) is the single
-- publish predicate. The Edge path calls it before generation AND again
-- immediately before the X create; any of these stops new posts even while
-- the access token is still valid: authority missing/off/revoked/not started/
-- expired, owner consent (approvalMode) withdrawn or the consent store absent,
-- brand inactive/not live, brand_post not enabled, account publish disabled or
-- not identity-verified, wrong account/brand, post not running.
-- The refresh generation ceiling stays a refresh control only.
--
-- Requires Stage 3A (live) and the Stage 3B completion RPC (20260927101423).
-- Transaction: one explicit transaction; apply alone; not re-runnable.
begin;

do $$
begin
  if to_regclass('public.x_account_refresh_rollout') is null
     or to_regprocedure('public.complete_vault_account_brand_post(uuid,text,text,text)') is null
     or to_regclass('public.brand_settings') is null then
    raise exception 'STAGE3B_PUBLISH_PRECONDITION_MISSING';
  end if;
  if to_regclass('public.x_account_publish_authority') is not null then
    raise exception 'STAGE3B_PUBLISH_PRECONDITION_ALREADY_APPLIED';
  end if;
end $$;

create table public.x_account_publish_authority (
  social_account_id text primary key references public.social_accounts (id),
  state text not null check (state in ('enabled', 'off', 'revoked')),
  starts_at timestamptz,
  expires_at timestamptz,
  reason_code text not null check (reason_code ~ '^[A-Z][A-Z0-9_]{1,99}$'),
  updated_at timestamptz not null default now(),
  constraint x_account_publish_authority_window check (
    (starts_at is null) = (expires_at is null)
    and (expires_at is null or (expires_at > starts_at and expires_at <= starts_at + interval '30 days'))),
  constraint x_account_publish_authority_enabled_window check (state <> 'enabled' or expires_at is not null)
);
alter table public.x_account_publish_authority enable row level security;
revoke all on public.x_account_publish_authority from public, anon, authenticated, service_role;
grant select on public.x_account_publish_authority to service_role;

-- The single publish predicate. SECURITY INVOKER: service_role reads rows it
-- may already read; it cannot write the authority table.
create function public.check_x_account_publish_authority(
  p_scheduled_post_id uuid, p_social_account_id text, p_brand_id text
) returns text language plpgsql stable security invoker set search_path = '' as $$
declare v_post public.scheduled_posts%rowtype;
        v_account public.social_accounts%rowtype;
        v_brand public.brands%rowtype;
        v_authority public.x_account_publish_authority%rowtype;
        v_approval text;
begin
  if p_scheduled_post_id is null or nullif(btrim(p_social_account_id), '') is null
     or nullif(btrim(p_brand_id), '') is null then
    raise exception 'VAULT_PUBLISH_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  -- Specialised paths never publish through the generic route.
  if p_brand_id in ('kabumori', 'ai_salaryman_lab') then
    raise exception 'VAULT_PUBLISH_BRAND_NOT_ELIGIBLE' using errcode = 'P0001';
  end if;
  select sp.* into v_post from public.scheduled_posts sp where sp.id = p_scheduled_post_id;
  if not found or v_post.status is distinct from 'running' or v_post.post_type is distinct from 'brand_post'
     or v_post.brand_id is distinct from p_brand_id
     or (pg_catalog.to_jsonb(v_post) ->> 'social_account_id') is not null then
    raise exception 'VAULT_PUBLISH_POST_NOT_RUNNING' using errcode = 'P0001';
  end if;
  if (select count(*) from public.social_accounts sa where sa.brand_id = p_brand_id and sa.platform = 'x') <> 1 then
    raise exception 'X_ACCOUNT_NOT_UNIQUE_FOR_BRAND' using errcode = 'P0001';
  end if;
  select sa.* into v_account from public.social_accounts sa where sa.brand_id = p_brand_id and sa.platform = 'x';
  if v_account.id is distinct from p_social_account_id then
    raise exception 'X_CLAIM_ACCOUNT_MISMATCH' using errcode = 'P0001';
  end if;
  select b.* into v_brand from public.brands b where b.id = p_brand_id;
  if v_brand.is_active is distinct from true or v_brand.publish_mode is distinct from 'live' then
    raise exception 'VAULT_PUBLISH_BRAND_DISABLED' using errcode = 'P0001';
  end if;
  if v_account.connection_status is distinct from 'identity_verified' then
    raise exception 'X_ACCOUNT_NOT_VERIFIED' using errcode = 'P0001';
  end if;
  if v_account.publish_enabled is distinct from true then
    raise exception 'X_ACCOUNT_PUBLISH_DISABLED' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.brand_settings bs
                 where bs.brand_id = p_brand_id and bs.enabled_post_types ? 'brand_post') then
    raise exception 'VAULT_PUBLISH_POST_TYPE_NOT_ENABLED' using errcode = 'P0001';
  end if;
  select pa.* into v_authority from public.x_account_publish_authority pa where pa.social_account_id = v_account.id;
  if not found or v_authority.state = 'off' then
    raise exception 'VAULT_PUBLISH_AUTHORITY_OFF' using errcode = 'P0001';
  end if;
  if v_authority.state = 'revoked' then
    raise exception 'VAULT_PUBLISH_AUTHORITY_REVOKED' using errcode = 'P0001';
  end if;
  if pg_catalog.now() < v_authority.starts_at then
    raise exception 'VAULT_PUBLISH_AUTHORITY_NOT_STARTED' using errcode = 'P0001';
  end if;
  if pg_catalog.now() >= v_authority.expires_at then
    raise exception 'VAULT_PUBLISH_AUTHORITY_EXPIRED' using errcode = 'P0001';
  end if;
  -- Owner consent lives in the brand's own content settings; an undeployed store is no consent.
  if pg_catalog.to_regclass('public.social_mobile_content_settings') is null then
    raise exception 'SOCIAL_MOBILE_AUTO_POST_NOT_CONSENTED' using errcode = 'P0001';
  end if;
  execute 'select settings ->> ''approvalMode'' from public.social_mobile_content_settings where brand_id = $1'
    into v_approval using p_brand_id;
  if v_approval is distinct from 'auto_post_preference' then
    raise exception 'SOCIAL_MOBILE_AUTO_POST_NOT_CONSENTED' using errcode = 'P0001';
  end if;
  return 'allowed';
end;
$$;

-- The only mutation path (service side). 'enabled' needs a window that has
-- not ended and lasts at most 30 days; 'off'/'revoked' are always allowed and
-- keep the last window for audit. Specialised brands are refused.
create function public.set_x_account_publish_authority(
  p_social_account_id text, p_state text, p_reason_code text,
  p_starts_at timestamptz default null, p_expires_at timestamptz default null
) returns text language plpgsql security definer set search_path = '' as $$
declare v_account public.social_accounts%rowtype;
begin
  if nullif(btrim(p_social_account_id), '') is null or p_state is null or p_state not in ('enabled', 'off', 'revoked')
     or p_reason_code is null or p_reason_code !~ '^[A-Z][A-Z0-9_]{1,99}$'
     or (p_state = 'enabled' and (p_starts_at is null or p_expires_at is null or p_expires_at <= pg_catalog.now()
                                  or p_expires_at <= p_starts_at or p_expires_at > p_starts_at + interval '30 days'))
     or (p_state <> 'enabled' and (p_starts_at is not null or p_expires_at is not null)) then
    raise exception 'VAULT_PUBLISH_AUTHORITY_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  select sa.* into v_account from public.social_accounts sa where sa.id = p_social_account_id for update;
  if not found or v_account.platform is distinct from 'x' then
    raise exception 'X_ACCOUNT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_account.brand_id in ('kabumori', 'ai_salaryman_lab') then
    raise exception 'VAULT_PUBLISH_BRAND_NOT_ELIGIBLE' using errcode = 'P0001';
  end if;
  if p_state = 'enabled' then
    insert into public.x_account_publish_authority (social_account_id, state, starts_at, expires_at, reason_code, updated_at)
    values (v_account.id, 'enabled', p_starts_at, p_expires_at, p_reason_code, pg_catalog.now())
    on conflict (social_account_id) do update
    set state = 'enabled', starts_at = excluded.starts_at, expires_at = excluded.expires_at,
        reason_code = excluded.reason_code, updated_at = pg_catalog.now();
  else
    insert into public.x_account_publish_authority (social_account_id, state, reason_code, updated_at)
    values (v_account.id, p_state, p_reason_code, pg_catalog.now())
    on conflict (social_account_id) do update
    set state = excluded.state, reason_code = excluded.reason_code, updated_at = pg_catalog.now();
  end if;
  return p_state;
exception
  when sqlstate 'P0001' then raise;
  when others then raise exception 'VAULT_PUBLISH_AUTHORITY_UNAVAILABLE' using errcode = 'P0001';
end;
$$;

revoke all on function public.check_x_account_publish_authority(uuid, text, text),
  public.set_x_account_publish_authority(text, text, text, timestamptz, timestamptz)
from public, anon, authenticated, service_role;
grant execute on function public.check_x_account_publish_authority(uuid, text, text),
  public.set_x_account_publish_authority(text, text, text, timestamptz, timestamptz)
to service_role;

commit;
