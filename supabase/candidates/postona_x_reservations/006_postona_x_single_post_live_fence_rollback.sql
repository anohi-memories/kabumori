-- Rollback of 006_postona_x_single_post_live_fence.sql (F3 SOURCE CANDIDATE). Re-runnable. Roll the single-post Edge code
-- back to the 005 steps first. Restores 005's single_post_fence and post_now_begin bodies verbatim (copied from
-- 005_postona_x_single_post.sql) and the API role's 005 grants; drops the 006 functions, the generation function and the
-- bindings (their after_freeze / simulated marks go with them -- export them first if they must be kept).
begin;
create or replace function postona_x_resv.single_post_fence(p_user_id uuid, p_social_account_id text) returns text
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

create or replace function postona_x_resv.post_now_begin(p_social_account_id text, p_client_request_id uuid, p_text text, p_content_sha256 text)
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

drop function if exists postona_x_resv.post_now_preflight(uuid, uuid);
drop function if exists postona_x_resv.post_now_record(uuid, uuid, text, text, text, text);
drop function if exists postona_x_resv.post_now_readback(uuid);
drop function if exists postona_x_resv.post_now_readiness(text);
drop table if exists postona_x_resv.single_post_bindings;
drop function if exists postona_x_resv.x_credential_generation(text);
revoke all on function postona_x_resv.single_post_fence(uuid, text) from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
revoke all on function postona_x_resv.post_now_begin(text, uuid, text, text) from public, anon, authenticated, service_role, postona_resv_worker;
grant execute on function
  postona_x_resv.post_now_begin(text, uuid, text, text),
  postona_x_resv.post_now_check(uuid, uuid),
  postona_x_resv.post_now_finish(uuid, uuid, text, text, text),
  postona_x_resv.post_now_get(uuid)
to postona_resv_api;
commit;
