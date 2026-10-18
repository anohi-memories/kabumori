-- NOT A MIGRATION. SOURCE CANDIDATE ONLY (G4, POSTONA X OAuth hardening). Kept outside
-- supabase/migrations on purpose: no Supabase tool applies it. It cannot apply anywhere until G5's
-- service-write guard (T13, Draft PR #121) and G4's personal-workspace provisioner (T9, Draft PR #124)
-- exist there: both are preconditions.
--
-- What it adds (owner-only; NO grant to anon / authenticated / service_role, so nothing here is
-- reachable, and the live X RPCs are not changed, replaced or revoked by this file):
--   public.begin_social_mobile_x_oauth_connection_v2(text,text,timestamptz)
--   public.consume_social_mobile_x_oauth_state_v2(text)                read-only, before the code exchange
--   public.complete_social_mobile_x_oauth_connection_v2(uuid,text,text,text,text,text)
--   TABLE public.x_account_identity_attestations   (F4 M1, postona-f4-m1-x-identity-verified-credential-port-source-
--       20261018) one row per X account: the attested connection complete_v2 made -- the person, the workspace,
--       the X user id, the two Vault references, the verified_at it wrote AND the SHA-256 of the two tokens the Edge
--       signed (J2 V2 R1: content, not a timestamp), F5's workspace owner epoch (J2 V2 R2), the refresh generation and
--       the assumed access-token expiry. Only this function and G4's refresh re-attestation
--       (x_account_attest_refreshed_credential) write it. G4's verified predicate and server-only credential handoff
--       (candidates/postona_x_identity_credential/) accept an account only while the stored tokens' digests, the row
--       and the owner epoch still equal this record, so any other credential write -- a live (v1) complete, even in
--       the same transaction as this one -- and any owner change (A -> B -> A included) leave the account unverified
--       until the next attested connect.
-- The upgrade (grant these to authenticated, deploy the Edge that attests, then revoke the old three) is
-- a separate reviewed, user-authorized rollout: docs/postona/x-oauth-hardening-candidate-20261010.md.
--
-- What changes against the live X RPCs (20260919120000 + 20260922003101):
--   * T13 first. Every function calls private.account_lifecycle_assert_active_service_write(auth.uid(),
--     'x_autopost') in the caller's READ COMMITTED transaction before it locks or writes anything of its
--     own (login KEY SHARE -> common account -> entitlement, held to COMMIT), then workspace -> OAuth
--     state -> social account -> Vault.
--   * T9. begin uses the one provisioner, private.social_mobile_ensure_personal_workspace(uid): the
--     deterministic self-service workspace, never "the one brand the person happens to own".
--   * Provider binding. A state is bound to the person, their workspace and its X row (platform = 'x');
--     a Threads state, another person's, another workspace's, an expired or a used one is refused.
--   * Verified provider identity. complete() accepts the X user id, handle and tokens only with a server
--     attestation: HMAC-SHA256 over them and the state id, keyed by a secret held only by the Edge code
--     exchange and by Vault (name postona_x_connect_attestation_v1). The live complete() takes them from
--     any authenticated caller as given, so a person can bind someone else's X id to their own row and
--     keep its real owner from ever connecting (X_ACCOUNT_ALREADY_CONNECTED).
--   * Truthful failures. An identity connected elsewhere refuses the whole call: no secret, no consumed
--     state, no status change. (The live complete() writes connection_status = 'failed' and then
--     re-raises, which rolls that write back: the 'failed' status was never durable.)
--   * Credentials: Vault references only, created or updated in place while the row's own and distinct;
--     a shared, dangling or leftover reference refuses the whole call. publish_enabled = false, as today.
--   * Errors: the live codes where the meaning is the same (OAUTH_STATE_INPUT_INVALID,
--     OAUTH_STATE_NOT_CONSUMABLE, OAUTH_TOKEN_OR_IDENTITY_INVALID, SOCIAL_MOBILE_ACCOUNT_NOT_OWNED,
--     X_IDENTITY_ACCOUNT_MISMATCH, X_ACCOUNT_ALREADY_CONNECTED), new ones otherwise; never a token,
--     secret, code or provider body. SQLSTATE P0001 here, 42501 from the guard.
begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_owner oid := (select c.relowner from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('public.social_accounts'));
  v_guard regprocedure;
  v_provisioner regprocedure;
begin
  -- First (it reads nothing outside public): one non-superuser owner of every table written here, and
  -- it is the creator.
  if v_owner is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
     or (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or exists (select 1 from pg_catalog.pg_class c
                where c.oid in ('public.brands'::pg_catalog.regclass, 'public.brand_memberships'::pg_catalog.regclass,
                                'public.social_account_oauth_states'::pg_catalog.regclass)
                  and c.relowner is distinct from v_owner) then
    raise exception 'POSTONA_X_OAUTH_PRECONDITION_OWNER';
  end if;

  if pg_catalog.to_regprocedure('public.begin_social_mobile_x_oauth_connection_v2(text,text,timestamptz)') is not null
     or pg_catalog.to_regprocedure('public.consume_social_mobile_x_oauth_state_v2(text)') is not null
     or pg_catalog.to_regprocedure('public.complete_social_mobile_x_oauth_connection_v2(uuid,text,text,text,text,text)') is not null then
    raise exception 'POSTONA_X_OAUTH_PRECONDITION_ALREADY_APPLIED';
  end if;
  if pg_catalog.to_regclass('public.x_account_identity_attestations') is not null then
    raise exception 'POSTONA_X_OAUTH_PRECONDITION_ALREADY_APPLIED';
  end if;
  -- F5's workspace owner epoch (proposed F5 interface, J2 V2 R2) and the refresh core's state (its generation).
  if pg_catalog.to_regprocedure('private.account_lifecycle_brand_owner_epoch(text)') is null
     or (select p.prorettype from pg_catalog.pg_proc p
         where p.oid = pg_catalog.to_regprocedure('private.account_lifecycle_brand_owner_epoch(text)')) is distinct from 'pg_catalog.int8'::pg_catalog.regtype
     or (select p.proowner from pg_catalog.pg_proc p
         where p.oid = pg_catalog.to_regprocedure('private.account_lifecycle_brand_owner_epoch(text)')) is distinct from v_owner
     or exists (select 1 from pg_catalog.pg_roles r
                where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                  and pg_catalog.has_function_privilege(r.oid, pg_catalog.to_regprocedure('private.account_lifecycle_brand_owner_epoch(text)'), 'EXECUTE')) then
    raise exception 'POSTONA_X_OAUTH_PRECONDITION_OWNER_EPOCH';
  end if;
  if pg_catalog.to_regclass('public.x_account_refresh_state_v2') is null
     or (select pg_catalog.count(*) from pg_catalog.pg_attribute a
         where a.attrelid = pg_catalog.to_regclass('public.x_account_refresh_state_v2') and not a.attisdropped
           and a.attname in ('social_account_id', 'generation')) <> 2 then
    raise exception 'POSTONA_X_OAUTH_PRECONDITION_REFRESH_STATE';
  end if;

  -- G5's guard (T13): exists, returns void, owned by the table owner, executable by no API role.
  v_guard := pg_catalog.to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)');
  if v_guard is null then
    raise exception 'POSTONA_X_OAUTH_PRECONDITION_T13_MISSING';
  end if;
  if (select p.prorettype from pg_catalog.pg_proc p where p.oid = v_guard) is distinct from 'pg_catalog.void'::pg_catalog.regtype
     or (select p.proowner from pg_catalog.pg_proc p where p.oid = v_guard) is distinct from v_owner
     or exists (select 1 from pg_catalog.pg_roles r
                where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                  and pg_catalog.has_function_privilege(r.oid, v_guard, 'EXECUTE')) then
    raise exception 'POSTONA_X_OAUTH_PRECONDITION_T13_CONTRACT';
  end if;

  -- G4's provisioner (T9): exists, returns text, SECURITY INVOKER, owned by the table owner, executable
  -- by no API role (it runs only inside an owner-owned writer that already passed the guard).
  v_provisioner := pg_catalog.to_regprocedure('private.social_mobile_ensure_personal_workspace(uuid)');
  if v_provisioner is null then
    raise exception 'POSTONA_X_OAUTH_PRECONDITION_T9_MISSING';
  end if;
  if (select p.prorettype from pg_catalog.pg_proc p where p.oid = v_provisioner) is distinct from 'pg_catalog.text'::pg_catalog.regtype
     or (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_provisioner) is distinct from false
     or (select p.proowner from pg_catalog.pg_proc p where p.oid = v_provisioner) is distinct from v_owner
     or exists (select 1 from pg_catalog.pg_roles r
                where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                  and pg_catalog.has_function_privilege(r.oid, v_provisioner, 'EXECUTE')) then
    raise exception 'POSTONA_X_OAUTH_PRECONDITION_T9_CONTRACT';
  end if;

  -- The columns, keys and helpers relied on: the state columns, UNIQUE (state_hash), one provider
  -- identity per row (the index that turns a duplicate identity into unique_violation), one account per
  -- workspace and provider, the workspace helpers, Vault with names, pgcrypto.
  if (select count(*) from pg_catalog.pg_attribute a
      where a.attrelid = 'public.social_account_oauth_states'::pg_catalog.regclass and a.attnum > 0 and not a.attisdropped
        and (a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod)) in (
          ('id', 'uuid'), ('social_account_id', 'text'), ('brand_id', 'text'), ('state_hash', 'text'),
          ('code_verifier_vault_secret_id', 'uuid'), ('redirect_uri', 'text'), ('expires_at', 'timestamp with time zone'),
          ('consumed_at', 'timestamp with time zone'), ('initiated_by_user_id', 'uuid'))) <> 9
     or not exists (select 1 from pg_catalog.pg_constraint c
                    where c.conrelid = 'public.social_account_oauth_states'::pg_catalog.regclass and c.contype = 'u'
                      and pg_catalog.pg_get_constraintdef(c.oid) = 'UNIQUE (state_hash)')
     or not exists (select 1 from pg_catalog.pg_index i
                    where i.indrelid = 'public.social_accounts'::pg_catalog.regclass and i.indisvalid and i.indisready
                      and i.indislive and i.indimmediate
                      and pg_catalog.regexp_replace(pg_catalog.pg_get_indexdef(i.indexrelid), '^(CREATE (UNIQUE )?INDEX )\S+ ON ', '\1ON ')
                          = 'CREATE UNIQUE INDEX ON public.social_accounts USING btree (platform, platform_user_id) WHERE (platform_user_id IS NOT NULL)')
     or not exists (select 1 from pg_catalog.pg_index i
                    where i.indrelid = 'public.social_accounts'::pg_catalog.regclass and i.indisvalid and i.indisready
                      and i.indislive and i.indimmediate
                      and pg_catalog.regexp_replace(pg_catalog.pg_get_indexdef(i.indexrelid), '^(CREATE (UNIQUE )?INDEX )\S+ ON ', '\1ON ')
                          = 'CREATE UNIQUE INDEX ON public.social_accounts USING btree (brand_id, platform)')
     or pg_catalog.to_regprocedure('public.social_mobile_account_deletion_workspace(uuid)') is null
     or pg_catalog.to_regprocedure('public.social_mobile_account_deletion_workspace_lock(text)') is null
     or pg_catalog.to_regprocedure('public.social_mobile_account_deletion_guard()') is null
     or pg_catalog.to_regprocedure('vault.create_secret(text,text,text,uuid)') is null
     or pg_catalog.to_regprocedure('vault.update_secret(uuid,text,text,text,uuid)') is null
     or pg_catalog.to_regprocedure('extensions.hmac(bytea,bytea,text)') is null
     or (select count(*) from pg_catalog.pg_attribute a
         where a.attrelid = pg_catalog.to_regclass('vault.secrets') and a.attname = 'id'
           and a.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype) <> 1
     or (select count(*) from pg_catalog.pg_attribute a
         where a.attrelid = pg_catalog.to_regclass('vault.decrypted_secrets') and a.attname in ('name', 'decrypted_secret')) <> 2 then
    raise exception 'POSTONA_X_OAUTH_PRECONDITION_SHAPE';
  end if;
end $$;

-- F4 M1: the attested connection of an X account (written by complete_v2 only; see the header).
create table public.x_account_identity_attestations (
  social_account_id text primary key references public.social_accounts (id) on delete cascade,
  attestation_id uuid not null unique,
  user_id uuid not null,
  brand_id text not null references public.brands (id) on delete cascade,
  platform_user_id text not null check (platform_user_id ~ '^[1-9][0-9]{0,19}$'),
  oauth_state_id uuid not null,
  vault_access_token_secret_id uuid not null,
  vault_refresh_token_secret_id uuid not null,
  verified_at timestamptz not null,
  attested_at timestamptz not null,
  -- J2 V2 R1: the credential's content as signed (or as re-attested after a refresh), never a timestamp.
  access_token_sha256 text not null check (access_token_sha256 ~ '^[0-9a-f]{64}$'),
  refresh_token_sha256 text not null check (refresh_token_sha256 ~ '^[0-9a-f]{64}$'),
  -- J2 V2 R2: F5's workspace owner epoch when attested; any later owner write moves it on for good.
  owner_epoch bigint not null,
  refresh_generation bigint not null,
  access_expires_at timestamptz not null,
  check (vault_access_token_secret_id <> vault_refresh_token_secret_id)
);
alter table public.x_account_identity_attestations enable row level security;
revoke all on table public.x_account_identity_attestations from public, anon, authenticated, service_role;
create trigger social_mobile_deletion_guard before insert or update on public.x_account_identity_attestations
  for each row execute function public.social_mobile_account_deletion_guard();

create function public.begin_social_mobile_x_oauth_connection_v2(p_state_hash text, p_redirect_uri text, p_expires_at timestamptz)
returns table (brand_id text, social_account_id text)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_workspace text;
  v_account text;
  v_existing text;
begin
  -- Shape only; nothing is locked or written before the guard. The redirect stays a registered app URI
  -- (the live flow uses a custom scheme); X itself checks it against the registered callback.
  if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$'
     or p_redirect_uri is null or p_redirect_uri !~ '^[a-z][a-z0-9+.-]*://[^#*@[:space:]]+$' or p_redirect_uri ~ '^http://'
     or length(p_redirect_uri) > 2048
     or p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '10 minutes' then
    raise exception 'OAUTH_STATE_INPUT_INVALID' using errcode = 'P0001';
  end if;
  perform private.account_lifecycle_assert_active_service_write(v_user, 'x_autopost');

  v_workspace := private.social_mobile_ensure_personal_workspace(v_user);
  v_account := 'sa_' || pg_catalog.substr(pg_catalog.md5(v_workspace || ':x'), 1, 24);
  select sa.id into v_existing from public.social_accounts sa
   where sa.brand_id = v_workspace and sa.platform = 'x' for update;
  if not found then
    insert into public.social_accounts (id, brand_id, platform, handle, publish_enabled, oauth_client_ref, connection_status)
    values (v_account, v_workspace, 'x', 'pending', false, 'default', 'authorization_pending');
  elsif v_existing is distinct from v_account then
    raise exception 'X_ACCOUNT_CONFLICT' using errcode = 'P0001';
  else
    -- As 20260922003101: a new attempt never demotes a verified identity before its callback succeeds.
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
    raise exception 'OAUTH_STATE_INPUT_INVALID' using errcode = 'P0001';
  end;
  return query select v_workspace, v_account;
end;
$$;

-- Read-only: the state, before the single-use code is spent. Guarded, so an ended service or a
-- deletion in progress never reaches the code exchange.
create function public.consume_social_mobile_x_oauth_state_v2(p_state_hash text)
returns table (oauth_state_id uuid, redirect_uri text, brand_id text, social_account_id text)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'OAUTH_STATE_NOT_CONSUMABLE' using errcode = 'P0001';
  end if;
  perform private.account_lifecycle_assert_active_service_write(v_user, 'x_autopost');
  return query
    select s.id, s.redirect_uri, s.brand_id, s.social_account_id
    from public.social_account_oauth_states s
    join public.social_accounts sa on sa.id = s.social_account_id
    join public.brand_memberships m on m.brand_id = s.brand_id and m.user_id = v_user and m.role = 'owner'
    where s.state_hash = p_state_hash and s.initiated_by_user_id = v_user
      and s.consumed_at is null and s.expires_at > now()
      and sa.platform = 'x' and sa.brand_id = s.brand_id
      and s.brand_id = public.social_mobile_account_deletion_workspace(v_user);
  if not found then
    raise exception 'OAUTH_STATE_NOT_CONSUMABLE' using errcode = 'P0001';
  end if;
end;
$$;

create function public.complete_social_mobile_x_oauth_connection_v2(
  p_oauth_state_id uuid, p_platform_user_id text, p_handle text, p_access_token text, p_refresh_token text, p_attestation text
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
  v_access uuid;
  v_refresh uuid;
begin
  -- Shape (X ids are 64-bit decimal strings, usernames 1-15 of [A-Za-z0-9_]; tokens are printable ASCII
  -- without spaces, at most 4096; PostgreSQL bounds regex repetition at 255, so lengths are apart).
  if p_oauth_state_id is null or p_platform_user_id is null or p_platform_user_id !~ '^[1-9][0-9]{0,19}$'
     or p_handle is null or p_handle !~ '^[A-Za-z0-9_]{1,15}$'
     or p_access_token is null or p_access_token !~ '^[!-~]+$' or length(p_access_token) not between 16 and 4096
     or p_refresh_token is null or p_refresh_token !~ '^[!-~]+$' or length(p_refresh_token) not between 16 and 4096
     or p_access_token = p_refresh_token
     or p_attestation is null or p_attestation !~ '^[0-9a-f]{64}$' then
    raise exception 'OAUTH_TOKEN_OR_IDENTITY_INVALID' using errcode = 'P0001';
  end if;
  perform private.account_lifecycle_assert_active_service_write(v_user, 'x_autopost');

  -- Only the code exchange can vouch for this identity and these tokens.
  select count(*), min(d.decrypted_secret) into v_keys, v_key
    from vault.decrypted_secrets d where d.name = 'postona_x_connect_attestation_v1';
  if v_keys <> 1 or v_key is null or length(v_key) < 32 then
    raise exception 'X_CONNECT_ATTESTATION_UNAVAILABLE' using errcode = 'P0001';
  end if;
  if pg_catalog.encode(extensions.hmac(
       pg_catalog.convert_to(pg_catalog.concat_ws(pg_catalog.chr(10), 'postona-x-connect-v1', p_oauth_state_id::text,
                             p_platform_user_id, p_handle,
                             pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_access_token, 'UTF8')), 'hex'),
                             pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_refresh_token, 'UTF8')), 'hex')), 'UTF8'),
       pg_catalog.convert_to(v_key, 'UTF8'), 'sha256'), 'hex') is distinct from p_attestation then
    raise exception 'X_CONNECT_ATTESTATION_INVALID' using errcode = 'P0001';
  end if;

  -- Workspace, then the state, then the account, then Vault.
  v_workspace := public.social_mobile_account_deletion_workspace(v_user);
  perform public.social_mobile_account_deletion_workspace_lock(v_workspace);
  perform 1 from public.brand_memberships m
   where m.brand_id = v_workspace and m.user_id = v_user and m.role = 'owner' for share;
  if not found then
    raise exception 'SOCIAL_MOBILE_ACCOUNT_NOT_OWNED' using errcode = 'P0001';
  end if;
  -- The one irreversible claim: this person's, this workspace's X state, unexpired, unused.
  update public.social_account_oauth_states s set consumed_at = now()
   where s.id = p_oauth_state_id and s.initiated_by_user_id = v_user and s.brand_id = v_workspace
     and s.consumed_at is null and s.expires_at > now()
     and exists (select 1 from public.social_accounts sa
                 where sa.id = s.social_account_id and sa.brand_id = v_workspace and sa.platform = 'x')
  returning s.id into v_state_id;
  if v_state_id is null then
    raise exception 'OAUTH_STATE_NOT_CONSUMABLE' using errcode = 'P0001';
  end if;
  select sa.* into v_account from public.social_accounts sa
   where sa.brand_id = v_workspace and sa.platform = 'x' for update;
  if v_account.platform_user_id is not null and v_account.platform_user_id is distinct from p_platform_user_id then
    raise exception 'X_IDENTITY_ACCOUNT_MISMATCH' using errcode = 'P0001';
  end if;

  -- Each reference is updated in place only while it is this row's alone, distinct from the other one,
  -- and still names a secret (an update of a missing id would silently change nothing).
  if v_account.vault_access_token_secret_id = v_account.vault_refresh_token_secret_id
     or exists (select 1 from public.social_accounts o
                where o.id <> v_account.id
                  and (o.vault_access_token_secret_id in (v_account.vault_access_token_secret_id, v_account.vault_refresh_token_secret_id)
                       or o.vault_refresh_token_secret_id in (v_account.vault_access_token_secret_id, v_account.vault_refresh_token_secret_id)))
     or (v_account.vault_access_token_secret_id is not null
         and not exists (select 1 from vault.secrets s where s.id = v_account.vault_access_token_secret_id))
     or (v_account.vault_refresh_token_secret_id is not null
         and not exists (select 1 from vault.secrets s where s.id = v_account.vault_refresh_token_secret_id)) then
    raise exception 'X_CREDENTIAL_SHAPE_INVALID' using errcode = 'P0001';
  end if;
  begin
    if v_account.vault_access_token_secret_id is null then
      v_access := vault.create_secret(p_access_token, v_account.id || '_access_token', 'OAuth access token.');
    else
      perform vault.update_secret(v_account.vault_access_token_secret_id, p_access_token);
      v_access := v_account.vault_access_token_secret_id;
    end if;
    if v_account.vault_refresh_token_secret_id is null then
      v_refresh := vault.create_secret(p_refresh_token, v_account.id || '_refresh_token', 'OAuth refresh token.');
    else
      perform vault.update_secret(v_account.vault_refresh_token_secret_id, p_refresh_token);
      v_refresh := v_account.vault_refresh_token_secret_id;
    end if;
  exception when unique_violation then
    -- A secret of the row's name outlived its reference (an unfinished cleanup): reconcile it first.
    raise exception 'X_CREDENTIAL_SHAPE_INVALID' using errcode = 'P0001';
  end;
  begin
    update public.social_accounts sa
       set vault_access_token_secret_id = v_access, vault_refresh_token_secret_id = v_refresh,
           platform_user_id = p_platform_user_id, handle = pg_catalog.lower(p_handle), publish_enabled = false,
           connection_status = 'identity_verified', verified_at = now(),
           last_connection_error_code = null, updated_at = now()
     where sa.id = v_account.id;
  exception when unique_violation then
    -- The whole call fails: no secret, no consumed state, no status change.
    raise exception 'X_ACCOUNT_ALREADY_CONNECTED' using errcode = 'P0001';
  end;
  -- F4 M1: what was attested, bound to this person and workspace, in this same transaction: the signed tokens'
  -- digests (R1), F5's owner epoch read under the owner membership's FOR SHARE above (R2), the refresh generation, and
  -- the access-token expiry ASSUMED from X's documented 2-hour lifetime (not attested; NOT verified against real X).
  insert into public.x_account_identity_attestations
    (social_account_id, attestation_id, user_id, brand_id, platform_user_id, oauth_state_id,
     vault_access_token_secret_id, vault_refresh_token_secret_id, verified_at, attested_at,
     access_token_sha256, refresh_token_sha256, owner_epoch, refresh_generation, access_expires_at)
  values (v_account.id, gen_random_uuid(), v_user, v_workspace, p_platform_user_id, v_state_id, v_access, v_refresh, now(), now(),
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_access_token, 'UTF8')), 'hex'),
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_refresh_token, 'UTF8')), 'hex'),
          private.account_lifecycle_brand_owner_epoch(v_workspace),
          coalesce((select st.generation from public.x_account_refresh_state_v2 st where st.social_account_id = v_account.id), 0),
          pg_catalog.clock_timestamp() + interval '2 hours')
  on conflict (social_account_id) do update
    set attestation_id = excluded.attestation_id, user_id = excluded.user_id, brand_id = excluded.brand_id,
        platform_user_id = excluded.platform_user_id, oauth_state_id = excluded.oauth_state_id,
        vault_access_token_secret_id = excluded.vault_access_token_secret_id,
        vault_refresh_token_secret_id = excluded.vault_refresh_token_secret_id,
        verified_at = excluded.verified_at, attested_at = excluded.attested_at,
        access_token_sha256 = excluded.access_token_sha256, refresh_token_sha256 = excluded.refresh_token_sha256,
        owner_epoch = excluded.owner_epoch, refresh_generation = excluded.refresh_generation,
        access_expires_at = excluded.access_expires_at;
end;
$$;

revoke all on function public.begin_social_mobile_x_oauth_connection_v2(text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.consume_social_mobile_x_oauth_state_v2(text) from public, anon, authenticated, service_role;
revoke all on function public.complete_social_mobile_x_oauth_connection_v2(uuid, text, text, text, text, text)
  from public, anon, authenticated, service_role;

-- Postcondition: three SECURITY DEFINER functions owned by the table owner, empty search_path, EXECUTE
-- for the owner only, and no API role able to run any of them, directly or through a membership.
do $$
declare
  v_owner oid := (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::pg_catalog.regclass);
  v_fn record;
  v_seen integer := 0;
begin
  for v_fn in
    select p.oid, p.prosecdef, p.proowner, p.proconfig, p.proacl
    from pg_catalog.pg_proc p
    where p.oid in ('public.begin_social_mobile_x_oauth_connection_v2(text,text,timestamptz)'::pg_catalog.regprocedure,
                    'public.consume_social_mobile_x_oauth_state_v2(text)'::pg_catalog.regprocedure,
                    'public.complete_social_mobile_x_oauth_connection_v2(uuid,text,text,text,text,text)'::pg_catalog.regprocedure)
  loop
    if v_fn.proowner is distinct from v_owner or not v_fn.prosecdef
       or v_fn.proconfig is distinct from array['search_path=""']
       or (select pg_catalog.array_agg(pg_catalog.concat_ws(' | ', (a.grantor = v_owner)::text, (a.grantee = v_owner)::text,
                                                             a.privilege_type, a.is_grantable::text))
           from pg_catalog.aclexplode(coalesce(v_fn.proacl, pg_catalog.acldefault('f', v_fn.proowner))) a)
          is distinct from array['true | true | EXECUTE | false']
       or exists (select 1 from pg_catalog.pg_roles r
                  where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                    and pg_catalog.has_function_privilege(r.oid, v_fn.oid, 'EXECUTE')) then
      raise exception 'POSTONA_X_OAUTH_POSTCONDITION_FUNCTIONS';
    end if;
    v_seen := v_seen + 1;
  end loop;
  if v_seen <> 3 then
    raise exception 'POSTONA_X_OAUTH_POSTCONDITION_FUNCTIONS';
  end if;
  -- F4 M1: the attestation record is the owner's alone.
  if (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.x_account_identity_attestations'::pg_catalog.regclass) is distinct from v_owner
     or not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.x_account_identity_attestations'::pg_catalog.regclass)
     or exists (select 1 from pg_catalog.pg_roles r,
                              (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
                where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                  and pg_catalog.has_table_privilege(r.oid, 'public.x_account_identity_attestations', p.priv)) then
    raise exception 'POSTONA_X_OAUTH_POSTCONDITION_ATTESTATIONS';
  end if;
end $$;

commit;
