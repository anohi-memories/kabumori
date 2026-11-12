-- NOT A MIGRATION. G4 SOURCE CANDIDATE ONLY (G4-02 #12, Issue #561). Rollback of 002_manual_publish_attempt_credential_generation.sql.
-- Restores the bodies of public.begin_threads_manual_publish (md5 6ae40adbcd203592fbc3847c57f1bccf, threads_manual_publish_candidate.sql)
-- and public.release_threads_manual_publish_step (md5 bd5bed5adcbef4d87614613f51c83dbf, threads_publish_release_candidate.sql)
-- exactly, then drops G4-02 #13's send fence (trigger threads_manual_publish_send_fence on postona_threads_binding.bindings and
-- postona_threads_binding.manual_publish_send_fence()) and public.threads_manual_publish_attempt_generations. Owners and ACLs
-- stay (CREATE OR REPLACE; checked).
-- Refuses (nothing changed) unless 002 is applied byte for byte. G4-02 #14 (H1 #42 P3): and unless the fence, its trigger and
-- the table still have the shape 002's postconditions checked (a disabled or reshaped trigger, a changed function
-- attribute / ACL / body, a changed table ACL / RLS -> G4MG_ROLLBACK_FENCE_DRIFT / G4MG_ROLLBACK_TABLE_DRIFT). G4-02 #15: also
-- a column ACL / column privilege / column set on the table (H1 #43 P3) -> G4MG_ROLLBACK_TABLE_DRIFT, and the three
-- recovery functions -> G4MG_ROLLBACK_NOT_APPLIED (missing) / G4MG_ROLLBACK_RECOVERY_DRIFT (changed); they are dropped too.
-- After it, write steps are again gated by 001 only (the P2 gap returns): roll back only together with a decision to stop
-- manual publishing, or before 001's rollback.
-- Run as the lifecycle owner.

begin;
set local lock_timeout = '2s';
set local search_path = '';

do $$
declare
  v_me oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_begin regprocedure := pg_catalog.to_regprocedure('public.begin_threads_manual_publish(text,uuid,text)');
  v_release regprocedure := pg_catalog.to_regprocedure('public.release_threads_manual_publish_step(uuid,text,bigint,text,text)');
begin
  if pg_catalog.to_regclass('public.threads_manual_publish_attempt_generations') is null
     or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_begin) is distinct from '7d26e42edaf3f7f85083880814983c2e'
     or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_release) is distinct from 'e92ec523bb1a7a3ba7ca53dce744fb82'
     -- G4-02 #13: the send fence and its trigger, as installed
     or pg_catalog.to_regprocedure('postona_threads_binding.manual_publish_send_fence()') is null
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger t
          where t.tgrelid = 'postona_threads_binding.bindings'::regclass and t.tgname = 'threads_manual_publish_send_fence'
            and t.tgfoid = pg_catalog.to_regprocedure('postona_threads_binding.manual_publish_send_fence()')) <> 1
     -- G4-02 #15: the recovery functions
     or pg_catalog.to_regprocedure('postona_threads_binding.reconnect_recovery_account(text,uuid,text)') is null
     or pg_catalog.to_regprocedure('postona_threads_binding.reconnect_recovery_candidates(text,uuid,text)') is null
     or pg_catalog.to_regprocedure('postona_threads_binding.settle_attempt_before_rebind(text,uuid,text,uuid,text,text,text)') is null then
    raise exception 'G4MG_ROLLBACK_NOT_APPLIED';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user)
     or exists (select 1 from pg_catalog.pg_proc p where p.oid in (v_begin, v_release) and p.proowner is distinct from v_me)
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'postona_threads_binding.bindings'::regclass) is distinct from v_me then
    raise exception 'G4MG_ROLLBACK_OWNER';
  end if;
  -- G4-02 #13 / #14: the fence exactly as reviewed and owner-only, used by exactly one trigger, which has the reviewed shape:
  -- BEFORE, ROW, INSERT + UPDATE (tgtype 23), enabled as origin (tgenabled 'O'), no WHEN / column list / arguments / constraint /
  -- transition tables. The rollback refuses (G4MG_ROLLBACK_FENCE_DRIFT) unless the same predicate still holds.
  -- (= 002's G4MG_POSTCONDITION_FENCE)
  if not coalesce((select p.prosecdef and p.proowner = v_me and p.provolatile = 'v' and p.pronargs = 0 and not p.proretset
                          and p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
                          and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
                          and p.proconfig is not distinct from array['search_path=""']
                          and p.proacl is not null and not exists (select 1 from pg_catalog.aclexplode(p.proacl) e where e.grantee <> v_me)
                          and pg_catalog.md5(p.prosrc) = '4992a4a16baad53a9eb17c3cfb71a3f6'
                     from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_threads_binding.manual_publish_send_fence()')), false)
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger t
          where t.tgfoid = pg_catalog.to_regprocedure('postona_threads_binding.manual_publish_send_fence()')) <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger t
          where t.tgrelid = 'postona_threads_binding.bindings'::regclass and t.tgname = 'threads_manual_publish_send_fence'
            and t.tgfoid = pg_catalog.to_regprocedure('postona_threads_binding.manual_publish_send_fence()')
            and t.tgtype = 23 and t.tgenabled = 'O' and not t.tgisinternal and t.tgqual is null and t.tgnargs = 0
            and t.tgattr::text = '' and t.tgconstraint = 0 and not t.tgdeferrable and not t.tginitdeferred
            and t.tgoldtable is null and t.tgnewtable is null and t.tgparentid = 0) <> 1 then
    raise exception 'G4MG_ROLLBACK_FENCE_DRIFT';
  end if;
  -- (= 002's G4MG_POSTCONDITION_TABLE_ACL) G4-02 #15 (H1 #43 P3): the generation table as 002 made it, column by column: RLS on, owner-only, no policy, exactly its
  -- three columns (none dropped), no column ACL, and no API role holding any table OR column privilege on it.
  if not coalesce((select c.relrowsecurity and c.relowner = v_me and c.relacl is not null
                          and not exists (select 1 from pg_catalog.aclexplode(c.relacl) e where e.grantee <> v_me)
                     from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('public.threads_manual_publish_attempt_generations')), false)
     or exists (select 1 from pg_catalog.pg_policy p where p.polrelid = pg_catalog.to_regclass('public.threads_manual_publish_attempt_generations'))
     or (select pg_catalog.string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod), ',' order by a.attnum)
           from pg_catalog.pg_attribute a
          where a.attrelid = pg_catalog.to_regclass('public.threads_manual_publish_attempt_generations') and a.attnum > 0)
        is distinct from 'attempt_id:uuid,credential_generation:text,bound_at:timestamp with time zone'
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = pg_catalog.to_regclass('public.threads_manual_publish_attempt_generations') and a.attnum > 0
                   and a.attacl is not null)
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                 and (pg_catalog.has_table_privilege(r.oid, 'public.threads_manual_publish_attempt_generations',
                                                     'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                      or pg_catalog.has_any_column_privilege(r.oid, 'public.threads_manual_publish_attempt_generations',
                                                             'SELECT, INSERT, UPDATE, REFERENCES'))) then
    raise exception 'G4MG_ROLLBACK_TABLE_DRIFT';
  end if;
  -- (= 002's G4MG_POSTCONDITION_RECOVERY) G4-02 #15: the three recovery functions exactly as reviewed: SECURITY DEFINER, VOLATILE, empty search_path, plpgsql,
  -- owned by the owner and executable by nobody else; nothing else of those names in the schema.
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'postona_threads_binding'
         and p.proname in ('reconnect_recovery_account', 'reconnect_recovery_candidates', 'settle_attempt_before_rebind')) <> 3
     or (select pg_catalog.string_agg(p.oid::regprocedure::text || '=' || pg_catalog.md5(p.prosrc), ' ' order by p.proname)
           from pg_catalog.pg_proc p
          where p.oid in (pg_catalog.to_regprocedure('postona_threads_binding.reconnect_recovery_account(text,uuid,text)'),
                          pg_catalog.to_regprocedure('postona_threads_binding.reconnect_recovery_candidates(text,uuid,text)'),
                          pg_catalog.to_regprocedure('postona_threads_binding.settle_attempt_before_rebind(text,uuid,text,uuid,text,text,text)'))
            and p.prosecdef and p.proowner = v_me and p.provolatile = 'v'
            and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
            and p.proconfig is not distinct from array['search_path=""']
            and p.proacl is not null and not exists (select 1 from pg_catalog.aclexplode(p.proacl) e where e.grantee <> v_me))
        is distinct from 'postona_threads_binding.reconnect_recovery_account(text,uuid,text)=162ff57cf514b5be5d722baa63aa9206 postona_threads_binding.reconnect_recovery_candidates(text,uuid,text)=ec05fa2b45bdddd77ec8d9da6dc78ad8 postona_threads_binding.settle_attempt_before_rebind(text,uuid,text,uuid,text,text,text)=dba022f199158a4142ac51dbc89b6978' then
    raise exception 'G4MG_ROLLBACK_RECOVERY_DRIFT';
  end if;
  perform pg_catalog.set_config('g4mg.before', (
    select pg_catalog.string_agg(p.oid::regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-')
                                 || ':' || p.prosecdef::text || ':' || coalesce(p.proconfig::text, '-'), '|' order by p.oid)
    from pg_catalog.pg_proc p where p.oid in (v_begin, v_release)), true);
end $$;

create or replace function public.begin_threads_manual_publish(p_social_account_id text, p_idempotency_key uuid, p_text text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_user uuid := auth.uid();
  v_code text;
  v_hash text;
  v_row public.threads_manual_publish_attempts%rowtype;
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

drop trigger threads_manual_publish_send_fence on postona_threads_binding.bindings;
drop function postona_threads_binding.settle_attempt_before_rebind(text, uuid, text, uuid, text, text, text);
drop function postona_threads_binding.reconnect_recovery_candidates(text, uuid, text);
drop function postona_threads_binding.reconnect_recovery_account(text, uuid, text);
drop function postona_threads_binding.manual_publish_send_fence();
drop table public.threads_manual_publish_attempt_generations;

do $$
declare
  v_begin regprocedure := pg_catalog.to_regprocedure('public.begin_threads_manual_publish(text,uuid,text)');
  v_release regprocedure := pg_catalog.to_regprocedure('public.release_threads_manual_publish_step(uuid,text,bigint,text,text)');
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_begin) is distinct from '6ae40adbcd203592fbc3847c57f1bccf'
     or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_release) is distinct from 'bd5bed5adcbef4d87614613f51c83dbf' then
    raise exception 'G4MG_ROLLBACK_POSTCONDITION_BODY';
  end if;
  if pg_catalog.to_regprocedure('postona_threads_binding.manual_publish_send_fence()') is not null
     or exists (select 1 from pg_catalog.pg_trigger t where t.tgname = 'threads_manual_publish_send_fence')
     or exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'postona_threads_binding'
                   and p.proname in ('reconnect_recovery_account', 'reconnect_recovery_candidates', 'settle_attempt_before_rebind'))
     or pg_catalog.to_regclass('public.threads_manual_publish_attempt_generations') is not null then
    raise exception 'G4MG_ROLLBACK_POSTCONDITION_LEFTOVER';
  end if;
  if (select pg_catalog.string_agg(p.oid::regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-')
                                   || ':' || p.prosecdef::text || ':' || coalesce(p.proconfig::text, '-'), '|' order by p.oid)
        from pg_catalog.pg_proc p where p.oid in (v_begin, v_release)) is distinct from pg_catalog.current_setting('g4mg.before', true) then
    raise exception 'G4MG_ROLLBACK_POSTCONDITION_SHAPE';
  end if;
end $$;

commit;
