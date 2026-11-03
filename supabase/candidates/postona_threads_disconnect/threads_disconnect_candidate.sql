-- SOURCE CANDIDATE ONLY. NOT a migration, NOT applied anywhere (F4,
-- postona-f4-threads-disconnect-lease-safe-v1-20261012; lifecycle removal policy on G5 Phase 4 by F4,
-- postona-f4-threads-t13-authenticated-writer-integration-20261013). Apply only after G5 Phase 4
-- (20261012130000) and the G4 publish stack (custody ->
-- manual publish -> release), as a single reviewed file, after an independent security review. It ships
-- with its release gate CLOSED (threads_disconnect_gate_open() = false): even applied, nothing can be
-- disconnected until a separately reviewed change opens it.
--
-- POSTONA Threads: the person removes ONLY their Threads connection from POSTONA. Their X connection,
-- their POSTONA registration, their common account and Kabumori stay as they are. This is NOT an account
-- or service deletion (that is G5's lifecycle, whose Threads part is threads_provider_cleanup_candidate.sql).
--
--   public.disconnect_threads_account(social_account_id, expected_handle) -> jsonb
--     run with the CALLER'S JWT (role authenticated; auth.uid() and the session from the same verified
--     claims), ONE transaction:
--       release gate -> G5's lifecycle decision for the caller (Phase 4 private.account_lifecycle_service_
--       state_refusal: the I1 locks first, held to COMMIT) under a REMOVAL policy (F4 T13 task): allowed while
--       POSTONA is active, suspended, ended or not registered -- removing a credential grants nothing and an
--       ended service must not strand one -- and refused while the account or POSTONA is being deleted (G5's
--       cleanup owns the removal under its lease), while the account is locked or unknown, or busy -> the
--       caller's Auth session still signed in (auth.sessions FOR SHARE) -> the caller's OWN self-service
--       POSTONA workspace (workspace lock) -> owner/admin
--       membership -> its Threads account FOR UPDATE, the one the person confirmed (id + handle) ->
--       1. publishing stops: the manual publish permission is withdrawn (kept withdrawn in every answer
--          below except a refusal, which changes nothing);
--       2. a post that may be in flight (creating_container / publishing / publish_returned / uncertain)
--          keeps the credential so it can still be reconciled: answer `stopped` / PUBLISH_IN_FLIGHT;
--       3. a secret shared with another row is never deleted: `stopped` / SECRET_SHARED;
--       4. otherwise the Vault access secret and the Threads row are deleted (cascading: attempts and their
--          nonces, credential custody) and read back: `disconnected` / LOCAL_REMOVED.
--     Every answer carries the local result and the remote result SEPARATELY. POSTONA never revokes the
--     grant at Threads: the Threads API documents no app-side revoke endpoint (only Meta's deauthorize and
--     data-deletion callbacks, which Meta calls when the person removes the app in Threads), so
--     remote_access is always `not_revoked_by_app` and the app tells the person where to remove it.
--
-- Not the account-deletion cleanup with looser rights: this function takes no user id (auth.uid() only),
-- touches only the caller's own deterministic workspace and refuses while any deletion of the person is in
-- progress (that cleanup, under G5's lease, owns the removal then). The cleanup functions stay owner-only.
-- No Threads reservations exist to stop: scheduled_posts is X-only (generated target_platform 'x' in its
-- account FK) and G3's reservation candidate accepts X accounts only.
--
-- Access: EXECUTE for `authenticated` only (no anon, no service_role). Body: SECURITY DEFINER, owner.
begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare v_owner oid;
begin
  if pg_catalog.to_regprocedure('public.disconnect_threads_account(text,text)') is not null then
    raise exception 'THREADS_DISCONNECT_PRECONDITION_ALREADY_APPLIED';
  end if;
  if pg_catalog.to_regclass('public.threads_manual_publish_attempts') is null
     or pg_catalog.to_regclass('public.social_account_manual_publish_permissions') is null
     or pg_catalog.to_regclass('public.threads_account_credential_custody') is null
     or pg_catalog.to_regclass('public.threads_manual_publish_nonces') is null
     or pg_catalog.to_regprocedure('public.threads_manual_publish_session_id()') is null
     or pg_catalog.to_regprocedure('public.threads_manual_publish_refused(text)') is null then
    raise exception 'THREADS_DISCONNECT_PRECONDITION_PUBLISH_STACK';
  end if;
  select c.relowner into v_owner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass;
  -- G5 Phase 4: the one lifecycle decision, owned by the table owner and reachable by no API role.
  if pg_catalog.to_regprocedure('private.account_lifecycle_service_state_refusal(uuid,text)') is null
     or (select p.proowner from pg_catalog.pg_proc p
         where p.oid = pg_catalog.to_regprocedure('private.account_lifecycle_service_state_refusal(uuid,text)')) is distinct from v_owner
     or (select p.prorettype from pg_catalog.pg_proc p
         where p.oid = pg_catalog.to_regprocedure('private.account_lifecycle_service_state_refusal(uuid,text)')) is distinct from 'text'::regtype
     or exists (select 1 from pg_catalog.pg_roles r
                where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                  and (pg_catalog.has_function_privilege(r.oid, 'private.account_lifecycle_service_state_refusal(uuid,text)', 'EXECUTE')
                       or pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER'))) then
    raise exception 'THREADS_DISCONNECT_PRECONDITION_LIFECYCLE';
  end if;
  if (select count(*) from pg_catalog.pg_attribute a
      where a.attrelid = pg_catalog.to_regclass('auth.sessions') and a.attname in ('id', 'user_id', 'not_after') and not a.attisdropped) <> 3
     or pg_catalog.to_regprocedure('auth.uid()') is null then
    raise exception 'THREADS_DISCONNECT_PRECONDITION_AUTH';
  end if;
  if pg_catalog.to_regprocedure('public.social_mobile_account_deletion_workspace(uuid)') is null
     or pg_catalog.to_regprocedure('public.social_mobile_account_deletion_workspace_lock(text)') is null
     or pg_catalog.to_regclass('vault.secrets') is null
     or (select count(*) from pg_catalog.pg_attribute a
         where a.attrelid = pg_catalog.to_regclass('public.social_account_oauth_states')
           and a.attname in ('social_account_id', 'code_verifier_vault_secret_id') and not a.attisdropped) <> 2 then
    raise exception 'THREADS_DISCONNECT_PRECONDITION_DELETION';
  end if;
  select c.relowner into v_owner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass;
  if v_owner is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
     or (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'THREADS_DISCONNECT_PRECONDITION_OWNER';
  end if;
end $$;

-- The release gate. CLOSED. Opening it is a separately reviewed replacement of this function (owner only).
create function public.threads_disconnect_gate_open() returns boolean
language sql immutable set search_path = '' as $$ select false $$;

-- Every non-refusal answer, with the local and the remote result kept apart.
create function public.threads_disconnect_answer(p_status text, p_code text, p_withdrawn boolean, p_local text)
returns jsonb language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'status', p_status, 'code', p_code,
    'publish_permission', case when p_withdrawn then 'withdrawn' else 'already_off' end,
    'local_credentials', p_local,
    'remote_access', 'not_revoked_by_app')
$$;

create function public.disconnect_threads_account(p_social_account_id text, p_expected_handle text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_user uuid := auth.uid();
  v_session uuid := public.threads_manual_publish_session_id();
  v_code text;
  v_workspace text;
  v_role text;
  v_account public.social_accounts%rowtype;
  v_withdrawn boolean;
  v_secret uuid;
  v_verifiers uuid[];
begin
  if not public.threads_disconnect_gate_open() then return public.threads_manual_publish_refused('DISCONNECT_DISABLED'); end if;
  if v_user is null or v_session is null then return public.threads_manual_publish_refused('AUTH_REQUIRED'); end if;
  if p_social_account_id is null or p_social_account_id !~ '^[a-z][a-z0-9_]{1,80}$'
     or p_expected_handle is null or pg_catalog.char_length(p_expected_handle) not between 1 and 64
     or p_expected_handle ~ '[[:cntrl:][:space:]]' then
    return public.threads_manual_publish_refused('REQUEST_INVALID');
  end if;
  -- G5 lifecycle first (Phase 4 decision, I1 locks held to COMMIT), under the REMOVAL policy: a suspended,
  -- ended or never-registered POSTONA may still remove its Threads credential; a deletion of this person
  -- (whole account, or POSTONA) owns the removal under its lease and is never raced; a locked or unknown
  -- account changes nothing.
  v_code := private.account_lifecycle_service_state_refusal(v_user, 'x_autopost');
  if v_code = 'ACCOUNT_LIFECYCLE_BUSY' then return public.threads_manual_publish_refused('BUSY'); end if;
  if v_code is not null and v_code not in ('SERVICE_NOT_ACTIVE', 'SERVICE_NOT_REGISTERED') then
    return public.threads_manual_publish_refused('ACCOUNT_LIFECYCLE_BLOCKED');
  end if;
  -- The person is still signed in on this session. FOR SHARE: a sign-out or expiry UPDATE waits for us.
  perform 1 from auth.sessions s
   where s.id = v_session and s.user_id = v_user and (s.not_after is null or s.not_after > pg_catalog.clock_timestamp())
   for share;
  if not found then return public.threads_manual_publish_refused('AUTH_REQUIRED'); end if;
  -- Only the caller's own self-service workspace, whoever else is a member anywhere. Serializes with
  -- connection (PR #124), workspace deletion and the provider cleanup.
  v_workspace := public.social_mobile_account_deletion_workspace(v_user);
  perform public.social_mobile_account_deletion_workspace_lock(v_workspace);
  perform 1 from public.brands b where b.id = v_workspace and b.code_profile_key = 'social_mobile_user_v1' for share;
  if not found then return public.threads_manual_publish_refused('ACCOUNT_NOT_FOUND'); end if;
  select m.role into v_role from public.brand_memberships m where m.brand_id = v_workspace and m.user_id = v_user for share;
  if v_role is null then return public.threads_manual_publish_refused('ACCOUNT_NOT_FOUND'); end if;
  if v_role not in ('owner', 'admin') then return public.threads_manual_publish_refused('DISCONNECT_FORBIDDEN'); end if;
  -- FOR UPDATE: waits for a publish release that holds the account FOR SHARE, then sees its committed step.
  select a.* into v_account from public.social_accounts a
   where a.brand_id = v_workspace and a.platform = 'threads' for update;
  if v_account.id is null then
    -- Nothing is connected (a previous disconnect, or never): the same answer every time.
    return public.threads_disconnect_answer('not_connected', 'ALREADY_REMOVED', false, 'none');
  end if;
  if v_account.id is distinct from p_social_account_id then return public.threads_manual_publish_refused('ACCOUNT_NOT_FOUND'); end if;
  -- The account the person confirmed on screen: a reconnection in between makes the tap stale.
  if pg_catalog.ltrim(v_account.handle, '@') is distinct from pg_catalog.ltrim(p_expected_handle, '@') then
    return public.threads_manual_publish_refused('ACCOUNT_CHANGED');
  end if;
  -- 1. Publishing stops first, whatever happens to the credential below.
  delete from public.social_account_manual_publish_permissions p where p.social_account_id = v_account.id;
  v_withdrawn := found;
  -- 2. A post that may exist is never turned into "not posted": the credential stays for reconciliation.
  if exists (select 1 from public.threads_manual_publish_attempts t
             where t.social_account_id = v_account.id
               and t.status in ('creating_container', 'publishing', 'publish_returned', 'uncertain')) then
    return public.threads_disconnect_answer('stopped', 'PUBLISH_IN_FLIGHT', v_withdrawn, 'kept');
  end if;
  v_secret := v_account.vault_access_token_secret_id;
  -- 3. Never another row's secret.
  if v_secret is not null and exists (
       select 1 from public.social_accounts o
       where o.id <> v_account.id and (o.vault_access_token_secret_id = v_secret or o.vault_refresh_token_secret_id = v_secret)) then
    return public.threads_disconnect_answer('stopped', 'SECRET_SHARED', v_withdrawn, 'kept');
  end if;
  -- 4. The removal, read back. On any failure only this block rolls back; publishing stays stopped.
  begin
    -- The connection's own OAuth states (PR #124 keeps them, consumed or pending): they reference the row
    -- without a cascade, as the POSTONA deletion removes them first. A verifier secret goes with its state.
    select coalesce(pg_catalog.array_agg(s.code_verifier_vault_secret_id), '{}') into v_verifiers
      from public.social_account_oauth_states s
     where s.social_account_id = v_account.id and s.code_verifier_vault_secret_id is not null;
    delete from public.social_account_oauth_states s where s.social_account_id = v_account.id;
    if v_secret is not null then
      delete from vault.secrets s where s.id = v_secret;
    end if;
    -- Cascades: attempts (and their nonces), credential custody.
    delete from public.social_accounts a where a.id = v_account.id;
    delete from vault.secrets s where s.id = any (v_verifiers)
       and not exists (select 1 from public.social_account_oauth_states o where o.code_verifier_vault_secret_id = s.id)
       and not exists (select 1 from public.social_accounts o where o.vault_access_token_secret_id = s.id or o.vault_refresh_token_secret_id = s.id);
    if exists (select 1 from public.social_accounts a where a.id = v_account.id)
       or exists (select 1 from public.social_account_oauth_states s where s.social_account_id = v_account.id)
       or exists (select 1 from public.social_accounts a where a.brand_id = v_workspace and a.platform = 'threads')
       or exists (select 1 from public.threads_manual_publish_attempts t where t.social_account_id = v_account.id)
       or exists (select 1 from public.social_account_manual_publish_permissions p where p.social_account_id = v_account.id)
       or exists (select 1 from public.threads_account_credential_custody c where c.social_account_id = v_account.id)
       or (v_secret is not null and exists (select 1 from vault.secrets s where s.id = v_secret)) then
      raise exception 'THREADS_DISCONNECT_READBACK_FAILED';
    end if;
  exception
    when lock_not_available or deadlock_detected then
      raise;
    when others then
      return public.threads_disconnect_answer('stopped', 'DISCONNECT_FAILED', v_withdrawn, 'kept');
  end;
  return public.threads_disconnect_answer('disconnected', 'LOCAL_REMOVED', v_withdrawn, 'removed');
exception
  when lock_not_available or deadlock_detected then
    -- Everything above was rolled back: nothing changed.
    return public.threads_manual_publish_refused('BUSY');
  when raise_exception then
    -- A reviewed guard (for example the workspace deletion guard): nothing changed.
    return public.threads_manual_publish_refused('ACCOUNT_LIFECYCLE_BLOCKED');
end;
$$;

revoke all on function public.threads_disconnect_gate_open(),
                       public.threads_disconnect_answer(text, text, boolean, text),
                       public.disconnect_threads_account(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.disconnect_threads_account(text, text) to authenticated;

do $$
begin
  if pg_catalog.has_function_privilege('anon', 'public.disconnect_threads_account(text,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', 'public.disconnect_threads_account(text,text)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.disconnect_threads_account(text,text)', 'EXECUTE')
     or exists (select 1 from (values ('anon'::name), ('authenticated'::name), ('service_role'::name)) a(app),
                              (values ('public.threads_disconnect_gate_open()'), ('public.threads_disconnect_answer(text,text,boolean,text)')) f(fn)
                where pg_catalog.has_function_privilege(a.app, f.fn::regprocedure, 'EXECUTE'))
     or public.threads_disconnect_gate_open() then
    raise exception 'THREADS_DISCONNECT_POSTCONDITION_ACL';
  end if;
end $$;

commit;
