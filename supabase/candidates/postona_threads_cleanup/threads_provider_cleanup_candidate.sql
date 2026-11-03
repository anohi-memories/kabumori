-- SOURCE CANDIDATE ONLY. NOT a migration, NOT applied anywhere (G4,
-- postona-g4-threads-mobile-oauth-and-cleanup-wiring-v1-20261012; lease re-check added by F4,
-- postona-f4-threads-disconnect-lease-safe-v1-20261012; live lease for BOTH deletion kinds through G5's own
-- predicate by F4, postona-f4-threads-cleanup-live-lease-security-fix-20261013). Apply only after the G4 publish
-- stack (custody -> manual publish -> release) and G5/F5 Phase 6 (20261013120000, PR #178), as a single
-- reviewed file, after the integrated review.
--
-- POSTONA Threads: the database side of the Threads provider cleanup that G5's account deletion (T10,
-- Draft PR #152 ProviderCleanupAdapter) calls through supabase/functions/_shared/social/threads_provider_cleanup.ts.
--
--   public.threads_provider_connection_state(user)   read-only: 'connected' | 'not_connected'
--   public.cleanup_threads_provider_footprint(user)   ONE transaction, removes this person's Threads footprint:
--       the Threads social account of their POSTONA workspace, its Vault access secret, and (cascading) the
--       manual publish permission, attempts, nonces and credential custody. Answers one of G5's outcomes:
--         local_removed_remote_unverified  removed and read back; Threads offers no app-side revoke we can
--                                          verify, so the remote grant is never reported as revoked
--         reconciliation_required          a post may be in flight (creating_container / publishing /
--                                          publish_returned / uncertain), or the secret is shared, or the
--                                          read-back failed: NOTHING is removed, a person checks first
--         blocked                          no POSTONA / account deletion is in progress for this person, the
--                                          deletion's owner holds no live lease (also re-checked after the
--                                          locks), or the workspace is busy: nothing is removed
--       It never reports confirmed_remote_revoked and never calls Threads.
--
-- Authority: the person id comes from G5's orchestrator, which owns the deletion lease. This function does
-- not trust it alone: it acts only while G5's own lifecycle table says a deletion of this person is in its
-- cleanup step (account_deletion, or service_deletion of x_autopost = ending POSTONA only). It touches only
-- the deterministic POSTONA workspace of that person (social_mobile_account_deletion_workspace) and only its
-- Threads row, never X rows, other workspaces or other people's secrets. It takes the workspace lock that
-- serializes with connection (PR #124), the person's own Threads disconnect and deletion, then the account row.
--
-- Lease (F4, G5 PR #152 R1 contract; F5 Phase 6 PR #178 section 8.3): BOTH deletion kinds authorize only while
-- their owner HOLDS a live lease, by the wall clock -- an account deletion in its cleanup step, or the
-- POSTONA-only service deletion of x_autopost, which Phase 6 gave an owner lease (claim_service_deletion). The
-- decision is G5's own predicate private.account_lifecycle_cleanup_authorized(user) (owner-only), asked once on
-- entry and AGAIN after the locks were obtained, right before anything is deleted: a deletion that was begun
-- but never claimed, a lease that ended or was released, or one that ran out while this call waited for a lock,
-- removes nothing (blocked / DELETION_NOT_IN_PROGRESS or LEASE_NOT_HELD). Before F4's fix the service deletion
-- needed no lease: any holder of the cleanup grant could remove the footprint under an unclaimed or ended
-- POSTONA deletion. The adapter asks G5's stillOwned() immediately before calling this function; the function
-- cannot tell WHICH owner holds the lease (the port does not hand the lease to adapters), so a stale owner is
-- stopped by stillOwned(), and a takeover by a new owner in between is safe only because the removal is
-- idempotent and serialized by the workspace lock (G5's own rule: "a lease check is not a lock").
--
-- Access: EXECUTE for the owner only. Granting it to the role G5's account-delete function runs as is part
-- of G5's adapter registration (separately reviewed); until then the adapter cannot reach it and fails
-- closed.
begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare v_owner oid;
begin
  if pg_catalog.to_regprocedure('public.cleanup_threads_provider_footprint(uuid)') is not null then
    raise exception 'THREADS_CLEANUP_PRECONDITION_ALREADY_APPLIED';
  end if;
  if pg_catalog.to_regclass('public.threads_manual_publish_attempts') is null
     or pg_catalog.to_regclass('public.social_account_manual_publish_permissions') is null
     or pg_catalog.to_regclass('public.threads_account_credential_custody') is null
     or pg_catalog.to_regclass('public.threads_manual_publish_nonces') is null then
    raise exception 'THREADS_CLEANUP_PRECONDITION_PUBLISH_STACK';
  end if;
  select c.relowner into v_owner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass;
  -- G5/F5 Phase 6: the one cleanup predicate (live owner lease for both deletion kinds), a boolean owned by the
  -- table owner and reachable by no API role, directly or through a membership. Missing -> fail closed.
  if pg_catalog.to_regprocedure('private.account_lifecycle_cleanup_authorized(uuid)') is null
     or (select p.proowner from pg_catalog.pg_proc p
         where p.oid = pg_catalog.to_regprocedure('private.account_lifecycle_cleanup_authorized(uuid)')) is distinct from v_owner
     or (select p.prorettype from pg_catalog.pg_proc p
         where p.oid = pg_catalog.to_regprocedure('private.account_lifecycle_cleanup_authorized(uuid)')) is distinct from 'boolean'::regtype
     or exists (select 1 from pg_catalog.pg_roles r
                where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                  and (pg_catalog.has_function_privilege(r.oid, 'private.account_lifecycle_cleanup_authorized(uuid)', 'EXECUTE')
                       or pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER'))) then
    raise exception 'THREADS_CLEANUP_PRECONDITION_LIFECYCLE';
  end if;
  if pg_catalog.to_regprocedure('public.social_mobile_account_deletion_workspace(uuid)') is null
     or pg_catalog.to_regprocedure('public.social_mobile_account_deletion_workspace_lock(text)') is null
     or pg_catalog.to_regclass('vault.secrets') is null
     or (select count(*) from pg_catalog.pg_attribute a
         where a.attrelid = pg_catalog.to_regclass('public.social_account_oauth_states')
           and a.attname in ('social_account_id', 'code_verifier_vault_secret_id') and not a.attisdropped) <> 2 then
    raise exception 'THREADS_CLEANUP_PRECONDITION_DELETION';
  end if;
  select c.relowner into v_owner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass;
  if v_owner is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
     or (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'THREADS_CLEANUP_PRECONDITION_OWNER';
  end if;
end $$;

-- Whether a deletion of this person is in its cleanup step NOW with its owner's lease live (wall clock), for
-- BOTH kinds: G5's own predicate (Phase 6), never this candidate's reading of G5's table.
create function public.threads_cleanup_authorized(p_user_id uuid) returns boolean
language sql volatile security definer set search_path = '' as $$
  select private.account_lifecycle_cleanup_authorized(p_user_id)
$$;

create function public.threads_provider_connection_state(p_user_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when p_user_id is null then 'invalid'
    when exists (select 1 from public.social_accounts a
                 where a.brand_id = public.social_mobile_account_deletion_workspace(p_user_id) and a.platform = 'threads')
      then 'connected'
    else 'not_connected' end
$$;

create function public.cleanup_threads_provider_footprint(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_workspace text;
  v_account public.social_accounts%rowtype;
  v_secret uuid;
  v_verifiers uuid[];
  v_result jsonb;
begin
  if p_user_id is null or not public.threads_cleanup_authorized(p_user_id) then
    return pg_catalog.jsonb_build_object('outcome', 'blocked', 'code', 'DELETION_NOT_IN_PROGRESS');
  end if;
  v_workspace := public.social_mobile_account_deletion_workspace(p_user_id);
  -- Serializes with a connection being completed (PR #124) and with workspace creation / deletion.
  perform public.social_mobile_account_deletion_workspace_lock(v_workspace);
  select a.* into v_account from public.social_accounts a
   where a.brand_id = v_workspace and a.platform = 'threads' for update;
  -- The locks may have taken up to lock_timeout: the lease is asked again before anything is deleted.
  if not public.threads_cleanup_authorized(p_user_id) then
    return pg_catalog.jsonb_build_object('outcome', 'blocked', 'code', 'LEASE_NOT_HELD');
  end if;
  if v_account.id is null then
    -- Nothing local remains (a previous run, or never stored): the remote grant is still not verified.
    return pg_catalog.jsonb_build_object('outcome', 'local_removed_remote_unverified', 'code', 'ALREADY_REMOVED');
  end if;
  -- A post that may exist is never turned into "not posted" by deleting its record.
  if exists (select 1 from public.threads_manual_publish_attempts t
             where t.social_account_id = v_account.id
               and t.status in ('creating_container', 'publishing', 'publish_returned', 'uncertain')) then
    return pg_catalog.jsonb_build_object('outcome', 'reconciliation_required', 'code', 'PUBLISH_IN_FLIGHT');
  end if;
  v_secret := v_account.vault_access_token_secret_id;
  if v_secret is not null and exists (
       select 1 from public.social_accounts o
       where o.id <> v_account.id and (o.vault_access_token_secret_id = v_secret or o.vault_refresh_token_secret_id = v_secret)) then
    return pg_catalog.jsonb_build_object('outcome', 'reconciliation_required', 'code', 'SECRET_SHARED');
  end if;
  begin
    -- F4: the connection's own OAuth states reference the row without a cascade (found on the real G5 world:
    -- a PR #124-connected account could not be removed); a verifier secret goes with its state.
    select coalesce(pg_catalog.array_agg(s.code_verifier_vault_secret_id), '{}') into v_verifiers
      from public.social_account_oauth_states s
     where s.social_account_id = v_account.id and s.code_verifier_vault_secret_id is not null;
    delete from public.social_account_oauth_states s where s.social_account_id = v_account.id;
    if v_secret is not null then
      delete from vault.secrets s where s.id = v_secret;
    end if;
    -- Cascades: manual publish permission, attempts (and their nonces), credential custody.
    delete from public.social_accounts a where a.id = v_account.id;
    delete from vault.secrets s where s.id = any (v_verifiers)
       and not exists (select 1 from public.social_account_oauth_states o where o.code_verifier_vault_secret_id = s.id)
       and not exists (select 1 from public.social_accounts o where o.vault_access_token_secret_id = s.id or o.vault_refresh_token_secret_id = s.id);
    if exists (select 1 from public.social_accounts a where a.id = v_account.id)
       or exists (select 1 from public.social_account_oauth_states s where s.social_account_id = v_account.id)
       or exists (select 1 from public.threads_manual_publish_attempts t where t.social_account_id = v_account.id)
       or exists (select 1 from public.social_account_manual_publish_permissions p where p.social_account_id = v_account.id)
       or exists (select 1 from public.threads_account_credential_custody c where c.social_account_id = v_account.id)
       or (v_secret is not null and exists (select 1 from vault.secrets s where s.id = v_secret)) then
      raise exception 'THREADS_CLEANUP_READBACK_FAILED';
    end if;
    v_result := pg_catalog.jsonb_build_object('outcome', 'local_removed_remote_unverified', 'code', 'LOCAL_REMOVED');
  exception
    when lock_not_available or deadlock_detected then
      v_result := pg_catalog.jsonb_build_object('outcome', 'blocked', 'code', 'BUSY');
    when others then
      -- Everything in this block was rolled back: nothing was removed, but something is wrong; a person checks.
      v_result := pg_catalog.jsonb_build_object('outcome', 'reconciliation_required', 'code', 'CLEANUP_FAILED');
  end;
  return v_result;
exception
  when lock_not_available or deadlock_detected then
    return pg_catalog.jsonb_build_object('outcome', 'blocked', 'code', 'BUSY');
end;
$$;

revoke all on function public.threads_cleanup_authorized(uuid),
                       public.threads_provider_connection_state(uuid),
                       public.cleanup_threads_provider_footprint(uuid)
  from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from (values ('anon'::name), ('authenticated'::name), ('service_role'::name)) a(app),
                           (values ('public.threads_cleanup_authorized(uuid)'), ('public.threads_provider_connection_state(uuid)'),
                                   ('public.cleanup_threads_provider_footprint(uuid)')) f(fn)
             where pg_catalog.has_function_privilege(a.app, f.fn::regprocedure, 'EXECUTE')) then
    raise exception 'THREADS_CLEANUP_POSTCONDITION_ACL';
  end if;
end $$;

commit;
