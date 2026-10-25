-- G4 SOURCE CANDIDATE (2026-10-25, Issue #319 G4-40). NOT in supabase/migrations/. NOT applied anywhere but a disposable local PG17.
-- Applies ON TOP OF 001_x_oauth_personal_epoch.sql (PR #511) and makes it fit the PRODUCT around it. Same adoption gates as 001
-- (G5 accepts the authority interface, one Codex Sol (high) batch review, the owner's explicit production approval).
--
-- Product facts measured in G4-40 (main 0c42933c) that 001 did not meet:
--   W1  social_accounts.connection_status has a CHECK (unconnected | authorization_pending | connected | identity_verified | failed;
--       20261007150000 L232). 001's disconnect wrote 'disconnected' -> check_violation on the product shape. -> 'unconnected'
--       (what the app treats as "connect again": apps/social-mobile/src/domain/onboarding.ts, connect_x resume).
--   W2  The product already has ONE X token writer with a single-flight lease: x_account_refresh_state_v2 +
--       begin_/commit_x_account_refresh_* (20260925140000, 20260925150000, 20260926032054). Its commit refuses a lease whose account
--       row changed (updated_at, status, refs, identity) -> 'account_changed'. 001's store_refreshed_x_tokens was a SECOND writer
--       outside that lease (measured: an in-flight lease commit silently replaces what it stored). -> dropped. The refresh lease stays
--       the only writer; connection_epoch is offered to the refresh owner as an extra fence (docs, not wired).
--   W3  A deadlock that main ALREADY has: an X (re)connect complete locks the account row (FOR UPDATE) and then UPDATEs the table
--       (ROW EXCLUSIVE), while a refresh commit takes SHARE ROW EXCLUSIVE on social_accounts and then waits for that row. Measured
--       on main's bodies: the commit dies (X_REFRESH_PERSIST_FAILED, pg_stat_database.deadlocks + 1) and its lease stays
--       'refreshing' after X has already rotated the refresh token. -> begin, complete and disconnect take ROW EXCLUSIVE on
--       social_accounts BEFORE any row lock on it (after the per-workspace advisory lock), so the two serialize instead.
-- begin / complete below are 001's bodies (001 L150-L243, L245-L359) with ONLY the one W3 line added; disconnect = 001's with W1 + W3.
-- Not changed: x_connection_epoch, the refresh functions, the Edge function, the app, any migration.
-- Rollback: 002_x_oauth_product_wiring_rollback.sql (back to 001 exactly).
begin;

set local lock_timeout = '5s';

do $$
declare
  v_def text;
begin
  if to_regnamespace('postona_g4_x_oauth') is null then
    raise exception 'G4X_WIRING_NEEDS_001';
  end if;
  if to_regprocedure('postona_g4_x_oauth.store_refreshed_x_tokens(text,bigint,text,text)') is null then
    raise exception 'G4X_WIRING_ALREADY_APPLIED';
  end if;
  -- 001's three bodies exactly as reviewed
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('postona_g4_x_oauth.disconnect_x_connection()'))
       is distinct from '609dfcde5bc837303813d83dfdc8dafa'
     or (select md5(p.prosrc) from pg_proc p
           where p.oid = to_regprocedure('public.begin_social_mobile_x_oauth_connection(text,text,timestamptz)'))
       is distinct from '7f605c3ca7a69b4d7f58d0d7fa82fb0f'
     or (select md5(p.prosrc) from pg_proc p
           where p.oid = to_regprocedure('public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)'))
       is distinct from '3ea5686f26e8de515d902cd408ef5275' then
    raise exception 'G4X_WIRING_PRECONDITION_001_BODY';
  end if;
  -- nothing calls the writer this file drops: no other body names it, in any letter case (G4-45 / H1 F1), and the catalog
  -- records nothing depending on it (a SQL-standard body, a view, a default...). A name built by dynamic SQL is not found:
  -- consumers are to be removed first.
  if exists (select 1 from pg_proc p
               where p.oid <> to_regprocedure('postona_g4_x_oauth.store_refreshed_x_tokens(text,bigint,text,text)')
                 and p.prosrc ilike '%store_refreshed_x_tokens%')
     or exists (select 1 from pg_depend d
                 where d.refclassid = 'pg_proc'::regclass and d.deptype in ('n', 'a')
                   and d.refobjid = to_regprocedure('postona_g4_x_oauth.store_refreshed_x_tokens(text,bigint,text,text)')) then
    raise exception 'G4X_WIRING_PRECONDITION_WRITER_IN_USE';
  end if;
  -- every CHECK that names connection_status (and not only for other platforms) must allow 'unconnected'
  for v_def in
    select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.social_accounts'::regclass and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%connection_status%' and pg_get_constraintdef(c.oid) not like '%platform%'
  loop
    if v_def not like '%''unconnected''%' then
      raise exception 'G4X_WIRING_PRECONDITION_STATUS_SET';
    end if;
  end loop;
end $$;

drop function postona_g4_x_oauth.store_refreshed_x_tokens(text, bigint, text, text);

-- begin: same signature, owner, ACL (CREATE OR REPLACE); only the person's own workspace, never a join
create or replace function public.begin_social_mobile_x_oauth_connection(
  p_state_hash text,
  p_redirect_uri text,
  p_expires_at timestamptz
)
returns table (brand_id text, social_account_id text)
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_user_id uuid := auth.uid();
  v_brand_id text;
  v_verdict text;
  v_owner_epoch bigint;
  v_social_account_id text;
  v_connection_epoch bigint;
  v_state_id uuid;
  v_rows bigint;
begin
  if v_user_id is null then
    raise exception 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED';
  end if;
  if p_state_hash !~ '^[0-9a-f]{64}$' or p_expires_at <= now() then
    raise exception 'OAUTH_STATE_INPUT_INVALID';
  end if;

  v_brand_id := 'u_' || substr(md5(v_user_id::text), 1, 24);
  perform postona_g4_x_oauth.lock_workspace(v_brand_id);
  lock table public.social_accounts in row exclusive mode;  -- W3 (G4-40): before any row lock on social_accounts
  v_verdict := postona_g4_x_oauth.require_person(v_user_id);

  if v_verdict = 'absent' then
    insert into public.brands (id, display_name, is_active, publish_mode, code_profile_key)
    values (v_brand_id, 'My Workspace', false, 'disabled', 'social_mobile_user_v1')
    on conflict (id) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      -- someone else made the row between the verdict and here: never join it
      raise exception 'OWN_WORKSPACE_CONFLICT';
    end if;
    insert into public.brand_memberships (brand_id, user_id, role)
    values (v_brand_id, v_user_id, 'owner');
    -- the rule must hold after the write too
    if postona_g4_x_oauth.require_person(v_user_id) <> 'own' then
      raise exception 'OWN_WORKSPACE_CONFLICT';
    end if;
  end if;
  v_owner_epoch := postona_g4_x_oauth.require_owner_epoch(v_brand_id);

  select sa.id into v_social_account_id
  from public.social_accounts sa
  where sa.brand_id = v_brand_id and sa.platform = 'x'
  for update;
  if v_social_account_id is null then
    v_social_account_id := 'sa_' || substr(md5(v_brand_id || ':x'), 1, 24);
    insert into public.social_accounts
      (id, brand_id, platform, handle, publish_enabled, oauth_client_ref, connection_status)
    values (v_social_account_id, v_brand_id, 'x', 'pending', false, 'default', 'authorization_pending');
  else
    -- a reconnect refreshes the state but never demotes a verified identity before the callback
    update public.social_accounts sa
    set connection_status = case
          when sa.connection_status = 'identity_verified' then 'identity_verified'
          else 'authorization_pending'
        end,
        last_connection_error_code = null,
        updated_at = now()
    where sa.id = v_social_account_id;
  end if;

  insert into postona_g4_x_oauth.connections as c (social_account_id)
  values (v_social_account_id)
  on conflict on constraint g4x_connections_pkey do nothing;
  select c.connection_epoch into v_connection_epoch
  from postona_g4_x_oauth.connections c
  where c.social_account_id = v_social_account_id
  for update;

  insert into public.social_account_oauth_states
    (social_account_id, brand_id, state_hash, code_verifier_vault_secret_id, redirect_uri, expires_at, initiated_by_user_id)
  values (v_social_account_id, v_brand_id, p_state_hash, null, p_redirect_uri, p_expires_at, v_user_id)
  returning id into v_state_id;
  insert into postona_g4_x_oauth.state_bindings
    (oauth_state_id, initiated_by, brand_id, social_account_id, owner_epoch, connection_epoch)
  values (v_state_id, v_user_id, v_brand_id, v_social_account_id, v_owner_epoch, v_connection_epoch);
  -- the newest begin is the only one that may complete
  update postona_g4_x_oauth.connections c
  set latest_state_id = v_state_id, updated_at = now()
  where c.social_account_id = v_social_account_id;

  return query select v_brand_id, v_social_account_id;
end;
$$;

-- complete: same signature, owner, ACL; the claim, then every begin-time fact again, then the original writes
create or replace function public.complete_social_mobile_x_oauth_connection(
  p_oauth_state_id uuid,
  p_platform_user_id text,
  p_handle text,
  p_access_token text,
  p_refresh_token text
)
returns void
language plpgsql
security definer
set search_path = 'public', 'vault'
as $$
declare
  v_user_id uuid := auth.uid();
  v_social_account_id text;
  v_state_brand text;
  v_account public.social_accounts%rowtype;
  v_binding postona_g4_x_oauth.state_bindings%rowtype;
  v_connection postona_g4_x_oauth.connections%rowtype;
  v_handle text := lower(regexp_replace(trim(p_handle), '^@', ''));
begin
  if v_user_id is null then
    raise exception 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED';
  end if;
  if coalesce(p_access_token, '') = '' or coalesce(p_refresh_token, '') = '' or coalesce(p_platform_user_id, '') = '' then
    raise exception 'OAUTH_TOKEN_OR_IDENTITY_INVALID';
  end if;
  -- the lock of the workspace the state names (a state of someone else's workspace fails the claim below anyway)
  select s.brand_id into v_state_brand from public.social_account_oauth_states s where s.id = p_oauth_state_id;
  if v_state_brand is not null then
    perform postona_g4_x_oauth.lock_workspace(v_state_brand);
  end if;
  lock table public.social_accounts in row exclusive mode;  -- W3 (G4-40): before any row lock on social_accounts

  update public.social_account_oauth_states
  set consumed_at = now()
  where id = p_oauth_state_id
    and initiated_by_user_id = v_user_id
    and consumed_at is null
    and expires_at > now()
  returning social_account_id into v_social_account_id;
  if v_social_account_id is null then
    raise exception 'OAUTH_STATE_NOT_CONSUMABLE';
  end if;

  select b.* into v_binding from postona_g4_x_oauth.state_bindings b where b.oauth_state_id = p_oauth_state_id;
  if not found or v_binding.initiated_by <> v_user_id or v_binding.social_account_id <> v_social_account_id
     or v_binding.brand_id <> v_state_brand then
    raise exception 'OAUTH_STATE_NOT_BOUND';
  end if;
  select c.* into v_connection from postona_g4_x_oauth.connections c
  where c.social_account_id = v_social_account_id
  for update;
  if not found or v_connection.latest_state_id is distinct from p_oauth_state_id then
    raise exception 'OAUTH_STATE_SUPERSEDED';
  end if;
  if v_connection.connection_epoch <> v_binding.connection_epoch then
    raise exception 'X_CONNECTION_CHANGED';
  end if;
  -- the callback re-asks G5 (Q13 proposal): live person, still exactly their own workspace, same owner epoch
  if v_binding.brand_id <> 'u_' || substr(md5(v_user_id::text), 1, 24)
     or postona_g4_x_oauth.require_person(v_user_id) <> 'own' then
    raise exception 'OWN_WORKSPACE_CONFLICT';
  end if;
  if postona_g4_x_oauth.require_owner_epoch(v_binding.brand_id) <> v_binding.owner_epoch then
    raise exception 'OWNER_EPOCH_CHANGED';
  end if;

  select sa.* into v_account
  from public.social_accounts sa
  join public.brand_memberships bm on bm.brand_id = sa.brand_id
  where sa.id = v_social_account_id and sa.brand_id = v_binding.brand_id and bm.user_id = v_user_id and bm.role = 'owner'
  for update of sa;
  if not found then
    raise exception 'SOCIAL_MOBILE_ACCOUNT_NOT_OWNED';
  end if;
  if v_account.platform_user_id is not null and v_account.platform_user_id <> p_platform_user_id then
    raise exception 'X_IDENTITY_ACCOUNT_MISMATCH';
  end if;

  if v_account.vault_access_token_secret_id is null then
    v_account.vault_access_token_secret_id := vault.create_secret(p_access_token, v_social_account_id || '_access_token', 'OAuth access token.');
  else
    perform vault.update_secret(v_account.vault_access_token_secret_id, p_access_token);
  end if;
  if v_account.vault_refresh_token_secret_id is null then
    v_account.vault_refresh_token_secret_id := vault.create_secret(p_refresh_token, v_social_account_id || '_refresh_token', 'OAuth refresh token.');
  else
    perform vault.update_secret(v_account.vault_refresh_token_secret_id, p_refresh_token);
  end if;

  update public.social_accounts set
    vault_access_token_secret_id = v_account.vault_access_token_secret_id,
    vault_refresh_token_secret_id = v_account.vault_refresh_token_secret_id,
    platform_user_id = p_platform_user_id,
    handle = v_handle,
    publish_enabled = false,
    connection_status = 'identity_verified',
    verified_at = now(),
    last_connection_error_code = null,
    updated_at = now()
  where id = v_social_account_id;

  -- a new token lineage: every older lease / token holder is now stale
  update postona_g4_x_oauth.connections c
  set connection_epoch = c.connection_epoch + 1, latest_state_id = null, updated_at = now()
  where c.social_account_id = v_social_account_id;
exception
  when unique_violation then
    update public.social_accounts
    set connection_status = 'failed', last_connection_error_code = 'X_ACCOUNT_ALREADY_CONNECTED', updated_at = now()
    where id = v_social_account_id;
    raise exception 'X_ACCOUNT_ALREADY_CONNECTED';
end;
$$;

-- disconnect: the product's own "not connected" value (W1) and the W3 lock; everything else as 001
create or replace function postona_g4_x_oauth.disconnect_x_connection() returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_brand_id text;
  v_account text;
begin
  if v_user_id is null then
    raise exception 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED';
  end if;
  v_brand_id := 'u_' || pg_catalog.substr(pg_catalog.md5(v_user_id::text), 1, 24);
  perform postona_g4_x_oauth.lock_workspace(v_brand_id);
  lock table public.social_accounts in row exclusive mode;
  -- 'absent' = no workspace, so nothing to disconnect; require_person raised for every other non-'own' answer
  if postona_g4_x_oauth.require_person(v_user_id) = 'absent' then
    raise exception 'X_CONNECTION_NOT_FOUND';
  end if;
  select sa.id into v_account from public.social_accounts sa
  where sa.brand_id = v_brand_id and sa.platform = 'x'
  for update;
  if v_account is null then
    raise exception 'X_CONNECTION_NOT_FOUND';
  end if;
  delete from public.social_account_oauth_states s where s.social_account_id = v_account and s.consumed_at is null;
  -- the row change (status, updated_at) is what makes an in-flight refresh lease commit 'account_changed'
  update public.social_accounts sa
  set connection_status = 'unconnected', publish_enabled = false, last_connection_error_code = null,
      updated_at = pg_catalog.clock_timestamp()
  where sa.id = v_account;
  insert into postona_g4_x_oauth.connections as c (social_account_id) values (v_account)
  on conflict on constraint g4x_connections_pkey do nothing;
  update postona_g4_x_oauth.connections c
  set connection_epoch = c.connection_epoch + 1, latest_state_id = null, updated_at = pg_catalog.now()
  where c.social_account_id = v_account;
end $$;

revoke all on function postona_g4_x_oauth.disconnect_x_connection() from public, anon, authenticated, service_role;

do $$
declare
  v_role text;
  v_fn regprocedure;
begin
  if to_regprocedure('postona_g4_x_oauth.store_refreshed_x_tokens(text,bigint,text,text)') is not null then
    raise exception 'G4X_WIRING_POSTCONDITION_WRITER_LEFT';
  end if;
  foreach v_fn in array array[
    'public.begin_social_mobile_x_oauth_connection(text,text,timestamptz)'::regprocedure,
    'public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)'::regprocedure] loop
    if not has_function_privilege('authenticated', v_fn, 'EXECUTE')
       or has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception 'G4X_WIRING_POSTCONDITION_ACL %', v_fn;
    end if;
  end loop;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if has_schema_privilege(v_role, 'postona_g4_x_oauth', 'USAGE')
       or exists (select 1 from pg_proc p where p.pronamespace = 'postona_g4_x_oauth'::regnamespace
                    and has_function_privilege(v_role, p.oid, 'EXECUTE')) then
      raise exception 'G4X_WIRING_POSTCONDITION_API_ROLE_REACHES %', v_role;
    end if;
  end loop;
end $$;

commit;
