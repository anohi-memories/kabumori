-- G5 binding behaviour: the REAL G5 candidate decision (PR121 + PR152 SQL) bound into the reservation candidate by
-- 003, on a production-shaped disposable baseline (G5's own fixtures + the real onboarding / deletion / Phase 1-4
-- migrations). Run by g5_binding_run.sh as the schema owner. Fake data only.
-- MOCK_ONLY: G4 (verified X account) is a test double here; G4 is NOT bound by 003.
-- TEST STAND-INS (as in G5's own suites): owner INSERTs build workspaces / X accounts the onboarding RPC would;
-- owner UPDATEs of common_accounts / service_entitlements build states no client can reach.
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
-- One statement as a role with a subject; returns its text or 'ERR:' || message.
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
create function pg_temp.api(p_sql text, p_sub uuid) returns text language sql as $$ select pg_temp.as_role(p_sql, 'postona_resv_api', p_sub) $$;
create function pg_temp.person(p_n integer, p_services text[]) returns uuid language plpgsql as $$
declare v_user uuid := pg_temp.uid(p_n); v_service text;
begin
  perform public.fixture_login(v_user);
  foreach v_service in array p_services loop
    perform pg_temp.expect(pg_temp.as_role(format('select (public.start_%s_service() ->> ''status'')', v_service), 'authenticated', v_user) = 'active',
                           format('setup: start %s', v_service));
  end loop;
  return v_user;
end $$;
-- The person's own POSTONA workspace and one X account in it (as onboarding would make them).
create function pg_temp.x_account(p_user uuid) returns text language plpgsql as $$
declare v_brand text := public.social_mobile_account_deletion_workspace(p_user); v_account text;
begin
  insert into public.brands (id, code_profile_key) values (v_brand, 'social_mobile_user_v1') on conflict (id) do nothing;
  insert into public.brand_memberships (brand_id, user_id, role) values (v_brand, p_user, 'owner') on conflict do nothing;
  v_account := 'x' || replace(p_user::text, '-', '');
  insert into public.social_accounts (id, brand_id) values (v_account, v_brand) on conflict (id) do nothing;
  insert into t_mock.verified values (p_user, v_account) on conflict do nothing;
  return v_account;
end $$;
create function pg_temp.items(p_prefix text, p_days integer[]) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('draft_id', p_prefix || d, 'scheduled_at', ((now() at time zone 'Asia/Tokyo')::date + d + time '10:00') at time zone 'Asia/Tokyo',
                                      'body', '本文' || d, 'consent', jsonb_build_object('confirmed', true,
                                      'content_sha256', encode(sha256(convert_to('本文' || d, 'UTF8')), 'hex'))) order by d)
  from unnest(p_days) d $$;
create function pg_temp.create_sql(p_account text, p_prefix text, p_days integer[]) returns text language sql as $$
  select format('select count(*)::text from postona_x_resv.create_batch(%L, gen_random_uuid(), 1, %L, null, %L::jsonb)',
                p_account, 'manual_exact', pg_temp.items(p_prefix, p_days)) $$;

\set a 00000000-0000-4000-8000-000000000031
\set k 00000000-0000-4000-8000-000000000032
select pg_temp.person(31, array['x_autopost']) is not null as a_ready \gset
select pg_temp.person(32, array['kabumori']) is not null as k_ready \gset
select pg_temp.x_account(:'a') as acc_a \gset
select pg_temp.x_account(:'k') as acc_k \gset

-- G1: an active x_autopost entitlement and an active account: the API role creates, lists and reads.
select pg_temp.expect(pg_temp.api(pg_temp.create_sql(:'acc_a', 'g1_', array[3, 4]), :'a') = '2', 'G1 create');
select pg_temp.expect(pg_temp.api(format('select count(*)::text from postona_x_resv.list_reservations(%L)', :'acc_a'), :'a') = '2', 'G1 list');
select id::text as r1 from postona_x_resv.reservations where draft_id = 'g1_3' \gset
select pg_temp.expect(pg_temp.api(format('select status from postona_x_resv.get_reservation(%L)', :'r1'), :'a') = 'planned', 'G1 get');
select 'G1_ACTIVE_ENTITLEMENT_ALLOWS_PASS' as result;

-- G2: the service ended / suspended / deleting, the account locked / deleting: every action is refused.
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'a' and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.api(format('select count(*)::text from postona_x_resv.list_reservations(%L)', :'acc_a'), :'a') = 'ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE', 'G2 ended: list');
select pg_temp.expect(pg_temp.api(pg_temp.create_sql(:'acc_a', 'g2_', array[6]), :'a') = 'ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE', 'G2 ended: create');
select pg_temp.expect(pg_temp.api(format('select status from postona_x_resv.cancel(%L, 1)', :'r1'), :'a') = 'ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE', 'G2 ended: cancel');
update public.service_entitlements set status = 'suspended', ended_at = null where user_id = :'a' and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.api(format('select status from postona_x_resv.get_reservation(%L)', :'r1'), :'a') = 'ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE', 'G2 suspended: get');
update public.service_entitlements set status = 'deleting' where user_id = :'a' and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.api(format('select count(*)::text from postona_x_resv.list_reservations(%L)', :'acc_a'), :'a') = 'ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE', 'G2 service deleting');
update public.service_entitlements set status = 'active' where user_id = :'a' and service_key = 'x_autopost';
update public.common_accounts set status = 'locked' where user_id = :'a';
select pg_temp.expect(pg_temp.api(format('select count(*)::text from postona_x_resv.list_reservations(%L)', :'acc_a'), :'a') = 'ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE', 'G2 locked');
update public.common_accounts set status = 'deleting' where user_id = :'a';
select pg_temp.expect(pg_temp.api(format('select count(*)::text from postona_x_resv.list_reservations(%L)', :'acc_a'), :'a') = 'ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE', 'G2 account deleting');
update public.common_accounts set status = 'active' where user_id = :'a';
select pg_temp.expect(pg_temp.api(format('select count(*)::text from postona_x_resv.list_reservations(%L)', :'acc_a'), :'a') = '2', 'G2 restored');
-- A person enrolled only in Kabumori has no x_autopost entitlement: refused on their own workspace.
select pg_temp.expect(pg_temp.api(pg_temp.create_sql(:'acc_k', 'g2k_', array[7]), :'k') = 'ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE', 'G2 kabumori only');
-- Cross-user: still ACCOUNT_NOT_FOUND before any G5 decision is revealed.
select pg_temp.expect(pg_temp.api(format('select count(*)::text from postona_x_resv.list_reservations(%L)', :'acc_a'), :'k') = 'ERR:POSTONA_RESV_ACCOUNT_NOT_FOUND', 'G2 cross-user');
select pg_temp.expect(pg_temp.api(format('select status from postona_x_resv.get_reservation(%L)', :'r1'), :'k') = 'ERR:POSTONA_RESV_NOT_FOUND', 'G2 cross-user get');
select 'G2_LIFECYCLE_REFUSES_EVERY_ACTION_PASS' as result;

-- G3: the worker path uses the same decision: claim only while active; a service ended after the claim stops the
-- send at pre-publish.
update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute' where draft_id = 'g1_3';
create temp table g3 as select * from postona_x_resv.claim_due('worker-g5', 120, 10);
select pg_temp.expect((select count(*) from g3) = 1, 'G3 claimed while active');
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'a' and service_key = 'x_autopost';
select pg_temp.expect(postona_x_resv.pre_publish_check((select reservation_id from g3), (select lease_token from g3)) = 'NOT_PUBLISHABLE', 'G3 pre-publish refuses');
update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute' where draft_id = 'g1_4';
select pg_temp.expect((select count(*) from postona_x_resv.claim_due('worker-g5', 120, 10)) = 0, 'G3 nothing claimed while ended');
update public.service_entitlements set status = 'active', ended_at = null where user_id = :'a' and service_key = 'x_autopost';
select 'G3_WORKER_PATH_BOUND_PASS' as result;

-- G4: the API role reaches neither the G5 decision nor the bound predicate directly.
select pg_temp.expect(pg_temp.api(format('select coalesce(private.account_lifecycle_service_state_refusal(%L, ''x_autopost''), ''ok'')', :'a'), :'a') like 'ERR:permission denied%', 'G4 G5 function');
select pg_temp.expect(pg_temp.api(format('select postona_x_resv.g5_x_autopost_allowed(%L)::text', :'a'), :'a') like 'ERR:permission denied%', 'G4 predicate');
select 'G4_NO_DIRECT_ACCESS_PASS' as result;

select 'POSTONA_RESV_G5_BINDING_BEHAVIOR_PASS' as result;
