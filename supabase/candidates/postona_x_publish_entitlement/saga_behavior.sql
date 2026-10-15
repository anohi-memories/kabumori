-- SQL-level behaviour of social_mobile_account_deletion_stop_x (F3 002) on G5's production-shaped baseline with the
-- real deletion saga SQL (20260928160000), the real Stage 3B authority, the F3 guard 001 and the reservation candidate.
-- Run by saga_run.sh as the schema owner. Fake data only.
-- TEST STAND-INS: owner inserts build workspaces / authority rows / reservations. (S2, a membership added after
-- acquire, needs a superuser to pass the deletion guard and runs in saga_run.sh.)
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create function pg_temp.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin if not coalesce(p_ok, false) then raise exception 'FAIL %', p_label; end if; end $$;
create function pg_temp.as_role(p_sql text, p_role text) returns text language plpgsql as $$
declare v text;
begin
  execute format('set local role %I', p_role);
  execute p_sql into v;
  reset role;
  return coalesce(v, '<null>');
exception when others then
  reset role;
  return 'ERR:' || sqlerrm;
end $$;
create function pg_temp.svc(p_sql text) returns text language sql as $$ select pg_temp.as_role(p_sql, 'service_role') $$;
-- A person with an active Kabumori service (the profiles row exists => scope social_only), as G5's own suites build it.
create function pg_temp.kabumori_person(p_user uuid) returns void language plpgsql as $$
declare v text;
begin
  perform public.fixture_login(p_user);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  set local role authenticated;
  v := public.start_kabumori_service() ->> 'status';
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  if v is distinct from 'active' then raise exception 'FAIL setup kabumori %', v; end if;
  insert into public.profiles (id) values (p_user) on conflict do nothing;
end $$;
-- A person with the X app's workspace (fixture), Kabumori data (=> scope social_only), an authority row and reservations.
create function pg_temp.person(p_user uuid, p_prefix text) returns text language plpgsql as $$
declare v_ws text; v_acc text; v_batch uuid := gen_random_uuid();
begin
  perform pg_temp.kabumori_person(p_user);
  v_ws := public.fixture_user_with_workspace(p_user, p_prefix);
  select id into v_acc from public.social_accounts where brand_id = v_ws;
  insert into public.x_account_publish_authority (social_account_id, state, starts_at, expires_at, reason_code)
    values (v_acc, 'enabled', now() - interval '1 minute', now() + interval '7 days', 'TEST_STAND_IN');
  insert into postona_x_resv.batches (id, user_id, brand_id, social_account_id, client_batch_id, revision, mode, origin, time_zone, band, payload_sha256)
    values (v_batch, p_user, v_ws, v_acc, gen_random_uuid(), 1, 'manual_exact', 'user_authored', 'Asia/Tokyo', null, repeat('a', 64));
  insert into postona_x_resv.reservations (batch_id, user_id, brand_id, social_account_id, draft_id, position, origin, mode, body, content_sha256,
    scheduled_at, fixed, status, consent_state, expires_at)
  select v_batch, p_user, v_ws, v_acc, p_prefix || g, g, 'user_authored', 'manual_exact', 'b', repeat('c', 64), now() + (g + 1) * interval '1 day',
         true, 'planned', 'confirmed', now() + interval '30 days' from generate_series(0, 1) g;
  insert into postona_x_resv.audit (user_id, batch_id, action) values (p_user, v_batch, 'create_batch');
  return v_ws;
end $$;
create function pg_temp.acquire(p_user uuid) returns text language sql as $$
  select pg_temp.svc(format('select public.social_mobile_account_deletion_acquire(%L, ''social_only'', false) ->> ''lease''', p_user)) $$;
create function pg_temp.stop(p_user uuid, p_lease text) returns jsonb language plpgsql as $$
declare v text := pg_temp.svc(format('select public.social_mobile_account_deletion_stop_x(%L, %L)::text', p_user, p_lease));
begin
  if v like 'ERR:%' then return jsonb_build_object('error', substr(v, 5)); end if;
  return v::jsonb;
end $$;

\set u1 00000000-0000-4000-8000-0000000000a1
\set u2 00000000-0000-4000-8000-0000000000a2
\set u3 00000000-0000-4000-8000-0000000000a3
select pg_temp.person(:'u1', 'one') as ws1 \gset
select pg_temp.person(:'u2', 'two') as ws2 \gset
select pg_temp.person(:'u3', 'three') as ws3 \gset

-- S1: only the saga's own live lease may stop; the stop is idempotent; an operator / authenticated cannot call it.
select pg_temp.acquire(:'u1') as lease1 \gset
select pg_temp.expect(pg_temp.stop(:'u1', gen_random_uuid()::text) ->> 'error' = 'SOCIAL_MOBILE_DELETION_LEASE_LOST', 'S1 foreign lease');
select pg_temp.expect(pg_temp.stop(:'u2', :'lease1') ->> 'error' = 'SOCIAL_MOBILE_DELETION_LEASE_LOST', 'S1 another person');
select pg_temp.stop(:'u1', :'lease1')::text as s1 \gset
select pg_temp.expect((:'s1')::jsonb ->> 'status' = 'stopped', 'S1 stopped ' || :'s1');
select pg_temp.expect((:'s1')::jsonb ->> 'remote_authorization' = 'pending_saga_revoke', 'S1 remote revoke is the saga''s step');
select pg_temp.expect((select state from public.x_account_publish_authority a join public.social_accounts s on s.id = a.social_account_id where s.brand_id = :'ws1') = 'revoked', 'S1 authority revoked');
select pg_temp.expect((select count(*) from postona_x_resv.reservations where brand_id = :'ws1' and status = 'cancelled') = 2, 'S1 planned cancelled');
select pg_temp.expect((pg_temp.stop(:'u1', :'lease1') #>> '{accounts,0,reservations_cancelled}')::int = 0, 'S1 idempotent');
select pg_temp.expect(pg_temp.as_role(format('select public.social_mobile_account_deletion_stop_x(%L, %L)::text', :'u1', :'lease1'), 'authenticated') like 'ERR:permission denied%', 'S1 authenticated refused');
select pg_temp.expect((select state from public.x_account_publish_authority a join public.social_accounts s on s.id = a.social_account_id where s.brand_id = :'ws2') = 'enabled', 'S1 another person untouched');
update public.social_mobile_account_deletions set lease_expires_at = now() - interval '1 second' where user_id = :'u1';
select pg_temp.expect(pg_temp.stop(:'u1', :'lease1') ->> 'error' = 'SOCIAL_MOBILE_DELETION_LEASE_LOST', 'S1 expired lease');
select 'S1_LEASE_IDEMPOTENT_ACL_PASS' as result;

-- S3: the common account frozen / its x_autopost ended (F5 begins the service end that way): the stop still works.
set role authenticated;
select set_config('request.jwt.claim.sub', :'u3', false);
select (public.start_x_autopost_service() ->> 'status');
reset role;
select set_config('request.jwt.claim.sub', '', false);
update public.common_accounts set status = 'locked' where user_id = :'u3';
update public.service_entitlements set status = 'deleting' where user_id = :'u3' and service_key = 'x_autopost';
select pg_temp.acquire(:'u3') as lease3 \gset
select pg_temp.expect(pg_temp.stop(:'u3', :'lease3') ->> 'status' = 'stopped', 'S3 frozen account still stopped');
select 'S3_FROZEN_STILL_STOPS_PASS' as result;

-- S5: a live claimed reservation blocks (publishing already stopped); once its lease runs out it is fenced to
-- 'uncertain' and the stop answers reconciliation_required (never success-by-silence).
\set u4 00000000-0000-4000-8000-0000000000a4
select pg_temp.person(:'u4', 'four') as ws4 \gset
select pg_temp.acquire(:'u4') as lease4 \gset
update postona_x_resv.reservations set status = 'claimed', lease_token = gen_random_uuid(), lease_expires_at = now() + interval '2 minutes'
 where brand_id = :'ws4' and position = 0;
select pg_temp.stop(:'u4', :'lease4')::text as s5a \gset
select pg_temp.expect((:'s5a')::jsonb ->> 'status' = 'blocked' and (:'s5a')::jsonb ->> 'reason' = 'POSTING_IN_PROGRESS'
  and ((:'s5a')::jsonb ->> 'publishing_stopped')::boolean and ((:'s5a')::jsonb ->> 'reservations_in_flight')::int = 1, 'S5 in flight blocked ' || :'s5a');
select pg_temp.expect((select state from public.x_account_publish_authority a join public.social_accounts s on s.id = a.social_account_id where s.brand_id = :'ws4') = 'revoked', 'S5 authority revoked while blocked');
update postona_x_resv.reservations set lease_expires_at = now() - interval '1 second' where brand_id = :'ws4' and status = 'claimed';
select pg_temp.stop(:'u4', :'lease4')::text as s5b \gset
select pg_temp.expect((:'s5b')::jsonb ->> 'status' = 'stopped' and ((:'s5b')::jsonb ->> 'reservations_lease_expired_fenced')::int = 1
  and ((:'s5b')::jsonb ->> 'reservations_uncertain')::int = 1 and ((:'s5b')::jsonb ->> 'reconciliation_required')::boolean, 'S5 expired lease fenced ' || :'s5b');
select pg_temp.expect((select outcome_code from postona_x_resv.reservations where brand_id = :'ws4' and position = 0) = 'LEASE_EXPIRED', 'S5 outcome code');
select pg_temp.expect(not ((pg_temp.stop(:'u3', :'lease3') ->> 'reconciliation_required')::boolean), 'S5 nothing unknown => no reconciliation');
select 'S5_IN_FLIGHT_AND_UNCERTAIN_PASS' as result;

-- S6 (R1 / R1a, J3 V3): the unknown post is checkpointed durably under the subject hash (no raw user id); no API role
-- can read or write the record or its receipts or call the snapshot helper; the acknowledgement is service_role only,
-- never during a deletion, and names the exact snapshot (a bare count clears nothing).
select pg_temp.expect((select count(*) from public.social_mobile_account_deletion_x_unconfirmed
  where subject_sha256 = public.social_mobile_account_deletion_subject(:'u4')) = 1, 'S6 checkpointed');
select pg_temp.expect((pg_temp.stop(:'u4', :'lease4') ->> 'x_posts_unconfirmed')::int = 1, 'S6 repeated stop does not double count');
select encode(sha256(convert_to('x_unconfirmed:v1:' || public.social_mobile_account_deletion_subject(:'u4') || ':' || r.id::text, 'UTF8')), 'hex') as snap4
  from postona_x_resv.reservations r where r.brand_id = :'ws4' and r.status = 'uncertain' \gset
select pg_temp.expect(pg_temp.stop(:'u4', :'lease4') ->> 'x_unconfirmed_snapshot' = :'snap4', 'S6 stop answers the exact snapshot');
select pg_temp.expect(pg_temp.as_role(format('select count(*)::text from public.%I', tbl), r) like 'ERR:permission denied%', 'S6 ' || tbl || ' closed to ' || r)
  from unnest(array['anon', 'authenticated', 'service_role']) r,
       unnest(array['social_mobile_account_deletion_x_unconfirmed', 'social_mobile_account_deletion_x_unconfirmed_ack_receipts']) tbl;
select pg_temp.expect(pg_temp.as_role(format('select public.social_mobile_account_deletion_x_unconfirmed_snapshot(%L)::text', 'x'), r) like 'ERR:permission denied%', 'S6 snapshot helper closed to ' || r)
  from unnest(array['anon', 'authenticated', 'service_role']) r;
select pg_temp.expect(pg_temp.as_role(format('select public.social_mobile_account_deletion_x_unconfirmed_ack(%L, %s)::text', :'u4', arg), r) like 'ERR:permission denied%', 'S6 ack closed to ' || r)
  from unnest(array['anon', 'authenticated']) r, unnest(array['1', quote_literal(:'snap4')]) arg;
select pg_temp.expect(pg_temp.svc(format('select public.social_mobile_account_deletion_x_unconfirmed_ack(%L, %L::text) ->> ''status''', :'u4', :'snap4')) = 'deletion_in_progress', 'S6 no ack during a deletion');
select pg_temp.expect(pg_temp.svc(format('select public.social_mobile_account_deletion_x_unconfirmed_ack(%L, 1)::text', :'u4')) = '{"status": "snapshot_required"}', 'S6 a bare count is refused typed');
select pg_temp.expect(pg_temp.svc(format('select public.social_mobile_account_deletion_x_unconfirmed_ack(%L, %L::text)::text', :'u4', s)) = 'ERR:SOCIAL_MOBILE_DELETION_ACK_INVALID', 'S6 ack needs a snapshot ' || coalesce(s, 'null'))
  from unnest(array['abc', upper(:'snap4'), null]) s;
select pg_temp.expect((select count(*) from public.social_mobile_account_deletion_x_unconfirmed
  where subject_sha256 = public.social_mobile_account_deletion_subject(:'u4')) = 1, 'S6 nothing cleared by any refused ack');
select pg_temp.expect((pg_temp.svc(format('select public.social_mobile_account_deletion_x_precheck(%L)::text', :'u4')))::jsonb
  = jsonb_build_object('non_x_accounts', 0, 'x_posts_unconfirmed', 1, 'x_unconfirmed_snapshot', :'snap4', 'reconciliation_required', true), 'S6 precheck reports it');
select pg_temp.expect((pg_temp.svc(format('select public.social_mobile_account_deletion_x_precheck(%L)::text', :'u3')))::jsonb
  = '{"non_x_accounts": 0, "x_posts_unconfirmed": 0, "x_unconfirmed_snapshot": null, "reconciliation_required": false}'::jsonb, 'S6 another person has none');
select 'S6_DURABLE_UNCONFIRMED_ACL_PASS' as result;

-- R3 setup (the two-session cases run in saga_run.sh): two fresh people.
\set u5 00000000-0000-4000-8000-0000000000a5
\set u6 00000000-0000-4000-8000-0000000000a6
select pg_temp.person(:'u5', 'five') is not null as r3_setup_five;
select pg_temp.person(:'u6', 'six') is not null as r3_setup_six;
-- R3a / R1b setup: four more fresh people (row-lock waits, rollback race).
\set u7 00000000-0000-4000-8000-0000000000a7
\set u8 00000000-0000-4000-8000-0000000000a8
\set u9 00000000-0000-4000-8000-0000000000a9
\set u10 00000000-0000-4000-8000-0000000000aa
select pg_temp.person(:'u7', 'seven') is not null as r3a_setup_seven;
select pg_temp.person(:'u8', 'eight') is not null as r3a_setup_eight;
select pg_temp.person(:'u9', 'nine') is not null as r1b_setup_nine;
select pg_temp.person(:'u10', 'ten') is not null as r1b_setup_ten;

select 'X_SAGA_STOP_BEHAVIOR_PASS' as result;
