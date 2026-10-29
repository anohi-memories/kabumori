-- NOT A MIGRATION. G4 SOURCE CANDIDATE ONLY (G4-02 #4, Issue #561). Applies ON TOP OF 001 (same schema, same owner).
-- The read-only X publish-credential VERDICT for G3's X reservation consumer, the same shape as Threads':
--
--   postona_g4_credential.x_publish_credential_verdict(p_user_id uuid, p_social_account_id text)
--     returns table (verified boolean, credential_generation text, code text)   -- exactly one row, always
--
-- verified = true (code 'VERIFIED') only when ALL hold, in one snapshot:
--   * the account exists, is X, lives in the person's own workspace whose single owner is the person (G5's brand owner);
--   * the person's x_autopost service is 'active' for that workspace (G5's common_account_brand_service_state);
--   * the connection was made through G4's X lineage (postona_g4_x_oauth.connections: G4-39..46) and no begin is pending
--     on it (latest_state_id is null);
--   * connection_status = 'identity_verified' with no connection error, and both the access and the refresh credential set;
--   * the token refresh state (public.x_account_refresh_state_v2, main's refresh core) is not 'refreshing'
--     (REFRESH_IN_PROGRESS: G3 releases, no send), 'uncertain' (REFRESH_UNCERTAIN) or 'reauth_required' (REAUTH_REQUIRED).
--     An expired ACCESS token alone is not a refusal: the refresh credential renews it (main's refresh core decides).
-- credential_generation = 'g4x1:' || connection_epoch: G4's epoch moves +1 on every completed connect AND every
--   disconnect (001 / 002 / 005), never back, so a reconnect -- even of the same X user -- is a new value. A token refresh
--   by main's refresh core (its lease is the only token writer since G4-40 002) keeps it. Opaque: compare for equality only.
-- code (fixed): VERIFIED | INPUT_INVALID | NOT_CONNECTED | NOT_OWN_WORKSPACE | SERVICE_<G5 state> | LINEAGE_UNKNOWN |
--   CONNECT_PENDING | DISCONNECTED (G4's 'unconnected' or the older 'disconnected') | NOT_VERIFIED | CONNECTION_ERROR | CREDENTIAL_MISSING | REFRESH_IN_PROGRESS |
--   REFRESH_UNCERTAIN | REAUTH_REQUIRED.
--
-- Needs G4's X lineage schema, which today exists only with the FULL G5 profile (G4's X 001 binds F5's owner epoch);
-- on the personal MVP profile the install refuses (G4_X_VERDICT_PRECONDITION_LINEAGE) until G4's X OAuth has its g5pv
-- variant. Owner-only, no grant. Rollback: 002_x_publish_credential_verdict_rollback.sql.

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
  if to_regnamespace('postona_g4_credential') is null
     or (select nspowner from pg_catalog.pg_namespace where nspname = 'postona_g4_credential') <> v_me
     or to_regprocedure('postona_g4_credential.threads_publish_credential_verdict(uuid,text)') is null then
    raise exception 'G4_X_VERDICT_PRECONDITION_001';
  end if;
  if to_regclass('postona_g4_x_oauth.connections') is null
     or (select relowner from pg_catalog.pg_class where oid = to_regclass('postona_g4_x_oauth.connections')) <> v_me then
    raise exception 'G4_X_VERDICT_PRECONDITION_LINEAGE';
  end if;
  foreach v_name in array array['public.social_accounts', 'public.x_account_refresh_state_v2'] loop
    if to_regclass(v_name) is null or (select relowner from pg_catalog.pg_class where oid = to_regclass(v_name)) <> v_me then
      raise exception 'G4_VERDICT_PRECONDITION_TABLE %', v_name;
    end if;
  end loop;
  if to_regprocedure('postona_g4_credential.x_publish_credential_verdict(uuid,text)') is not null then
    raise exception 'G4_X_VERDICT_ALREADY_APPLIED';
  end if;
end $$;

create function postona_g4_credential.x_publish_credential_verdict(p_user_id uuid, p_social_account_id text)
returns table (verified boolean, credential_generation text, code text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_account public.social_accounts;
  v_connection postona_g4_x_oauth.connections;
  v_refresh text;
  v_state text;
  v_generation text;
begin
  if p_user_id is null or p_social_account_id is null or p_social_account_id = '' then
    return query select false, null::text, 'INPUT_INVALID'::text;
    return;
  end if;
  select sa.* into v_account from public.social_accounts sa where sa.id = p_social_account_id and sa.platform = 'x';
  if not found then
    return query select false, null::text, 'NOT_CONNECTED'::text;
    return;
  end if;
  if v_account.brand_id is distinct from 'u_' || pg_catalog.substr(pg_catalog.md5(p_user_id::text), 1, 24)
     or private.account_lifecycle_brand_owner(v_account.brand_id) is distinct from p_user_id then
    return query select false, null::text, 'NOT_OWN_WORKSPACE'::text;
    return;
  end if;
  select c.* into v_connection from postona_g4_x_oauth.connections c where c.social_account_id = v_account.id;
  if not found then
    return query select false, null::text, 'LINEAGE_UNKNOWN'::text;  -- connected outside G4's lineage (or never)
    return;
  end if;
  v_generation := 'g4x1:' || v_connection.connection_epoch::text;
  v_state := public.common_account_brand_service_state(v_account.brand_id, 'x_autopost');
  if v_state is distinct from 'active' then
    return query select false, v_generation, coalesce(v_state, 'SERVICE_STATE_UNKNOWN');
    return;
  end if;
  -- G4's disconnect leaves 'unconnected' (002, CHECK-safe); the older live disconnect leaves 'disconnected'
  if v_account.connection_status in ('disconnected', 'unconnected') then
    return query select false, v_generation, 'DISCONNECTED'::text;
    return;
  end if;
  if v_connection.latest_state_id is not null then
    return query select false, v_generation, 'CONNECT_PENDING'::text;  -- a begin is open: the next complete moves the epoch
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
  if v_account.vault_access_token_secret_id is null or v_account.vault_refresh_token_secret_id is null then
    return query select false, v_generation, 'CREDENTIAL_MISSING'::text;
    return;
  end if;
  select r.status into v_refresh from public.x_account_refresh_state_v2 r where r.social_account_id = v_account.id;
  if v_refresh = 'refreshing' then
    return query select false, v_generation, 'REFRESH_IN_PROGRESS'::text;
    return;
  elsif v_refresh = 'uncertain' then
    return query select false, v_generation, 'REFRESH_UNCERTAIN'::text;
    return;
  elsif v_refresh = 'reauth_required' then
    return query select false, v_generation, 'REAUTH_REQUIRED'::text;
    return;
  end if;
  return query select true, v_generation, 'VERIFIED'::text;
end $$;

revoke all on function postona_g4_credential.x_publish_credential_verdict(uuid, text) from public, anon, authenticated, service_role;

do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  v_fn regprocedure := to_regprocedure('postona_g4_credential.x_publish_credential_verdict(uuid,text)');
  v_api text;
begin
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.proowner = v_me and p.prosecdef and p.provolatile = 's'
                   and coalesce(p.proconfig @> array['search_path=""'], false)) then
    raise exception 'G4_VERDICT_POSTCONDITION_FUNCTION';
  end if;
  if (select p.proacl from pg_catalog.pg_proc p where p.oid = v_fn) is null
     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a where p.oid = v_fn and a.grantee <> v_me) then
    raise exception 'G4_VERDICT_POSTCONDITION_ACL';
  end if;
  foreach v_api in array array['anon', 'authenticated', 'service_role', 'authenticator'] loop
    if exists (select 1 from pg_catalog.pg_roles r where r.rolname = v_api) and pg_catalog.has_function_privilege(v_api, v_fn, 'EXECUTE') then
      raise exception 'G4_VERDICT_POSTCONDITION_API_ROLE_REACHES %', v_api;
    end if;
  end loop;
  if (select count(*) from pg_catalog.pg_proc p where p.pronamespace = to_regnamespace('postona_g4_credential')) <> 2 then
    raise exception 'G4_VERDICT_POSTCONDITION_INVENTORY';
  end if;
end $$;

commit;
