-- G4 SOURCE CANDIDATE (2026-10-25, Issue #319 G4-43). NOT in supabase/migrations/. NOT applied anywhere but a disposable local PG17.
-- Applies ON TOP OF 001_threads_entry_workspace_recheck.sql (G4-42). DO NOT ADOPT BEFORE H5's owner transport sets the claim
-- is_anonymous (from the verified JWT) -- see below; until then every Threads callback would be refused.
--
-- The Threads callback entry also asks G5's S2-2 person-session verdict (private.postona_personal_session(), PR #510), after
-- every existing check and before G4-42's workspace recheck (every existing refusal keeps its code and order; the whole call
-- is undone on a refusal): a callback binds only for a signed-in, NON-ANONYMOUS person whose session is live right now
-- (THREADS_SESSION_NOT_ACTIVE otherwise). This is X's 001 rule for Threads. Measured: main's T13 already refuses an ended
-- session, but lets an anonymous session through; this check refuses it.
-- The owner-transport dependency (measured in G4-43): H5's owner_transport.ts L53-L65 sets request.jwt.claims
-- {sub, session_id, role: authenticated} and the three per-claim settings, but NOT is_anonymous; S2-2 (#510 L19, L31, L35)
-- requires is_anonymous to be exactly false and answers AUTH_REQUIRED otherwise. So: H5 must add is_anonymous (the verified
-- JWT's own value, never a constant) to both representations, or G5 must offer a verdict by (user, session id). G4 does not
-- choose for them; this file only makes the entry ready for either once it returns 'active'.
-- Rollback: 002_threads_entry_person_session_rollback.sql (back to G4-42's 001 body, byte for byte).
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid;
begin
  if (select md5(p.prosrc) from pg_proc p
        where p.oid = to_regprocedure('postona_threads_binding.complete_and_attest_binding(uuid,text,text,text,text)'))
     is distinct from 'e5404eacfccc8817b74995dedf4e01f5' then
    raise exception 'G4T_SESSION_PRECONDITION_ENTRY_BODY';
  end if;
  select p.proowner into v_owner from pg_proc p
    where p.oid = to_regprocedure('postona_threads_binding.complete_and_attest_binding(uuid,text,text,text,text)');
  if to_regprocedure('private.postona_personal_session()') is null
     or (select p.prorettype::regtype::text from pg_proc p where p.oid = to_regprocedure('private.postona_personal_session()')) <> 'text'
     or not has_function_privilege(v_owner, to_regprocedure('private.postona_personal_session()'), 'EXECUTE') then
    raise exception 'G4T_SESSION_PRECONDITION_AUTHORITY private.postona_personal_session()';
  end if;
end $$;

-- G4-42 001's entry (001_threads_entry_workspace_recheck.sql L46-L136) with the G4-43 addition (marked)
create or replace function postona_threads_binding.complete_and_attest_binding(
  p_oauth_state_id uuid, p_platform_user_id text, p_handle text, p_access_token text, p_attestation text
) returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_gen postona_threads_binding.state_generations;
  v_account public.social_accounts;
  v_owner uuid;
  v_epoch bigint;
  v_lifecycle bigint;
  v_proof uuid := pg_catalog.gen_random_uuid();
  v_verdict text;  -- G4-42
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
  -- PR #124 first (T13 guard, workspace, then the state). It claims the state with UPDATE ... WHERE consumed_at IS NULL
  -- and raises otherwise: when it returns, THIS call consumed the state, and the claim and the binding below are one
  -- statement -- they commit together or not at all.
  perform public.complete_social_mobile_threads_oauth_connection(p_oauth_state_id, p_platform_user_id, p_handle,
                                                                 p_access_token, p_attestation);
  select g.* into v_gen from postona_threads_binding.state_generations g where g.oauth_state_id = p_oauth_state_id for update;
  if not found then
    raise exception 'THREADS_BINDING_GENERATION_UNRECORDED' using errcode = 'P0001';
  end if;
  if v_gen.initiated_by is distinct from v_actor then
    raise exception 'THREADS_BINDING_NOT_INITIATOR' using errcode = 'P0001';
  end if;
  -- Once per state, ever (G4-13): even after a reconnect replaced the binding, an old state is never attested again.
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
  select o.owner, private.account_lifecycle_brand_owner_epoch(v_gen.brand_id),
         (select a.lifecycle_version from public.common_accounts a where a.user_id = o.owner)
    into v_owner, v_epoch, v_lifecycle
    from (select private.account_lifecycle_brand_owner(v_gen.brand_id) as owner) o;
  if v_owner is distinct from v_actor then
    raise exception 'THREADS_BINDING_NOT_OWNER' using errcode = 'P0001';
  end if;
  if v_epoch is null or v_epoch < 1 then
    raise exception 'THREADS_BINDING_OWNER_EPOCH_UNKNOWN' using errcode = 'P0001';
  end if;
  if v_epoch <> v_gen.owner_epoch then
    raise exception 'THREADS_BINDING_OWNER_EPOCH_CHANGED' using errcode = 'P0001';
  end if;
  if v_lifecycle is distinct from v_gen.lifecycle_version then
    raise exception 'THREADS_BINDING_SERVICE_GENERATION_CHANGED' using errcode = 'P0001';
  end if;
  -- G4-43: G5's S2-2 person-session verdict (signed in, not anonymous, live session), after every existing check
  if private.postona_personal_session() is distinct from 'active' then
    raise exception 'THREADS_SESSION_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  -- G4-42 (B10 for Threads): the callback asks G5's one personal-workspace rule again
  v_verdict := private.postona_personal_workspace_eligibility(v_actor);
  if v_verdict is distinct from 'own' then
    raise exception '%', case when v_verdict in ('OWN_WORKSPACE_CONFLICT', 'WORKSPACE_OWNER_UNKNOWN') then v_verdict
                          else 'WORKSPACE_VERDICT_UNKNOWN' end using errcode = 'P0001';
  end if;
  update postona_threads_binding.state_generations set attested_at = now() where oauth_state_id = p_oauth_state_id;
  -- A reconnect replaces the account's binding with this one (a new state, the numbers it was begun under).
  insert into postona_threads_binding.bindings
    (social_account_id, brand_id, threads_user_id, bound_by, oauth_state_id, connect_proof, owner_epoch, lifecycle_version)
  values (v_account.id, v_gen.brand_id, p_platform_user_id, v_actor, p_oauth_state_id, v_proof, v_gen.owner_epoch,
          v_gen.lifecycle_version)
  on conflict (social_account_id) do update
    set brand_id = excluded.brand_id, threads_user_id = excluded.threads_user_id, bound_by = excluded.bound_by,
        oauth_state_id = excluded.oauth_state_id, connect_proof = excluded.connect_proof, owner_epoch = excluded.owner_epoch,
        lifecycle_version = excluded.lifecycle_version, bound_at = now();
  -- G4-16: the proof of THIS transaction (transaction-local; undone with the binding by any rollback).
  perform pg_catalog.set_config('postona_threads_binding.connect_proof', v_proof::text, true);
end $$;

do $$
declare v_role text;
begin
  if (select md5(p.prosrc) from pg_proc p
        where p.oid = to_regprocedure('postona_threads_binding.complete_and_attest_binding(uuid,text,text,text,text)'))
     is distinct from '5e4569ed220fcc205339b4caa8cdbe2c' then
    raise exception 'G4T_SESSION_POSTCONDITION_ENTRY_BODY';
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(v_role, 'postona_threads_binding.complete_and_attest_binding(uuid,text,text,text,text)', 'EXECUTE') then
      raise exception 'G4T_SESSION_POSTCONDITION_API_ROLE_REACHES %', v_role;
    end if;
  end loop;
end $$;

commit;
