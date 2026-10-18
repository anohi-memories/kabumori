-- F5 M1 (first manual X post): a TEST-ONLY model of the authorization chain, for a THROW-AWAY LOCAL PostgreSQL 17. NOT a migration, NOT a
-- candidate, never applied anywhere else. It exists so that F5's REAL lifecycle SQL (Phase 1..10, loaded before this file) can be exercised in the
-- order F3's single-post orchestrator needs, with test doubles for what F5 does not own:
--
--   F5 (REAL SQL)  private.account_lifecycle_assert_active_service_write(uuid, text)   login session + entitlement + common account, T13, locks held
--                  private.account_lifecycle_brand_owner(text)                          who owns a workspace (exactly one owner of a user workspace)
--                  public.common_account_brand_service_state(text, text)                the worker-side, advisory state read (no session)
--   G4 (DOUBLE)    m1_fixture.g4_account                                                verified X identity + credential owner + credential generation
--   F3 (MODEL)     m1_fixture.authorize_manual_post / presend_check / record_result     the SHAPE of the wrappers F3 builds; F3's real SQL is not used here
--
-- Every function is owned by the lifecycle owner (the role that runs this file) and SECURITY DEFINER with an empty search_path, as F3's
-- wrappers are. The model never calls X: the transport is a counter in the test. A result it stores is SIMULATED and never evidence of a real post.
create schema m1_fixture;
revoke all on schema m1_fixture from public;
grant usage on schema m1_fixture to authenticated, service_role;

-- G4's side, as a double: who the verified X identity belongs to, who owns the credential, and the credential's generation (a refresh or a
-- re-connect changes it). The real predicate is postona_x_resv.g4_x_account_verified(user, account) and XPostingCredentialSource (G4-owned).
create table m1_fixture.g4_account (
  social_account_id text primary key,
  verified_user_id uuid,
  credential_owner_id uuid,
  credential_generation integer not null default 1
);

create table m1_fixture.intent (
  intent_id uuid primary key default gen_random_uuid(),
  request_id text not null,
  user_id uuid not null,
  brand_id text not null,
  social_account_id text not null,
  credential_generation integer not null,
  text_sha256 text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),
  state text not null default 'authorized' check (state in ('authorized', 'sent', 'failed', 'uncertain')),
  simulated_x_id text,
  simulated boolean not null default true check (simulated),
  after_freeze boolean,
  created_at timestamptz not null default now(),
  unique (user_id, request_id)
);

create function m1_fixture.refused(p_code text) returns jsonb language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_build_object('status', 'refused', 'code', p_code)
$$;

-- User path: the person's own JWT (role authenticated). T13 FIRST, in this transaction, locks held to COMMIT; then ownership, G4, the switch; then
-- the intent is stored (idempotent per user and request id). F3's real wrapper has this order (PR #257 / #262 shape).
create function m1_fixture.authorize_manual_post(p_social_account_id text, p_request_id text, p_text_sha256 text)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_user uuid := auth.uid();
  v_brand text;
  v_enabled boolean;
  v_g4 m1_fixture.g4_account;
  v_intent m1_fixture.intent;
begin
  if v_user is null then
    return m1_fixture.refused('ACCOUNT_LIFECYCLE_AUTH_REQUIRED');
  end if;
  begin
    perform private.account_lifecycle_assert_active_service_write(v_user, 'x_autopost');
  exception
    when lock_not_available then
      return pg_catalog.jsonb_build_object('status', 'busy', 'code', 'ACCOUNT_LIFECYCLE_BUSY');
    when insufficient_privilege then
      return m1_fixture.refused(sqlerrm);
  end;
  select a.brand_id, a.publish_enabled into v_brand, v_enabled from public.social_accounts a where a.id = p_social_account_id;
  if not found then
    return m1_fixture.refused('ACCOUNT_NOT_FOUND');
  end if;
  if private.account_lifecycle_brand_owner(v_brand) is distinct from v_user then
    return m1_fixture.refused('NOT_WORKSPACE_OWNER');
  end if;
  select * into v_g4 from m1_fixture.g4_account g where g.social_account_id = p_social_account_id;
  if not found or v_g4.verified_user_id is distinct from v_user then
    return m1_fixture.refused('CONNECTION_NOT_VERIFIED');
  end if;
  if v_g4.credential_owner_id is distinct from v_user then
    return m1_fixture.refused('CREDENTIAL_OWNER_MISMATCH');
  end if;
  if v_enabled is distinct from true then
    return m1_fixture.refused('X_ACCOUNT_PUBLISH_DISABLED');
  end if;
  select * into v_intent from m1_fixture.intent i where i.user_id = v_user and i.request_id = p_request_id;
  if found then
    -- a replay of the same request: the same intent, never a second one
    return pg_catalog.jsonb_build_object('status', 'authorized', 'intent_id', v_intent.intent_id, 'replay', true, 'state', v_intent.state);
  end if;
  insert into m1_fixture.intent (request_id, user_id, brand_id, social_account_id, credential_generation, text_sha256)
  values (p_request_id, v_user, v_brand, p_social_account_id, v_g4.credential_generation, p_text_sha256)
  returning * into v_intent;
  return pg_catalog.jsonb_build_object('status', 'authorized', 'intent_id', v_intent.intent_id, 'replay', false, 'state', v_intent.state);
end $$;

-- Worker path: no person's session (service_role). The LAST check before the X call, from fresh reads. F5's part is the advisory read of the
-- workspace owner's service state; everything else is the other owners' (credential generation: G4; the switch: F3's live column).
create function m1_fixture.presend_check(p_intent_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_intent m1_fixture.intent;
  v_state text;
  v_g4 m1_fixture.g4_account;
  v_enabled boolean;
begin
  select * into v_intent from m1_fixture.intent i where i.intent_id = p_intent_id;
  if not found or v_intent.state <> 'authorized' then
    return m1_fixture.refused('INTENT_NOT_AUTHORIZED');
  end if;
  v_state := public.common_account_brand_service_state(v_intent.brand_id, 'x_autopost');
  if v_state is distinct from 'active' then
    return m1_fixture.refused(v_state);
  end if;
  if private.account_lifecycle_brand_owner(v_intent.brand_id) is distinct from v_intent.user_id then
    return m1_fixture.refused('OWNER_CHANGED');
  end if;
  select * into v_g4 from m1_fixture.g4_account g where g.social_account_id = v_intent.social_account_id;
  if not found or v_g4.verified_user_id is distinct from v_intent.user_id then
    return m1_fixture.refused('CONNECTION_NOT_VERIFIED');
  end if;
  if v_g4.credential_owner_id is distinct from v_intent.user_id then
    return m1_fixture.refused('CREDENTIAL_OWNER_MISMATCH');
  end if;
  if v_g4.credential_generation is distinct from v_intent.credential_generation then
    return m1_fixture.refused('CREDENTIAL_CHANGED');
  end if;
  select a.publish_enabled into v_enabled from public.social_accounts a where a.id = v_intent.social_account_id;
  if v_enabled is distinct from true then
    return m1_fixture.refused('X_ACCOUNT_PUBLISH_DISABLED');
  end if;
  return pg_catalog.jsonb_build_object('status', 'ok', 'intent_id', v_intent.intent_id);
end $$;

-- Result: exactly one transition from 'authorized'. It does NOT ask F5 whether the service is still active: a post that X accepted is recorded
-- as it happened. `after_freeze` says what F5 reports at record time (the honest limit: no database lock spans the call to X).
create function m1_fixture.record_result(p_intent_id uuid, p_outcome text, p_simulated_x_id text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_intent m1_fixture.intent;
  v_after_freeze boolean;
begin
  if p_outcome is null or p_outcome not in ('sent', 'failed', 'uncertain') then
    return m1_fixture.refused('OUTCOME_INVALID');
  end if;
  select * into v_intent from m1_fixture.intent i where i.intent_id = p_intent_id for update;
  if not found or v_intent.state <> 'authorized' then
    return m1_fixture.refused('INTENT_NOT_AUTHORIZED');
  end if;
  v_after_freeze := public.common_account_brand_service_state(v_intent.brand_id, 'x_autopost') is distinct from 'active';
  update m1_fixture.intent set state = p_outcome, simulated_x_id = p_simulated_x_id, after_freeze = v_after_freeze where intent_id = p_intent_id;
  return pg_catalog.jsonb_build_object('status', 'recorded', 'state', p_outcome, 'after_freeze', v_after_freeze);
end $$;

create function m1_fixture.read_back(p_intent_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.to_jsonb(i) - 'user_id' from m1_fixture.intent i where i.intent_id = p_intent_id
$$;

-- A probe of the F5 guard with an explicit person, so that a token whose subject is another person can be shown refused. Test only.
create function m1_fixture.guard_probe(p_user_id uuid, p_service_key text)
returns text language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
begin
  perform private.account_lifecycle_assert_active_service_write(p_user_id, p_service_key);
  return 'allowed';
exception when insufficient_privilege then
  return sqlerrm;
end $$;

revoke all on all functions in schema m1_fixture from public, anon, authenticated, service_role;
grant execute on function m1_fixture.authorize_manual_post(text, text, text) to authenticated;
grant execute on function m1_fixture.guard_probe(uuid, text) to authenticated;
grant execute on function m1_fixture.presend_check(uuid), m1_fixture.record_result(uuid, text, text), m1_fixture.read_back(uuid) to service_role;
