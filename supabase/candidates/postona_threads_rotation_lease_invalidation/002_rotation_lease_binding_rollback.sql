-- Rollback of 002_rotation_lease_binding.sql (ISOLATED SOURCE CANDIDATE ONLY, G4-29). Restores claim and rotate to the
-- bodies option A pins (md5 2d5fdec6... / 4de6764d...) and drops the lease column; open leases end (fail closed).
-- Run it BEFORE rolling back A (001_rotation_lease_invalidation_rollback.sql). Afterwards only A protects the refresh.
begin;

set local lock_timeout = '5s';
set local search_path = '';

delete from public.threads_credential_refresh_leases;

create or replace function public.claim_threads_credential_refresh(p_social_account_id text) returns jsonb
language plpgsql security invoker set search_path = '' set lock_timeout = '3s' as $$
declare
  v_brand_id text;
  v_code text;
  v_checked uuid;
  v_owner uuid;
  v_account public.social_accounts%rowtype;
  v_custody public.threads_account_credential_custody%rowtype;
  v_lease public.threads_credential_refresh_leases%rowtype;
  v_now timestamptz;
begin
  if auth.uid() is not null then return public.threads_credential_rotation_refused('SERVER_ONLY'); end if;
  if p_social_account_id is null or p_social_account_id !~ '^[a-z][a-z0-9_]{1,80}$' then
    return public.threads_credential_rotation_refused('REQUEST_INVALID');
  end if;
  select a.brand_id into v_brand_id from public.social_accounts a where a.id = p_social_account_id and a.platform = 'threads';
  if v_brand_id is null then return public.threads_credential_rotation_refused('ACCOUNT_NOT_FOUND'); end if;
  -- F5 first, for an EXPLICIT person: the workspace owner by F5's own rule, whose lifecycle locks are taken before
  -- any workspace or account lock and kept to COMMIT.
  v_checked := private.account_lifecycle_brand_owner(v_brand_id);
  if v_checked is null then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;
  v_code := public.threads_credential_refresh_lifecycle(v_checked);
  if v_code is not null then return public.threads_credential_rotation_refused(v_code); end if;
  perform public.social_mobile_account_deletion_workspace_lock(v_brand_id);
  perform 1 from public.brands b where b.id = v_brand_id and b.code_profile_key = 'social_mobile_user_v1' for share;
  if not found then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;
  v_owner := public.threads_credential_refresh_owner(v_brand_id);
  if v_owner is null then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;
  -- J2 R1: the owner may have changed while the decision waited. A lease is only for the person decided on.
  if v_owner is distinct from v_checked then return public.threads_credential_rotation_refused('OWNER_CHANGED'); end if;
  select a.* into v_account from public.social_accounts a where a.id = p_social_account_id for update;
  if v_account.id is null or v_account.platform is distinct from 'threads' then
    return public.threads_credential_rotation_refused('ACCOUNT_NOT_FOUND');
  end if;
  if v_account.brand_id is distinct from v_brand_id then return public.threads_credential_rotation_refused('WORKSPACE_CHANGED'); end if;
  if v_account.connection_status is distinct from 'identity_verified' or v_account.verified_at is null
     or v_account.vault_access_token_secret_id is null then
    return public.threads_credential_rotation_refused('CONNECTION_NOT_VERIFIED');
  end if;
  select c.* into v_custody from public.threads_account_credential_custody c where c.social_account_id = p_social_account_id for update;
  if v_custody.social_account_id is null or v_custody.vault_secret_id is distinct from v_account.vault_access_token_secret_id
     or v_custody.recorded_at < v_account.verified_at then
    return public.threads_credential_rotation_refused('CUSTODY_UNKNOWN');
  end if;
  v_now := pg_catalog.clock_timestamp();
  if v_custody.expires_at <= v_now then return public.threads_credential_rotation_refused('CREDENTIAL_EXPIRED'); end if;
  if public.threads_credential_publish_in_flight(p_social_account_id) then
    return public.threads_credential_rotation_refused('PUBLISH_IN_FLIGHT');
  end if;
  select l.* into v_lease from public.threads_credential_refresh_leases l where l.social_account_id = p_social_account_id for update;
  if v_lease.social_account_id is not null then
    if v_lease.lease_expires_at > v_now then return public.threads_credential_rotation_refused('LEASE_HELD'); end if;
    -- An ended lease is taken over: its holder's rotate can no longer match.
    delete from public.threads_credential_refresh_leases l where l.social_account_id = p_social_account_id;
  end if;
  insert into public.threads_credential_refresh_leases
    (social_account_id, lease_id, brand_id, owner_user_id, vault_secret_id, custody_recorded_at, claimed_at, lease_expires_at)
  values (p_social_account_id, gen_random_uuid(), v_brand_id, v_owner, v_custody.vault_secret_id, v_custody.recorded_at,
          v_now, v_now + interval '60 seconds')
  returning * into v_lease;
  -- No token: H5 reads it from Vault by this secret id in the same transaction. custody_recorded_at is the
  -- conservative issue time for Meta's 24-hour rule (the token was exchanged before it was recorded).
  return pg_catalog.jsonb_build_object(
    'status', 'claimed', 'lease', v_lease.lease_id, 'social_account_id', p_social_account_id,
    'vault_secret_id', v_custody.vault_secret_id, 'custody_recorded_at', v_custody.recorded_at,
    'expires_at', v_custody.expires_at, 'lease_expires_at', v_lease.lease_expires_at);
exception
  when lock_not_available or deadlock_detected or unique_violation then
    return public.threads_credential_rotation_refused('BUSY');
  when raise_exception then
    -- The deletion guard (SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS) or another reviewed guard.
    return public.threads_credential_rotation_refused('ACCOUNT_LIFECYCLE_BLOCKED');
end;
$$;

create or replace function public.rotate_threads_credential_custody(p_social_account_id text, p_lease uuid, p_expected_secret_id uuid,
                                                         p_expected_recorded_at timestamptz, p_new_expires_at timestamptz)
returns jsonb language plpgsql security invoker set search_path = '' set lock_timeout = '3s' as $$
declare
  v_brand_id text;
  v_code text;
  v_checked uuid;
  v_owner uuid;
  v_account public.social_accounts%rowtype;
  v_custody public.threads_account_credential_custody%rowtype;
  v_lease public.threads_credential_refresh_leases%rowtype;
  v_now timestamptz;
begin
  if auth.uid() is not null then return public.threads_credential_rotation_refused('SERVER_ONLY'); end if;
  if p_social_account_id is null or p_social_account_id !~ '^[a-z][a-z0-9_]{1,80}$' or p_lease is null
     or p_expected_secret_id is null or p_expected_recorded_at is null or p_new_expires_at is null
     or not pg_catalog.isfinite(p_expected_recorded_at) or not pg_catalog.isfinite(p_new_expires_at) then
    return public.threads_credential_rotation_refused('REQUEST_INVALID');
  end if;
  v_now := pg_catalog.clock_timestamp();
  if p_new_expires_at <= v_now or p_new_expires_at > v_now + interval '61 days' then
    return public.threads_credential_rotation_refused('EXPIRY_INVALID');
  end if;
  select a.brand_id into v_brand_id from public.social_accounts a where a.id = p_social_account_id and a.platform = 'threads';
  if v_brand_id is null then return public.threads_credential_rotation_refused('ACCOUNT_NOT_FOUND'); end if;
  -- No lease of this account under this id: refused before any lock, so a stray or replayed call never queues on
  -- the workspace owner's lifecycle rows. Decided again below after the locks. A lease id names one claim, so its
  -- owner is the person that claim was for.
  select l.owner_user_id into v_checked from public.threads_credential_refresh_leases l
   where l.social_account_id = p_social_account_id and l.lease_id = p_lease;
  if v_checked is null then return public.threads_credential_rotation_refused('LEASE_NOT_HELD'); end if;
  -- F5 for THAT person, explicitly (never the owner of the moment, which may have changed and changed back).
  v_code := public.threads_credential_refresh_lifecycle(v_checked);
  if v_code is not null then return public.threads_credential_rotation_refused(v_code); end if;
  perform public.social_mobile_account_deletion_workspace_lock(v_brand_id);
  perform 1 from public.brands b where b.id = v_brand_id and b.code_profile_key = 'social_mobile_user_v1' for share;
  if not found then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;
  v_owner := public.threads_credential_refresh_owner(v_brand_id);
  if v_owner is null then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;
  select a.* into v_account from public.social_accounts a where a.id = p_social_account_id for update;
  if v_account.id is null or v_account.platform is distinct from 'threads' then
    return public.threads_credential_rotation_refused('ACCOUNT_NOT_FOUND');
  end if;
  if v_account.brand_id is distinct from v_brand_id then return public.threads_credential_rotation_refused('WORKSPACE_CHANGED'); end if;
  if v_account.connection_status is distinct from 'identity_verified' or v_account.verified_at is null
     or v_account.vault_access_token_secret_id is null then
    return public.threads_credential_rotation_refused('CONNECTION_NOT_VERIFIED');
  end if;
  select c.* into v_custody from public.threads_account_credential_custody c where c.social_account_id = p_social_account_id for update;
  select l.* into v_lease from public.threads_credential_refresh_leases l where l.social_account_id = p_social_account_id for update;
  -- Every decision below uses the clock after the waits.
  v_now := pg_catalog.clock_timestamp();
  if v_lease.lease_id is distinct from p_lease or v_lease.lease_expires_at <= v_now then
    return public.threads_credential_rotation_refused('LEASE_NOT_HELD');
  end if;
  if v_lease.brand_id is distinct from v_account.brand_id then return public.threads_credential_rotation_refused('WORKSPACE_CHANGED'); end if;
  if v_lease.owner_user_id is distinct from v_owner or v_checked is distinct from v_owner then
    return public.threads_credential_rotation_refused('OWNER_CHANGED');
  end if;
  -- The compare-and-set: the account, the custody row and the lease all name the version the caller refreshed.
  if v_custody.social_account_id is null
     or v_account.vault_access_token_secret_id is distinct from p_expected_secret_id
     or v_custody.vault_secret_id is distinct from p_expected_secret_id
     or v_custody.recorded_at is distinct from p_expected_recorded_at
     or v_lease.vault_secret_id is distinct from p_expected_secret_id
     or v_lease.custody_recorded_at is distinct from p_expected_recorded_at
     or v_custody.recorded_at < v_account.verified_at then
    return public.threads_credential_rotation_refused('STALE_CREDENTIAL');
  end if;
  if v_custody.expires_at <= v_now then return public.threads_credential_rotation_refused('CREDENTIAL_EXPIRED'); end if;
  if p_new_expires_at <= v_now or p_new_expires_at > v_now + interval '61 days' then
    return public.threads_credential_rotation_refused('EXPIRY_INVALID');
  end if;
  if p_new_expires_at <= v_custody.expires_at then return public.threads_credential_rotation_refused('EXPIRY_NOT_EXTENDED'); end if;
  if public.threads_credential_publish_in_flight(p_social_account_id) then
    return public.threads_credential_rotation_refused('PUBLISH_IN_FLIGHT');
  end if;
  update public.threads_account_credential_custody c
     set expires_at = p_new_expires_at, recorded_at = pg_catalog.now(), recorded_by = v_owner
   where c.social_account_id = p_social_account_id;
  -- Single use: the same lease can never rotate again (a replay answers LEASE_NOT_HELD).
  delete from public.threads_credential_refresh_leases l where l.social_account_id = p_social_account_id and l.lease_id = p_lease;
  return pg_catalog.jsonb_build_object(
    'status', 'rotated', 'social_account_id', p_social_account_id, 'vault_secret_id', p_expected_secret_id,
    'recorded_at', pg_catalog.now(), 'expires_at', p_new_expires_at);
exception
  when lock_not_available or deadlock_detected then
    return public.threads_credential_rotation_refused('BUSY');
  when raise_exception then
    return public.threads_credential_rotation_refused('ACCOUNT_LIFECYCLE_BLOCKED');
end;
$$;

alter table public.threads_credential_refresh_leases drop column if exists binding_oauth_state_id;

do $$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
       where p.oid = 'public.claim_threads_credential_refresh(text)'::regprocedure) is distinct from '2d5fdec6a3f9a1f7bab30e4f32b992ec'
     or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
          where p.oid = 'public.rotate_threads_credential_custody(text,uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)
        is distinct from '4de6764d8681c333c698a43fa0b8d01c'
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.threads_credential_refresh_leases'::regclass and a.attname = 'binding_oauth_state_id' and not a.attisdropped) then
    raise exception 'THREADS_LEASE_BINDING_ROLLBACK_INCOMPLETE';
  end if;
end $$;

commit;
