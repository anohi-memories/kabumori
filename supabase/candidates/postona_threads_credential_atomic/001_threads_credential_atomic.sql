-- NOT A MIGRATION. SOURCE CANDIDATE ONLY (G4-11, Issue #319). Kept outside supabase/migrations: no tool applies it. A Codex
-- Sol (high) review of this file and an explicit approval come before any real database; granting it to the dispatcher's
-- role is a further, separate step.
--
-- What it adds (owner-only; no grant to any other role):
--   postona_threads_credential.credential_row(social_account_id text, service_key text)
--     -> 0 or 1 row (social_account_id, threads_user_id, access_token, generation)
-- the row G4-02's ThreadsCredentialStatement must return for G3's ThreadsCredentialPort.credentialFor(account): the
-- decision, the token and the credential generation from ONE SQL statement (one snapshot), never in two reads.
--
-- A row is returned only when, in that one statement, all of these hold (otherwise no row, never an error carrying data):
--   * the key is G5's common POSTONA key 'x_autopost' (G4-10) -- the key alone authorizes nothing;
--   * the account is a Threads account, identity_verified, with a Vault reference;
--   * G4's binding (PR #367 postona_threads_binding.bindings; CHANGES_REQUIRED by H2, not approved) exists for this account in
--     its current workspace with its current Threads user, bound by the workspace's CURRENT single owner;
--   * G5's W1 (PR #358 private.account_lifecycle_worker_brand_verdict) answers 'active' for the binding's owner_epoch and
--     lifecycle_version, unchanged (owner A -> B -> A, a service ended and restarted, deletion, freeze -> another answer);
--   * G4's custody (threads_account_credential_expires_at: the expiry recorded for exactly this Vault secret, after the
--     verified connection) is in the future -- an expired, rotated-but-unrecorded or never-recorded credential gives no row;
--   * the Vault secret exists;
--   * G3's credential generation (postona_threads_resv.threads_credential_generation, 007) is 64 lowercase hex.
-- The generation is G3's, computed in the same statement as the token; G4 computes none of its own. G3 compares it with
-- the generation bound at claim (preflight), so a rotation between the two calls is refused by G3, not hidden here.
--
-- Not done here (named, not assumed): the caller (an Edge credential port over a reviewed grant), G3's g4_threads_account_
-- verified predicate (still G3's DENY), the refresh writer, any real token. bigint numbers stay bigint in SQL; nothing here
-- converts them to text for the caller.

begin;
set local lock_timeout = '2s';
set local search_path = '';

do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  v_fn text;
  v_api text;
begin
  if (select rolsuper from pg_catalog.pg_roles where oid = v_me) then
    raise exception 'THREADS_CREDENTIAL_PRECONDITION_OWNER';
  end if;
  -- No API role may become this owner (SET ROLE), directly or through any membership, inherited or not.
  foreach v_api in array array['anon', 'authenticated', 'service_role', 'authenticator'] loop
    if exists (select 1 from pg_catalog.pg_roles r where r.rolname = v_api)
       and (pg_catalog.pg_has_role(v_api, v_me, 'MEMBER') or pg_catalog.pg_has_role(v_api, v_me, 'SET')
            or pg_catalog.pg_has_role(v_api, v_me, 'USAGE')) then
      raise exception 'THREADS_CREDENTIAL_PRECONDITION_OWNER_REACHABLE %', v_api;
    end if;
  end loop;
  if to_regclass('public.social_accounts') is null
     or (select relowner from pg_catalog.pg_class where oid = to_regclass('public.social_accounts')) <> v_me
     or to_regclass('postona_threads_binding.bindings') is null
     or (select relowner from pg_catalog.pg_class where oid = to_regclass('postona_threads_binding.bindings')) <> v_me
     or to_regclass('vault.decrypted_secrets') is null then
    raise exception 'THREADS_CREDENTIAL_PRECONDITION_TABLES';
  end if;
  -- Every function the statement calls: present, STABLE, owned by this role.
  foreach v_fn in array array[
    'private.account_lifecycle_brand_owner(text)',
    'private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)',
    'public.threads_account_credential_expires_at(text)',
    'postona_threads_resv.threads_credential_generation(text)'] loop
    if to_regprocedure(v_fn) is null
       or not exists (select 1 from pg_catalog.pg_proc p where p.oid = to_regprocedure(v_fn) and p.proowner = v_me and p.provolatile = 's') then
      raise exception 'THREADS_CREDENTIAL_PRECONDITION_DEPENDENCY %', v_fn;
    end if;
  end loop;
  if to_regnamespace('postona_threads_credential') is not null then
    raise exception 'THREADS_CREDENTIAL_ALREADY_APPLIED';
  end if;
end $$;

create schema postona_threads_credential;
revoke all on schema postona_threads_credential from public, anon, authenticated, service_role;

create function postona_threads_credential.credential_row(p_social_account_id text, p_service_key text)
returns table (social_account_id text, threads_user_id text, access_token text, generation text)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.platform_user_id, c.token, c.generation
    from (
      select sa.id, sa.platform_user_id, ds.decrypted_secret as token,
             postona_threads_resv.threads_credential_generation(sa.id) as generation
        from public.social_accounts sa
        join postona_threads_binding.bindings b
          on b.social_account_id = sa.id and b.brand_id = sa.brand_id and b.threads_user_id = sa.platform_user_id
        join vault.decrypted_secrets ds on ds.id = sa.vault_access_token_secret_id
       where p_service_key = 'x_autopost'
         and sa.id = p_social_account_id
         and sa.platform = 'threads'
         and sa.connection_status = 'identity_verified'
         and sa.platform_user_id ~ '^[1-9][0-9]{0,31}$'
         and b.bound_by = private.account_lifecycle_brand_owner(sa.brand_id)
         and private.account_lifecycle_worker_brand_verdict(sa.brand_id, 'x_autopost', b.owner_epoch, b.lifecycle_version) = 'active'
         and public.threads_account_credential_expires_at(sa.id) > pg_catalog.now()
         and ds.decrypted_secret is not null
    ) c
   where c.generation ~ '^[0-9a-f]{64}$'
$$;

revoke all on function postona_threads_credential.credential_row(text, text) from public, anon, authenticated, service_role;

-- Postconditions (H2 #329 on PR #367: a role reaching through NOINHERIT / SET or a default ACL must not slip through). The
-- ACLs must name ONLY this owner -- any other grantee (a default-ACL grant to some delegate role included) refuses the
-- install, whoever could reach that grantee -- and the function is owner / definer / STABLE / empty search_path.
do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  v_fn oid := to_regprocedure('postona_threads_credential.credential_row(text,text)');
begin
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.proowner = v_me and p.prosecdef and p.provolatile = 's'
                   and coalesce(p.proconfig @> array['search_path=""'], false)) then
    raise exception 'THREADS_CREDENTIAL_POSTCONDITION_FUNCTION';
  end if;
  if (select p.proacl from pg_catalog.pg_proc p where p.oid = v_fn) is null
     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a where p.oid = v_fn and a.grantee <> v_me) then
    raise exception 'THREADS_CREDENTIAL_POSTCONDITION_FUNCTION_ACL';
  end if;
  if exists (select 1 from pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
              where n.nspname = 'postona_threads_credential' and a.grantee <> v_me) then
    raise exception 'THREADS_CREDENTIAL_POSTCONDITION_SCHEMA_ACL';
  end if;
end $$;

commit;
