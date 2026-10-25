-- POSTONA X single manual post — live pre-send fence (M1-F1) and an honest result record (M1-F3)
-- (F3 SOURCE CANDIDATE, 2026-10-18). NOT in supabase/migrations/. Applies only after 001-005, G5/F5's Phase 3b guard
-- (T13) and Phase 5 brand state (public.common_account_brand_service_state, private.account_lifecycle_brand_owner), and the
-- Stage 3B publish authority when present. Never apply without G4's verified predicate / credential source, F5's
-- approval, one Sol（高） review of the Auth / token / send boundary (with G4 and F5) and the user's explicit approval.
--
-- F5's M1 contract (PR #275, B1-B8) asks F3 for: (2) a fresh F5 workspace-state read in the pre-send step (M1-F1);
-- (3) the workspace owner, G4's verification, the credential owner and the credential GENERATION re-read just before the
-- send, refusing on any change; (5) an `after_freeze` flag from a fresh F5 read when the result is recorded (M1-F3: no lock
-- spans the X call; an in-flight post that completes after a freeze is recorded as it happened, never hidden); (6) a mock
-- transport's result stays marked simulated. B6: publishing must be switched on for the account.
--
-- What it changes (F3-owned postona_x_resv objects only; no F5 / G4 / Stage 3B object is changed):
--   * single_post_fence (005) now also requires, after T13 + owner / G5 / G4 + authority: the account's publish switch ON
--     (public.social_accounts.publish_enabled -- B6), F5's brand-level state public.common_account_brand_service_state(brand,
--     'x_autopost') = 'active' (owner resolved by F5: the single owner of a user workspace, account active, entitlement
--     active, nothing being deleted -- B7 / M1-F1), F5's workspace owner private.account_lifecycle_brand_owner(brand) =
--     the caller (B4), and a credential that is not being refreshed / degraded.
--   * x_credential_generation(account): the credential generation -- SHA-256 over the account, its workspace and F5's owner
--     of it, the X user id, both Vault references, the connection status, verified_at and the row's updated_at, and (where
--     the refresh core's table exists) the refresh state's generation and status. It changes on a refresh, a reconnect, a
--     Vault reference change, any write to the account row or an owner change. Vault itself is never read.
--   * single_post_bindings: one row per single post -- owner, workspace, the generation bound at begin, then the transport
--     ('x' | 'simulated') and after_freeze set when the result is recorded.
--   * post_now_begin (replaced, same signature and answers) binds the generation; post_now_preflight (new; replaces
--     post_now_check for the API role) re-runs the fence and refuses if the owner, the workspace or the generation changed
--     since begin (failed CREDENTIAL_CHANGED, never sent), then the existing pre_publish_check, and answers the generation
--     the sender must see on the token it uses; post_now_record (new; replaces post_now_finish) records the outcome
--     (existing finish) plus transport and after_freeze (a fresh F5 brand-state read at record time); post_now_readback (new;
--     replaces post_now_get) answers state, the stored X id, after_freeze and simulated.
-- Rollback: 006_postona_x_single_post_live_fence_rollback.sql (restores 005's bodies and grants exactly).
begin;

do $$
declare v_fn regprocedure; v_p record; v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  if to_regprocedure('postona_x_resv.post_now_begin(text,uuid,text,text)') is null
     or to_regprocedure('postona_x_resv.single_post_fence(uuid,text)') is null then
    raise exception 'POSTONA_X_SINGLE_POST_FENCE_PRECONDITION_005_MISSING';
  end if;
  if to_regclass('postona_x_resv.single_post_bindings') is not null or to_regprocedure('postona_x_resv.post_now_preflight(uuid,uuid)') is not null then
    raise exception 'POSTONA_X_SINGLE_POST_FENCE_ALREADY_APPLIED';
  end if;
  -- F5 Phase 5: brand state (text,text) -> text, stable definer; brand owner (text) -> uuid; both owned by this owner.
  v_fn := to_regprocedure('public.common_account_brand_service_state(text,text)');
  if v_fn is null or to_regprocedure('private.account_lifecycle_brand_owner(text)') is null then
    raise exception 'POSTONA_X_SINGLE_POST_FENCE_PRECONDITION_F5_BRAND_STATE_MISSING';
  end if;
  select p.prorettype::regtype::text as ret, p.provolatile, p.prosecdef, p.proowner into v_p from pg_catalog.pg_proc p where p.oid = v_fn;
  if v_p.ret <> 'text' or v_p.provolatile <> 's' or not v_p.prosecdef or v_p.proowner <> v_owner
     or (select p.prorettype::regtype::text from pg_catalog.pg_proc p where p.oid = 'private.account_lifecycle_brand_owner(text)'::regprocedure) <> 'uuid'
     or (select p.proowner from pg_catalog.pg_proc p where p.oid = 'private.account_lifecycle_brand_owner(text)'::regprocedure) <> v_owner
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'postona_resv_api', 'postona_resv_worker')
                and (pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE')
                     or pg_catalog.has_function_privilege(r.oid, 'private.account_lifecycle_brand_owner(text)', 'EXECUTE'))) then
    raise exception 'POSTONA_X_SINGLE_POST_FENCE_PRECONDITION_F5_BRAND_STATE_CONTRACT';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'social_accounts'
      and column_name in ('id', 'brand_id', 'platform_user_id', 'vault_access_token_secret_id', 'vault_refresh_token_secret_id',
                          'connection_status', 'verified_at', 'updated_at', 'publish_enabled')) <> 9 then
    raise exception 'POSTONA_X_SINGLE_POST_FENCE_PRECONDITION_SOCIAL_ACCOUNTS_SHAPE';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from v_owner then
    raise exception 'POSTONA_X_SINGLE_POST_FENCE_PRECONDITION_OWNER';
  end if;
end $$;

create table postona_x_resv.single_post_bindings (
  reservation_id uuid primary key references postona_x_resv.reservations (id) on delete cascade,
  owner_user_id uuid not null,
  brand_id text not null,
  credential_generation text not null check (credential_generation ~ '^[0-9a-f]{64}$'),
  transport text check (transport in ('x', 'simulated')),
  after_freeze boolean,
  bound_at timestamptz not null default now(),
  recorded_at timestamptz
);
alter table postona_x_resv.single_post_bindings enable row level security;
revoke all on table postona_x_resv.single_post_bindings from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;

/** The credential generation of one X account (see the header). Internal: no API role may call it. The refresh state
 *  (public.x_account_refresh_state_v2, the refresh core's table) is read only where that table exists: the refresh core
 *  is itself a candidate, and without it a refresh cannot rotate the token behind the account's back. */
create function postona_x_resv.x_credential_generation(p_social_account_id text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_sa public.social_accounts%rowtype; v_refresh_generation bigint; v_refresh_status text;
begin
  select sa.* into v_sa from public.social_accounts sa where sa.id = p_social_account_id;
  if v_sa.id is null then
    return null;
  end if;
  if to_regclass('public.x_account_refresh_state_v2') is not null then
    execute 'select st.generation, st.status from public.x_account_refresh_state_v2 st where st.social_account_id = $1'
      into v_refresh_generation, v_refresh_status using p_social_account_id;
  end if;
  return pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'v', 1, 'account', v_sa.id, 'brand', v_sa.brand_id, 'owner', private.account_lifecycle_brand_owner(v_sa.brand_id),
    'platform_user_id', v_sa.platform_user_id, 'access', v_sa.vault_access_token_secret_id, 'refresh', v_sa.vault_refresh_token_secret_id,
    'connection', v_sa.connection_status, 'verified_at', v_sa.verified_at, 'account_updated_at', v_sa.updated_at,
    'refresh_generation', v_refresh_generation, 'refresh_status', v_refresh_status)::text, 'UTF8')), 'hex');
end $$;

-- The fence (005's, extended): T13 first, then owner / G5 / G4, authority, and now B6 / B7 / B4 and the credential state.
create or replace function postona_x_resv.single_post_fence(p_user_id uuid, p_social_account_id text) returns text
language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
-- SINGLE_POST_LIVE_FENCE_V1 (F3 2026-10-18, M1-F1)
declare v_brand text; v_code text; v_authority text; v_refresh text;
begin
  begin
    perform private.account_lifecycle_assert_active_service_write(p_user_id, 'x_autopost');
  exception
    when lock_not_available then
      raise exception 'POSTONA_RESV_SERVICE_BUSY' using errcode = 'P0001';
    when insufficient_privilege then
      v_code := sqlerrm;
      raise exception '%', case v_code when 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' then 'POSTONA_RESV_AUTH_REQUIRED'
                                       else 'POSTONA_RESV_SERVICE_NOT_ACTIVE' end using errcode = 'P0001';
  end;
  v_brand := postona_x_resv.assert_account_access(p_user_id, p_social_account_id);
  if to_regclass('public.x_account_publish_authority') is not null then
    execute 'select pa.state from public.x_account_publish_authority pa where pa.social_account_id = $1' into v_authority using p_social_account_id;
    if v_authority = 'revoked' then
      raise exception 'POSTONA_RESV_PUBLISH_AUTHORITY_REVOKED' using errcode = 'P0001';
    end if;
  end if;
  -- B6: publishing switched on for this account (PR #262's switch).
  if (select sa.publish_enabled from public.social_accounts sa where sa.id = p_social_account_id) is not true then
    raise exception 'POSTONA_RESV_PUBLISH_DISABLED' using errcode = 'P0001';
  end if;
  -- B7 / M1-F1: F5's fresh workspace state, owner resolved by F5 (read-only; T13 above already holds the I1 locks).
  if public.common_account_brand_service_state(v_brand, 'x_autopost') is distinct from 'active' then
    raise exception 'POSTONA_RESV_SERVICE_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  -- B4: F5's owner of the workspace is exactly the caller (a second owner or none refuses).
  if private.account_lifecycle_brand_owner(v_brand) is distinct from p_user_id then
    raise exception 'POSTONA_RESV_ACCOUNT_NOT_FOUND' using errcode = 'P0001';
  end if;
  -- The credential is not being refreshed (busy) and not degraded.
  if to_regclass('public.x_account_refresh_state_v2') is not null then
    execute 'select st.status from public.x_account_refresh_state_v2 st where st.social_account_id = $1' into v_refresh using p_social_account_id;
  end if;
  if v_refresh = 'refreshing' then
    raise exception 'POSTONA_RESV_SERVICE_BUSY' using errcode = 'P0001';
  elsif v_refresh in ('uncertain', 'reauth_required') then
    raise exception 'POSTONA_RESV_CREDENTIAL_DEGRADED' using errcode = 'P0001';
  end if;
  return v_brand;
end $$;

-- begin (005's, unchanged answers) + the generation binding.
create or replace function postona_x_resv.post_now_begin(p_social_account_id text, p_client_request_id uuid, p_text text, p_content_sha256 text)
returns table (reservation_id uuid, lease_token uuid, state text, provider_post_id text, outcome_code text)
language plpgsql volatile security definer set search_path = '' as $$
-- SINGLE_POST_LIVE_FENCE_V1 (F3 2026-10-18): 005's begin + the credential generation bound for this attempt.
declare v_user uuid := postona_x_resv.caller(); v_brand text; v_sha text; v_batch postona_x_resv.batches%rowtype;
        v_row postona_x_resv.reservations%rowtype; v_token uuid := gen_random_uuid(); v_batch_id uuid := gen_random_uuid();
        v_now timestamptz := pg_catalog.now();
begin
  if p_social_account_id is null or p_client_request_id is null or p_text is null or p_content_sha256 is null then
    raise exception 'POSTONA_RESV_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  if pg_catalog.length(p_text) = 0 or pg_catalog.length(p_text) > 2000 or p_text ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]'
     or postona_x_resv.x_weighted_length(p_text) > 280 then
    raise exception 'POSTONA_RESV_TEXT_INVALID' using errcode = 'P0001';
  end if;
  v_sha := postona_x_resv.sha256_hex(p_text);
  if p_content_sha256 is distinct from v_sha then
    raise exception 'POSTONA_RESV_CONSENT_REQUIRED' using errcode = 'P0001';
  end if;
  v_brand := postona_x_resv.single_post_fence(v_user, p_social_account_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('postona_x_resv:' || p_social_account_id, 0));
  select b.* into v_batch from postona_x_resv.batches b
   where b.user_id = v_user and b.social_account_id = p_social_account_id and b.client_batch_id = p_client_request_id and b.revision = 1;
  if found then
    select r.* into v_row from postona_x_resv.reservations r where r.batch_id = v_batch.id and r.position = 0 for update;
    if not found or v_row.draft_id !~ '^single:' or v_batch.payload_sha256 is distinct from v_sha then
      raise exception 'POSTONA_RESV_IDEMPOTENCY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_row.status = 'claimed' and v_row.lease_expires_at > pg_catalog.clock_timestamp() then
      reservation_id := v_row.id; state := 'in_progress'; return next; return;
    end if;
    if v_row.status = 'claimed' then  -- its sender's lease ran out: the X outcome is unknown, never re-sent
      update postona_x_resv.reservations r set status = 'uncertain', outcome_code = 'LEASE_EXPIRED', updated_at = pg_catalog.now() where r.id = v_row.id;
      reservation_id := v_row.id; state := 'uncertain'; outcome_code := 'LEASE_EXPIRED'; return next; return;
    end if;
    if v_row.status in ('planned', 'expired') then  -- provably never sent: re-arm for this request
      update postona_x_resv.reservations r
      set status = 'claimed', lease_token = v_token, claimed_by = 'single_post',
          lease_expires_at = pg_catalog.clock_timestamp() + interval '60 seconds', updated_at = pg_catalog.now()
      where r.id = v_row.id;
      insert into postona_x_resv.single_post_bindings (reservation_id, owner_user_id, brand_id, credential_generation)
      values (v_row.id, v_user, v_brand, postona_x_resv.x_credential_generation(p_social_account_id))
      on conflict on constraint single_post_bindings_pkey do update
        set owner_user_id = excluded.owner_user_id, brand_id = excluded.brand_id, credential_generation = excluded.credential_generation,
            transport = null, after_freeze = null, bound_at = pg_catalog.now(), recorded_at = null;
      insert into postona_x_resv.audit (user_id, batch_id, reservation_id, action, detail)
      values (v_user, v_batch.id, v_row.id, 'single_post_rearm', '{}'::jsonb);
      reservation_id := v_row.id; lease_token := v_token; state := 'claimed'; return next; return;
    end if;
    reservation_id := v_row.id;
    state := case v_row.status when 'published' then 'sent' when 'uncertain' then 'uncertain' else 'failed' end;
    provider_post_id := v_row.provider_post_id; outcome_code := v_row.outcome_code;
    return next; return;
  end if;
  insert into postona_x_resv.batches (id, user_id, brand_id, social_account_id, client_batch_id, revision, mode, origin, time_zone, band, payload_sha256)
  values (v_batch_id, v_user, v_brand, p_social_account_id, p_client_request_id, 1, 'manual_exact', 'user_authored', 'Asia/Tokyo', null, v_sha);
  insert into postona_x_resv.reservations (batch_id, user_id, brand_id, social_account_id, draft_id, position, origin, mode, body, content_sha256,
    scheduled_at, fixed, status, revision, consent_state, consent_sha256, consent_scheduled_at, consent_revision, consent_at, expires_at,
    lease_token, lease_expires_at, claimed_by)
  values (v_batch_id, v_user, v_brand, p_social_account_id, 'single:' || pg_catalog.replace(p_client_request_id::text, '-', ''), 0, 'user_authored',
    'manual_exact', p_text, v_sha, v_now, true, 'claimed', 1, 'confirmed', v_sha, v_now, 1, v_now, v_now,
    v_token, pg_catalog.clock_timestamp() + interval '60 seconds', 'single_post')
  returning * into v_row;
  insert into postona_x_resv.single_post_bindings (reservation_id, owner_user_id, brand_id, credential_generation)
  values (v_row.id, v_user, v_brand, postona_x_resv.x_credential_generation(p_social_account_id));
  insert into postona_x_resv.audit (user_id, batch_id, reservation_id, action, detail)
  values (v_user, v_batch_id, v_row.id, 'single_post_begin', '{}'::jsonb);
  reservation_id := v_row.id; lease_token := v_token; state := 'claimed';
  return next;
end $$;

/** Right before the X call: the fence again, then owner / workspace / credential generation unchanged since begin, then the
 *  existing pre_publish_check. Answers the verdict and, when OK, the generation the sender's token must carry. */
create function postona_x_resv.post_now_preflight(p_reservation_id uuid, p_lease_token uuid)
returns table (verdict text, credential_generation text)
language plpgsql volatile security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller(); v_row postona_x_resv.reservations%rowtype; v_bind postona_x_resv.single_post_bindings%rowtype;
        v_code text; v_now_generation text;
begin
  v_row := postona_x_resv.own_single_post(v_user, p_reservation_id);
  if v_row.id is null or v_row.status <> 'claimed' or v_row.lease_token is distinct from p_lease_token then
    verdict := 'LEASE_LOST'; return next; return;
  end if;
  begin
    perform postona_x_resv.single_post_fence(v_user, v_row.social_account_id);
  exception when others then
    v_code := sqlerrm;
    if v_code = 'POSTONA_RESV_SERVICE_BUSY' then
      verdict := case when postona_x_resv.release_claim(p_reservation_id, p_lease_token, 'SERVICE_BUSY') then 'RELEASED' else 'LEASE_LOST' end;
      return next; return;
    end if;
    if v_code !~ '^POSTONA_RESV_' then
      raise;
    end if;
    update postona_x_resv.reservations r set status = 'failed', outcome_code = 'NOT_PUBLISHABLE_AT_SEND', updated_at = pg_catalog.now()
    where r.id = p_reservation_id and r.status = 'claimed' and r.lease_token = p_lease_token;
    verdict := case when found then 'NOT_PUBLISHABLE' else 'LEASE_LOST' end; return next; return;
  end;
  select b.* into v_bind from postona_x_resv.single_post_bindings b where b.reservation_id = p_reservation_id;
  v_now_generation := postona_x_resv.x_credential_generation(v_row.social_account_id);
  if v_bind.reservation_id is null or v_bind.owner_user_id is distinct from v_user or v_bind.brand_id is distinct from v_row.brand_id
     or v_bind.credential_generation is distinct from v_now_generation then
    update postona_x_resv.reservations r set status = 'failed', outcome_code = 'CREDENTIAL_CHANGED', updated_at = pg_catalog.now()
    where r.id = p_reservation_id and r.status = 'claimed' and r.lease_token = p_lease_token;
    verdict := case when found then 'NOT_PUBLISHABLE' else 'LEASE_LOST' end; return next; return;
  end if;
  verdict := postona_x_resv.pre_publish_check(p_reservation_id, p_lease_token);
  if verdict = 'OK' then
    credential_generation := v_now_generation;
  end if;
  return next;
end $$;

/** The outcome (existing finish) + transport + after_freeze from a fresh F5 brand-state read at record time. */
create function postona_x_resv.post_now_record(p_reservation_id uuid, p_lease_token uuid, p_outcome text, p_provider_post_id text, p_code text, p_transport text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller(); v_row postona_x_resv.reservations%rowtype; v_recorded text;
begin
  if p_transport is null or p_transport not in ('x', 'simulated') then
    raise exception 'POSTONA_RESV_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  v_row := postona_x_resv.own_single_post(v_user, p_reservation_id);
  if v_row.id is null then
    raise exception 'POSTONA_RESV_LEASE_LOST' using errcode = 'P0001';
  end if;
  v_recorded := postona_x_resv.finish(p_reservation_id, p_lease_token, p_outcome, p_provider_post_id, p_code);
  update postona_x_resv.single_post_bindings b
  set transport = p_transport,
      after_freeze = public.common_account_brand_service_state(v_row.brand_id, 'x_autopost') is distinct from 'active',
      recorded_at = pg_catalog.now()
  where b.reservation_id = p_reservation_id and b.recorded_at is null;
  return v_recorded;
end $$;

create function postona_x_resv.post_now_readback(p_reservation_id uuid)
returns table (reservation_id uuid, state text, provider_post_id text, outcome_code text, after_freeze boolean, simulated boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller(); v_row postona_x_resv.reservations%rowtype; v_bind postona_x_resv.single_post_bindings%rowtype;
begin
  v_row := postona_x_resv.own_single_post(v_user, p_reservation_id);
  if v_row.id is null then
    raise exception 'POSTONA_RESV_NOT_FOUND' using errcode = 'P0001';
  end if;
  select b.* into v_bind from postona_x_resv.single_post_bindings b where b.reservation_id = p_reservation_id;
  reservation_id := v_row.id;
  -- G3-33 X5: a claimed row whose lease ran out may have reached X: 'uncertain' until a sweep / reconciliation says more
  -- (the same answer as Threads' receipt, 007). Read only: the row is not changed here.
  state := case v_row.status when 'published' then 'sent' when 'uncertain' then 'uncertain'
                             when 'failed' then 'failed' when 'cancelled' then 'failed'
                             when 'claimed' then case when v_row.lease_expires_at > pg_catalog.clock_timestamp() then 'pending' else 'uncertain' end
                             else 'pending' end;
  provider_post_id := v_row.provider_post_id; outcome_code := v_row.outcome_code;
  after_freeze := coalesce(v_bind.after_freeze, false);
  simulated := v_bind.transport is distinct from 'x';  -- unknown transport is never reported as a real post
  return next;
end $$;

revoke all on function postona_x_resv.x_credential_generation(text) from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
revoke all on function postona_x_resv.single_post_fence(uuid, text) from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
revoke all on function postona_x_resv.post_now_begin(text, uuid, text, text) from public, anon, authenticated, service_role, postona_resv_worker;
revoke all on function postona_x_resv.post_now_preflight(uuid, uuid) from public, anon, authenticated, service_role, postona_resv_worker;
revoke all on function postona_x_resv.post_now_record(uuid, uuid, text, text, text, text) from public, anon, authenticated, service_role, postona_resv_worker;
revoke all on function postona_x_resv.post_now_readback(uuid) from public, anon, authenticated, service_role, postona_resv_worker;
-- The 005 steps without the generation / after_freeze are no longer reachable by the API role.
revoke execute on function postona_x_resv.post_now_check(uuid, uuid), postona_x_resv.post_now_finish(uuid, uuid, text, text, text),
  postona_x_resv.post_now_get(uuid) from postona_resv_api;
grant execute on function
  postona_x_resv.post_now_begin(text, uuid, text, text),
  postona_x_resv.post_now_preflight(uuid, uuid),
  postona_x_resv.post_now_record(uuid, uuid, text, text, text, text),
  postona_x_resv.post_now_readback(uuid)
to postona_resv_api;

do $$
declare v_role text; v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text) into v_bad from pg_catalog.pg_proc p
  where p.pronamespace = 'postona_x_resv'::regnamespace and pg_catalog.has_function_privilege('postona_resv_api', p.oid, 'EXECUTE');
  if v_bad is distinct from 'postona_x_resv.cancel(uuid,integer),postona_x_resv.create_batch(text,uuid,integer,text,jsonb,jsonb),'
                            'postona_x_resv.get_reservation(uuid),postona_x_resv.list_reservations(text),'
                            'postona_x_resv.post_now_begin(text,uuid,text,text),postona_x_resv.post_now_preflight(uuid,uuid),'
                            'postona_x_resv.post_now_readback(uuid),postona_x_resv.post_now_record(uuid,uuid,text,text,text,text),'
                            'postona_x_resv.reconfirm(uuid,integer,text),postona_x_resv.reschedule(uuid,integer,timestamp with time zone)' then
    raise exception 'POSTONA_X_SINGLE_POST_FENCE_POSTCONDITION: postona_resv_api executes %', v_bad;
  end if;
  select string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text) into v_bad from pg_catalog.pg_proc p
  where p.pronamespace = 'postona_x_resv'::regnamespace and pg_catalog.has_function_privilege('postona_resv_worker', p.oid, 'EXECUTE');
  if v_bad is distinct from 'postona_x_resv.claim_due(text,integer,integer),postona_x_resv.finish(uuid,uuid,text,text,text),'
                            'postona_x_resv.pre_publish_check(uuid,uuid),postona_x_resv.release_unsent(uuid,uuid)' then
    raise exception 'POSTONA_X_SINGLE_POST_FENCE_POSTCONDITION: postona_resv_worker executes %', v_bad;
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    select string_agg(p.proname, ',') into v_bad from pg_catalog.pg_proc p
    where p.pronamespace = 'postona_x_resv'::regnamespace and pg_catalog.has_function_privilege(v_role, p.oid, 'EXECUTE');
    if v_bad is not null then raise exception 'POSTONA_X_SINGLE_POST_FENCE_POSTCONDITION: % executes %', v_role, v_bad; end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_proc p where p.pronamespace = 'postona_x_resv'::regnamespace
             and p.prosecdef and p.proconfig is distinct from array['search_path=""']
             and not (p.proname = 'single_post_fence' and p.proconfig = array['search_path=""', 'lock_timeout=3s'])) then
    raise exception 'POSTONA_X_SINGLE_POST_FENCE_POSTCONDITION: definer search_path';
  end if;
  if exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'postona_resv_api', 'postona_resv_worker']) r(role)
             where pg_catalog.has_table_privilege(r.role, 'postona_x_resv.single_post_bindings', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) then
    raise exception 'POSTONA_X_SINGLE_POST_FENCE_POSTCONDITION: bindings reachable';
  end if;
end $$;

commit;
