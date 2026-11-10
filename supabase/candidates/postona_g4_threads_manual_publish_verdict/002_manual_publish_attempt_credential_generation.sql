-- NOT A MIGRATION. G4 SOURCE CANDIDATE ONLY (G4-02 #12, Issue #561). Kept outside supabase/migrations: no tool applies it.
--
-- H1 #40 P2 (Issue #306): a manual post begun under one Threads connection could still go out after the SAME person
-- reconnected the SAME Threads user in the middle of it (social_account_id and G5's lifecycle_version unchanged, only G4's
-- credential_generation moved; measured: container_created -> reconnect -> publish released, provider publish +1). 001 asks
-- "is this account verified NOW", never "is it still the connection this attempt began under".
--
-- After this file an attempt is bound to the credential generation of G4's verdict at begin, and every provider WRITE step
-- (create_container / check_container / publish) is released only while the verdict is VERIFIED with that SAME generation:
--   * begin_threads_manual_publish: after authorize (which already requires the verdict, 001), the verdict's generation is
--     stored for the new attempt in public.threads_manual_publish_attempt_generations (owner only; a replay stores nothing).
--   * release_threads_manual_publish_step, write steps only, with the attempt row FOR UPDATE and the account FOR SHARE (taken
--     by authorize): the binding row FOR SHARE (to COMMIT), then the verdict. No stored generation (an attempt begun before
--     this file), not verified, or another generation -> the attempt is failed with the existing code AUTHORIZATION_CHANGED
--     (the app already says "conditions changed just before posting; nothing was sent") and the step is refused
--     CONNECTION_NOT_VERIFIED, before the credential is read: no token leaves, no provider call follows.
--   * confirm / reconcile (a post that may already exist) are NOT gated by the generation: read-only, never resent (001's rule).
-- Lock order: social_accounts (authorize, FOR SHARE) then the binding (FOR SHARE) -- the order the binding completion takes
-- them (social_accounts FOR UPDATE, then its upsert), so a reconnect and a release serialize instead of deadlocking. A
-- reconnect committed first is seen by the verdict's own statement snapshot; one still open makes the release wait for it.
--
-- What changes: the BODIES of public.begin_threads_manual_publish(text, uuid, text) (md5 6ae40adbcd203592fbc3847c57f1bccf ->
-- 7d26e42edaf3f7f85083880814983c2e) and public.release_threads_manual_publish_step(uuid, text, bigint, text, text)
-- (bd5bed5adcbef4d87614613f51c83dbf -> e92ec523bb1a7a3ba7ca53dce744fb82); one new owner-only table. Same owners, SECURITY
-- DEFINER, empty search_path, lock_timeout and ACLs (CREATE OR REPLACE keeps them; checked after). New DB object, least
-- privilege: public.threads_manual_publish_attempt_generations -- RLS on, no policy, no grant to any role (ALL revoked from
-- PUBLIC / anon / authenticated / service_role); only the owner's SECURITY DEFINER functions read or write it; a cascade from
-- the attempt removes it. No shared table, column, RLS policy, grant, Vault object, G3 or G5 object is touched.
-- Install after 001 (its authorize body f31f16d6ccbb4fc64946337325e93a35 must be in place), as the lifecycle owner. The
-- verdict must be the reviewed one (the same pin as 001, md5 fb93a0ad84c44c6781521eec4618fff4).
-- Rollback: 002_manual_publish_attempt_credential_generation_rollback.sql (restores both bodies exactly, drops the table).

begin;
set local lock_timeout = '2s';
set local search_path = '';

do $$
declare
  v_me oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_begin regprocedure := pg_catalog.to_regprocedure('public.begin_threads_manual_publish(text,uuid,text)');
  v_release regprocedure := pg_catalog.to_regprocedure('public.release_threads_manual_publish_step(uuid,text,bigint,text,text)');
  v_authorize regprocedure := pg_catalog.to_regprocedure('public.threads_manual_publish_authorize(uuid,text,boolean)');
  v_verdict regprocedure := pg_catalog.to_regprocedure('postona_g4_credential.threads_publish_credential_verdict(uuid,text)');
begin
  if pg_catalog.to_regclass('public.threads_manual_publish_attempt_generations') is not null then
    raise exception 'G4MG_PRECONDITION_ALREADY_APPLIED';
  end if;
  if v_begin is null or v_release is null or v_authorize is null then
    raise exception 'G4MG_PRECONDITION_RELEASE_CANDIDATE';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_authorize) is distinct from 'f31f16d6ccbb4fc64946337325e93a35' then
    raise exception 'G4MG_PRECONDITION_001';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_begin) is distinct from '6ae40adbcd203592fbc3847c57f1bccf' then
    raise exception 'G4MG_PRECONDITION_BEGIN_UNPINNED';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_release) is distinct from 'bd5bed5adcbef4d87614613f51c83dbf' then
    raise exception 'G4MG_PRECONDITION_RELEASE_UNPINNED';
  end if;
  if v_verdict is null then
    raise exception 'G4MG_PRECONDITION_VERDICT';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_me)
     or exists (select 1 from pg_catalog.pg_proc p where p.oid in (v_begin, v_release, v_authorize, v_verdict) and p.proowner is distinct from v_me)
     or exists (select 1 from pg_catalog.pg_class c
                 where c.oid in ('public.threads_manual_publish_attempts'::regclass, 'postona_threads_binding.bindings'::regclass)
                   and c.relowner is distinct from v_me) then
    raise exception 'G4MG_PRECONDITION_OWNER';
  end if;
  -- the reviewed verdict (as 001 and G3's 013): body, shape, owner-only ACL, no API role reaching it
  if not (select p.prosecdef and p.provolatile = 's' and p.proretset
                 and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
                 and p.proconfig is not distinct from array['search_path=""']
                 and pg_catalog.md5(p.prosrc) = 'fb93a0ad84c44c6781521eec4618fff4'
                 and pg_catalog.pg_get_function_result(p.oid) = 'TABLE(verified boolean, credential_generation text, code text)'
                 and p.proacl is not null
                 and not exists (select 1 from pg_catalog.aclexplode(p.proacl) e where e.grantee <> v_me)
            from pg_catalog.pg_proc p where p.oid = v_verdict)
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                 and (pg_catalog.has_function_privilege(r.oid, v_verdict, 'EXECUTE')
                      or pg_catalog.has_schema_privilege(r.oid, 'postona_g4_credential', 'USAGE'))) then
    raise exception 'G4MG_PRECONDITION_VERDICT_UNPINNED';
  end if;
  -- the binding the release locks: the account's single row (both G5 profiles key it by social_account_id)
  if not exists (select 1 from pg_catalog.pg_index i join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
                  where i.indrelid = 'postona_threads_binding.bindings'::regclass and i.indisprimary and i.indnatts = 1
                    and a.attname = 'social_account_id') then
    raise exception 'G4MG_PRECONDITION_BINDING_SHAPE';
  end if;
  -- owners / ACLs / settings of the two functions, compared after the replacement
  perform pg_catalog.set_config('g4mg.before', (
    select pg_catalog.string_agg(p.oid::regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-')
                                 || ':' || p.prosecdef::text || ':' || coalesce(p.proconfig::text, '-'), '|' order by p.oid)
    from pg_catalog.pg_proc p where p.oid in (v_begin, v_release)), true);
end $$;

-- The credential generation each attempt was begun under (G4's verdict, opaque, compared for equality only).
create table public.threads_manual_publish_attempt_generations (
  attempt_id uuid primary key references public.threads_manual_publish_attempts (id) on delete cascade,
  credential_generation text not null check (credential_generation ~ '^g4t1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  bound_at timestamptz not null default now()  -- audit only: never compared
);
alter table public.threads_manual_publish_attempt_generations enable row level security;
revoke all on table public.threads_manual_publish_attempt_generations from public, anon, authenticated, service_role;

create or replace function public.begin_threads_manual_publish(p_social_account_id text, p_idempotency_key uuid, p_text text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_user uuid := auth.uid();
  v_code text;
  v_hash text;
  v_row public.threads_manual_publish_attempts%rowtype;
  v_verified boolean;
  v_generation text;
begin
  if v_user is null then return public.threads_manual_publish_refused('AUTH_REQUIRED'); end if;
  if p_social_account_id is null or p_social_account_id !~ '^[a-z][a-z0-9_]{1,80}$' or p_idempotency_key is null then
    return public.threads_manual_publish_refused('REQUEST_INVALID');
  end if;
  if p_text is null or pg_catalog.char_length(p_text) not between 1 and 500
     or pg_catalog.btrim(p_text, E' \t\n　') = '' or pg_catalog.translate(p_text, E'\n\t', '') ~ '[[:cntrl:]]' then
    return public.threads_manual_publish_refused('TEXT_INVALID');
  end if;
  v_code := public.threads_manual_publish_fence(v_user);
  if v_code is not null then return public.threads_manual_publish_refused(v_code); end if;
  v_code := public.threads_manual_publish_authorize(v_user, p_social_account_id, true);
  if v_code is not null then return public.threads_manual_publish_refused(v_code); end if;
  -- G4-02 #12: the connection this attempt is begun under -- the generation of the verdict authorize has just required
  select r.verified, r.credential_generation into v_verified, v_generation
    from postona_g4_credential.threads_publish_credential_verdict(v_user, p_social_account_id) r;
  if v_verified is distinct from true or v_generation is null then
    return public.threads_manual_publish_refused('CONNECTION_NOT_VERIFIED');
  end if;
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_text, 'UTF8')), 'hex');
  for i in 1..2 loop
    select t.* into v_row from public.threads_manual_publish_attempts t
    where t.social_account_id = p_social_account_id and t.idempotency_key = p_idempotency_key;
    if v_row.id is not null then
      -- A replay: same key, same caller, same text -> the same attempt, nothing new happens.
      if v_row.requested_by is distinct from v_user or v_row.text_sha256 is distinct from v_hash then
        return public.threads_manual_publish_refused('IDEMPOTENCY_CONFLICT');
      end if;
      return pg_catalog.jsonb_build_object('status', 'replayed', 'attempt', public.threads_manual_publish_attempt_json(v_row));
    end if;
    if exists (select 1 from public.threads_manual_publish_attempts t
               where t.social_account_id = p_social_account_id and t.status not in ('published', 'published_unidentified', 'failed')) then
      return public.threads_manual_publish_refused('PUBLISH_IN_PROGRESS');
    end if;
    begin
      insert into public.threads_manual_publish_attempts (social_account_id, brand_id, requested_by, idempotency_key, post_text, text_sha256)
      select p_social_account_id, a.brand_id, v_user, p_idempotency_key, p_text, v_hash
      from public.social_accounts a where a.id = p_social_account_id
      returning * into v_row;
      insert into public.threads_manual_publish_attempt_generations (attempt_id, credential_generation)
      values (v_row.id, v_generation);
      return pg_catalog.jsonb_build_object('status', 'reserved', 'attempt', public.threads_manual_publish_attempt_json(v_row));
    exception when unique_violation then
      -- A concurrent begin won (same key -> replay on the next pass; another key -> in progress).
      v_row := null;
    end;
  end loop;
  return public.threads_manual_publish_refused('BUSY');
exception
  when lock_not_available or deadlock_detected then
    return public.threads_manual_publish_refused('BUSY');
  when raise_exception then
    return public.threads_manual_publish_refused('ACCOUNT_LIFECYCLE_BLOCKED');
end;
$$;

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
  v_bound text;
  v_verified boolean;
  v_generation text;
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
  -- G4-02 #12: a provider WRITE (create / check / publish) goes out only under the connection this attempt was begun with.
  -- The binding row is held FOR SHARE to COMMIT (after social_accounts, the order the binding completion also locks in):
  -- a reconnect / re-bind waits for this release, and one committed first is seen by the verdict's own snapshot.
  -- Unknown (no row: begun before this candidate) / not verified / another generation -> failed before any provider call.
  -- confirm / reconcile (a post that may exist) are read-backs: not gated here, never resent.
  if p_step in ('create_container', 'check_container', 'publish') then
    perform 1 from postona_threads_binding.bindings b where b.social_account_id = v_row.social_account_id for share;
    select g.credential_generation into v_bound
      from public.threads_manual_publish_attempt_generations g where g.attempt_id = p_attempt_id;
    select x.verified, x.credential_generation into v_verified, v_generation
      from postona_g4_credential.threads_publish_credential_verdict(v_user, v_row.social_account_id) x;
    if v_bound is null or v_verified is distinct from true or v_generation is distinct from v_bound then
      update public.threads_manual_publish_attempts t
         set status = 'failed', error_code = 'AUTHORIZATION_CHANGED', grant_hash = null, grant_step = null, grant_state = null,
             grant_expires_at = null, grant_user_id = null, grant_session_id = null, updated_at = pg_catalog.now()
       where t.id = p_attempt_id;
      return public.threads_manual_publish_refused('CONNECTION_NOT_VERIFIED');
    end if;
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

-- Postconditions: the exact new bodies; owners / ACLs / definer / settings unchanged; the table reachable by no role but its owner.
do $$
declare
  v_me oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_begin regprocedure := pg_catalog.to_regprocedure('public.begin_threads_manual_publish(text,uuid,text)');
  v_release regprocedure := pg_catalog.to_regprocedure('public.release_threads_manual_publish_step(uuid,text,bigint,text,text)');
  v_api text;
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_begin) is distinct from '7d26e42edaf3f7f85083880814983c2e'
     or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_release) is distinct from 'e92ec523bb1a7a3ba7ca53dce744fb82' then
    raise exception 'G4MG_POSTCONDITION_BODY';
  end if;
  if (select pg_catalog.string_agg(p.oid::regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-')
                                   || ':' || p.prosecdef::text || ':' || coalesce(p.proconfig::text, '-'), '|' order by p.oid)
        from pg_catalog.pg_proc p where p.oid in (v_begin, v_release)) is distinct from pg_catalog.current_setting('g4mg.before', true) then
    raise exception 'G4MG_POSTCONDITION_SHAPE';
  end if;
  if not (select c.relrowsecurity and c.relowner = v_me and c.relacl is not null
                 and not exists (select 1 from pg_catalog.aclexplode(c.relacl) e where e.grantee <> v_me)
            from pg_catalog.pg_class c where c.oid = 'public.threads_manual_publish_attempt_generations'::regclass)
     or exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.threads_manual_publish_attempt_generations'::regclass) then
    raise exception 'G4MG_POSTCONDITION_TABLE_ACL';
  end if;
  foreach v_api in array array['anon', 'authenticated', 'service_role', 'authenticator'] loop
    if pg_catalog.to_regrole(v_api) is not null
       and pg_catalog.has_table_privilege(v_api, 'public.threads_manual_publish_attempt_generations',
                                          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
      raise exception 'G4MG_POSTCONDITION_TABLE_ACL %', v_api;
    end if;
  end loop;
end $$;

commit;
