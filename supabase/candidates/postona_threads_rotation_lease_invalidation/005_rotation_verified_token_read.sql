-- ISOLATED SOURCE CANDIDATE ONLY. NOT a migration, NOT applied anywhere, NOT adopted (G4-34, Issue #319,
-- postona-g4-threads-token-read-toctou-isolated-qa-20261023). Applied only to disposable local PostgreSQL 17 databases
-- with a FAKE Vault by supabase/tests/postona_threads_token_read_toctou_run.sh. Adoption, an independent security review
-- and any production use are separate decisions.
--
-- The token digest of G4-33 (004) is checked by threads_account_credential_expires_at, but the publish release
-- (threads_publish_release_candidate.sql) reads the token in a LATER statement: in READ COMMITTED a direct Vault write that
-- commits between the two is handed out unchecked (reproduced by the runner). This file closes that window for the
-- release and gives every token reader one function that cannot have it:
--   public.threads_credential_verified_token(account) -> text: ONE SQL statement that reads custody, the account and the
--     Vault row in one snapshot and returns the token only while the custody digest is that token's digest; NULL otherwise.
--   release_threads_manual_publish_step: replaced in place; its token read becomes that function (a refusal stays
--     CREDENTIALS_MISSING, before anything moves). Everything else in it is unchanged.
-- (The two-step claim / redeem path of the manual publish candidate no longer exists: the release candidate drops it.)
-- Apply only AFTER 004_rotation_token_digest.sql; roll back BEFORE it.
-- Not closed here: D8 (the owner writing custody after a direct Vault write), the owner replacing these bodies, H5 reading
-- the token after a claim with a raw SELECT instead of this function, the managed Vault.
begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_me oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  if pg_catalog.to_regprocedure('public.rotate_and_store_threads_credential(text,uuid,uuid,timestamp with time zone,timestamp with time zone,text)') is null
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = pg_catalog.to_regclass('public.threads_account_credential_custody') and a.attname = 'token_digest' and not a.attisdropped) then
    raise exception 'THREADS_VERIFIED_READ_PRECONDITION_DIGEST';
  end if;
  if (select c.relowner from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('public.threads_account_credential_custody')) is distinct from v_me then
    raise exception 'THREADS_VERIFIED_READ_PRECONDITION_OWNER';
  end if;
  if pg_catalog.to_regprocedure('public.threads_credential_verified_token(text)') is not null then
    raise exception 'THREADS_VERIFIED_READ_ALREADY_APPLIED';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.release_threads_manual_publish_step(uuid,text,bigint,text,text)'))
     is distinct from 'bd5bed5adcbef4d87614613f51c83dbf' then
    raise exception 'THREADS_VERIFIED_READ_PRECONDITION_RELEASE';
  end if;
end $$;

create function public.threads_credential_verified_token(p_social_account_id text) returns text
language sql volatile security invoker set search_path = '' as $$
  -- One statement: the custody row, the account and the Vault row read in one snapshot, the token returned only while
  -- the custody digest is the digest of exactly that token (the same conditions as threads_account_credential_expires_at,
  -- minus the clock). NULL otherwise.
  select ds.decrypted_secret
    from public.threads_account_credential_custody c
    join public.social_accounts a on a.id = c.social_account_id
    join vault.decrypted_secrets ds on ds.id = c.vault_secret_id
   where c.social_account_id = p_social_account_id
     and a.platform = 'threads'
     and a.connection_status = 'identity_verified'
     and a.vault_access_token_secret_id = c.vault_secret_id
     and a.verified_at is not null
     and c.recorded_at >= a.verified_at
     and c.token_digest is not null
     and c.token_digest = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(ds.decrypted_secret, 'UTF8')), 'hex')
$$;
revoke all on function public.threads_credential_verified_token(text) from public, anon, authenticated, service_role;

create or replace function public.release_threads_manual_publish_step(
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
  -- FOR SHARE, not FOR KEY SHARE (C3 R1): it conflicts with ANY update of the session row, not only key
  -- changes and deletion, so an expiry / revocation UPDATE (not_after) cannot commit while this release is
  -- still running; it waits until this transaction ends. An UPDATE already in flight makes this statement
  -- wait and then re-check the committed row (READ COMMITTED), which then fails. Held to COMMIT.
  perform 1 from auth.sessions s
   where s.id = v_session and s.user_id = v_user and (s.not_after is null or s.not_after > pg_catalog.clock_timestamp())
   for share;
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
  -- G4-34: the token and the custody digest check in ONE statement (no window between "checked" and "read").
  begin
    v_token := public.threads_credential_verified_token(v_account.id);
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

-- Postcondition: the reviewed bodies; the new function is the owner's alone and invoker; the release keeps its attributes.
do $$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.release_threads_manual_publish_step(uuid,text,bigint,text,text)'))
       is distinct from 'badc8a09db3f0309a13bfb80c209c7a4'
     or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.threads_credential_verified_token(text)'))
       is distinct from '396679757dc8474421e46f1e2b262dd9' then
    raise exception 'THREADS_VERIFIED_READ_POSTCONDITION_BODY';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p
              where p.oid in (pg_catalog.to_regprocedure('public.threads_credential_verified_token(text)'), pg_catalog.to_regprocedure('public.release_threads_manual_publish_step(uuid,text,bigint,text,text)'))
                and (p.proowner <> (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.threads_account_credential_custody'::regclass)
                     or exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee <> p.proowner
                                and a.grantee not in (select r.oid from pg_catalog.pg_roles r where r.rolname = 'authenticated'
                                                      and p.oid = pg_catalog.to_regprocedure('public.release_threads_manual_publish_step(uuid,text,bigint,text,text)')))))
     or (select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.threads_credential_verified_token(text)'))
     or not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.release_threads_manual_publish_step(uuid,text,bigint,text,text)')) then
    raise exception 'THREADS_VERIFIED_READ_POSTCONDITION_ACL';
  end if;
end $$;

commit;
