-- NOT A MIGRATION. G4 SOURCE CANDIDATE ONLY (G4-02 #2, Issue #561). Kept outside supabase/migrations: no tool applies it.
-- The Threads connect binding for G5's PERSONAL MVP profile (G5-46 PR #548 / G5-47 PR #550: 1 person, 1 workspace, no
-- brand owner epoch; supabase/candidates/postona_personal_mvp_auth/MVP_INSTALL.sql). It is the alternative to
-- ../postona_threads_binding_epoch/001_threads_binding_epoch.sql + ../postona_g4_threads_personal_auth/001 + 002 (the FULL
-- profile, which needs F5's owner epoch, PR #303 / #457) -- install exactly one of the two:
--   * same schema, same two tables WITHOUT owner_epoch, the same three owner-only functions, the same refusal codes where
--     the rule is the same; so ../postona_threads_binding_epoch/002_custody_connect_proof.sql (custody needs the entry's
--     connect proof) and H5's claim SQL apply on top unchanged;
--   * the generation is G5's "g5pv" counter: common_accounts.lifecycle_version (the same number G5-47's R1-MVP puts in its
--     allow token g5pv:<n>, G3 stores at reservation create, and G5's MV checks at send).
--
-- Who may complete what (each refusal raises, so the caller's whole transaction -- begin + record, or the completion --
-- rolls back: no consumed state, no credential, no binding):
--   record_state_generation(actor, state, lifecycle_version)   right after PR #124's begin, same transaction
--     the actor's own unconsumed, unexpired state for a Threads account of the same workspace; then G5's MV
--     private.postona_personal_worker_verdict(actor, workspace, 'x_autopost', n) must answer 'active': the workspace is the
--     actor's DERIVED personal one (u_ + md5(user)[1:24]), S2-3 says 'own' (exactly one membership, the person as owner,
--     no other owned brand), the service is active, and n is the lifecycle_version the database holds now.
--   complete_and_attest_binding(state, threads_user_id, handle, token, attestation)   the ONLY completion
--     PR #124's reviewed complete (md5-pinned, owner-only, re-checked on every call), then in the same call: the state was
--     recorded by this actor and is attested once ever; the account is that state's identity_verified Threads account
--     with this Threads user; MV answers 'active' for the SAME n recorded at begin (service ended and restarted between
--     begin and callback = A -> B -> A of the generation -> SERVICE_GENERATION_CHANGED); G5's S2-2 says this person's
--     session is live and not anonymous. Then the binding (with a fresh connect proof, set transaction-locally).
--   binding_row(social_account_id)   the account and its binding (lifecycle_version as text).
--
-- Owner transfer (A -> B -> A of the OWNER) is outside the MVP: the workspace is derived from the person and S2-3 refuses
-- any second member or owned brand (G5-46 §1). Every MV answer other than 'active' refuses; nothing decides by time.
-- Rollback: 001_threads_binding_g5pv_rollback.sql (002 custody first, as for the full profile).

begin;
set local lock_timeout = '2s';
set local search_path = '';

do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  v_fn text;
begin
  if (select rolsuper from pg_catalog.pg_roles where oid = v_me) then
    raise exception 'THREADS_BINDING_PRECONDITION_OWNER';
  end if;
  -- No API role may become this owner (SET ROLE), directly or through any membership, inherited or not.
  foreach v_fn in array array['anon', 'authenticated', 'service_role', 'authenticator'] loop
    if exists (select 1 from pg_catalog.pg_roles r where r.rolname = v_fn)
       and (pg_catalog.pg_has_role(v_fn, v_me, 'MEMBER') or pg_catalog.pg_has_role(v_fn, v_me, 'SET')
            or pg_catalog.pg_has_role(v_fn, v_me, 'USAGE')) then
      raise exception 'THREADS_BINDING_PRECONDITION_OWNER_REACHABLE %', v_fn;
    end if;
  end loop;
  if to_regclass('public.social_accounts') is null or to_regclass('public.social_account_oauth_states') is null
     or to_regclass('public.common_accounts') is null or to_regclass('public.brand_memberships') is null
     or (select relowner from pg_catalog.pg_class where oid = to_regclass('public.social_accounts')) <> v_me
     or (select relowner from pg_catalog.pg_class where oid = to_regclass('public.social_account_oauth_states')) <> v_me then
    raise exception 'THREADS_BINDING_PRECONDITION_TABLES';
  end if;
  if not exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = to_regclass('public.common_accounts') and a.attname = 'lifecycle_version'
                    and a.atttypid = 'bigint'::regtype and not a.attisdropped)
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = to_regclass('public.social_accounts') and a.attname = 'platform' and not a.attisdropped) then
    raise exception 'THREADS_BINDING_PRECONDITION_SHAPE';
  end if;
  -- The personal MVP profile, not the full one (G5: the two exclude each other; switching = rollback, then install).
  if to_regprocedure('private.account_lifecycle_brand_owner_epoch(text)') is not null then
    raise exception 'THREADS_BINDING_G5PV_PRECONDITION_FULL_PROFILE';
  end if;
  -- PR #124's RPCs and G5's MVP gates: present, owned by this role, SECURITY DEFINER with an empty search_path.
  foreach v_fn in array array[
    'public.begin_social_mobile_threads_oauth_connection(text,text,timestamptz)',
    'public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text)',
    'private.postona_personal_worker_verdict(uuid,text,text,bigint)',
    'private.postona_personal_session()'] loop
    if to_regprocedure(v_fn) is null or not exists (
         select 1 from pg_catalog.pg_proc p where p.oid = to_regprocedure(v_fn) and p.proowner = v_me and p.prosecdef
            and coalesce(p.proconfig @> array['search_path=""'], false)) then
      raise exception 'THREADS_BINDING_PRECONDITION_DEPENDENCY %', v_fn;
    end if;
  end loop;
  -- G5's gates stay owner-only (MVP install postcondition); this entry must not become a way around that.
  if exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
              where p.oid in (to_regprocedure('private.postona_personal_worker_verdict(uuid,text,text,bigint)'),
                              to_regprocedure('private.postona_personal_session()'))
                and a.grantee <> v_me)
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.oid in (to_regprocedure('private.postona_personal_worker_verdict(uuid,text,text,bigint)'),
                                 to_regprocedure('private.postona_personal_session()'))
                   and p.proacl is null) then
    raise exception 'THREADS_BINDING_PRECONDITION_G5_GATE_EXPOSED';
  end if;
  if to_regprocedure('auth.uid()') is null then
    raise exception 'THREADS_BINDING_PRECONDITION_DEPENDENCY auth.uid()';
  end if;
  -- G4-14: the complete the entry calls is PR #124's reviewed body, and nobody but this owner may call it.
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = to_regprocedure('public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text)')
                    and pg_catalog.md5(p.prosrc) = '8c90c72f625ff4af247a11e413fc761b') then
    raise exception 'THREADS_BINDING_PRECONDITION_COMPLETE_UNPINNED';
  end if;
  if (select p.proacl from pg_catalog.pg_proc p
       where p.oid = to_regprocedure('public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text)')) is null
     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
                 where p.oid = to_regprocedure('public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text)')
                   and a.grantee <> v_me) then
    raise exception 'THREADS_BINDING_PRECONDITION_COMPLETE_EXPOSED';
  end if;
  if to_regnamespace('postona_threads_binding') is not null then
    raise exception 'THREADS_BINDING_ALREADY_APPLIED';
  end if;
end $$;

create schema postona_threads_binding;
revoke all on schema postona_threads_binding from public, anon, authenticated, service_role;

create table postona_threads_binding.state_generations (
  oauth_state_id uuid primary key references public.social_account_oauth_states (id) on delete cascade,
  initiated_by uuid not null,
  brand_id text not null,
  social_account_id text not null,
  lifecycle_version bigint not null check (lifecycle_version >= 1), -- g5pv:<n>
  recorded_at timestamptz not null default now(), -- audit only
  attested_at timestamptz -- set once by complete_and_attest_binding; a state is never attested twice (G4-13)
);

create table postona_threads_binding.bindings (
  social_account_id text primary key references public.social_accounts (id) on delete cascade,
  brand_id text not null,
  threads_user_id text not null check (threads_user_id ~ '^[1-9][0-9]{0,31}$'),
  bound_by uuid not null,
  oauth_state_id uuid not null unique,
  connect_proof uuid not null, -- G4-16: this connect's proof (random; not a secret, not a token)
  lifecycle_version bigint not null check (lifecycle_version >= 1),
  bound_at timestamptz not null default now() -- audit only: never compared
);

revoke all on all tables in schema postona_threads_binding from public, anon, authenticated, service_role;

-- G5's MV answer -> this entry's refusal. The two rules G4 already had keep their codes; any other MV answer is raised
-- as G5's own fixed code (never an allow).
create function postona_threads_binding.g5pv_refusal(p_verdict text) returns text
language sql immutable set search_path = ''
as $$
  select case p_verdict
           when 'SERVICE_GENERATION_CHANGED' then 'THREADS_BINDING_SERVICE_GENERATION_CHANGED'
           when 'NOT_PERSONAL_WORKSPACE' then 'THREADS_BINDING_NOT_OWNER'
           when 'WORKSPACE_ABSENT' then 'THREADS_BINDING_NOT_OWNER'
           else coalesce(p_verdict, 'SERVICE_STATE_UNKNOWN')
         end
$$;

-- Right after PR #124's begin, in the same transaction.
create function postona_threads_binding.record_state_generation(
  p_actor uuid, p_oauth_state_id uuid, p_lifecycle_version bigint
) returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_state public.social_account_oauth_states;
  v_verdict text;
begin
  if p_actor is null or p_oauth_state_id is null or p_lifecycle_version is null or p_lifecycle_version < 1 then
    raise exception 'THREADS_BINDING_INPUT_INVALID' using errcode = 'P0001';
  end if;
  select s.* into v_state from public.social_account_oauth_states s
   where s.id = p_oauth_state_id and s.initiated_by_user_id = p_actor and s.consumed_at is null and s.expires_at > now()
     and exists (select 1 from public.social_accounts sa
                  where sa.id = s.social_account_id and sa.brand_id = s.brand_id and sa.platform = 'threads')
   for update;
  if not found then
    raise exception 'THREADS_BINDING_STATE_INVALID' using errcode = 'P0001';
  end if;
  v_verdict := private.postona_personal_worker_verdict(p_actor, v_state.brand_id, 'x_autopost', p_lifecycle_version);
  if v_verdict is distinct from 'active' then
    raise exception '%', postona_threads_binding.g5pv_refusal(v_verdict) using errcode = 'P0001';
  end if;
  begin
    insert into postona_threads_binding.state_generations
      (oauth_state_id, initiated_by, brand_id, social_account_id, lifecycle_version)
    values (v_state.id, p_actor, v_state.brand_id, v_state.social_account_id, p_lifecycle_version);
  exception when unique_violation then
    raise exception 'THREADS_BINDING_STATE_ALREADY_RECORDED' using errcode = 'P0001';
  end;
end $$;

-- The only completion of a Threads connect (G4-14): PR #124's complete, then the binding, in ONE call. The actor is the
-- person whose JWT claims PR #124's complete runs under (auth.uid()).
create function postona_threads_binding.complete_and_attest_binding(
  p_oauth_state_id uuid, p_platform_user_id text, p_handle text, p_access_token text, p_attestation text
) returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_gen postona_threads_binding.state_generations;
  v_account public.social_accounts;
  v_proof uuid := pg_catalog.gen_random_uuid();
  v_verdict text;
begin
  if v_actor is null or p_oauth_state_id is null or p_platform_user_id is null or p_platform_user_id !~ '^[1-9][0-9]{0,31}$' then
    raise exception 'THREADS_BINDING_INPUT_INVALID' using errcode = 'P0001';
  end if;
  -- Every call: the complete called below is PR #124's reviewed body, owned by this owner, definer, empty search_path, and
  -- callable by nobody else (so no completion happens outside this entry).
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = pg_catalog.to_regprocedure('public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text)')
                    and p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
                    and p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false)
                    and pg_catalog.md5(p.prosrc) = '8c90c72f625ff4af247a11e413fc761b'
                    and p.proacl is not null
                    and not exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee <> p.proowner)) then
    raise exception 'THREADS_BINDING_COMPLETE_UNPINNED' using errcode = 'P0001';
  end if;
  -- PR #124 first (T13 guard, workspace, then the state; it consumes the state or raises): its claim and the binding below
  -- are one statement -- they commit together or not at all.
  perform public.complete_social_mobile_threads_oauth_connection(p_oauth_state_id, p_platform_user_id, p_handle,
                                                                 p_access_token, p_attestation);
  select g.* into v_gen from postona_threads_binding.state_generations g where g.oauth_state_id = p_oauth_state_id for update;
  if not found then
    raise exception 'THREADS_BINDING_GENERATION_UNRECORDED' using errcode = 'P0001';
  end if;
  if v_gen.initiated_by is distinct from v_actor then
    raise exception 'THREADS_BINDING_NOT_INITIATOR' using errcode = 'P0001';
  end if;
  -- Once per state, ever (G4-13).
  if v_gen.attested_at is not null
     or exists (select 1 from postona_threads_binding.bindings b where b.oauth_state_id = p_oauth_state_id) then
    raise exception 'THREADS_BINDING_ALREADY_ATTESTED' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.social_account_oauth_states s
                  where s.id = p_oauth_state_id and s.initiated_by_user_id = v_actor and s.consumed_at is not null
                    and s.brand_id = v_gen.brand_id and s.social_account_id = v_gen.social_account_id) then
    raise exception 'THREADS_BINDING_STATE_NOT_COMPLETED' using errcode = 'P0001';
  end if;
  select sa.* into v_account from public.social_accounts sa where sa.id = v_gen.social_account_id for update;
  if not found or v_account.platform is distinct from 'threads' or v_account.brand_id is distinct from v_gen.brand_id
     or v_account.connection_status is distinct from 'identity_verified' or v_account.vault_access_token_secret_id is null
     or v_account.platform_user_id is distinct from p_platform_user_id then
    raise exception 'THREADS_BINDING_ACCOUNT_MISMATCH' using errcode = 'P0001';
  end if;
  -- G5's MV for the generation recorded at begin: own derived workspace, S2-3 'own', service active, SAME lifecycle_version.
  v_verdict := private.postona_personal_worker_verdict(v_actor, v_gen.brand_id, 'x_autopost', v_gen.lifecycle_version);
  if v_verdict is distinct from 'active' then
    raise exception '%', postona_threads_binding.g5pv_refusal(v_verdict) using errcode = 'P0001';
  end if;
  -- G4-43: G5's S2-2 person-session verdict (signed in, not anonymous, live session).
  if private.postona_personal_session() is distinct from 'active' then
    raise exception 'THREADS_SESSION_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  update postona_threads_binding.state_generations set attested_at = now() where oauth_state_id = p_oauth_state_id;
  -- A reconnect replaces the account's binding with this one.
  insert into postona_threads_binding.bindings
    (social_account_id, brand_id, threads_user_id, bound_by, oauth_state_id, connect_proof, lifecycle_version)
  values (v_account.id, v_gen.brand_id, p_platform_user_id, v_actor, p_oauth_state_id, v_proof, v_gen.lifecycle_version)
  on conflict (social_account_id) do update
    set brand_id = excluded.brand_id, threads_user_id = excluded.threads_user_id, bound_by = excluded.bound_by,
        oauth_state_id = excluded.oauth_state_id, connect_proof = excluded.connect_proof,
        lifecycle_version = excluded.lifecycle_version, bound_at = now();
  -- G4-16: the proof of THIS transaction (transaction-local; undone with the binding by any rollback).
  perform pg_catalog.set_config('postona_threads_binding.connect_proof', v_proof::text, true);
end $$;

-- The account and its binding; lifecycle_version as decimal text (never a JSON number). The binding's columns are null when
-- there is none, or when the account no longer carries the bound Threads user / workspace.
create function postona_threads_binding.binding_row(p_social_account_id text)
returns table (social_account_id text, brand_id text, platform text, platform_user_id text, connection_status text,
               has_access_credential boolean, bound_by uuid, bind_lifecycle_version text)
language sql stable security definer set search_path = ''
as $$
  select sa.id, sa.brand_id, sa.platform, sa.platform_user_id, sa.connection_status,
         sa.vault_access_token_secret_id is not null,
         b.bound_by, b.lifecycle_version::text
    from public.social_accounts sa
    left join postona_threads_binding.bindings b
      on b.social_account_id = sa.id and b.brand_id = sa.brand_id and b.threads_user_id is not distinct from sa.platform_user_id
   where sa.id = p_social_account_id and sa.platform = 'threads'
$$;

revoke all on function postona_threads_binding.g5pv_refusal(text),
                    postona_threads_binding.record_state_generation(uuid, uuid, bigint),
                    postona_threads_binding.complete_and_attest_binding(uuid, text, text, text, text),
                    postona_threads_binding.binding_row(text)
  from public, anon, authenticated, service_role;

-- Postconditions (as the full profile's 001): every ACL of what this created names ONLY this owner; API roles cannot
-- become the owner.
do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  v_fn text;
  v_rel text;
  v_api text;
begin
  foreach v_fn in array array[
    'postona_threads_binding.record_state_generation(uuid,uuid,bigint)',
    'postona_threads_binding.complete_and_attest_binding(uuid,text,text,text,text)',
    'postona_threads_binding.binding_row(text)'] loop
    if not exists (select 1 from pg_catalog.pg_proc p where p.oid = to_regprocedure(v_fn) and p.proowner = v_me and p.prosecdef
                     and coalesce(p.proconfig @> array['search_path=""'], false)) then
      raise exception 'THREADS_BINDING_POSTCONDITION_FUNCTION %', v_fn;
    end if;
  end loop;
  foreach v_fn in array array[
    'postona_threads_binding.g5pv_refusal(text)',
    'postona_threads_binding.record_state_generation(uuid,uuid,bigint)',
    'postona_threads_binding.complete_and_attest_binding(uuid,text,text,text,text)',
    'postona_threads_binding.binding_row(text)'] loop
    if (select p.proacl from pg_catalog.pg_proc p where p.oid = to_regprocedure(v_fn)) is null
       or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
                   where p.oid = to_regprocedure(v_fn) and a.grantee <> v_me) then
      raise exception 'THREADS_BINDING_POSTCONDITION_FUNCTION_ACL %', v_fn;
    end if;
  end loop;
  -- exactly these four functions; no separate attest (or any other function) lives in the schema.
  if (select count(*) from pg_catalog.pg_proc p where p.pronamespace = to_regnamespace('postona_threads_binding')) <> 4 then
    raise exception 'THREADS_BINDING_POSTCONDITION_INVENTORY';
  end if;
  foreach v_rel in array array['postona_threads_binding.state_generations', 'postona_threads_binding.bindings'] loop
    if exists (select 1 from pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
                where c.oid = to_regclass(v_rel) and a.grantee <> v_me) then
      raise exception 'THREADS_BINDING_POSTCONDITION_TABLE_ACL %', v_rel;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
              where n.nspname = 'postona_threads_binding' and a.grantee <> v_me) then
    raise exception 'THREADS_BINDING_POSTCONDITION_SCHEMA_ACL';
  end if;
  foreach v_api in array array['anon', 'authenticated', 'service_role', 'authenticator'] loop
    if exists (select 1 from pg_catalog.pg_roles r where r.rolname = v_api)
       and (pg_catalog.pg_has_role(v_api, v_me, 'MEMBER') or pg_catalog.pg_has_role(v_api, v_me, 'SET')
            or pg_catalog.pg_has_role(v_api, v_me, 'USAGE')) then
      raise exception 'THREADS_BINDING_POSTCONDITION_OWNER_REACHABLE %', v_api;
    end if;
  end loop;
end $$;

commit;
