-- NOT A MIGRATION. G4 SOURCE CANDIDATE ONLY (G4-02 #4, Issue #561). Kept outside supabase/migrations: no tool applies it.
-- The read-only Threads publish-credential VERDICT that G3's reservation consumer binds to (G3-47 Issue #318 REPORT
-- 6510569221, "IF requested from G4" 1-5). Answers whether THIS person's Threads account may be posted to right now, and
-- under which credential generation; never a token, a secret id or any other credential material.
--
--   postona_g4_credential.threads_publish_credential_verdict(p_user_id uuid, p_social_account_id text)
--     returns table (verified boolean, credential_generation text, code text)   -- exactly one row, always
--
-- verified = true (code 'VERIFIED') only when ALL hold, read in one statement snapshot:
--   * the account exists, is Threads, and lives in the person's own workspace (u_ + md5(user)[1:24]) whose single owner is
--     the person (G5's private.account_lifecycle_brand_owner -- present in both G5 profiles, full and personal MVP);
--   * the person's x_autopost service is 'active' for that workspace (G5's common_account_brand_service_state);
--   * G4's binding exists, was made by this person (bound_by), for the same workspace and the account's CURRENT Threads
--     user id (a re-bind to another Threads user is a new binding, never this one);
--   * connection_status = 'identity_verified' with no connection error, an access credential is set, and G4's custody
--     row names THAT credential and has not expired.
-- credential_generation = 'g4t1:' || the binding's oauth_state_id (one fresh uuid per completed connect): it changes on
--   every reconnect / re-bind, and disappears on disconnect (the rows are deleted). It is opaque: compare for equality only.
--   It is never reused (a uuid), so an A -> B -> A of the binding never brings an old value back. A token rotation that
--   keeps the same person and Threads user does NOT change it.
-- code (fixed): VERIFIED | INPUT_INVALID | NOT_CONNECTED | NOT_OWN_WORKSPACE | SERVICE_<G5 state> | NOT_BOUND |
--   NOT_VERIFIED | CONNECTION_ERROR | CREDENTIAL_MISSING | CREDENTIAL_EXPIRED. Anything not verified carries a null
--   generation except NOT_VERIFIED / CONNECTION_ERROR / CREDENTIAL_* / SERVICE_* (the binding's, for diagnosis only).
--   Threads has no refresh lease on this stack: REFRESH_IN_PROGRESS is reserved, never answered here.
--
-- Same shape on both G5 profiles: it reads only the binding's bound_by / brand_id / threads_user_id / oauth_state_id,
-- which the full (../postona_threads_binding_epoch/001) and personal (../postona_g4_threads_personal_mvp/001) bindings
-- both have. Owner-only: NO grant to anon / authenticated / service_role. G3's SECURITY DEFINER consumers call it as
-- their owner, which must be this owner (the lifecycle owner); a different owner needs its own reviewed EXECUTE grant.
-- Rollback: 001_threads_publish_credential_verdict_rollback.sql (002 first if installed).

begin;
set local lock_timeout = '2s';
set local search_path = '';

do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  v_name text;
begin
  if (select rolsuper from pg_catalog.pg_roles where oid = v_me) then
    raise exception 'G4_VERDICT_PRECONDITION_OWNER';
  end if;
  foreach v_name in array array['anon', 'authenticated', 'service_role', 'authenticator'] loop
    if exists (select 1 from pg_catalog.pg_roles r where r.rolname = v_name)
       and (pg_catalog.pg_has_role(v_name, v_me, 'MEMBER') or pg_catalog.pg_has_role(v_name, v_me, 'SET')
            or pg_catalog.pg_has_role(v_name, v_me, 'USAGE')) then
      raise exception 'G4_VERDICT_PRECONDITION_OWNER_REACHABLE %', v_name;
    end if;
  end loop;
  -- what it reads: owned by this role (the binding is G4's; either profile)
  foreach v_name in array array['public.social_accounts', 'public.threads_account_credential_custody', 'postona_threads_binding.bindings'] loop
    if to_regclass(v_name) is null or (select relowner from pg_catalog.pg_class where oid = to_regclass(v_name)) <> v_me then
      raise exception 'G4_VERDICT_PRECONDITION_TABLE %', v_name;
    end if;
  end loop;
  if not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = to_regclass('postona_threads_binding.bindings')
                  and a.attname = 'oauth_state_id' and a.atttypid = 'uuid'::regtype and not a.attisdropped) then
    raise exception 'G4_VERDICT_PRECONDITION_BINDING_SHAPE';
  end if;
  foreach v_name in array array['private.account_lifecycle_brand_owner(text)', 'public.common_account_brand_service_state(text,text)'] loop
    if to_regprocedure(v_name) is null then
      raise exception 'G4_VERDICT_PRECONDITION_DEPENDENCY %', v_name;
    end if;
  end loop;
  if to_regnamespace('postona_g4_credential') is not null then
    raise exception 'G4_VERDICT_ALREADY_APPLIED';
  end if;
end $$;

create schema postona_g4_credential;
revoke all on schema postona_g4_credential from public, anon, authenticated, service_role;

create function postona_g4_credential.threads_publish_credential_verdict(p_user_id uuid, p_social_account_id text)
returns table (verified boolean, credential_generation text, code text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_account public.social_accounts;
  v_binding postona_threads_binding.bindings;
  v_custody public.threads_account_credential_custody;
  v_state text;
  v_generation text;
begin
  if p_user_id is null or p_social_account_id is null or p_social_account_id = '' then
    return query select false, null::text, 'INPUT_INVALID'::text;
    return;
  end if;
  select sa.* into v_account from public.social_accounts sa where sa.id = p_social_account_id and sa.platform = 'threads';
  if not found then
    return query select false, null::text, 'NOT_CONNECTED'::text;  -- never connected, or disconnected (rows removed)
    return;
  end if;
  if v_account.brand_id is distinct from 'u_' || pg_catalog.substr(pg_catalog.md5(p_user_id::text), 1, 24)
     or private.account_lifecycle_brand_owner(v_account.brand_id) is distinct from p_user_id then
    return query select false, null::text, 'NOT_OWN_WORKSPACE'::text;
    return;
  end if;
  select b.* into v_binding from postona_threads_binding.bindings b
   where b.social_account_id = v_account.id and b.brand_id = v_account.brand_id and b.bound_by = p_user_id
     and b.threads_user_id is not distinct from v_account.platform_user_id;
  if not found then
    return query select false, null::text, 'NOT_BOUND'::text;
    return;
  end if;
  v_generation := 'g4t1:' || v_binding.oauth_state_id::text;
  v_state := public.common_account_brand_service_state(v_account.brand_id, 'x_autopost');
  if v_state is distinct from 'active' then
    return query select false, v_generation, coalesce(v_state, 'SERVICE_STATE_UNKNOWN');
    return;
  end if;
  if v_account.connection_status is distinct from 'identity_verified' then
    return query select false, v_generation, 'NOT_VERIFIED'::text;
    return;
  end if;
  if v_account.last_connection_error_code is not null then
    return query select false, v_generation, 'CONNECTION_ERROR'::text;
    return;
  end if;
  select c.* into v_custody from public.threads_account_credential_custody c where c.social_account_id = v_account.id;
  if v_account.vault_access_token_secret_id is null or not found
     or v_custody.vault_secret_id is distinct from v_account.vault_access_token_secret_id then
    return query select false, v_generation, 'CREDENTIAL_MISSING'::text;
    return;
  end if;
  if v_custody.expires_at <= pg_catalog.now() then
    return query select false, v_generation, 'CREDENTIAL_EXPIRED'::text;
    return;
  end if;
  return query select true, v_generation, 'VERIFIED'::text;
end $$;

revoke all on function postona_g4_credential.threads_publish_credential_verdict(uuid, text) from public, anon, authenticated, service_role;

-- Postconditions: owner / definer / empty search_path / STABLE; every ACL names only this owner; API roles cannot reach it.
do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  v_fn regprocedure := to_regprocedure('postona_g4_credential.threads_publish_credential_verdict(uuid,text)');
  v_api text;
begin
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.proowner = v_me and p.prosecdef and p.provolatile = 's'
                   and coalesce(p.proconfig @> array['search_path=""'], false)) then
    raise exception 'G4_VERDICT_POSTCONDITION_FUNCTION';
  end if;
  if (select p.proacl from pg_catalog.pg_proc p where p.oid = v_fn) is null
     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a where p.oid = v_fn and a.grantee <> v_me)
     or exists (select 1 from pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
                 where n.nspname = 'postona_g4_credential' and a.grantee <> v_me) then
    raise exception 'G4_VERDICT_POSTCONDITION_ACL';
  end if;
  foreach v_api in array array['anon', 'authenticated', 'service_role', 'authenticator'] loop
    if exists (select 1 from pg_catalog.pg_roles r where r.rolname = v_api)
       and (pg_catalog.has_function_privilege(v_api, v_fn, 'EXECUTE') or pg_catalog.has_schema_privilege(v_api, 'postona_g4_credential', 'USAGE')) then
      raise exception 'G4_VERDICT_POSTCONDITION_API_ROLE_REACHES %', v_api;
    end if;
  end loop;
  if (select count(*) from pg_catalog.pg_proc p where p.pronamespace = to_regnamespace('postona_g4_credential')) <> 1 then
    raise exception 'G4_VERDICT_POSTCONDITION_INVENTORY';
  end if;
end $$;

commit;
