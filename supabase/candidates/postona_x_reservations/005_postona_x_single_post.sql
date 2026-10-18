-- POSTONA X single manual post ("send now") — F3 SOURCE CANDIDATE (2026-10-18, M1). NOT in supabase/migrations/.
-- Applies only after 001 + 002 + 003 (G5 binding) + 004 (dispatch) and G5/F5's Phase 3b service-write guard (T13).
-- Never apply anywhere until G4 delivers the verified-X-account predicate and the credential source (Issue #131; the
-- predicate stays the shipped DENY), F5's candidates are approved and applied, one Sol（高） review of the Auth / X send
-- boundary, and the user's explicit approval.
--
-- One manual text post, sent now, is ONE reservation row of the existing schema -- no second store, no second state
-- machine, no second publisher: the existing pre_publish_check / finish / release / uncertain fencing applies as is.
-- The row is created already 'claimed' by the request (never 'planned' for the delivery worker: expires_at = its own
-- creation time, so claim_due never picks it up; the delivery worker's sweep still turns an expired lease into
-- 'uncertain'). Four owner functions for the API role (postona_resv_api), each re-deciding from the caller:
--   post_now_begin(account, client_request_id, text, content_sha256)
--       T13 FIRST (private.account_lifecycle_assert_active_service_write(caller, 'x_autopost'): live session, account
--       active, no deletion, x_autopost active; G5's locks held to COMMIT), then the account's owner / brand / G5 / G4
--       (assert_account_access), then a publish authority that a stop function revoked refuses. The per-action consent
--       is the SHA-256 of exactly this text. Idempotent on (caller, account, client_request_id): a repeat never sends
--       twice -- it answers the stored state (in_progress / sent / failed / uncertain); a row that provably was never
--       sent (planned / expired) is re-armed. Answers (reservation_id, lease_token, state, provider_post_id, outcome_code)
--       with state claimed (send now with this lease) | in_progress | sent | failed | uncertain.
--   post_now_check(reservation, lease)   right before the X call: the same fence again (a service ended, a session
--       signed out, a G4 / authority revocation since begin refuses -> failed, never sent; a busy fence -> RELEASED,
--       never sent), then the existing pre_publish_check (G5 first, then the row): OK | RELEASED | NOT_PUBLISHABLE |
--       LEASE_LOST.
--   post_now_finish(reservation, lease, outcome, provider_post_id, code)   the existing finish (lease_lost after the
--       deadline: the row is fenced to 'uncertain', never 'published').
--   post_now_get(reservation)   the independent read-back: sent | failed | uncertain | pending, the stored X post id.
-- T13 codes are mapped onto the API's fixed codes (POSTONA_RESV_AUTH_REQUIRED / _SERVICE_NOT_ACTIVE / _SERVICE_BUSY).
-- Rollback: 005_postona_x_single_post_rollback.sql (drops the functions; rows stay valid reservation rows).
begin;

do $$
declare v_fn regprocedure; v_p record; v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  if to_regprocedure('postona_x_resv.release_claim(uuid,uuid,text)') is null or to_regrole('postona_resv_api') is null
     or to_regrole('postona_resv_worker') is null then
    raise exception 'POSTONA_X_SINGLE_POST_PRECONDITION_001_004_MISSING';
  end if;
  if (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'postona_x_resv.g5_x_autopost_allowed(uuid)'::regprocedure) !~ 'G5_BINDING' then
    raise exception 'POSTONA_X_SINGLE_POST_PRECONDITION_G5_BINDING_MISSING';
  end if;
  v_fn := to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)');
  if v_fn is null then
    raise exception 'POSTONA_X_SINGLE_POST_PRECONDITION_T13_MISSING';
  end if;
  select p.prorettype::regtype::text as ret, p.provolatile, p.prosecdef, p.proconfig, p.proowner into v_p from pg_catalog.pg_proc p where p.oid = v_fn;
  if v_p.ret <> 'void' or v_p.provolatile <> 'v' or not v_p.prosecdef or v_p.proconfig is distinct from array['search_path=""'] or v_p.proowner <> v_owner
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'postona_resv_api', 'postona_resv_worker')
                and pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE')) then
    raise exception 'POSTONA_X_SINGLE_POST_PRECONDITION_T13_CONTRACT';
  end if;
  if to_regprocedure('postona_x_resv.post_now_begin(text,uuid,text,text)') is not null then
    raise exception 'POSTONA_X_SINGLE_POST_ALREADY_APPLIED';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from v_owner then
    raise exception 'POSTONA_X_SINGLE_POST_PRECONDITION_OWNER';
  end if;
end $$;

/** The single-post fence, G5's locks first: T13 (person, session, service), then owner / brand / G5 / G4, then the
 *  publish authority. Returns the account's brand or raises a fixed POSTONA_RESV_* code. Internal (no grant). */
create function postona_x_resv.single_post_fence(p_user_id uuid, p_social_account_id text) returns text
language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare v_brand text; v_code text; v_authority text;
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
  return v_brand;
end $$;

create function postona_x_resv.post_now_begin(p_social_account_id text, p_client_request_id uuid, p_text text, p_content_sha256 text)
returns table (reservation_id uuid, lease_token uuid, state text, provider_post_id text, outcome_code text)
language plpgsql volatile security definer set search_path = '' as $$
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
  insert into postona_x_resv.audit (user_id, batch_id, reservation_id, action, detail)
  values (v_user, v_batch_id, v_row.id, 'single_post_begin', '{}'::jsonb);
  reservation_id := v_row.id; lease_token := v_token; state := 'claimed';
  return next;
end $$;

/** The caller's own single-post row (plain read), or null. */
create function postona_x_resv.own_single_post(p_user_id uuid, p_reservation_id uuid) returns postona_x_resv.reservations
language sql stable security definer set search_path = '' as $$
  select r.* from postona_x_resv.reservations r where r.id = p_reservation_id and r.user_id = p_user_id and r.draft_id ~ '^single:'
$$;

create function postona_x_resv.post_now_check(p_reservation_id uuid, p_lease_token uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller(); v_row postona_x_resv.reservations%rowtype; v_code text;
begin
  v_row := postona_x_resv.own_single_post(v_user, p_reservation_id);
  if v_row.id is null or v_row.status <> 'claimed' or v_row.lease_token is distinct from p_lease_token then
    return 'LEASE_LOST';
  end if;
  begin
    perform postona_x_resv.single_post_fence(v_user, v_row.social_account_id);
  exception when others then
    v_code := sqlerrm;
    if v_code = 'POSTONA_RESV_SERVICE_BUSY' then
      return case when postona_x_resv.release_claim(p_reservation_id, p_lease_token, 'SERVICE_BUSY') then 'RELEASED' else 'LEASE_LOST' end;
    end if;
    if v_code !~ '^POSTONA_RESV_' then
      raise;
    end if;
    -- The person may no longer send (service, session, owner, G4 or authority changed since begin): never sent.
    update postona_x_resv.reservations r set status = 'failed', outcome_code = 'NOT_PUBLISHABLE_AT_SEND', updated_at = pg_catalog.now()
    where r.id = p_reservation_id and r.status = 'claimed' and r.lease_token = p_lease_token;
    return case when found then 'NOT_PUBLISHABLE' else 'LEASE_LOST' end;
  end;
  return postona_x_resv.pre_publish_check(p_reservation_id, p_lease_token);
end $$;

create function postona_x_resv.post_now_finish(p_reservation_id uuid, p_lease_token uuid, p_outcome text, p_provider_post_id text, p_code text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller();
begin
  if (postona_x_resv.own_single_post(v_user, p_reservation_id)).id is null then
    raise exception 'POSTONA_RESV_LEASE_LOST' using errcode = 'P0001';
  end if;
  return postona_x_resv.finish(p_reservation_id, p_lease_token, p_outcome, p_provider_post_id, p_code);
end $$;

create function postona_x_resv.post_now_get(p_reservation_id uuid)
returns table (reservation_id uuid, state text, provider_post_id text, outcome_code text)
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller(); v_row postona_x_resv.reservations%rowtype;
begin
  v_row := postona_x_resv.own_single_post(v_user, p_reservation_id);
  if v_row.id is null then
    raise exception 'POSTONA_RESV_NOT_FOUND' using errcode = 'P0001';
  end if;
  reservation_id := v_row.id;
  state := case v_row.status when 'published' then 'sent' when 'uncertain' then 'uncertain'
                             when 'failed' then 'failed' when 'cancelled' then 'failed' else 'pending' end;
  provider_post_id := v_row.provider_post_id; outcome_code := v_row.outcome_code;
  return next;
end $$;

revoke all on function postona_x_resv.single_post_fence(uuid, text) from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
revoke all on function postona_x_resv.own_single_post(uuid, uuid) from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
revoke all on function postona_x_resv.post_now_begin(text, uuid, text, text) from public, anon, authenticated, service_role, postona_resv_worker;
revoke all on function postona_x_resv.post_now_check(uuid, uuid) from public, anon, authenticated, service_role, postona_resv_worker;
revoke all on function postona_x_resv.post_now_finish(uuid, uuid, text, text, text) from public, anon, authenticated, service_role, postona_resv_worker;
revoke all on function postona_x_resv.post_now_get(uuid) from public, anon, authenticated, service_role, postona_resv_worker;
grant execute on function
  postona_x_resv.post_now_begin(text, uuid, text, text),
  postona_x_resv.post_now_check(uuid, uuid),
  postona_x_resv.post_now_finish(uuid, uuid, text, text, text),
  postona_x_resv.post_now_get(uuid)
to postona_resv_api;

-- Postconditions: the API role executes exactly its six owner functions + the four single-post ones; the worker role
-- still exactly its four; the API roles reach nothing; every definer keeps an empty search_path.
do $$
declare v_role text; v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text) into v_bad from pg_catalog.pg_proc p
  where p.pronamespace = 'postona_x_resv'::regnamespace and pg_catalog.has_function_privilege('postona_resv_api', p.oid, 'EXECUTE');
  if v_bad is distinct from 'postona_x_resv.cancel(uuid,integer),postona_x_resv.create_batch(text,uuid,integer,text,jsonb,jsonb),'
                            'postona_x_resv.get_reservation(uuid),postona_x_resv.list_reservations(text),'
                            'postona_x_resv.post_now_begin(text,uuid,text,text),postona_x_resv.post_now_check(uuid,uuid),'
                            'postona_x_resv.post_now_finish(uuid,uuid,text,text,text),postona_x_resv.post_now_get(uuid),'
                            'postona_x_resv.reconfirm(uuid,integer,text),postona_x_resv.reschedule(uuid,integer,timestamp with time zone)' then
    raise exception 'POSTONA_X_SINGLE_POST_POSTCONDITION: postona_resv_api executes %', v_bad;
  end if;
  select string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text) into v_bad from pg_catalog.pg_proc p
  where p.pronamespace = 'postona_x_resv'::regnamespace and pg_catalog.has_function_privilege('postona_resv_worker', p.oid, 'EXECUTE');
  if v_bad is distinct from 'postona_x_resv.claim_due(text,integer,integer),postona_x_resv.finish(uuid,uuid,text,text,text),'
                            'postona_x_resv.pre_publish_check(uuid,uuid),postona_x_resv.release_unsent(uuid,uuid)' then
    raise exception 'POSTONA_X_SINGLE_POST_POSTCONDITION: postona_resv_worker executes %', v_bad;
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    select string_agg(p.proname, ',') into v_bad from pg_catalog.pg_proc p
    where p.pronamespace = 'postona_x_resv'::regnamespace and pg_catalog.has_function_privilege(v_role, p.oid, 'EXECUTE');
    if v_bad is not null then raise exception 'POSTONA_X_SINGLE_POST_POSTCONDITION: % executes %', v_role, v_bad; end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_proc p where p.pronamespace = 'postona_x_resv'::regnamespace
             and p.prosecdef and p.proconfig is distinct from array['search_path=""']
             and not (p.proname = 'single_post_fence' and p.proconfig = array['search_path=""', 'lock_timeout=3s'])) then
    raise exception 'POSTONA_X_SINGLE_POST_POSTCONDITION: definer search_path';
  end if;
end $$;

commit;
