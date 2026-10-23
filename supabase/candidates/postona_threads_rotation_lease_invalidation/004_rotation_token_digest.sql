-- ISOLATED SOURCE CANDIDATE ONLY. NOT a migration, NOT applied anywhere, NOT adopted (G4-33, Issue #319,
-- postona-g4-threads-vault-f2-token-digest-isolated-qa-20261023). Applied only to disposable local PostgreSQL 17 databases
-- with a FAKE Vault by supabase/tests/postona_threads_token_digest_run.sh. Adoption, an independent security review and
-- any production use are separate decisions.
--
-- F2 of G4-29 / G4-31 (the Vault secret replaced in place, no custody write, no new binding, no consumed state) on top of
-- A (001), C (002) and (4) (003), as designed in docs/postona/threads-vault-direct-write-f2-design-20261023.md (G4-32):
--   * custody keeps TOKEN_DIGEST = sha256 of the token it describes. A BEFORE INSERT OR UPDATE trigger (ENABLE ALWAYS,
--     definer) sets it from the token NOW in Vault on every custody write, so no writer can choose it: the connect (PR #124
--     complete writes Vault, then the 002 writer records custody, same transaction) and the new rotate_and_store (writes
--     Vault, then custody, same statement) record the token they just wrote.
--   * Every reader refuses when the digest is missing or no longer the Vault content: the expiry reader
--     threads_account_credential_expires_at (used by credential_row, the manual publish and the publish release) is
--     replaced in place with that condition; claim and rotate answer CREDENTIAL_UNVERIFIED / CREDENTIAL_CHANGED.
--   * rotate_and_store_threads_credential(..., new_token): rotate's body plus a Vault row lock (FOR UPDATE) before the
--     digest check and the Vault write before the custody update -- the refresh needs no separate Vault write any more.
--     The legacy rotate stays callable; a separate Vault write after it leaves custody describing the OLD token, so every
--     reader refuses (fail closed) until the next connect.
-- Existing custody rows get NO digest (NULL = unverified): readers refuse until the account reconnects. Computing it at
-- apply time would bless whatever is in Vault now (docs, section 3); that choice is left open.
-- sha256 is used; an HMAC (key in Vault) is an open review item. Not closed here: an owner / superuser writing custody
-- after a direct Vault write (the trigger then records that content), the owner replacing these bodies, readers that read
-- the token in a statement other than the check (manual publish, release: a write in between is read as-is), the token as
-- an SQL argument (logging), the managed Vault's grants and row locks.
begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_me oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_custody regclass := pg_catalog.to_regclass('public.threads_account_credential_custody');
  v_lease regclass := pg_catalog.to_regclass('public.threads_credential_refresh_leases');
begin
  if v_lease is null
     or not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = v_lease and a.attname = 'connect_fingerprint' and not a.attisdropped) then
    raise exception 'THREADS_TOKEN_DIGEST_PRECONDITION_FINGERPRINT';
  end if;
  if v_custody is null or pg_catalog.to_regclass('vault.decrypted_secrets') is null or pg_catalog.to_regclass('vault.secrets') is null
     or pg_catalog.to_regprocedure('vault.update_secret(uuid,text,text,text,uuid)') is null then
    raise exception 'THREADS_TOKEN_DIGEST_PRECONDITION_TABLES';
  end if;
  if (select c.relowner from pg_catalog.pg_class c where c.oid = v_custody) is distinct from v_me then
    raise exception 'THREADS_TOKEN_DIGEST_PRECONDITION_OWNER';
  end if;
  if exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = v_custody and a.attname = 'token_digest' and not a.attisdropped)
     or pg_catalog.to_regprocedure('public.rotate_and_store_threads_credential(text,uuid,uuid,timestamp with time zone,timestamp with time zone,text)') is not null then
    raise exception 'THREADS_TOKEN_DIGEST_ALREADY_APPLIED';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.claim_threads_credential_refresh(text)')) is distinct from 'fa79d6b154b04e3bb7e7927f5e2df1d5'
     or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.rotate_threads_credential_custody(text,uuid,uuid,timestamp with time zone,timestamp with time zone)')) is distinct from '06ccc5c98190064f99bd544db8109cd2'
     or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.threads_account_credential_expires_at(text)')) is distinct from '0d63f9e609f4bc4380c8afa1b86d0916' then
    raise exception 'THREADS_TOKEN_DIGEST_PRECONDITION_BODIES';
  end if;
end $$;

alter table public.threads_account_credential_custody add column token_digest text check (token_digest ~ '^[0-9a-f]{64}$');

create function public.threads_credential_custody_token_digest() returns trigger
language plpgsql security definer set search_path = '' set row_security = off as $$
begin
  -- Whatever a writer put here is replaced by the digest of the token NOW in Vault under the recorded secret id.
  new.token_digest := (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(ds.decrypted_secret, 'UTF8')), 'hex')
                         from vault.decrypted_secrets ds where ds.id = new.vault_secret_id);
  return new;
end $$;
revoke all on function public.threads_credential_custody_token_digest() from public, anon, authenticated, service_role;
create trigger threads_credential_custody_token_digest
  before insert or update on public.threads_account_credential_custody
  for each row execute function public.threads_credential_custody_token_digest();
alter table public.threads_account_credential_custody enable always trigger threads_credential_custody_token_digest;

create or replace function public.threads_account_credential_expires_at(p_social_account_id text)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select c.expires_at
  from public.threads_account_credential_custody c
  join public.social_accounts a on a.id = c.social_account_id
  where c.social_account_id = p_social_account_id
    and a.platform = 'threads'
    and a.connection_status = 'identity_verified'
    and a.vault_access_token_secret_id = c.vault_secret_id
    and a.verified_at is not null
    and c.recorded_at >= a.verified_at
    -- G4-33 (F2): only while the record describes exactly the token now in Vault.
    and c.token_digest is not null
    and c.token_digest = (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(ds.decrypted_secret, 'UTF8')), 'hex')
                            from vault.decrypted_secrets ds where ds.id = c.vault_secret_id)
$$;

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
  v_binding_state uuid;
  v_fingerprint text;
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
  -- G4-33 (F2): the custody row describes exactly the token now in Vault (its digest, kept by the custody trigger).
  if v_custody.token_digest is null then return public.threads_credential_rotation_refused('CREDENTIAL_UNVERIFIED'); end if;
  if v_custody.token_digest is distinct from (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(ds.decrypted_secret, 'UTF8')), 'hex')
                                              from vault.decrypted_secrets ds where ds.id = v_custody.vault_secret_id) then
    return public.threads_credential_rotation_refused('CREDENTIAL_CHANGED');
  end if;
  v_now := pg_catalog.clock_timestamp();
  if v_custody.expires_at <= v_now then return public.threads_credential_rotation_refused('CREDENTIAL_EXPIRED'); end if;
  if public.threads_credential_publish_in_flight(p_social_account_id) then
    return public.threads_credential_rotation_refused('PUBLISH_IN_FLIGHT');
  end if;
  -- G4-29 C: the lease names the connect it was claimed under (read after the account row lock: the 001 entry writes
  -- the binding only while it holds that lock). Same binding condition as credential_row.
  select b.oauth_state_id into v_binding_state from postona_threads_binding.bindings b
   where b.social_account_id = p_social_account_id and b.brand_id = v_account.brand_id
     and b.threads_user_id = v_account.platform_user_id;
  if v_binding_state is null then return public.threads_credential_rotation_refused('CONNECTION_NOT_BOUND'); end if;
  -- G4-31 (4): the set of this account's CONSUMED OAuth states. Every PR #124 complete -- through the entry or called on
  -- its own -- consumes exactly one state before it takes the account row, so any completion changes this value.
  v_fingerprint := (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                       coalesce(pg_catalog.string_agg(s.id::text, ',' order by s.id), ''), 'UTF8')), 'hex')
                       from public.social_account_oauth_states s
                      where s.social_account_id = p_social_account_id and s.consumed_at is not null);
  select l.* into v_lease from public.threads_credential_refresh_leases l where l.social_account_id = p_social_account_id for update;
  if v_lease.social_account_id is not null then
    if v_lease.lease_expires_at > v_now then return public.threads_credential_rotation_refused('LEASE_HELD'); end if;
    -- An ended lease is taken over: its holder's rotate can no longer match.
    delete from public.threads_credential_refresh_leases l where l.social_account_id = p_social_account_id;
  end if;
  insert into public.threads_credential_refresh_leases
    (social_account_id, lease_id, brand_id, owner_user_id, vault_secret_id, custody_recorded_at, claimed_at, lease_expires_at,
     binding_oauth_state_id, connect_fingerprint)
  values (p_social_account_id, gen_random_uuid(), v_brand_id, v_owner, v_custody.vault_secret_id, v_custody.recorded_at,
          v_now, v_now + interval '60 seconds', v_binding_state, v_fingerprint)
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
  v_binding_state uuid;
  v_fingerprint text;
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
  -- G4-29 C: the connect the lease was claimed under must still be the account's binding (any entry reconnect --
  -- even with the lease-invalidation trigger off -- binds a new oauth_state_id). Read after the account row lock.
  select b.oauth_state_id into v_binding_state from postona_threads_binding.bindings b
   where b.social_account_id = p_social_account_id and b.brand_id = v_account.brand_id
     and b.threads_user_id = v_account.platform_user_id;
  if v_binding_state is null or v_binding_state is distinct from v_lease.binding_oauth_state_id then
    return public.threads_credential_rotation_refused('BINDING_CHANGED');
  end if;
  -- G4-31 (4): no OAuth state of this account was consumed since the claim (a completion that bound nothing and wrote no
  -- custody -- PR #124's complete on its own -- included). Read after the account row lock, like the binding.
  v_fingerprint := (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                       coalesce(pg_catalog.string_agg(s.id::text, ',' order by s.id), ''), 'UTF8')), 'hex')
                       from public.social_account_oauth_states s
                      where s.social_account_id = p_social_account_id and s.consumed_at is not null);
  if v_fingerprint is distinct from v_lease.connect_fingerprint then
    return public.threads_credential_rotation_refused('CONNECTION_CHANGED');
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
  -- G4-33 (F2): the custody row describes exactly the token now in Vault (its digest, kept by the custody trigger).
  if v_custody.token_digest is null then return public.threads_credential_rotation_refused('CREDENTIAL_UNVERIFIED'); end if;
  if v_custody.token_digest is distinct from (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(ds.decrypted_secret, 'UTF8')), 'hex')
                                              from vault.decrypted_secrets ds where ds.id = v_custody.vault_secret_id) then
    return public.threads_credential_rotation_refused('CREDENTIAL_CHANGED');
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

create function public.rotate_and_store_threads_credential(p_social_account_id text, p_lease uuid, p_expected_secret_id uuid,
                                                         p_expected_recorded_at timestamptz, p_new_expires_at timestamptz,
  p_new_token text)
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
  v_binding_state uuid;
  v_fingerprint text;
begin
  if auth.uid() is not null then return public.threads_credential_rotation_refused('SERVER_ONLY'); end if;
  if p_new_token is null or p_new_token !~ '^[A-Za-z0-9._|-]+$' or pg_catalog.length(p_new_token) not between 16 and 4096 then
    return public.threads_credential_rotation_refused('REQUEST_INVALID');
  end if;
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
  -- G4-29 C: the connect the lease was claimed under must still be the account's binding (any entry reconnect --
  -- even with the lease-invalidation trigger off -- binds a new oauth_state_id). Read after the account row lock.
  select b.oauth_state_id into v_binding_state from postona_threads_binding.bindings b
   where b.social_account_id = p_social_account_id and b.brand_id = v_account.brand_id
     and b.threads_user_id = v_account.platform_user_id;
  if v_binding_state is null or v_binding_state is distinct from v_lease.binding_oauth_state_id then
    return public.threads_credential_rotation_refused('BINDING_CHANGED');
  end if;
  -- G4-31 (4): no OAuth state of this account was consumed since the claim (a completion that bound nothing and wrote no
  -- custody -- PR #124's complete on its own -- included). Read after the account row lock, like the binding.
  v_fingerprint := (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                       coalesce(pg_catalog.string_agg(s.id::text, ',' order by s.id), ''), 'UTF8')), 'hex')
                       from public.social_account_oauth_states s
                      where s.social_account_id = p_social_account_id and s.consumed_at is not null);
  if v_fingerprint is distinct from v_lease.connect_fingerprint then
    return public.threads_credential_rotation_refused('CONNECTION_CHANGED');
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
  -- G4-33: lock the Vault row first, so a direct writer either finished (and is seen below) or waits for this commit.
  perform 1 from vault.secrets s where s.id = v_custody.vault_secret_id for update;
  -- G4-33 (F2): the custody row describes exactly the token now in Vault (its digest, kept by the custody trigger).
  if v_custody.token_digest is null then return public.threads_credential_rotation_refused('CREDENTIAL_UNVERIFIED'); end if;
  if v_custody.token_digest is distinct from (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(ds.decrypted_secret, 'UTF8')), 'hex')
                                              from vault.decrypted_secrets ds where ds.id = v_custody.vault_secret_id) then
    return public.threads_credential_rotation_refused('CREDENTIAL_CHANGED');
  end if;
  if v_custody.expires_at <= v_now then return public.threads_credential_rotation_refused('CREDENTIAL_EXPIRED'); end if;
  if p_new_expires_at <= v_now or p_new_expires_at > v_now + interval '61 days' then
    return public.threads_credential_rotation_refused('EXPIRY_INVALID');
  end if;
  if p_new_expires_at <= v_custody.expires_at then return public.threads_credential_rotation_refused('EXPIRY_NOT_EXTENDED'); end if;
  if public.threads_credential_publish_in_flight(p_social_account_id) then
    return public.threads_credential_rotation_refused('PUBLISH_IN_FLIGHT');
  end if;
  -- G4-33: the token and its record in ONE statement of ONE function (no separate Vault write by H5).
  perform vault.update_secret(v_custody.vault_secret_id, p_new_token);
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

revoke all on function public.rotate_and_store_threads_credential(text, uuid, uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;

-- Postcondition: the reviewed bodies; the new function and the trigger function are the owner's alone; the trigger fires
-- ALWAYS, BEFORE, on INSERT and UPDATE; the reader keeps its attributes (STABLE, definer) for credential_row's checks.
do $$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.claim_threads_credential_refresh(text)')) is distinct from '0af9e21cb173d3b8e7b452d69eb59494'
     or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.rotate_threads_credential_custody(text,uuid,uuid,timestamp with time zone,timestamp with time zone)')) is distinct from '82c587d895452c5e18f4634a0000242b'
     or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.threads_account_credential_expires_at(text)')) is distinct from 'f250186b7d2dd4f18d2ddc7fc338caad' then
    raise exception 'THREADS_TOKEN_DIGEST_POSTCONDITION_BODY';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.rotate_and_store_threads_credential(text,uuid,uuid,timestamp with time zone,timestamp with time zone,text)'))
     is distinct from '324848c38a86252529ba05a73f496a78'
     or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.threads_credential_custody_token_digest()'::regprocedure)
     is distinct from 'e964f9085648d8f5c3bc1e88b95e81bf' then
    raise exception 'THREADS_TOKEN_DIGEST_POSTCONDITION_BODY';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p
              where p.oid in (pg_catalog.to_regprocedure('public.rotate_and_store_threads_credential(text,uuid,uuid,timestamp with time zone,timestamp with time zone,text)'), 'public.threads_credential_custody_token_digest()'::regprocedure,
                              pg_catalog.to_regprocedure('public.claim_threads_credential_refresh(text)'), pg_catalog.to_regprocedure('public.rotate_threads_credential_custody(text,uuid,uuid,timestamp with time zone,timestamp with time zone)'),
                              pg_catalog.to_regprocedure('public.threads_account_credential_expires_at(text)'))
                and (p.proowner <> (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.threads_account_credential_custody'::regclass)
                     or exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee <> p.proowner)))
     or (select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.rotate_and_store_threads_credential(text,uuid,uuid,timestamp with time zone,timestamp with time zone,text)'))
     or not (select p.prosecdef and p.provolatile = 's' from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.threads_account_credential_expires_at(text)'))
     or not (select p.prosecdef and p.proconfig = array['search_path=""', 'row_security=off'] from pg_catalog.pg_proc p
              where p.oid = 'public.threads_credential_custody_token_digest()'::regprocedure) then
    raise exception 'THREADS_TOKEN_DIGEST_POSTCONDITION_ACL';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger t
                  where t.tgrelid = 'public.threads_account_credential_custody'::regclass and t.tgname = 'threads_credential_custody_token_digest'
                    and t.tgfoid = 'public.threads_credential_custody_token_digest()'::regprocedure and t.tgenabled = 'A'
                    and t.tgtype = (1 | 2 | 4 | 16) and not t.tgisinternal) then
    raise exception 'THREADS_TOKEN_DIGEST_POSTCONDITION_TRIGGER';
  end if;
  if exists (select 1 from pg_catalog.pg_roles r
              where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                and pg_catalog.has_column_privilege(r.oid, 'public.threads_account_credential_custody', 'token_digest', 'select')) then
    raise exception 'THREADS_TOKEN_DIGEST_POSTCONDITION_ACL';
  end if;
end $$;

commit;
