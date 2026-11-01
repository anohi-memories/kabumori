-- Rollback of 004_postona_x_resv_dispatch.sql (F3 SOURCE CANDIDATE). Re-runnable. Stop the delivery worker first.
-- Restores 001's bodies of lock_own / claim_due / pre_publish_check verbatim (copied from 001_postona_x_reservations.sql,
-- i.e. the row-first lock order F3-L1 again), drops release_unsent / release_claim and the worker role (with any
-- login membership granted to it). Rows a worker had claimed stay as they are: an expired lease is swept to
-- 'uncertain' by 001's claim_due, as before.
begin;
create or replace function postona_x_resv.lock_own(p_reservation_id uuid, p_expected_revision integer)
returns postona_x_resv.reservations
language plpgsql volatile security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller(); v_row postona_x_resv.reservations%rowtype;
begin
  select r.* into v_row from postona_x_resv.reservations r where r.id = p_reservation_id for update;
  if not found or v_row.user_id <> v_user then
    raise exception 'POSTONA_RESV_NOT_FOUND' using errcode = 'P0001';
  end if;
  perform postona_x_resv.assert_account_access(v_user, v_row.social_account_id);
  if v_row.revision <> p_expected_revision then
    raise exception 'POSTONA_RESV_STALE_REVISION' using errcode = 'P0001';
  end if;
  return v_row;
end $$;

create or replace function postona_x_resv.claim_due(p_worker text, p_lease_seconds integer, p_limit integer)
returns table (reservation_id uuid, lease_token uuid, social_account_id text, body text, scheduled_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare v_row postona_x_resv.reservations%rowtype; v_token uuid; v_count integer := 0;
begin
  if p_worker is null or p_worker !~ '^[a-z0-9_-]{1,40}$' or p_lease_seconds not between 30 and 900 or p_limit not between 1 and 50 then
    raise exception 'POSTONA_RESV_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  update postona_x_resv.reservations r set status = 'expired', updated_at = pg_catalog.now()
  where r.status = 'planned' and r.expires_at <= pg_catalog.now();
  update postona_x_resv.reservations r set status = 'uncertain', outcome_code = 'LEASE_EXPIRED', updated_at = pg_catalog.now()
  where r.status = 'claimed' and r.lease_expires_at <= pg_catalog.now();
  for v_row in
    select r.* from postona_x_resv.reservations r
    where r.status = 'planned' and r.scheduled_at <= pg_catalog.now() and r.expires_at > pg_catalog.now()
    order by r.scheduled_at, r.id
    for update skip locked
  loop
    exit when v_count >= p_limit;
    continue when not postona_x_resv.row_publishable(v_row);
    v_token := gen_random_uuid();
    update postona_x_resv.reservations r
    set status = 'claimed', lease_token = v_token, claimed_by = p_worker,
        lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds), updated_at = pg_catalog.now()
    where r.id = v_row.id;
    insert into postona_x_resv.audit (user_id, reservation_id, action, detail)
    values (v_row.user_id, v_row.id, 'claim', pg_catalog.jsonb_build_object('worker', p_worker));
    reservation_id := v_row.id; lease_token := v_token; social_account_id := v_row.social_account_id;
    body := v_row.body; scheduled_at := v_row.scheduled_at;
    v_count := v_count + 1;
    return next;
  end loop;
end $$;

create or replace function postona_x_resv.pre_publish_check(p_reservation_id uuid, p_lease_token uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v_row postona_x_resv.reservations%rowtype;
begin
  select r.* into v_row from postona_x_resv.reservations r where r.id = p_reservation_id for update;
  if not found or v_row.status <> 'claimed' or v_row.lease_token is distinct from p_lease_token
     or v_row.lease_expires_at <= pg_catalog.clock_timestamp() then
    return 'LEASE_LOST';
  end if;
  if not postona_x_resv.row_publishable(v_row) then
    update postona_x_resv.reservations r set status = 'failed', outcome_code = 'NOT_PUBLISHABLE_AT_SEND', updated_at = pg_catalog.now()
    where r.id = v_row.id;
    return 'NOT_PUBLISHABLE';
  end if;
  return 'OK';
end $$;

revoke all on function postona_x_resv.lock_own(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function postona_x_resv.claim_due(text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function postona_x_resv.pre_publish_check(uuid, uuid) from public, anon, authenticated, service_role;
drop function if exists postona_x_resv.release_unsent(uuid, uuid);
drop function if exists postona_x_resv.release_claim(uuid, uuid, text);
do $$ begin
  if to_regrole('postona_resv_worker') is not null then
    execute 'revoke all on all functions in schema postona_x_resv from postona_resv_worker';
    execute 'revoke all on schema postona_x_resv from postona_resv_worker';
    execute 'drop role postona_resv_worker';
  end if;
end $$;
commit;
