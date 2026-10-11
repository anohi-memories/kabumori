-- SOURCE CANDIDATE ONLY. NOT a migration, NOT applied anywhere (G4,
-- postona-threads-connect-publish-integrated-offline-v1-g4-20261011). Apply only after
-- threads_credential_custody_candidate.sql and threads_manual_publish_candidate.sql, as a single
-- reviewed file, after the integrated security review.
--
-- Fixes the K4 P1 finding on threads_manual_publish_candidate.sql: the credential was handed out by a
-- service_role function (redeem) up to 60 s after the caller-side claim, without re-running the G5
-- lifecycle fence or the caller's owner/admin membership. A revoked entitlement, a deletion that had
-- started or a removed membership could still obtain the token in that window.
--
-- After this file there is NO service_role path and NO separate claim:
--   release_threads_manual_publish_step(attempt, step, issued_at, nonce, attestation)
--       ONE transaction, run with the CALLER'S JWT (auth.uid() is the caller, session_id from the same
--       verified claims): server attestation -> G5 fence (T13, its locks first and held) -> the caller's
--       Auth session (auth.sessions KEY SHARE: signed out / expired = refused) -> workspace, membership,
--       account, credential expiry, manual permission (threads_manual_publish_authorize, row locks) ->
--       single-use nonce -> attempt FOR UPDATE (compare-and-set) -> Vault read -> status move + a record
--       grant bound to this user and session. The token leaves the database only in the transaction that
--       made every authorization decision, while those decisions' locks are held.
--   record_threads_manual_publish_result(attempt, step, grant, result..., issued_at, nonce, attestation)
--       the provider's answer, bound to the grant AND the same user and session, attested over the exact
--       result. It records facts: no fence (an entitlement that ended mid-flight must not erase the truth
--       of a post that may exist), fixed transitions only.
--
-- Server attestation: HMAC-SHA256 over a versioned, newline-joined message (user, attempt, step
-- [, grant, result], issued_at, nonce) keyed by the Vault secret `postona_threads_publish_attestation_v1`,
-- which only the publish Edge server also holds. A signed-in client can call both functions (role
-- authenticated) but cannot produce the attestation, so it can never obtain a token or record a result;
-- a captured attestation is single-use (nonce) and expires after 60 s. This mirrors PR #124's connect
-- attestation (a different key name and message prefix). The session is not in the message: the
-- database takes it from the same verified JWT claims as auth.uid(), so the server never decodes a JWT.
--
-- Not closed (and not claimed): between this commit and the Threads HTTP request (milliseconds, at most
-- the 10 s request bound) a lifecycle change cannot stop a request already released. Database locks do not
-- span network calls. Every LATER write needs a new release that re-checks everything.
--
-- Also (both found by the integration smoke on PR #124's real world): the G5 fence's refusals are mapped
-- by their fixed message whatever their SQLSTATE (P0001 or 42501, the code G5's guard candidate uses), so
-- SERVICE_NOT_ACTIVE is not collapsed into BLOCKED; and the workspace rule no longer reads the automatic-
-- publishing flags that every self-service workspace has off (section 2b).
begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_owner oid;
begin
  -- First: this file replaces the functions the next check requires.
  if pg_catalog.to_regprocedure('public.release_threads_manual_publish_step(uuid,text,bigint,text,text)') is not null then
    raise exception 'THREADS_RELEASE_PRECONDITION_ALREADY_APPLIED';
  end if;
  if pg_catalog.to_regclass('public.threads_manual_publish_attempts') is null
     or pg_catalog.to_regprocedure('public.claim_threads_manual_publish_step(uuid,text)') is null
     or pg_catalog.to_regprocedure('public.redeem_threads_manual_publish_step(uuid,text,text)') is null
     or pg_catalog.to_regprocedure('public.record_threads_manual_publish_step(uuid,text,text,text,text,text,text,text)') is null
     or pg_catalog.to_regprocedure('public.threads_manual_publish_authorize(uuid,text,boolean)') is null then
    raise exception 'THREADS_RELEASE_PRECONDITION_PUBLISH_CANDIDATE';
  end if;
  select c.relowner into v_owner from pg_catalog.pg_class c where c.oid = 'public.threads_manual_publish_attempts'::regclass;
  if v_owner is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
     or (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'THREADS_RELEASE_PRECONDITION_OWNER';
  end if;
  if pg_catalog.to_regprocedure('extensions.hmac(bytea,bytea,text)') is null then
    raise exception 'THREADS_RELEASE_PRECONDITION_PGCRYPTO';
  end if;
  if (select count(*) from pg_catalog.pg_attribute a
      where a.attrelid = pg_catalog.to_regclass('auth.sessions') and a.attname in ('id', 'user_id', 'not_after') and not a.attisdropped) <> 3 then
    raise exception 'THREADS_RELEASE_PRECONDITION_AUTH_SESSIONS';
  end if;
  if (select count(*) from pg_catalog.pg_attribute a
      where a.attrelid = pg_catalog.to_regclass('vault.decrypted_secrets') and a.attname in ('name', 'decrypted_secret')) <> 2 then
    raise exception 'THREADS_RELEASE_PRECONDITION_VAULT';
  end if;
end $$;

-- 1. The superseded path is removed, not just revoked: nothing dormant remains.
drop function public.redeem_threads_manual_publish_step(uuid, text, text);
drop function public.record_threads_manual_publish_step(uuid, text, text, text, text, text, text, text);
drop function public.claim_threads_manual_publish_step(uuid, text);

-- 2. The G5 fence's fixed codes, whatever their SQLSTATE.
create or replace function public.threads_manual_publish_fence(p_user uuid) returns text
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform private.account_lifecycle_assert_active_service_write(p_user, 'x_autopost');
  exception
    when sqlstate 'P0001' or sqlstate '42501' then
      return case
        when sqlerrm = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' then 'AUTH_REQUIRED'
        when sqlerrm in ('SERVICE_NOT_REGISTERED', 'SERVICE_NOT_ACTIVE', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND') then 'SERVICE_NOT_ACTIVE'
        else 'ACCOUNT_LIFECYCLE_BLOCKED' end;
    when lock_not_available or deadlock_detected then
      return 'BUSY';
    when others then
      return 'ACCOUNT_LIFECYCLE_BLOCKED';
  end;
  return null;
end;
$$;

-- 2b. The workspace rule, corrected by the integration smoke: self-service POSTONA workspaces are created
--     by PR #124 / the X onboarding with is_active = false and publish_mode = 'disabled' (those flags gate
--     the AUTOMATIC scheduler, which user workspaces do not have yet). PR #140 refused manual posts on those
--     flags, i.e. for every real user. A manual post now requires the person's own self-service workspace
--     (code_profile_key 'social_mobile_user_v1'); the automatic-publishing flags are not consulted.
--     Everything else is exactly PR #140's rule.
create or replace function public.threads_manual_publish_authorize(p_user uuid, p_social_account_id text, p_require_permission boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_brand_id text;
  v_brand public.brands%rowtype;
  v_role text;
  v_account public.social_accounts%rowtype;
begin
  select a.brand_id into v_brand_id from public.social_accounts a where a.id = p_social_account_id;
  if v_brand_id is null then return 'ACCOUNT_NOT_FOUND'; end if;
  select b.* into v_brand from public.brands b where b.id = v_brand_id for share;
  select m.role into v_role from public.brand_memberships m where m.brand_id = v_brand_id and m.user_id = p_user for share;
  if v_role is null then return 'ACCOUNT_NOT_FOUND'; end if;
  select a.* into v_account from public.social_accounts a where a.id = p_social_account_id for share;
  if v_account.id is null or v_account.brand_id is distinct from v_brand_id then return 'ACCOUNT_NOT_FOUND'; end if;
  if v_role not in ('owner', 'admin') then return 'PUBLISH_FORBIDDEN'; end if;
  if v_brand.code_profile_key is distinct from 'social_mobile_user_v1' then return 'WORKSPACE_INACTIVE'; end if;
  if v_account.platform is distinct from 'threads' then return 'PLATFORM_NOT_SUPPORTED'; end if;
  if v_account.connection_status is distinct from 'identity_verified' or v_account.verified_at is null
     or coalesce(v_account.platform_user_id, '') !~ '^[1-9][0-9]{0,31}$' then
    return 'CONNECTION_NOT_VERIFIED';
  end if;
  if v_account.vault_access_token_secret_id is null then return 'CREDENTIALS_MISSING'; end if;
  if coalesce(public.threads_account_credential_expires_at(p_social_account_id), '-infinity') <= pg_catalog.now() + interval '5 minutes' then
    return 'CREDENTIALS_EXPIRED';
  end if;
  if p_require_permission and not exists (
       select 1 from public.social_account_manual_publish_permissions p
       where p.social_account_id = p_social_account_id and p.brand_id = v_brand_id for share) then
    return 'MANUAL_PUBLISH_NOT_PERMITTED';
  end if;
  return null;
end;
$$;

-- 3. The record grant is bound to the user and the session that released it; nonces are single use.
alter table public.threads_manual_publish_attempts
  add column grant_user_id uuid,
  add column grant_session_id uuid,
  add constraint threads_manual_publish_attempts_grant_binding
    check ((grant_hash is null) = (grant_user_id is null) and (grant_hash is null) = (grant_session_id is null));

create table public.threads_manual_publish_nonces (
  nonce_hash text primary key check (nonce_hash ~ '^[0-9a-f]{64}$'),
  attempt_id uuid not null references public.threads_manual_publish_attempts (id) on delete cascade,
  used_at timestamptz not null default now()
);
alter table public.threads_manual_publish_nonces enable row level security;
revoke all on table public.threads_manual_publish_nonces from public, anon, authenticated, service_role;

-- 4. Internal helpers (owner only).
-- The Auth session of the verified JWT (the same claims auth.uid() reads), or NULL.
create function public.threads_manual_publish_session_id() returns uuid
language plpgsql stable set search_path = '' as $$
declare v text := coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.session_id', true), ''),
                           nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id');
begin
  if v is null or v !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
  return v::uuid;
end;
$$;

-- true / false, or NULL when the key is unavailable (missing, duplicated or too short).
create function public.threads_manual_publish_attestation_valid(p_message text, p_attestation text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_keys integer;
  v_key text;
begin
  select count(*), min(d.decrypted_secret) into v_keys, v_key
    from vault.decrypted_secrets d where d.name = 'postona_threads_publish_attestation_v1';
  if v_keys <> 1 or v_key is null or pg_catalog.length(v_key) < 32 then return null; end if;
  return pg_catalog.encode(extensions.hmac(pg_catalog.convert_to(p_message, 'UTF8'), pg_catalog.convert_to(v_key, 'UTF8'), 'sha256'), 'hex')
         = p_attestation;
end;
$$;

-- 5. Release: every authorization decision and the credential, in one transaction.
create function public.release_threads_manual_publish_step(
  p_attempt_id uuid, p_step text, p_issued_at bigint, p_nonce text, p_attestation text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_user uuid := auth.uid();
  v_session uuid := public.threads_manual_publish_session_id();
  v_from text;
  v_to text;
  v_valid boolean;
  v_code text;
  v_row public.threads_manual_publish_attempts%rowtype;
  v_account public.social_accounts%rowtype;
  v_token text;
  v_grant text;
begin
  if v_user is null or v_session is null then return public.threads_manual_publish_refused('AUTH_REQUIRED'); end if;
  v_from := case p_step when 'create_container' then 'reserved' when 'check_container' then 'container_created'
                        when 'publish' then 'container_created' when 'confirm' then 'publish_returned'
                        when 'reconcile' then 'uncertain' end;
  v_to := case p_step when 'create_container' then 'creating_container' when 'publish' then 'publishing' end;
  if p_attempt_id is null or v_from is null or p_issued_at is null or p_nonce is null or p_nonce !~ '^[0-9a-f]{64}$'
     or p_attestation is null or p_attestation !~ '^[0-9a-f]{64}$' then
    return public.threads_manual_publish_refused('REQUEST_INVALID');
  end if;
  -- Only the publish server: nothing is locked or written for a call it did not attest.
  v_valid := public.threads_manual_publish_attestation_valid(
    pg_catalog.concat_ws(pg_catalog.chr(10), 'postona-threads-publish-release-v1', v_user::text,
                         p_attempt_id::text, p_step, p_issued_at::text, p_nonce),
    p_attestation);
  if v_valid is null then return public.threads_manual_publish_refused('STORE_UNAVAILABLE'); end if;
  if not v_valid or pg_catalog.abs(extract(epoch from pg_catalog.clock_timestamp()) - p_issued_at) > 60 then
    return public.threads_manual_publish_refused('ATTESTATION_INVALID');
  end if;
  select t.* into v_row from public.threads_manual_publish_attempts t where t.id = p_attempt_id;
  if v_row.id is null or not exists (select 1 from public.brand_memberships m where m.brand_id = v_row.brand_id and m.user_id = v_user) then
    return public.threads_manual_publish_refused('ATTEMPT_NOT_FOUND');
  end if;
  -- G5 lifecycle first (its locks are held to COMMIT), then the session, then the workspace and account.
  v_code := public.threads_manual_publish_fence(v_user);
  if v_code is not null then return public.threads_manual_publish_refused(v_code); end if;
  perform 1 from auth.sessions s
   where s.id = v_session and s.user_id = v_user and (s.not_after is null or s.not_after > pg_catalog.clock_timestamp())
   for key share;
  if not found then return public.threads_manual_publish_refused('AUTH_REQUIRED'); end if;
  v_code := public.threads_manual_publish_authorize(v_user, v_row.social_account_id, p_step in ('create_container', 'check_container', 'publish'));
  if v_code is not null then return public.threads_manual_publish_refused(v_code); end if;
  begin
    insert into public.threads_manual_publish_nonces (nonce_hash, attempt_id)
    values (pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_nonce, 'UTF8')), 'hex'), p_attempt_id);
  exception when unique_violation then
    return public.threads_manual_publish_refused('ATTESTATION_INVALID');
  end;
  select t.* into v_row from public.threads_manual_publish_attempts t where t.id = p_attempt_id for update;
  if p_step = 'reconcile' and v_row.updated_at < pg_catalog.now() - interval '120 seconds' then
    if v_row.status = 'creating_container' then
      update public.threads_manual_publish_attempts t
         set status = 'failed', error_code = 'STEP_INTERRUPTED', grant_hash = null, grant_step = null, grant_state = null,
             grant_expires_at = null, grant_user_id = null, grant_session_id = null, updated_at = pg_catalog.now()
       where t.id = p_attempt_id;
      return public.threads_manual_publish_refused('STALE_STEP');
    end if;
    if v_row.status = 'publishing' then
      update public.threads_manual_publish_attempts t
         set status = 'uncertain', error_code = 'STEP_INTERRUPTED', grant_hash = null, grant_step = null, grant_state = null,
             grant_expires_at = null, grant_user_id = null, grant_session_id = null, updated_at = pg_catalog.now()
       where t.id = p_attempt_id
      returning * into v_row;
    end if;
  end if;
  if v_row.status is distinct from v_from then return public.threads_manual_publish_refused('STALE_STEP'); end if;
  if v_to is not null and v_row.created_at < pg_catalog.now() - interval '15 minutes' then
    update public.threads_manual_publish_attempts t
       set status = 'failed', error_code = 'ATTEMPT_EXPIRED', grant_hash = null, grant_step = null, grant_state = null,
           grant_expires_at = null, grant_user_id = null, grant_session_id = null, updated_at = pg_catalog.now()
     where t.id = p_attempt_id;
    return public.threads_manual_publish_refused('ATTEMPT_EXPIRED');
  end if;
  -- The credential is read before anything moves: a missing secret changes nothing.
  select a.* into v_account from public.social_accounts a where a.id = v_row.social_account_id;
  begin
    select ds.decrypted_secret into v_token from vault.decrypted_secrets ds where ds.id = v_account.vault_access_token_secret_id;
  exception when others then
    v_token := null;
  end;
  if coalesce(v_token, '') = '' then return public.threads_manual_publish_refused('CREDENTIALS_MISSING'); end if;
  v_grant := pg_catalog.replace(gen_random_uuid()::text, '-', '') || pg_catalog.replace(gen_random_uuid()::text, '-', '');
  update public.threads_manual_publish_attempts t
     set status = coalesce(v_to, t.status),
         updated_at = case when v_to is null then t.updated_at else pg_catalog.now() end,
         grant_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_grant, 'UTF8')), 'hex'),
         grant_step = p_step, grant_state = 'redeemed',
         grant_expires_at = pg_catalog.clock_timestamp() + interval '5 minutes',
         grant_user_id = v_user, grant_session_id = v_session
   where t.id = p_attempt_id
  returning * into v_row;
  return pg_catalog.jsonb_build_object(
    'status', 'released',
    'grant', v_grant,
    'threads_user_id', v_account.platform_user_id,
    'access_token', v_token,
    'text', case when p_step in ('create_container', 'reconcile') then v_row.post_text end,
    'container_id', v_row.container_id,
    'provider_post_id', v_row.provider_post_id,
    'attempt_created_at', v_row.created_at,
    'attempt', public.threads_manual_publish_attempt_json(v_row));
exception
  when lock_not_available or deadlock_detected then
    return public.threads_manual_publish_refused('BUSY');
  when raise_exception then
    return public.threads_manual_publish_refused('ACCOUNT_LIFECYCLE_BLOCKED');
end;
$$;

-- 6. Record: the provider's answer, bound to the grant, the same user and session, attested.
create function public.record_threads_manual_publish_result(
  p_attempt_id uuid, p_step text, p_grant text, p_to_status text,
  p_container_id text, p_provider_post_id text, p_permalink text, p_error_code text,
  p_issued_at bigint, p_nonce text, p_attestation text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_user uuid := auth.uid();
  v_session uuid := public.threads_manual_publish_session_id();
  v_valid boolean;
  v_row public.threads_manual_publish_attempts%rowtype;
begin
  if v_user is null or v_session is null then return public.threads_manual_publish_refused('AUTH_REQUIRED'); end if;
  if p_attempt_id is null or p_step is null or p_grant is null or p_grant !~ '^[0-9a-f]{64}$' or p_to_status is null
     or p_issued_at is null or p_nonce is null or p_nonce !~ '^[0-9a-f]{64}$'
     or p_attestation is null or p_attestation !~ '^[0-9a-f]{64}$' then
    return public.threads_manual_publish_refused('REQUEST_INVALID');
  end if;
  v_valid := public.threads_manual_publish_attestation_valid(
    pg_catalog.concat_ws(pg_catalog.chr(10), 'postona-threads-publish-record-v1', v_user::text,
                         p_attempt_id::text, p_step, p_grant, p_to_status, coalesce(p_container_id, ''),
                         coalesce(p_provider_post_id, ''), coalesce(p_permalink, ''), coalesce(p_error_code, ''),
                         p_issued_at::text, p_nonce),
    p_attestation);
  if v_valid is null then return public.threads_manual_publish_refused('STORE_UNAVAILABLE'); end if;
  if not v_valid or pg_catalog.abs(extract(epoch from pg_catalog.clock_timestamp()) - p_issued_at) > 60 then
    return public.threads_manual_publish_refused('ATTESTATION_INVALID');
  end if;
  select t.* into v_row from public.threads_manual_publish_attempts t where t.id = p_attempt_id for update;
  -- No expiry check on the grant: the provider call may outlast it; its answer must still be recorded.
  if v_row.id is null or v_row.grant_step is distinct from p_step or v_row.grant_state is distinct from 'redeemed'
     or v_row.grant_user_id is distinct from v_user or v_row.grant_session_id is distinct from v_session
     or v_row.grant_hash is distinct from pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_grant, 'UTF8')), 'hex') then
    return public.threads_manual_publish_refused('GRANT_INVALID');
  end if;
  begin
    insert into public.threads_manual_publish_nonces (nonce_hash, attempt_id)
    values (pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_nonce, 'UTF8')), 'hex'), p_attempt_id);
  exception when unique_violation then
    return public.threads_manual_publish_refused('ATTESTATION_INVALID');
  end;
  if (p_step, v_row.status, p_to_status) not in (
    ('create_container', 'creating_container', 'container_created'), ('create_container', 'creating_container', 'failed'),
    ('check_container', 'container_created', 'failed'),
    ('publish', 'publishing', 'publish_returned'), ('publish', 'publishing', 'failed'), ('publish', 'publishing', 'uncertain'),
    ('confirm', 'publish_returned', 'published'),
    ('reconcile', 'uncertain', 'published'), ('reconcile', 'uncertain', 'published_unidentified'),
    ('reconcile', 'uncertain', 'failed'), ('reconcile', 'uncertain', 'uncertain')) then
    return public.threads_manual_publish_refused('STALE_STEP');
  end if;
  if (p_to_status = 'container_created') is distinct from (p_container_id is not null)
     or (p_to_status in ('publish_returned', 'published')) is distinct from (p_provider_post_id is not null)
     or (p_to_status = 'published') is distinct from (p_permalink is not null)
     or (p_to_status in ('failed', 'uncertain', 'published_unidentified')) is distinct from (p_error_code is not null)
     or (p_to_status = 'published' and v_row.provider_post_id is not null and v_row.provider_post_id is distinct from p_provider_post_id) then
    return public.threads_manual_publish_refused('REQUEST_INVALID');
  end if;
  update public.threads_manual_publish_attempts t
     set status = p_to_status,
         container_id = coalesce(p_container_id, t.container_id),
         provider_post_id = coalesce(p_provider_post_id, t.provider_post_id),
         permalink = coalesce(p_permalink, t.permalink),
         error_code = case when p_to_status = 'published' then null else coalesce(p_error_code, t.error_code) end,
         grant_hash = null, grant_step = null, grant_state = null, grant_expires_at = null,
         grant_user_id = null, grant_session_id = null,
         updated_at = pg_catalog.now()
   where t.id = p_attempt_id
  returning * into v_row;
  return pg_catalog.jsonb_build_object('status', 'recorded', 'attempt', public.threads_manual_publish_attempt_json(v_row));
exception
  when check_violation then
    return public.threads_manual_publish_refused('REQUEST_INVALID');
  when lock_not_available or deadlock_detected then
    return public.threads_manual_publish_refused('BUSY');
  when raise_exception then
    return public.threads_manual_publish_refused('ACCOUNT_LIFECYCLE_BLOCKED');
end;
$$;

-- 7. Access.
revoke all on function
  public.threads_manual_publish_fence(uuid),
  public.threads_manual_publish_authorize(uuid, text, boolean),
  public.threads_manual_publish_session_id(),
  public.threads_manual_publish_attestation_valid(text, text),
  public.release_threads_manual_publish_step(uuid, text, bigint, text, text),
  public.record_threads_manual_publish_result(uuid, text, text, text, text, text, text, text, bigint, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.release_threads_manual_publish_step(uuid, text, bigint, text, text),
  public.record_threads_manual_publish_result(uuid, text, text, text, text, text, text, text, bigint, text, text)
to authenticated;

do $$
begin
  if pg_catalog.to_regprocedure('public.redeem_threads_manual_publish_step(uuid,text,text)') is not null
     or pg_catalog.to_regprocedure('public.claim_threads_manual_publish_step(uuid,text)') is not null
     or pg_catalog.to_regprocedure('public.record_threads_manual_publish_step(uuid,text,text,text,text,text,text,text)') is not null then
    raise exception 'THREADS_RELEASE_POSTCONDITION_OLD_PATH';
  end if;
  -- No service_role or anon path to anything in the publish ledger; authenticated only to the attested
  -- release / record and the caller functions that hand out nothing.
  if exists (select 1 from pg_catalog.pg_proc p
             where p.proname ~ '(threads_manual_publish|threads_credential|credential_expires)'
               and (pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
                    or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')))
     or exists (select 1 from (values ('anon'::name), ('authenticated'::name), ('service_role'::name)) a(app)
                where pg_catalog.has_table_privilege(a.app, 'public.threads_manual_publish_nonces', 'SELECT')
                   or pg_catalog.has_table_privilege(a.app, 'public.threads_manual_publish_nonces', 'INSERT'))
     or pg_catalog.has_function_privilege('authenticated', 'public.threads_manual_publish_attestation_valid(text,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.threads_manual_publish_fence(uuid)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.release_threads_manual_publish_step(uuid,text,bigint,text,text)', 'EXECUTE') then
    raise exception 'THREADS_RELEASE_POSTCONDITION_ACL';
  end if;
end $$;

commit;
