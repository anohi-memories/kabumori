-- NOT A MIGRATION. SOURCE CANDIDATE ONLY (G4, POSTONA Phase 2b). Kept outside supabase/migrations on
-- purpose: no Supabase tool applies it, and it cannot be applied anywhere until G5's service-write guard
-- (T13) really exists there, because its first precondition requires that guard.
--
-- What it defines (owner-only; NO grant to anon / authenticated / service_role in this file, so nothing
-- here is reachable; a later reviewed activation migration grants authenticated EXECUTE on the three
-- public RPCs once every prerequisite of docs/postona/threads-connection-phase2b.md §0.7 holds):
--   private.social_mobile_ensure_personal_workspace(uuid)            T9: the one POSTONA workspace provisioner
--   public.begin_social_mobile_threads_oauth_connection(text,text,timestamptz)
--   public.consume_social_mobile_threads_oauth_state(text)             read-only lookup before the code exchange
--   public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text)
--
-- Contract (docs/postona/threads-g5-t9-t10-t13-shared-contract-20261010.md):
--   * T13 first. Every function calls private.account_lifecycle_assert_active_service_write(auth.uid(),
--     'x_autopost') before it locks or writes anything of its own, in the caller's READ COMMITTED
--     transaction; the guard's locks (login KEY SHARE -> common account FOR UPDATE -> entitlement FOR
--     UPDATE) are held to COMMIT. Only then: workspace (advisory lock, brand, membership) -> OAuth state ->
--     social account -> Vault. The guard is G5's; it is called here, never re-implemented. It requires its
--     callers to be SECURITY DEFINER functions owned by its owner: these are.
--   * T9. The workspace is the person's deterministic self-service workspace
--     (public.social_mobile_account_deletion_workspace(uid), the id the X flow and account deletion use):
--     created with one owner membership if missing, otherwise verified (self-service code profile, the
--     person is its only member and its owner). A person who owns any other workspace is refused, never
--     moved. No entitlement, common account or service row is created or changed.
--   * Threads binding. The state row is bound to the person, the workspace and the workspace's Threads
--     row; it lives at most 10 minutes and is consumed once, in the same statement that checks all of
--     that. A state of another provider, person or workspace, or an expired or used one, is refused.
--   * Verified provider identity. complete() accepts the provider user id, handle and long-lived access
--     token only with a server attestation: HMAC-SHA256 over them and the state id, keyed by a secret
--     held only by the Edge exchange and by Vault (name postona_threads_connect_attestation_v1). A
--     caller who did not perform the code exchange cannot bind someone else's Threads id to a workspace.
--   * Reconnect: a row that already has a provider identity accepts only that identity.
--   * Credentials: the token goes to Vault (created, or updated in place under the row's own reference);
--     the row stores the reference only, refresh reference NULL, publish_enabled false. A provider
--     identity already connected elsewhere, a shared or dangling reference, or a leftover secret of the
--     row's name is refused as a whole (no secret, no state consumption).
--   * Errors: fixed codes only (SQLSTATE P0001 here; 42501 from the guard). Never a token, secret, code
--     or provider body.
--
-- Not covered here (each its own reviewed task): granting EXECUTE (activation), the Edge Function that
-- calls these, delegating the X begin's workspace creation to the provisioner, provider-aware cleanup
-- (T10), token refresh and expiry (T8), Threads publishing.
begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_owner oid := (select c.relowner from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('public.social_accounts'));
  v_guard regprocedure;
begin
  -- First (it reads nothing outside public): one non-superuser owner of every table written here, and
  -- it is the creator.
  if v_owner is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
     or (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or exists (select 1 from pg_catalog.pg_class c
                where c.oid in ('public.brands'::pg_catalog.regclass, 'public.brand_memberships'::pg_catalog.regclass,
                                'public.social_account_oauth_states'::pg_catalog.regclass)
                  and c.relowner is distinct from v_owner) then
    raise exception 'POSTONA_THREADS_OAUTH_PRECONDITION_OWNER';
  end if;

  if pg_catalog.to_regprocedure('private.social_mobile_ensure_personal_workspace(uuid)') is not null
     or pg_catalog.to_regprocedure('public.begin_social_mobile_threads_oauth_connection(text,text,timestamptz)') is not null
     or pg_catalog.to_regprocedure('public.consume_social_mobile_threads_oauth_state(text)') is not null
     or pg_catalog.to_regprocedure('public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text)') is not null then
    raise exception 'POSTONA_THREADS_OAUTH_PRECONDITION_ALREADY_APPLIED';
  end if;

  -- G5's service-write guard (T13) must exist, return void, share the owner of the tables (its callers
  -- must be owned by its owner) and be executable by no API role, directly or through any membership.
  v_guard := pg_catalog.to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)');
  if v_guard is null then
    raise exception 'POSTONA_THREADS_OAUTH_PRECONDITION_T13_MISSING';
  end if;
  if (select p.prorettype from pg_catalog.pg_proc p where p.oid = v_guard) is distinct from 'pg_catalog.void'::pg_catalog.regtype
     or (select p.proowner from pg_catalog.pg_proc p where p.oid = v_guard) is distinct from v_owner
     or exists (select 1 from pg_catalog.pg_roles r
                where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                  and pg_catalog.has_function_privilege(r.oid, v_guard, 'EXECUTE')) then
    raise exception 'POSTONA_THREADS_OAUTH_PRECONDITION_T13_CONTRACT';
  end if;

  -- Phase 2a-2 (the multi-provider social_accounts schema and its provider guard) applied.
  if not exists (select 1 from pg_catalog.pg_constraint c
                 where c.conrelid = 'public.social_accounts'::pg_catalog.regclass and c.conname = 'social_accounts_platform_supported')
     or not exists (select 1 from pg_catalog.pg_constraint c
                    where c.conrelid = 'public.social_accounts'::pg_catalog.regclass and c.conname = 'social_accounts_meta_connected_access')
     or not exists (select 1 from pg_catalog.pg_trigger t
                    where t.tgrelid = 'public.social_accounts'::pg_catalog.regclass and t.tgname = 'social_accounts_provider_guard') then
    raise exception 'POSTONA_THREADS_OAUTH_PRECONDITION_PHASE_2A2';
  end if;

  -- The columns, keys and helpers relied on.
  if (select count(*) from pg_catalog.pg_attribute a
      where a.attrelid = 'public.social_account_oauth_states'::pg_catalog.regclass and a.attnum > 0 and not a.attisdropped
        and (a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod)) in (
          ('id', 'uuid'), ('social_account_id', 'text'), ('brand_id', 'text'), ('state_hash', 'text'),
          ('code_verifier_vault_secret_id', 'uuid'), ('redirect_uri', 'text'), ('expires_at', 'timestamp with time zone'),
          ('consumed_at', 'timestamp with time zone'), ('initiated_by_user_id', 'uuid'))) <> 9
     or not exists (select 1 from pg_catalog.pg_constraint c
                    where c.conrelid = 'public.social_account_oauth_states'::pg_catalog.regclass and c.contype = 'u'
                      and pg_catalog.pg_get_constraintdef(c.oid) = 'UNIQUE (state_hash)')
     or not exists (select 1 from pg_catalog.pg_constraint c
                    where c.conrelid = 'public.brand_memberships'::pg_catalog.regclass and c.contype = 'p'
                      and pg_catalog.pg_get_constraintdef(c.oid) = 'PRIMARY KEY (brand_id, user_id)')
     or (select count(*) from pg_catalog.pg_attribute a
         where a.attrelid = 'public.brands'::pg_catalog.regclass and a.attnum > 0 and not a.attisdropped
           and a.attname in ('id', 'display_name', 'is_active', 'publish_mode', 'code_profile_key')) <> 5
     or pg_catalog.to_regclass('public.social_mobile_account_deletions') is null
     or pg_catalog.to_regprocedure('public.social_mobile_account_deletion_workspace(uuid)') is null
     or pg_catalog.to_regprocedure('public.social_mobile_account_deletion_workspace_lock(text)') is null
     or pg_catalog.to_regprocedure('vault.create_secret(text,text,text,uuid)') is null
     or pg_catalog.to_regprocedure('vault.update_secret(uuid,text,text,text,uuid)') is null
     or pg_catalog.to_regprocedure('extensions.hmac(bytea,bytea,text)') is null
     or (select count(*) from pg_catalog.pg_attribute a
         where a.attrelid = pg_catalog.to_regclass('vault.secrets') and a.attname = 'id'
           and a.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype) <> 1
     or (select count(*) from pg_catalog.pg_attribute a
         where a.attrelid = pg_catalog.to_regclass('vault.decrypted_secrets') and a.attname in ('name', 'decrypted_secret')) <> 2 then
    raise exception 'POSTONA_THREADS_OAUTH_PRECONDITION_SHAPE';
  end if;
end $$;

-- T9: the one POSTONA workspace provisioner. Internal (owner-only EXECUTE); SECURITY INVOKER, so it runs
-- with the rights of the owner-owned SECURITY DEFINER writer that calls it. Calls the guard itself first,
-- so no caller can provision before T13 (a second call in the same transaction re-takes held locks).
create function private.social_mobile_ensure_personal_workspace(p_user_id uuid)
returns text language plpgsql volatile security invoker set search_path = ''
as $$
declare
  v_workspace text;
  v_profile text;
begin
  if p_user_id is null then
    raise exception 'SOCIAL_MOBILE_WORKSPACE_USER_REQUIRED' using errcode = 'P0001';
  end if;
  perform private.account_lifecycle_assert_active_service_write(p_user_id, 'x_autopost');

  v_workspace := public.social_mobile_account_deletion_workspace(p_user_id);
  -- The workspace lock creation and account deletion share; then a fresh look at the tombstone.
  perform public.social_mobile_account_deletion_workspace_lock(v_workspace);
  if exists (select 1 from public.social_mobile_account_deletions d where d.workspace_id = v_workspace or d.user_id = p_user_id) then
    raise exception 'SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS' using errcode = 'P0001';
  end if;
  -- Never take over or move another workspace (legacy, admin or shared ownership is someone else's case).
  if exists (select 1 from public.brand_memberships m
             where m.user_id = p_user_id and m.role = 'owner' and m.brand_id <> v_workspace) then
    raise exception 'SOCIAL_MOBILE_WORKSPACE_CONFLICT' using errcode = 'P0001';
  end if;

  insert into public.brands (id, display_name, is_active, publish_mode, code_profile_key)
  values (v_workspace, 'My Workspace', false, 'disabled', 'social_mobile_user_v1')
  on conflict (id) do nothing;
  select b.code_profile_key into v_profile from public.brands b where b.id = v_workspace for update;
  if v_profile is distinct from 'social_mobile_user_v1' then
    raise exception 'SOCIAL_MOBILE_WORKSPACE_NOT_SELF_SERVICE' using errcode = 'P0001';
  end if;
  insert into public.brand_memberships (brand_id, user_id, role)
  values (v_workspace, p_user_id, 'owner')
  on conflict (brand_id, user_id) do nothing;
  perform 1 from public.brand_memberships m where m.brand_id = v_workspace for update;
  if exists (select 1 from public.brand_memberships m where m.brand_id = v_workspace and m.user_id <> p_user_id) then
    raise exception 'SOCIAL_MOBILE_WORKSPACE_SHARED' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.brand_memberships m
                 where m.brand_id = v_workspace and m.user_id = p_user_id and m.role = 'owner') then
    raise exception 'SOCIAL_MOBILE_WORKSPACE_ROLE_MISMATCH' using errcode = 'P0001';
  end if;
  return v_workspace;
end;
$$;

create function public.begin_social_mobile_threads_oauth_connection(p_state_hash text, p_redirect_uri text, p_expires_at timestamptz)
returns table (brand_id text, social_account_id text)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_workspace text;
  v_account text;
  v_existing text;
begin
  -- Shape only; nothing is locked or written before the guard.
  if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$'
     or p_redirect_uri is null or p_redirect_uri !~ '^https://[^#*@[:space:]]+$' or length(p_redirect_uri) > 2048
     or p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '10 minutes' then
    raise exception 'THREADS_OAUTH_STATE_INPUT_INVALID' using errcode = 'P0001';
  end if;
  perform private.account_lifecycle_assert_active_service_write(v_user, 'x_autopost');

  v_workspace := private.social_mobile_ensure_personal_workspace(v_user);
  v_account := 'sa_' || pg_catalog.substr(pg_catalog.md5(v_workspace || ':threads'), 1, 24);
  select sa.id into v_existing from public.social_accounts sa
   where sa.brand_id = v_workspace and sa.platform = 'threads' for update;
  if not found then
    insert into public.social_accounts (id, brand_id, platform, handle, publish_enabled, oauth_client_ref, connection_status)
    values (v_account, v_workspace, 'threads', 'pending', false, 'default', 'authorization_pending');
  elsif v_existing is distinct from v_account then
    raise exception 'THREADS_ACCOUNT_CONFLICT' using errcode = 'P0001';
  else
    -- A new attempt never demotes a verified identity before its callback succeeds or fails.
    update public.social_accounts sa
       set connection_status = case when sa.connection_status = 'identity_verified' then 'identity_verified' else 'authorization_pending' end,
           last_connection_error_code = null, updated_at = now()
     where sa.id = v_account;
  end if;

  begin
    insert into public.social_account_oauth_states
      (social_account_id, brand_id, state_hash, code_verifier_vault_secret_id, redirect_uri, expires_at, initiated_by_user_id)
    values (v_account, v_workspace, p_state_hash, null, p_redirect_uri, p_expires_at, v_user);
  exception when unique_violation then
    raise exception 'THREADS_OAUTH_STATE_INPUT_INVALID' using errcode = 'P0001';
  end;
  return query select v_workspace, v_account;
end;
$$;

-- Read-only: the state, before the single-use code is spent. Guarded too, so an ended service or a
-- deletion in progress never reaches the code exchange.
create function public.consume_social_mobile_threads_oauth_state(p_state_hash text)
returns table (oauth_state_id uuid, redirect_uri text, brand_id text, social_account_id text)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'THREADS_OAUTH_STATE_NOT_CONSUMABLE' using errcode = 'P0001';
  end if;
  perform private.account_lifecycle_assert_active_service_write(v_user, 'x_autopost');
  return query
    select s.id, s.redirect_uri, s.brand_id, s.social_account_id
    from public.social_account_oauth_states s
    join public.social_accounts sa on sa.id = s.social_account_id
    join public.brand_memberships m on m.brand_id = s.brand_id and m.user_id = v_user and m.role = 'owner'
    where s.state_hash = p_state_hash and s.initiated_by_user_id = v_user
      and s.consumed_at is null and s.expires_at > now()
      and sa.platform = 'threads' and sa.brand_id = s.brand_id
      and s.brand_id = public.social_mobile_account_deletion_workspace(v_user);
  if not found then
    raise exception 'THREADS_OAUTH_STATE_NOT_CONSUMABLE' using errcode = 'P0001';
  end if;
end;
$$;

create function public.complete_social_mobile_threads_oauth_connection(
  p_oauth_state_id uuid, p_platform_user_id text, p_handle text, p_access_token text, p_attestation text
) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_workspace text;
  v_keys integer;
  v_key text;
  v_state_id uuid;
  v_account public.social_accounts;
  v_secret uuid;
begin
  if p_oauth_state_id is null or p_platform_user_id is null or p_platform_user_id !~ '^[1-9][0-9]{0,31}$'
     or (p_handle is not null and p_handle !~ '^[A-Za-z0-9._]{1,30}$')
     -- (PostgreSQL regular expressions bound repetitions at 255: the length is checked apart.)
     or p_access_token is null or p_access_token !~ '^[A-Za-z0-9._|-]+$' or length(p_access_token) not between 16 and 4096
     or p_attestation is null or p_attestation !~ '^[0-9a-f]{64}$' then
    raise exception 'THREADS_CONNECT_INPUT_INVALID' using errcode = 'P0001';
  end if;
  perform private.account_lifecycle_assert_active_service_write(v_user, 'x_autopost');

  -- Only the code exchange can vouch for this identity and token.
  select count(*), min(d.decrypted_secret) into v_keys, v_key
    from vault.decrypted_secrets d where d.name = 'postona_threads_connect_attestation_v1';
  if v_keys <> 1 or v_key is null or length(v_key) < 32 then
    raise exception 'THREADS_CONNECT_ATTESTATION_UNAVAILABLE' using errcode = 'P0001';
  end if;
  if pg_catalog.encode(extensions.hmac(
       pg_catalog.convert_to(pg_catalog.concat_ws(pg_catalog.chr(10), 'postona-threads-connect-v1', p_oauth_state_id::text,
                             p_platform_user_id, coalesce(p_handle, ''),
                             pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_access_token, 'UTF8')), 'hex')), 'UTF8'),
       pg_catalog.convert_to(v_key, 'UTF8'), 'sha256'), 'hex') is distinct from p_attestation then
    raise exception 'THREADS_CONNECT_ATTESTATION_INVALID' using errcode = 'P0001';
  end if;

  -- Workspace, then the state, then the account, then Vault.
  v_workspace := public.social_mobile_account_deletion_workspace(v_user);
  perform public.social_mobile_account_deletion_workspace_lock(v_workspace);
  perform 1 from public.brand_memberships m
   where m.brand_id = v_workspace and m.user_id = v_user and m.role = 'owner' for share;
  if not found then
    raise exception 'THREADS_ACCOUNT_NOT_OWNED' using errcode = 'P0001';
  end if;
  -- The one irreversible claim: this person's, this workspace's Threads state, unexpired, unused.
  update public.social_account_oauth_states s set consumed_at = now()
   where s.id = p_oauth_state_id and s.initiated_by_user_id = v_user and s.brand_id = v_workspace
     and s.consumed_at is null and s.expires_at > now()
     and exists (select 1 from public.social_accounts sa
                 where sa.id = s.social_account_id and sa.brand_id = v_workspace and sa.platform = 'threads')
  returning s.id into v_state_id;
  if v_state_id is null then
    raise exception 'THREADS_OAUTH_STATE_NOT_CONSUMABLE' using errcode = 'P0001';
  end if;
  select sa.* into v_account from public.social_accounts sa
   where sa.brand_id = v_workspace and sa.platform = 'threads' for update;
  if v_account.platform_user_id is not null and v_account.platform_user_id is distinct from p_platform_user_id then
    raise exception 'THREADS_IDENTITY_ACCOUNT_MISMATCH' using errcode = 'P0001';
  end if;
  if v_account.vault_refresh_token_secret_id is not null then
    raise exception 'THREADS_CREDENTIAL_SHAPE_INVALID' using errcode = 'P0001';
  end if;
  if v_account.vault_access_token_secret_id is null then
    begin
      v_secret := vault.create_secret(p_access_token, v_account.id || '_access_token', 'Threads long-lived access token.');
    exception when unique_violation then
      -- A secret of this name outlived its reference (an unfinished cleanup): reconcile it first.
      raise exception 'THREADS_CREDENTIAL_SHAPE_INVALID' using errcode = 'P0001';
    end;
  else
    -- Updated in place only while the reference is this row's alone and still names a secret (an update
    -- of a missing id would silently change nothing).
    if exists (select 1 from public.social_accounts o
               where o.id <> v_account.id
                 and (o.vault_access_token_secret_id = v_account.vault_access_token_secret_id
                      or o.vault_refresh_token_secret_id = v_account.vault_access_token_secret_id))
       or not exists (select 1 from vault.secrets s where s.id = v_account.vault_access_token_secret_id) then
      raise exception 'THREADS_CREDENTIAL_SHAPE_INVALID' using errcode = 'P0001';
    end if;
    perform vault.update_secret(v_account.vault_access_token_secret_id, p_access_token);
    v_secret := v_account.vault_access_token_secret_id;
  end if;
  begin
    update public.social_accounts sa
       set vault_access_token_secret_id = v_secret, platform_user_id = p_platform_user_id,
           handle = coalesce(p_handle, sa.handle), publish_enabled = false,
           connection_status = 'identity_verified', verified_at = now(),
           last_connection_error_code = null, updated_at = now()
     where sa.id = v_account.id;
  exception when unique_violation then
    -- The whole call fails: no secret, no consumed state, nothing written.
    raise exception 'THREADS_ACCOUNT_ALREADY_CONNECTED' using errcode = 'P0001';
  end;
end;
$$;

revoke all on function private.social_mobile_ensure_personal_workspace(uuid) from public, anon, authenticated, service_role;
revoke all on function public.begin_social_mobile_threads_oauth_connection(text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.consume_social_mobile_threads_oauth_state(text) from public, anon, authenticated, service_role;
revoke all on function public.complete_social_mobile_threads_oauth_connection(uuid, text, text, text, text)
  from public, anon, authenticated, service_role;

-- Postcondition: four functions, owned by the table owner, empty search_path, the three RPCs SECURITY
-- DEFINER and the provisioner SECURITY INVOKER, EXECUTE for the owner only, and no API role able to run
-- any of them, directly or through a membership.
do $$
declare
  v_owner oid := (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::pg_catalog.regclass);
  v_fn record;
  v_seen integer := 0;
begin
  for v_fn in
    select p.oid, p.prosecdef, p.proowner, p.proconfig, p.proacl,
           p.oid = 'private.social_mobile_ensure_personal_workspace(uuid)'::pg_catalog.regprocedure as provisioner
    from pg_catalog.pg_proc p
    where p.oid in ('private.social_mobile_ensure_personal_workspace(uuid)'::pg_catalog.regprocedure,
                    'public.begin_social_mobile_threads_oauth_connection(text,text,timestamptz)'::pg_catalog.regprocedure,
                    'public.consume_social_mobile_threads_oauth_state(text)'::pg_catalog.regprocedure,
                    'public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text)'::pg_catalog.regprocedure)
  loop
    if v_fn.proowner is distinct from v_owner or v_fn.prosecdef = v_fn.provisioner
       or v_fn.proconfig is distinct from array['search_path=""']
       or (select pg_catalog.array_agg(pg_catalog.concat_ws(' | ', (a.grantor = v_owner)::text, (a.grantee = v_owner)::text,
                                                             a.privilege_type, a.is_grantable::text))
           from pg_catalog.aclexplode(coalesce(v_fn.proacl, pg_catalog.acldefault('f', v_fn.proowner))) a)
          is distinct from array['true | true | EXECUTE | false']
       or exists (select 1 from pg_catalog.pg_roles r
                  where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                    and pg_catalog.has_function_privilege(r.oid, v_fn.oid, 'EXECUTE')) then
      raise exception 'POSTONA_THREADS_OAUTH_POSTCONDITION_FUNCTIONS';
    end if;
    v_seen := v_seen + 1;
  end loop;
  if v_seen <> 4 then
    raise exception 'POSTONA_THREADS_OAUTH_POSTCONDITION_FUNCTIONS';
  end if;
end $$;

commit;
