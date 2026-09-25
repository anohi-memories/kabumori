-- SOURCE CANDIDATE ONLY. Do not apply until a separately reviewed activation.
-- Requires Phase1B..1H (20260924023133 .. 20260925120000) and the universal
-- credential refresh core (20260925140000), which owns the per-account refresh
-- state table, the generic release RPC and the account health mirror. This
-- file only adds the v2-attempt lease kind: one table, one single-flight lease
-- per account for both the legacy and the v2 publish paths.
--
-- Exact-account pre-X token refresh. The only authority is an open pre-X v2
-- attempt (attempt id + claim token) bound to exactly one social account.
-- A per-account lease makes the refresh single-flight; the returned tokens are
-- written back only to that account's own Vault secrets, atomically with the
-- lease release. X refresh tokens are single-use, so any refresh whose result
-- was not durably stored leaves the account blocked for operator review; it is
-- never replayed automatically.
--
-- Transaction: one explicit transaction; apply alone with a tool that does NOT
-- wrap the file in another transaction; not re-runnable.
begin;

do $$
begin
  if to_regprocedure('public.read_x_publish_credential_for_resume_v2(uuid,uuid,text,text)') is null
     or to_regclass('public.post_provider_steps_v2') is null
     or to_regprocedure('vault.update_secret(uuid,text,text,text,uuid)') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise exception 'PHASE1I_PRECONDITION_PHASE1H_OR_VAULT_MISSING';
  end if;
  if to_regclass('public.x_account_refresh_state_v2') is null
     or to_regprocedure('public.release_x_account_refresh_v2(uuid,text,text,text)') is null
     or to_regprocedure('public.commit_x_account_refresh_legacy_post(uuid,text,text,text,integer)') is null then
    raise exception 'PHASE1I_PRECONDITION_REFRESH_CORE_MISSING';
  end if;
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'social_accounts'
        and column_name in ('oauth_client_ref', 'updated_at', 'vault_access_token_secret_id',
                            'vault_refresh_token_secret_id', 'connection_status', 'platform_user_id',
                            'publish_enabled')) <> 7 then
    raise exception 'PHASE1I_PRECONDITION_SOCIAL_ACCOUNTS_SHAPE';
  end if;
end $$;

-- 1. The core lease table gains the attempt FK for the v2 lease kind.
alter table public.x_account_refresh_state_v2
  add constraint x_account_refresh_state_v2_lease_attempt_fkey
  foreign key (lease_attempt_id) references public.post_queue_attempts_v2 (id);

-- 2. Begin: validate the exact claim/account, take the single-flight lease,
--    and hand the refresh token to the server refresh helper only.
create function public.begin_x_account_refresh_v2(
  p_attempt_id uuid, p_claim_token uuid, p_social_account_id text, p_brand_id text
) returns table (lease_token uuid, oauth_client_ref text, refresh_token text)
language plpgsql security definer set search_path = '' as $$
declare v_attempt public.post_queue_attempts_v2%rowtype;
        v_post public.scheduled_posts%rowtype;
        v_account record;
        v_state public.x_account_refresh_state_v2%rowtype;
        v_refresh text;
        v_lease uuid;
begin
  if p_attempt_id is null or p_claim_token is null
     or nullif(btrim(p_social_account_id), '') is null or nullif(btrim(p_brand_id), '') is null then
    raise exception 'X_REFRESH_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  -- Attempt lock first (same order as mark_post_provider_started_v2), then account.
  select a.* into v_attempt from public.post_queue_attempts_v2 a
  where a.id = p_attempt_id and a.claim_token = p_claim_token for update;
  if not found or v_attempt.phase <> 'pre_x' or v_attempt.outcome is not null then
    raise exception 'X_REFRESH_CLAIM_NOT_PRE_X' using errcode = 'P0001';
  end if;
  if v_attempt.social_account_id <> p_social_account_id or v_attempt.brand_id <> p_brand_id then
    raise exception 'X_REFRESH_ACCOUNT_MISMATCH' using errcode = 'P0001';
  end if;
  select s.* into v_post from public.scheduled_posts s where s.id = v_attempt.scheduled_post_id;
  if v_post.status is distinct from 'running'
     or v_post.social_account_id is distinct from v_attempt.social_account_id
     or v_post.brand_id is distinct from v_attempt.brand_id then
    raise exception 'X_REFRESH_CLAIM_NOT_PRE_X' using errcode = 'P0001';
  end if;

  select sa.id, sa.brand_id, sa.platform, sa.connection_status, sa.platform_user_id, sa.publish_enabled,
         sa.oauth_client_ref, sa.updated_at, sa.vault_access_token_secret_id, sa.vault_refresh_token_secret_id
    into v_account
  from public.social_accounts sa where sa.id = v_attempt.social_account_id for update;
  if not found then raise exception 'X_ACCOUNT_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_account.platform is distinct from 'x' then raise exception 'X_ACCOUNT_NOT_X' using errcode = 'P0001'; end if;
  if v_account.brand_id is distinct from v_attempt.brand_id then
    raise exception 'X_ACCOUNT_BRAND_MISMATCH' using errcode = 'P0001';
  end if;
  if v_account.connection_status is distinct from 'identity_verified'
     or nullif(btrim(v_account.platform_user_id), '') is null then
    raise exception 'X_ACCOUNT_NOT_VERIFIED' using errcode = 'P0001';
  end if;
  if v_account.publish_enabled is distinct from true then
    raise exception 'X_ACCOUNT_PUBLISH_DISABLED' using errcode = 'P0001';
  end if;
  if nullif(btrim(v_account.oauth_client_ref), '') is null then
    raise exception 'X_REFRESH_CLIENT_NOT_CONFIGURED' using errcode = 'P0001';
  end if;
  if v_account.vault_refresh_token_secret_id is null or v_account.vault_access_token_secret_id is null
     or v_account.vault_refresh_token_secret_id = v_account.vault_access_token_secret_id then
    raise exception 'X_REFRESH_CREDENTIAL_NOT_CONFIGURED' using errcode = 'P0001';
  end if;
  -- Both destinations must belong to this account alone.
  if exists (
    select 1 from public.social_accounts o
    where o.id <> v_account.id
      and (o.vault_access_token_secret_id in (v_account.vault_access_token_secret_id, v_account.vault_refresh_token_secret_id)
        or o.vault_refresh_token_secret_id in (v_account.vault_access_token_secret_id, v_account.vault_refresh_token_secret_id))
  ) then
    raise exception 'X_REFRESH_SECRET_REF_SHARED' using errcode = 'P0001';
  end if;

  insert into public.x_account_refresh_state_v2 (social_account_id) values (v_account.id)
  on conflict (social_account_id) do nothing;
  select st.* into v_state from public.x_account_refresh_state_v2 st
  where st.social_account_id = v_account.id for update;
  if v_state.status = 'refreshing' then raise exception 'X_REFRESH_IN_PROGRESS' using errcode = 'P0001'; end if;
  if v_state.status = 'uncertain' then raise exception 'X_REFRESH_BLOCKED_UNCERTAIN' using errcode = 'P0001'; end if;
  if v_state.status = 'reauth_required' then raise exception 'X_REFRESH_REAUTH_REQUIRED' using errcode = 'P0001'; end if;

  begin
    select ds.decrypted_secret into v_refresh
    from vault.decrypted_secrets ds where ds.id = v_account.vault_refresh_token_secret_id;
  exception when others then
    raise exception 'X_REFRESH_CREDENTIAL_UNAVAILABLE' using errcode = 'P0001';
  end;
  if nullif(v_refresh, '') is null then
    raise exception 'X_REFRESH_CREDENTIAL_UNAVAILABLE' using errcode = 'P0001';
  end if;

  v_lease := gen_random_uuid();
  update public.x_account_refresh_state_v2 st
  set status = 'refreshing', lease_token = v_lease, lease_kind = 'v2_attempt',
      lease_attempt_id = v_attempt.id, leased_at = now(),
      account_updated_at = v_account.updated_at, leased_brand_id = v_account.brand_id,
      leased_platform_user_id = v_account.platform_user_id,
      leased_oauth_client_ref = v_account.oauth_client_ref,
      leased_access_secret_id = v_account.vault_access_token_secret_id,
      leased_refresh_secret_id = v_account.vault_refresh_token_secret_id,
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

-- 3. Commit: only the holder of the current lease may write, only to the
--    same account's own secrets, only if the account was not changed (e.g.
--    re-connected) since the lease was taken. Secrets and lease release are
--    one transaction. An account change turns the lease into 'uncertain'.
create function public.commit_x_account_refresh_v2(
  p_lease_token uuid, p_social_account_id text, p_access_token text,
  p_refresh_token text default null, p_expires_in integer default null
) returns text language plpgsql security definer set search_path = '' as $$
declare v_account record;
        v_state public.x_account_refresh_state_v2%rowtype;
        v_attempt public.post_queue_attempts_v2%rowtype;
        v_post public.scheduled_posts%rowtype;
        v_attempt_id uuid;
begin
  if p_lease_token is null or nullif(btrim(p_social_account_id), '') is null
     or nullif(btrim(p_access_token), '') is null
     or (p_refresh_token is not null and nullif(btrim(p_refresh_token), '') is null)
     or (p_expires_in is not null and (p_expires_in < 1 or p_expires_in > 2592000)) then
    raise exception 'X_REFRESH_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  -- Freeze account-reference membership while validating and writing Vault.
  -- Self-conflicting (as in the core commit) so concurrent commits, whose
  -- health mirror may update social_accounts, serialize instead of deadlocking.
  lock table public.social_accounts in share row exclusive mode;
  select st.lease_attempt_id into v_attempt_id from public.x_account_refresh_state_v2 st
  where st.social_account_id = p_social_account_id and st.status = 'refreshing'
    and st.lease_token = p_lease_token and st.lease_kind = 'v2_attempt';
  if v_attempt_id is null then return 'lease_lost'; end if;
  -- Attempt -> post -> account -> state: the same row-lock order as the queue.
  select a.* into v_attempt from public.post_queue_attempts_v2 a
  where a.id = v_attempt_id for update;
  if v_attempt.id is not null then
    select s.* into v_post from public.scheduled_posts s
    where s.id = v_attempt.scheduled_post_id for update;
  end if;
  select sa.id, sa.brand_id, sa.platform, sa.connection_status, sa.platform_user_id,
         sa.publish_enabled, sa.oauth_client_ref, sa.updated_at,
         sa.vault_access_token_secret_id, sa.vault_refresh_token_secret_id
    into v_account
  from public.social_accounts sa where sa.id = p_social_account_id for update;
  select st.* into v_state from public.x_account_refresh_state_v2 st
  where st.social_account_id = p_social_account_id for update;
  if v_account.id is null or v_state.social_account_id is null
     or v_state.status <> 'refreshing' or v_state.lease_token is distinct from p_lease_token
     or v_state.lease_kind is distinct from 'v2_attempt' then
    return 'lease_lost';
  end if;
  if v_attempt.id is distinct from v_state.lease_attempt_id
     or v_attempt.phase is distinct from 'pre_x' or v_attempt.outcome is not null
     or v_attempt.social_account_id is distinct from p_social_account_id
     or v_attempt.brand_id is distinct from v_state.leased_brand_id
     or v_post.id is distinct from v_attempt.scheduled_post_id
     or v_post.status is distinct from 'running'
     or v_post.social_account_id is distinct from p_social_account_id
     or v_post.brand_id is distinct from v_state.leased_brand_id
     or v_account.brand_id is distinct from v_state.leased_brand_id
     or v_account.platform_user_id is distinct from v_state.leased_platform_user_id
     or v_account.publish_enabled is distinct from true
     or v_account.oauth_client_ref is distinct from v_state.leased_oauth_client_ref
     or v_account.vault_access_token_secret_id is distinct from v_state.leased_access_secret_id
     or v_account.vault_refresh_token_secret_id is distinct from v_state.leased_refresh_secret_id
     or v_account.vault_access_token_secret_id is null
     or v_account.vault_refresh_token_secret_id is null
     or v_account.vault_access_token_secret_id = v_account.vault_refresh_token_secret_id
     or exists (
       select 1 from public.social_accounts o where o.id <> p_social_account_id
         and (o.vault_access_token_secret_id in (v_state.leased_access_secret_id, v_state.leased_refresh_secret_id)
           or o.vault_refresh_token_secret_id in (v_state.leased_access_secret_id, v_state.leased_refresh_secret_id))
     )
     or v_account.platform is distinct from 'x' or v_account.connection_status is distinct from 'identity_verified'
     or v_account.updated_at is distinct from v_state.account_updated_at then
    update public.x_account_refresh_state_v2 st
    set status = 'uncertain', lease_token = null, lease_kind = null, lease_attempt_id = null, leased_at = null,
        last_error_code = 'X_REFRESH_ACCOUNT_CHANGED'
    where st.social_account_id = p_social_account_id;
    return 'account_changed';
  end if;
  -- Vault is a separate trust boundary: even its own P0001 must not surface.
  -- Any failure here rolls back both secrets and keeps the lease 'refreshing'.
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
      lease_attempt_id = null, leased_at = null,
      access_expires_at = case when p_expires_in is null then null else now() + make_interval(secs => p_expires_in) end,
      last_refreshed_at = now(), last_error_code = null
  where st.social_account_id = p_social_account_id;
  return 'committed';
exception
  when sqlstate 'P0001' then raise;
  when others then raise exception 'X_REFRESH_PERSIST_FAILED' using errcode = 'P0001';
end;
$$;

-- 4. Release (not_rotated / reauth_required / uncertain) is the core's
--    generic release_x_account_refresh_v2; it serves both lease kinds.

-- 5. While an account holds a refresh lease, none of its attempts may cross
--    the provider-start boundary or begin a provider step. The account row is
--    share-locked so this serializes with begin_x_account_refresh_v2.
create function public.x_v2_block_provider_during_refresh() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_account text;
begin
  if tg_table_name = 'post_queue_attempts_v2' then
    if not (old.phase = 'pre_x' and new.phase = 'provider_started') then return new; end if;
    v_account := new.social_account_id;
  else
    select a.social_account_id into v_account from public.post_queue_attempts_v2 a where a.id = new.attempt_id;
  end if;
  perform 1 from public.social_accounts sa where sa.id = v_account for share;
  if exists (select 1 from public.x_account_refresh_state_v2 st
             where st.social_account_id = v_account and st.status = 'refreshing') then
    raise exception 'X_REFRESH_IN_PROGRESS' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger post_queue_attempts_v2_refresh_guard
before update of phase on public.post_queue_attempts_v2
for each row execute function public.x_v2_block_provider_during_refresh();
create trigger post_provider_steps_v2_refresh_guard
before insert on public.post_provider_steps_v2
for each row execute function public.x_v2_block_provider_during_refresh();

revoke all on function public.begin_x_account_refresh_v2(uuid, uuid, text, text),
  public.commit_x_account_refresh_v2(uuid, text, text, text, integer),
  public.x_v2_block_provider_during_refresh()
from public, anon, authenticated, service_role;
grant execute on function
  public.begin_x_account_refresh_v2(uuid, uuid, text, text),
  public.commit_x_account_refresh_v2(uuid, text, text, text, integer)
to service_role;

commit;
