-- NOT A MIGRATION. G4 SOURCE CANDIDATE ONLY (G4-02 #12; the send fence #13, made clock-free by #14; Issue #561).
-- Kept outside supabase/migrations: no tool applies it.
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
-- the attempt removes it. G4-02 #13 adds one trigger function in G4's schema postona_threads_binding (no EXECUTE for any API
-- role) and its trigger on G4's postona_threads_binding.bindings (below). No shared table, column, RLS policy, grant, Vault
-- object, G3 or G5 object is touched.
-- Install after 001 (its authorize body f31f16d6ccbb4fc64946337325e93a35 must be in place), as the lifecycle owner. The
-- verdict must be the reviewed one (the same pin as 001, md5 fb93a0ad84c44c6781521eec4618fff4).
--
-- G4-02 #13 (H1 #41 P2, Issue #306): the publish release COMMITs and hands the credential to the server; a reconnect that
-- committed after that but before the server's HTTP request still let the old attempt post (the release's locks end at its
-- COMMIT). The send onset is a contract between the release and every connection change.
-- G4-02 #14 (H1 #42 P2): #13 ended that lease after 120 s on the DATABASE's clock while the server decided to send on ITS
-- clocks; with only the database's clock ahead, a reconnect committed and the old attempt still posted. No clock decides
-- the lease any more:
--   * the SEND LEASE is a recorded state, not a duration: the account has an attempt in `publishing` (the publish release
--     committed; the server may be sending) or `uncertain` (a post may exist or may still come: the server's answer was
--     lost, or the database gave up waiting for it). It ends ONLY when a state that no later send can change is recorded:
--     the server's own answer for that request (publish_returned; failed: nothing was sent, or the provider refused it),
--     or the read-only reconcile's provider evidence (published / published_unidentified: the post exists; failed: the
--     container is ERROR / EXPIRED and can never be published). Reconcile turning an abandoned `publishing` into
--     `uncertain` after 120 s does NOT end it, so no clock (fast, slow or jumping, the database's or the server's) lets a
--     reconnect in while a server could still send.
--   * postona_threads_binding.manual_publish_send_fence(), a BEFORE INSERT OR UPDATE trigger on G4's
--     postona_threads_binding.bindings (the row every connect / reconnect / re-bind writes): a write that installs another
--     oauth_state_id (= another credential generation) while that account holds a send lease is refused
--     THREADS_BINDING_SEND_IN_PROGRESS (the whole connect transaction rolls back: no state, binding or secret change).
--     Outside READ COMMITTED such a write is refused THREADS_BINDING_SEND_FENCE_ISOLATION (its snapshot could miss a lease
--     committed after it began).
--   * the publish server starts the request within THREADS_PUBLISH_SEND_START_WINDOW_MS (30 s, on its own monotonic and
--     wall clocks) of asking for the release, or records `failed` STEP_INTERRUPTED and sends nothing; the request is
--     bounded at 10 s (supabase/functions/_shared/social/threads_manual_publish.ts). That keeps a send from going out stale
--     and the lease short; the fence's safety depends neither on it nor on two clocks agreeing.
-- So: a reconnect committed BEFORE the publish release -> the release refuses (G4-02 #12, above); a publish release committed
-- first -> the reconnect cannot commit until that send's outcome is recorded by the server or settled from the provider's
-- own container status (read-only, never resent). The price is liveness, not safety: a server that dies after the release,
-- or whose answer is lost, keeps the account's reconnect refused until reconcile reads a final container status (how long
-- a real Threads container takes to report EXPIRED is not verified). Not closed by any database: a provider whose
-- container status is wrong. Disconnect / stop / G5 end are not fenced: they never resume a send, and a send whose lease
-- began before them is ordered before them. The begin / release bodies above are unchanged by #13 and #14.
-- G4-02 #15 (H1 #43 P2): an `uncertain` attempt whose stored credential has EXPIRED could never be settled -- reconcile
-- needs a valid credential (CREDENTIALS_EXPIRED), the fence refuses the reconnect that would bring one, disconnect keeps the
-- account (PUBLISH_IN_FLIGHT). Recovery is READ-BEFORE-REBIND, inside the person's own reconnect: G4's owner bridge holds
-- the freshly granted token of the SAME Threads user (H5's exchange read /me), and BEFORE the completion moves the binding
-- it asks the provider -- GET only, never a write -- for each open attempt's container status with that token, and records
-- only final evidence through postona_threads_binding.settle_attempt_before_rebind (PUBLISHED -> published /
-- published_unidentified; ERROR / EXPIRED -> failed). No final evidence (FINISHED / IN_PROGRESS / a failed read) -> nothing is
-- recorded and the fence still refuses. The token is never stored for this, and nothing is ever resent. Who may record:
--   * the caller of this transaction is the person (auth.uid(), an active session, G5's lifecycle fence) who started THIS
--     connect (public.social_account_oauth_states: initiated_by_user_id, not expired) for that account, and an owner / admin
--     of its workspace;
--   * the token's Threads user (as H5's exchange proved it) is the account's platform_user_id AND the binding's
--     threads_user_id; the attempt is that account's, still `publishing` / `uncertain`, with the SAME container id, and bound
--     to the binding's current generation (the one this reconnect is replacing).
--   Only G4's owner bridge calls these (owner-only EXECUTE, no API role reaches the schema).
-- What the database cannot check: that the evidence came from Threads for that container (the owner bridge did the read).
-- G4-02 #16 (H1 #44): (P2-1) PUBLISHED proves a post exists, not WHICH post -- so recovery records only
-- `published_unidentified` PUBLISHED_POST_NOT_FOUND (no post id, no permalink, ever) or `failed` CONTAINER_ERROR /
-- CONTAINER_EXPIRED; (P2-2) with no permalink written here, 002 has no URL policy of its own (the only one stays the
-- TypeScript contract + the attempts table's CHECK); (P3) every call also requires THIS connect's H5 attempt to be `claimed`
-- by this person and session, not expired, for that account, and its OAuth state not yet consumed; and the owner bridge
-- writes the evidence INSIDE the completion's transaction, before complete_and_attest_binding, so it commits only together
-- with PR #124's state check, G5's generation / session checks and the binding (a refused completion rolls it back).
-- Rollback: 002_manual_publish_attempt_credential_generation_rollback.sql (restores both bodies exactly, drops the fence and
-- the table).

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
  if pg_catalog.to_regclass('public.threads_manual_publish_attempt_generations') is not null
     or pg_catalog.to_regprocedure('postona_threads_binding.manual_publish_send_fence()') is not null
     or exists (select 1 from pg_catalog.pg_trigger t where t.tgname = 'threads_manual_publish_send_fence')
     or exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'postona_threads_binding'
                   and p.proname in ('reconnect_recovery_account', 'reconnect_recovery_candidates', 'settle_attempt_before_rebind')) then
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
                   and c.relowner is distinct from v_me)
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_threads_binding') is distinct from v_me
     -- G4-02 #16: H5's claimed attempt (read by the recovery functions), owned by the same owner
     or pg_catalog.to_regclass('postona_threads_runtime.attempts') is null
     or (select c.relowner from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('postona_threads_runtime.attempts')) is distinct from v_me
     or (select pg_catalog.count(*) from pg_catalog.pg_attribute a
          where a.attrelid = pg_catalog.to_regclass('postona_threads_runtime.attempts') and not a.attisdropped
            and a.attname in ('state_hash', 'oauth_state_id', 'user_id', 'session_id', 'brand_id', 'social_account_id', 'expires_at', 'status')) <> 8 then
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

-- G4-02 #13 / #14: the send fence (see the header). The publish release holds the binding FOR SHARE to its COMMIT, so a
-- reconnect's binding write waits for it and then runs this function, whose query takes a fresh snapshot (READ COMMITTED)
-- and sees that release. No time is read: the lease is the attempt's recorded state.
create function postona_threads_binding.manual_publish_send_fence()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.social_account_id is not distinct from old.social_account_id
     and new.oauth_state_id is not distinct from old.oauth_state_id then
    return new;  -- the generation does not move
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'THREADS_BINDING_SEND_FENCE_ISOLATION' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.threads_manual_publish_attempts t
              where t.social_account_id in (new.social_account_id, case when tg_op = 'UPDATE' then old.social_account_id end)
                and t.status in ('publishing', 'uncertain')) then
    raise exception 'THREADS_BINDING_SEND_IN_PROGRESS' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function postona_threads_binding.manual_publish_send_fence() from public, anon, authenticated, service_role;
create trigger threads_manual_publish_send_fence
  before insert or update on postona_threads_binding.bindings
  for each row execute function postona_threads_binding.manual_publish_send_fence();

-- G4-02 #15 / #16: read-before-rebind recovery (see the header). The account a reconnect may settle attempts of, or null.
create function postona_threads_binding.reconnect_recovery_account(p_state_hash text, p_oauth_state_id uuid, p_platform_user_id text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_session uuid := public.threads_manual_publish_session_id();
  v_account public.social_accounts%rowtype;
  v_role text;
begin
  if v_user is null or v_session is null or p_oauth_state_id is null or coalesce(p_state_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_platform_user_id, '') !~ '^[1-9][0-9]{0,31}$' then
    return null;
  end if;
  if public.threads_manual_publish_fence(v_user) is not null then return null; end if;  -- G5's lifecycle
  if not exists (select 1 from auth.sessions s where s.id = v_session and s.user_id = v_user
                  and (s.not_after is null or s.not_after > pg_catalog.clock_timestamp())) then
    return null;
  end if;
  select a.* into v_account
    from public.social_account_oauth_states s
    join public.social_accounts a on a.id = s.social_account_id and a.brand_id = s.brand_id
   where s.id = p_oauth_state_id and s.initiated_by_user_id = v_user and s.consumed_at is null
     and s.expires_at > pg_catalog.clock_timestamp();
  if v_account.id is null or v_account.platform is distinct from 'threads'
     or v_account.platform_user_id is distinct from p_platform_user_id then
    return null;
  end if;
  -- G4-02 #16 (H1 #44 P3): THIS connect, as H5 claimed it (the same row the completion checks, same person and session)
  if not exists (select 1 from postona_threads_runtime.attempts h
                  where h.state_hash = p_state_hash and h.oauth_state_id = p_oauth_state_id and h.user_id = v_user
                    and h.session_id = v_session and h.status = 'claimed' and h.expires_at > pg_catalog.clock_timestamp()
                    and h.social_account_id = v_account.id and h.brand_id = v_account.brand_id) then
    return null;
  end if;
  select m.role into v_role from public.brand_memberships m where m.brand_id = v_account.brand_id and m.user_id = v_user;
  if v_role is null or v_role not in ('owner', 'admin') then return null; end if;
  if not exists (select 1 from postona_threads_binding.bindings b
                  where b.social_account_id = v_account.id and b.threads_user_id = p_platform_user_id) then
    return null;
  end if;
  return v_account.id;
end;
$$;

-- The attempts the bridge may read a container status for: still open, with a container, bound to the current generation.
create function postona_threads_binding.reconnect_recovery_candidates(p_state_hash text, p_oauth_state_id uuid, p_platform_user_id text)
returns table (attempt_id uuid, container_id text)
language plpgsql security definer set search_path = '' as $$
declare
  v_account text := postona_threads_binding.reconnect_recovery_account(p_state_hash, p_oauth_state_id, p_platform_user_id);
begin
  if v_account is null then return; end if;
  return query
    select t.id, t.container_id
      from public.threads_manual_publish_attempts t
      join public.threads_manual_publish_attempt_generations g on g.attempt_id = t.id
      join postona_threads_binding.bindings b on b.social_account_id = t.social_account_id
     where t.social_account_id = v_account and t.status in ('publishing', 'uncertain') and t.container_id is not null
       and g.credential_generation = 'g4t1:' || b.oauth_state_id::text
     order by t.created_at;
end;
$$;

-- Records ONE final piece of evidence for ONE attempt (compare-and-set on its status and container): a post exists but is not
-- attributed, or the container can never be published. Never a post id, a permalink, or a write step.
create function postona_threads_binding.settle_attempt_before_rebind(
  p_state_hash text, p_oauth_state_id uuid, p_platform_user_id text, p_attempt_id uuid, p_container_id text,
  p_to_status text, p_error_code text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_account text := postona_threads_binding.reconnect_recovery_account(p_state_hash, p_oauth_state_id, p_platform_user_id);
  v_row public.threads_manual_publish_attempts%rowtype;
begin
  if v_account is null then return 'NOT_PERMITTED'; end if;
  if not ((p_to_status = 'published_unidentified' and p_error_code = 'PUBLISHED_POST_NOT_FOUND')
       or (p_to_status = 'failed' and p_error_code in ('CONTAINER_ERROR', 'CONTAINER_EXPIRED'))) then
    return 'REQUEST_INVALID';
  end if;
  -- the publish release's order: the account, then the attempt
  perform 1 from public.social_accounts a where a.id = v_account for share;
  select t.* into v_row from public.threads_manual_publish_attempts t where t.id = p_attempt_id for update;
  if v_row.id is null or v_row.social_account_id is distinct from v_account then return 'NOT_PERMITTED'; end if;
  if v_row.status not in ('publishing', 'uncertain') or v_row.container_id is null
     or v_row.container_id is distinct from p_container_id
     or not exists (select 1 from public.threads_manual_publish_attempt_generations g
                      join postona_threads_binding.bindings b on b.social_account_id = v_row.social_account_id
                     where g.attempt_id = v_row.id and g.credential_generation = 'g4t1:' || b.oauth_state_id::text) then
    return 'STALE';
  end if;
  update public.threads_manual_publish_attempts t
     set status = p_to_status, provider_post_id = null, permalink = null, error_code = p_error_code,
         grant_hash = null, grant_step = null, grant_state = null, grant_expires_at = null, grant_user_id = null,
         grant_session_id = null, updated_at = pg_catalog.now()
   where t.id = v_row.id;
  return 'SETTLED';
end;
$$;
revoke all on function postona_threads_binding.reconnect_recovery_account(text, uuid, text),
                       postona_threads_binding.reconnect_recovery_candidates(text, uuid, text),
                       postona_threads_binding.settle_attempt_before_rebind(text, uuid, text, uuid, text, text, text)
  from public, anon, authenticated, service_role;

-- Postconditions: the exact new bodies; owners / ACLs / definer / settings unchanged; the table reachable by no role but its owner.
do $$
declare
  v_me oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_begin regprocedure := pg_catalog.to_regprocedure('public.begin_threads_manual_publish(text,uuid,text)');
  v_release regprocedure := pg_catalog.to_regprocedure('public.release_threads_manual_publish_step(uuid,text,bigint,text,text)');
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
  -- G4-02 #15 (H1 #43 P3): the generation table as 002 made it, column by column: RLS on, owner-only, no policy, exactly its
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
    raise exception 'G4MG_POSTCONDITION_TABLE_ACL';
  end if;
  -- G4-02 #15: the three recovery functions exactly as reviewed: SECURITY DEFINER, VOLATILE, empty search_path, plpgsql,
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
    raise exception 'G4MG_POSTCONDITION_RECOVERY';
  end if;
  -- G4-02 #13 / #14: the fence exactly as reviewed and owner-only, used by exactly one trigger, which has the reviewed shape:
  -- BEFORE, ROW, INSERT + UPDATE (tgtype 23), enabled as origin (tgenabled 'O'), no WHEN / column list / arguments / constraint /
  -- transition tables. The rollback refuses (G4MG_ROLLBACK_FENCE_DRIFT) unless the same predicate still holds.
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
    raise exception 'G4MG_POSTCONDITION_FENCE';
  end if;
end $$;

commit;
