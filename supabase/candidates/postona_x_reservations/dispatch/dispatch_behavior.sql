-- F3 dispatch (004) behaviour on G5's production-shaped disposable baseline (real G5 candidate SQL bound by 003).
-- Run by dispatch_run.sh as the schema owner. Fake data only.
-- MOCK_ONLY: G4 (verified X account) is the t_mock.verified allow list (G4 is NOT delivered: Issue #131).
-- TEST STAND-INS: owner INSERTs build workspaces / X accounts the onboarding RPC would; owner UPDATEs move a planned
-- reservation's time into the past (the "clock") and end a service (states no client can reach directly).
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create function pg_temp.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin if not coalesce(p_ok, false) then raise exception 'FAIL %', p_label; end if; end $$;
create function pg_temp.uid(p_n integer) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pg_temp.set_claims(p_sub uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p_sub is null then '' else 'authenticated' end, true);
  perform set_config('request.jwt.claims', case when p_sub is null then '' else json_build_object('sub', p_sub, 'role', 'authenticated')::text end, true);
end $$;
create function pg_temp.as_role(p_sql text, p_role text, p_sub uuid default null) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.set_claims(p_sub);
  execute format('set local role %I', p_role);
  execute p_sql into v;
  reset role;
  perform pg_temp.set_claims(null);
  return coalesce(v, '<null>');
exception when others then
  reset role;
  perform pg_temp.set_claims(null);
  return 'ERR:' || sqlerrm;
end $$;
create function pg_temp.worker(p_sql text) returns text language sql as $$ select pg_temp.as_role(p_sql, 'postona_resv_worker') $$;
create function pg_temp.person(p_n integer) returns uuid language plpgsql as $$
declare v_user uuid := pg_temp.uid(p_n); v_brand text; v_account text;
begin
  perform public.fixture_login(v_user);
  perform pg_temp.expect(pg_temp.as_role('select (public.start_x_autopost_service() ->> ''status'')', 'authenticated', v_user) = 'active', 'setup: x_autopost');
  v_brand := public.social_mobile_account_deletion_workspace(v_user);
  insert into public.brands (id, code_profile_key) values (v_brand, 'social_mobile_user_v1') on conflict (id) do nothing;
  insert into public.brand_memberships (brand_id, user_id, role) values (v_brand, v_user, 'owner') on conflict do nothing;
  v_account := 'x' || replace(v_user::text, '-', '');
  insert into public.social_accounts (id, brand_id) values (v_account, v_brand) on conflict (id) do nothing;
  insert into t_mock.verified values (v_user, v_account) on conflict do nothing;
  return v_user;
end $$;
-- One consented manual reservation created through the API role (days ahead), returned by id.
create function pg_temp.reserve(p_user uuid, p_draft text, p_days integer) returns uuid language plpgsql as $$
declare v_items jsonb; v_out text;
begin
  v_items := jsonb_build_array(jsonb_build_object('draft_id', p_draft,
    'scheduled_at', ((now() at time zone 'Asia/Tokyo')::date + p_days + time '10:00') at time zone 'Asia/Tokyo', 'body', '本文 ' || p_draft,
    'consent', jsonb_build_object('confirmed', true, 'content_sha256', encode(sha256(convert_to('本文 ' || p_draft, 'UTF8')), 'hex'))));
  v_out := pg_temp.as_role(format('select string_agg(reservation_id::text, '','') from postona_x_resv.create_batch(%L, gen_random_uuid(), 1, ''manual_exact'', null, %L::jsonb)',
                                  'x' || replace(p_user::text, '-', ''), v_items), 'postona_resv_api', p_user);
  perform pg_temp.expect(v_out !~ '^ERR', 'setup: create ' || v_out);
  return v_out::uuid;
end $$;
-- The clock: the reservation is due now (its consent moves with it, as if confirmed at that time).
create function pg_temp.make_due(p_id uuid) returns void language sql as $$
  update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute',
         expires_at = now() + interval '6 hours' where id = p_id $$;
create function pg_temp.status(p_id uuid) returns text language sql as $$ select status from postona_x_resv.reservations where id = p_id $$;
create function pg_temp.claim(p_limit integer default 50) returns text language sql as $$
  select pg_temp.worker(format('select coalesce(string_agg(reservation_id::text || ''='' || lease_token::text, '',''), '''') from postona_x_resv.claim_due(''w1'', 120, %s)', p_limit)) $$;
create function pg_temp.lease_of(p_id uuid) returns text language sql as $$ select lease_token::text from postona_x_resv.reservations where id = p_id $$;
create schema t_ids;
create table t_ids.ids (name text primary key, id uuid not null);

-- W1: the worker role executes exactly the four worker functions; no owner function, table or other role.
select pg_temp.expect(pg_temp.worker(q) like 'ERR:permission denied%', 'W1 worker refused: ' || q) from unnest(array[
  'select count(*)::text from postona_x_resv.reservations',
  'select count(*)::text from postona_x_resv.list_reservations(''x'')',
  'select postona_x_resv.release_claim(gen_random_uuid(), gen_random_uuid(), ''X'')::text',
  'select postona_x_resv.g5_x_autopost_allowed(gen_random_uuid())::text',
  'select postona_x_resv.lock_own(gen_random_uuid(), 1)::text']) q;
select pg_temp.expect(pg_temp.as_role(format('select count(*)::text from postona_x_resv.claim_due(%L, 60, 1)', 'w'), r) like 'ERR:permission denied%', 'W1 claim refused to ' || r)
  from unnest(array['postona_resv_api', 'authenticated', 'anon', 'service_role']) r;
select 'W1_WORKER_ROLE_BOUNDARY_PASS' as result;

-- W2: a claimed row that was not sent is handed back (lease proven); its revision and consent stay; it is claimed again.
select pg_temp.person(41) is not null as setup_41;
select pg_temp.reserve(pg_temp.uid(41), 'w2', 3) as w2 \gset
select pg_temp.make_due(:'w2');
select pg_temp.expect(pg_temp.claim() like '%' || :'w2' || '%', 'W2 claimed');
select pg_temp.lease_of(:'w2') as w2lease \gset
select pg_temp.expect(pg_temp.worker(format('select postona_x_resv.release_unsent(%L, gen_random_uuid())', :'w2')) = 'lease_lost', 'W2 foreign lease');
select pg_temp.expect(pg_temp.worker(format('select postona_x_resv.release_unsent(%L, %L)', :'w2', :'w2lease')) = 'released', 'W2 released');
select pg_temp.expect((select status = 'planned' and revision = 1 and consent_state = 'confirmed' and lease_token is null and claimed_by is null
                       from postona_x_resv.reservations where id = :'w2'), 'W2 back to planned, unchanged');
select pg_temp.expect((select count(*) from postona_x_resv.audit where reservation_id = :'w2' and action = 'release' and detail ->> 'reason' = 'WORKER_SHUTDOWN') = 1, 'W2 audit');
select pg_temp.expect(pg_temp.worker(format('select postona_x_resv.release_unsent(%L, %L)', :'w2', :'w2lease')) = 'lease_lost', 'W2 second release');
select pg_temp.expect(pg_temp.claim() like '%' || :'w2' || '%', 'W2 claimed again');
-- W3: pre_publish_check after the lease ran out (still ours, before any send): handed back, not 'uncertain'.
select pg_temp.lease_of(:'w2') as w2lease \gset
update postona_x_resv.reservations set lease_expires_at = clock_timestamp() - interval '1 second' where id = :'w2';
select pg_temp.expect(pg_temp.worker(format('select postona_x_resv.pre_publish_check(%L, %L)', :'w2', :'w2lease')) = 'RELEASED', 'W3 released');
select pg_temp.expect(pg_temp.status(:'w2') = 'planned', 'W3 planned');
select pg_temp.expect((select count(*) from postona_x_resv.audit where reservation_id = :'w2' and detail ->> 'reason' = 'LEASE_EXPIRED_BEFORE_SEND') = 1, 'W3 audit');
select pg_temp.expect(pg_temp.worker(format('select postona_x_resv.pre_publish_check(%L, %L)', :'w2', :'w2lease')) = 'LEASE_LOST', 'W3 not ours any more');
-- a valid lease: OK; then finish 'published'; a published row is never claimed or released again
select pg_temp.expect(pg_temp.claim() like '%' || :'w2' || '%', 'W3 claimed');
select pg_temp.lease_of(:'w2') as w2lease \gset
select pg_temp.expect(pg_temp.worker(format('select postona_x_resv.pre_publish_check(%L, %L)', :'w2', :'w2lease')) = 'OK', 'W3 OK');
select pg_temp.expect(pg_temp.worker(format('select postona_x_resv.finish(%L, %L, ''published'', ''1790000000000000002'', null)', :'w2', :'w2lease')) = 'published', 'W3 published');
select pg_temp.expect(pg_temp.worker(format('select postona_x_resv.release_unsent(%L, %L)', :'w2', :'w2lease')) = 'lease_lost', 'W3 published is final');
select pg_temp.expect(pg_temp.claim() not like '%' || :'w2' || '%', 'W3 never re-claimed');
select 'W2_W3_RELEASE_UNSENT_PASS' as result;

-- W4: the owner's x_autopost ends between claim and send: NOT_PUBLISHABLE (failed), never sent.
select pg_temp.person(42) is not null as setup_42;
select pg_temp.reserve(pg_temp.uid(42), 'w4', 3) as w4 \gset
select pg_temp.reserve(pg_temp.uid(42), 'w5', 4) as w5 \gset
select pg_temp.make_due(:'w4');
select pg_temp.expect(pg_temp.claim() like '%' || :'w4' || '%', 'W4 claimed');
select pg_temp.lease_of(:'w4') as w4lease \gset
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = pg_temp.uid(42) and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.worker(format('select postona_x_resv.pre_publish_check(%L, %L)', :'w4', :'w4lease')) = 'NOT_PUBLISHABLE', 'W4 not publishable');
select pg_temp.expect((select status = 'failed' and outcome_code = 'NOT_PUBLISHABLE_AT_SEND' from postona_x_resv.reservations where id = :'w4'), 'W4 failed');
-- W5: due rows of an owner whose service is not active are not claimed (they stay planned); others are.
select pg_temp.make_due(:'w5');
select pg_temp.person(43) is not null as setup_43;
select pg_temp.reserve(pg_temp.uid(43), 'w5b', 3) as w5b \gset
select pg_temp.make_due(:'w5b');
select pg_temp.claim() as w5claims \gset
select pg_temp.expect(:'w5claims' not like '%' || :'w5' || '%' and :'w5claims' like '%' || :'w5b' || '%', 'W5 only the active owner');
select pg_temp.expect(pg_temp.status(:'w5') = 'planned', 'W5 stays planned');
-- W6: the X account is no longer verified (G4): not claimed.
select pg_temp.lease_of(:'w5b') as w5blease \gset
select pg_temp.expect(pg_temp.worker(format('select postona_x_resv.release_unsent(%L, %L)', :'w5b', :'w5blease')) = 'released', 'W6 setup release');
delete from t_mock.verified where user_id = pg_temp.uid(43);
select pg_temp.expect(pg_temp.claim() not like '%' || :'w5b' || '%', 'W6 unverified not claimed');
select pg_temp.expect(pg_temp.status(:'w5b') = 'planned', 'W6 stays planned');
update postona_x_resv.reservations set status = 'cancelled' where id in (:'w5', :'w5b');
select 'W4_W5_W6_LIVE_PERMISSIONS_AT_CLAIM_AND_SEND_PASS' as result;

-- Setup for the two-session cases in dispatch_run.sh (L1 lock order, busy fence): people 44..47, one reservation each.
select pg_temp.person(n) is not null from generate_series(44, 47) n;
insert into t_ids.ids select 'r' || n, pg_temp.reserve(pg_temp.uid(n), 'l' || n, 5) from generate_series(44, 47) n;

select 'POSTONA_RESV_DISPATCH_BEHAVIOR_PASS' as result;
