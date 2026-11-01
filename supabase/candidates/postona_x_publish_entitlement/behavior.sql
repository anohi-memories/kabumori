-- Behaviour of the F3 X publish entitlement guard on G5's production-shaped baseline with the REAL Stage 3B
-- publish-authority functions replaced by the candidate and the REAL G5/F5 candidate decisions (PR152 + PR165).
-- Run by run.sh as the schema owner after the candidate is applied. Fake data only.
-- TEST STAND-INS (as in G5's own suites): owner INSERTs build workspaces / X accounts / posts / reservations the
-- apps and planners would; owner UPDATEs of common_accounts / service_entitlements build states no client can reach.
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
  perform set_config('request.jwt.claims', '', true);
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
create function pg_temp.svc(p_sql text) returns text language sql as $$ select pg_temp.as_role(p_sql, 'service_role') $$;
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
-- The person's POSTONA workspace, live, brand_post on, owner consent saved, one X account (verified, publish on).
create function pg_temp.workspace(p_user uuid) returns text language plpgsql as $$
declare v_brand text := public.social_mobile_account_deletion_workspace(p_user); v_account text;
begin
  insert into public.brands (id, code_profile_key) values (v_brand, 'social_mobile_user_v1') on conflict (id) do nothing;
  insert into public.brand_memberships (brand_id, user_id, role) values (v_brand, p_user, 'owner') on conflict do nothing;
  insert into public.brand_settings (brand_id, enabled_post_types) values (v_brand, '["brand_post"]')
    on conflict (brand_id) do update set enabled_post_types = '["brand_post"]';
  insert into t3b.consent values (v_brand, '{"approvalMode":"auto_post_preference"}') on conflict (brand_id) do nothing;
  v_account := 'x' || replace(p_user::text, '-', '');
  insert into public.social_accounts (id, brand_id) values (v_account, v_brand) on conflict (id) do nothing;
  return v_brand;
end $$;
create function pg_temp.account(p_user uuid) returns text language sql immutable as $$ select 'x' || replace(p_user::text, '-', '') $$;
create function pg_temp.running_post(p_brand text) returns uuid language sql as $$
  insert into public.scheduled_posts (brand_id, post_type, status, started_at) values (p_brand, 'brand_post', 'running', now()) returning id $$;
create function pg_temp.check(p_post uuid, p_account text, p_brand text) returns text language sql as $$
  select pg_temp.svc(format('select public.check_x_account_publish_authority(%L, %L, %L)', p_post, p_account, p_brand)) $$;
create function pg_temp.enable(p_account text) returns text language sql as $$
  select pg_temp.svc(format('select public.set_x_account_publish_authority(%L, ''enabled'', ''OPS_PILOT'', now() - interval ''1 minute'', now() + interval ''7 days'')', p_account)) $$;
create function pg_temp.authority(p_account text) returns text language sql as $$
  select coalesce((select state from public.x_account_publish_authority where social_account_id = p_account), 'none') $$;

\set a 00000000-0000-4000-8000-000000000051
\set b 00000000-0000-4000-8000-000000000052
\set k 00000000-0000-4000-8000-000000000053
\set s 00000000-0000-4000-8000-000000000054
\set t 00000000-0000-4000-8000-000000000055
select pg_temp.person(51, array['x_autopost']) is not null as ok \gset
select pg_temp.person(52, array['x_autopost']) is not null as ok \gset
select pg_temp.person(53, array['kabumori']) is not null as ok \gset
select pg_temp.person(54, array['x_autopost']) is not null as ok \gset
select pg_temp.person(55, array['x_autopost']) is not null as ok \gset
select pg_temp.workspace(:'a') as ws_a, pg_temp.account(:'a') as acc_a \gset
select pg_temp.workspace(:'b') as ws_b, pg_temp.account(:'b') as acc_b \gset
select pg_temp.workspace(:'k') as ws_k, pg_temp.account(:'k') as acc_k \gset
select pg_temp.workspace(:'s') as ws_s, pg_temp.account(:'s') as acc_s \gset

-- E1: active entitlement: the grant and the predicate allow (B then A).
select pg_temp.expect(pg_temp.enable(:'acc_a') = 'enabled', 'E1 enable');
select pg_temp.expect(pg_temp.enable(:'acc_b') = 'enabled', 'E1 enable b');
select pg_temp.running_post(:'ws_a') as post_a \gset
select pg_temp.expect(pg_temp.check(:'post_a', :'acc_a', :'ws_a') = 'allowed', 'E1 allowed');
select 'E1_ACTIVE_ALLOWS_PASS' as result;

-- E2: every lifecycle refusal of the owner refuses the predicate (before generation and before the X create).
create function pg_temp.refused(p_label text) returns void language plpgsql as $$
begin perform pg_temp.expect(pg_temp.check(current_setting('e.post')::uuid, current_setting('e.acc'), current_setting('e.ws')) = 'ERR:VAULT_PUBLISH_SERVICE_NOT_ACTIVE', p_label); end $$;
select set_config('e.post', :'post_a', false), set_config('e.acc', :'acc_a', false), set_config('e.ws', :'ws_a', false) \gset
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'a' and service_key = 'x_autopost';
select pg_temp.refused('E2 ended');
update public.service_entitlements set status = 'suspended', ended_at = null where user_id = :'a' and service_key = 'x_autopost';
select pg_temp.refused('E2 suspended');
update public.service_entitlements set status = 'deleting' where user_id = :'a' and service_key = 'x_autopost';
select pg_temp.refused('E2 service deleting');
update public.service_entitlements set status = 'active' where user_id = :'a' and service_key = 'x_autopost';
update public.common_accounts set status = 'locked' where user_id = :'a';
select pg_temp.refused('E2 account locked (frozen)');
update public.common_accounts set status = 'deleting' where user_id = :'a';
select pg_temp.refused('E2 account deleting');
update public.common_accounts set status = 'active' where user_id = :'a';
select pg_temp.expect(pg_temp.check(:'post_a', :'acc_a', :'ws_a') = 'allowed', 'E2 restored');
-- Not registered for x_autopost (Kabumori only): even with an operator's authority row, refused.
insert into public.x_account_publish_authority (social_account_id, state, starts_at, expires_at, reason_code)
  values (:'acc_k', 'enabled', now() - interval '1 minute', now() + interval '1 day', 'TEST_STAND_IN');
select pg_temp.running_post(:'ws_k') as post_k \gset
select pg_temp.expect(pg_temp.check(:'post_k', :'acc_k', :'ws_k') = 'ERR:VAULT_PUBLISH_SERVICE_NOT_ACTIVE', 'E2 not registered');
-- Owner unknown: a second owner, then no owner.
insert into public.brand_memberships (brand_id, user_id, role) values (:'ws_a', :'b', 'owner');
select pg_temp.refused('E2 two owners');
delete from public.brand_memberships where brand_id = :'ws_a';
select pg_temp.refused('E2 no owner');
insert into public.brand_memberships (brand_id, user_id, role) values (:'ws_a', :'a', 'owner');
select pg_temp.expect(pg_temp.check(:'post_a', :'acc_a', :'ws_a') = 'allowed', 'E2 owner restored');
-- The G5 decision unreadable / unknown (TEST STAND-IN: G5's read temporarily answers null, then is restored
-- byte-for-byte): only the exact answer 'active' allows.
select pg_get_functiondef('public.common_account_brand_service_state(text,text)'::regprocedure) as g5_def,
       md5(prosrc) as g5_src from pg_proc where oid = 'public.common_account_brand_service_state(text,text)'::regprocedure \gset
create or replace function public.common_account_brand_service_state(p_brand_id text, p_service_key text default 'x_autopost')
returns text language sql stable security definer set search_path = '' as $$ select null::text $$;
select pg_temp.refused('E2 G5 answer unknown (null)');
select :'g5_def' \gexec
select pg_temp.expect((select md5(prosrc) from pg_proc where oid = 'public.common_account_brand_service_state(text,text)'::regprocedure) = :'g5_src', 'E2 G5 restored byte-for-byte');
select pg_temp.expect(pg_temp.check(:'post_a', :'acc_a', :'ws_a') = 'allowed', 'E2 allowed after restore');
select 'E2_LIFECYCLE_REFUSES_PREDICATE_PASS' as result;

-- E3: the existing Stage 3B refusals are unchanged and keep their own codes (regression), with an active service.
select pg_temp.expect(pg_temp.check(:'post_a', :'acc_b', :'ws_a') = 'ERR:X_CLAIM_ACCOUNT_MISMATCH', 'E3 other account');
select pg_temp.expect(pg_temp.check(:'post_a', :'acc_a', :'ws_b') = 'ERR:VAULT_PUBLISH_POST_NOT_RUNNING', 'E3 other brand');
select pg_temp.expect(pg_temp.check(:'post_a', :'acc_a', 'kabumori') = 'ERR:VAULT_PUBLISH_BRAND_NOT_ELIGIBLE', 'E3 kabumori');
update public.social_accounts set connection_status = 'connected' where id = :'acc_a';
select pg_temp.expect(pg_temp.check(:'post_a', :'acc_a', :'ws_a') = 'ERR:X_ACCOUNT_NOT_VERIFIED', 'E3 not verified');
update public.social_accounts set connection_status = 'identity_verified', publish_enabled = false where id = :'acc_a';
select pg_temp.expect(pg_temp.check(:'post_a', :'acc_a', :'ws_a') = 'ERR:X_ACCOUNT_PUBLISH_DISABLED', 'E3 publish disabled');
update public.social_accounts set publish_enabled = true where id = :'acc_a';
update t3b.consent set settings = '{"approvalMode":"manual_review"}' where brand_id = :'ws_a';
select pg_temp.expect(pg_temp.check(:'post_a', :'acc_a', :'ws_a') = 'ERR:SOCIAL_MOBILE_AUTO_POST_NOT_CONSENTED', 'E3 no consent');
update t3b.consent set settings = '{"approvalMode":"auto_post_preference"}' where brand_id = :'ws_a';
select pg_temp.expect(pg_temp.svc(format('select public.set_x_account_publish_authority(%L, ''off'', ''OPS_PAUSE'')', :'acc_a')) = 'off', 'E3 off');
select pg_temp.expect(pg_temp.check(:'post_a', :'acc_a', :'ws_a') = 'ERR:VAULT_PUBLISH_AUTHORITY_OFF', 'E3 authority off');
select pg_temp.expect(pg_temp.enable(:'acc_a') = 'enabled', 'E3 re-enable');
select pg_temp.expect(pg_temp.check(:'post_a', :'acc_a', :'ws_a') = 'allowed', 'E3 allowed again');
select 'E3_EXISTING_CHECKS_UNCHANGED_PASS' as result;

-- E4: the grant needs the active service; stopping (off / revoked) never does.
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'b' and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.enable(:'acc_b') = 'ERR:VAULT_PUBLISH_SERVICE_NOT_ACTIVE', 'E4 enable refused while ended');
select pg_temp.expect(pg_temp.authority(:'acc_b') = 'enabled', 'E4 refused grant changed nothing');
select pg_temp.expect(pg_temp.svc(format('select public.set_x_account_publish_authority(%L, ''revoked'', ''SERVICE_ENDED'')', :'acc_b')) = 'revoked', 'E4 revoke while ended');
select pg_temp.expect(pg_temp.enable(:'acc_b') = 'ERR:VAULT_PUBLISH_SERVICE_NOT_ACTIVE', 'E4 no re-grant while ended');
update public.service_entitlements set status = 'active', ended_at = null where user_id = :'b' and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.enable(:'acc_b') = 'enabled', 'E4 re-grant once the service is active again');
select pg_temp.expect(pg_temp.enable(:'acc_k') = 'ERR:VAULT_PUBLISH_SERVICE_NOT_ACTIVE', 'E4 not registered');
select pg_temp.expect(pg_temp.as_role(format('select public.set_x_account_publish_authority(%L, ''enabled'', ''X'', now(), now() + interval ''1 day'')', :'acc_a'), 'authenticated', :'a') like 'ERR:permission denied%', 'E4 authenticated cannot grant');
select pg_temp.expect(pg_temp.svc(format('select private.account_lifecycle_assert_brand_service_active(%L, ''x_autopost'')::text', :'ws_a')) like 'ERR:permission denied%', 'E4 service_role never reaches the ordering variant');
select 'E4_GRANT_NEEDS_ACTIVE_SERVICE_PASS' as result;

-- E5: scheduled work across the service end: reserved/claimed before the end is refused at the next check.
select pg_temp.running_post(:'ws_a') as post_a2 \gset
select pg_temp.expect(pg_temp.check(:'post_a2', :'acc_a', :'ws_a') = 'allowed', 'E5 first check (before generation) allowed');
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'a' and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.check(:'post_a2', :'acc_a', :'ws_a') = 'ERR:VAULT_PUBLISH_SERVICE_NOT_ACTIVE', 'E5 second check (before the X create) refused');
update public.service_entitlements set status = 'active', ended_at = null where user_id = :'a' and service_key = 'x_autopost';
select 'E5_SECOND_CHECK_REFUSES_PASS' as result;

-- E6: X-only stop for one person's POSTONA end (B), with reservations and Stage 3B posts in every state.
insert into postona_x_resv.batches (id, user_id, brand_id, social_account_id, client_batch_id, revision, mode, origin, time_zone, band, payload_sha256)
values ('6a000000-0000-4000-8000-000000000001', :'a', :'ws_a', :'acc_a', gen_random_uuid(), 1, 'manual_exact', 'user_authored', 'Asia/Tokyo', null, repeat('a', 64)),
       ('6a000000-0000-4000-8000-000000000002', :'b', :'ws_b', :'acc_b', gen_random_uuid(), 1, 'manual_exact', 'user_authored', 'Asia/Tokyo', null, repeat('b', 64));
insert into postona_x_resv.reservations (batch_id, user_id, brand_id, social_account_id, draft_id, position, origin, mode, body, content_sha256,
  scheduled_at, fixed, status, consent_state, expires_at, lease_token, lease_expires_at)
select '6a000000-0000-4000-8000-000000000001', :'a', :'ws_a', :'acc_a', 'd' || g, g, 'user_authored', 'manual_exact', 'b' || g, repeat('c', 64),
       now() + (g || ' days')::interval, true, case when g = 2 then 'claimed' else 'planned' end, 'confirmed', now() + interval '20 days',
       case when g = 2 then gen_random_uuid() end, case when g = 2 then now() + interval '2 minutes' end
  from generate_series(0, 2) g;
insert into postona_x_resv.reservations (batch_id, user_id, brand_id, social_account_id, draft_id, position, origin, mode, body, content_sha256,
  scheduled_at, fixed, status, consent_state, expires_at)
values ('6a000000-0000-4000-8000-000000000002', :'b', :'ws_b', :'acc_b', 'db0', 0, 'user_authored', 'manual_exact', 'b', repeat('c', 64),
        now() + interval '3 days', true, 'planned', 'confirmed', now() + interval '20 days');
insert into public.scheduled_posts (brand_id, post_type, status) values (:'ws_a', 'brand_post', 'pending');
-- Threads lives in the same workspace (TEST STAND-IN: the baseline's X-only platform check is relaxed for it).
alter table public.social_accounts drop constraint if exists social_accounts_platform_check;
insert into public.social_accounts (id, brand_id, platform) values ('th' || replace(:'a', '-', ''), :'ws_a', 'threads');
select pg_temp.svc(format('select public.postona_x_stop_publishing_for_user(%L, ''POSTONA_SERVICE_ENDED'')::text', :'a')) as stop1 \gset
select pg_temp.expect((:'stop1')::jsonb ->> 'status' = 'stopped_in_flight', 'E6 status ' || :'stop1');
select pg_temp.expect(jsonb_array_length((:'stop1')::jsonb -> 'accounts') = 1, 'E6 one X account (Threads is not X)');
select pg_temp.expect((:'stop1')::jsonb #>> '{accounts,0,authority}' = 'revoked', 'E6 revoked');
select pg_temp.expect(((:'stop1')::jsonb #>> '{accounts,0,reservations_cancelled}')::int = 2, 'E6 planned cancelled');
select pg_temp.expect(((:'stop1')::jsonb #>> '{accounts,0,reservations_in_flight}')::int = 1, 'E6 claimed in flight');
select pg_temp.expect(((:'stop1')::jsonb #>> '{accounts,0,brand_posts_running}')::int = 2, 'E6 running posts counted');
select pg_temp.expect(((:'stop1')::jsonb #>> '{accounts,0,brand_posts_pending_refused}')::int = 1, 'E6 pending posts counted');
select pg_temp.expect((:'stop1')::jsonb ->> 'remote_authorization' = 'not_attempted' and (:'stop1')::jsonb #>> '{accounts,0,remote_authorization}' = 'not_attempted', 'E6 remote never claimed revoked');
select pg_temp.expect(((:'stop1')::jsonb ->> 'reconciliation_required')::boolean, 'E6 reconciliation required');
select pg_temp.expect(pg_temp.check(:'post_a', :'acc_a', :'ws_a') = 'ERR:VAULT_PUBLISH_AUTHORITY_REVOKED', 'E6 publishing stopped');
select pg_temp.expect((select status from postona_x_resv.reservations where draft_id = 'd2') = 'claimed', 'E6 in-flight row kept for reconciliation');
select pg_temp.expect(pg_temp.authority('th' || replace(:'a', '-', '')) = 'none', 'E6 Threads untouched');
select pg_temp.expect(pg_temp.authority(:'acc_b') = 'enabled' and (select status from postona_x_resv.reservations where draft_id = 'db0') = 'planned', 'E6 other person untouched');
select pg_temp.expect((select count(*) from postona_x_resv.audit where action = 'service_stop') = 2, 'E6 audited');
-- Idempotent: a second call changes nothing more.
select pg_temp.svc(format('select public.postona_x_stop_publishing_for_user(%L, ''POSTONA_SERVICE_ENDED'')::text', :'a')) as stop2 \gset
select pg_temp.expect(((:'stop2')::jsonb #>> '{accounts,0,reservations_cancelled}')::int = 0 and (:'stop2')::jsonb #>> '{accounts,0,authority_before}' = 'revoked', 'E6 idempotent');
-- A workspace shared with another person is blocked, never stopped on one person's word.
insert into public.brand_memberships (brand_id, user_id, role) values (:'ws_s', :'t', 'member');
select pg_temp.expect(pg_temp.enable(:'acc_s') = 'enabled', 'E6 shared setup');
select pg_temp.svc(format('select public.postona_x_stop_publishing_for_user(%L, ''POSTONA_SERVICE_ENDED'')::text', :'s')) as stop3 \gset
select pg_temp.expect((:'stop3')::jsonb ->> 'status' = 'blocked' and pg_temp.authority(:'acc_s') = 'enabled', 'E6 shared workspace blocked');
-- One account (A: individual X disconnect); invalid / foreign / specialised inputs.
select pg_temp.expect(pg_temp.svc(format('select public.postona_x_stop_account_publishing(%L, ''X_DISCONNECTED'') ->> ''authority''', :'acc_b')) = 'revoked', 'E6 one account');
select pg_temp.expect(pg_temp.svc('select public.postona_x_stop_account_publishing(''x_nope'', ''X_DISCONNECTED'')::text') = 'ERR:X_ACCOUNT_NOT_FOUND', 'E6 unknown account');
select pg_temp.expect(pg_temp.svc(format('select public.postona_x_stop_account_publishing(%L, ''bad'')::text', :'acc_b')) = 'ERR:X_STOP_REQUEST_INVALID', 'E6 bad reason');
select pg_temp.expect(pg_temp.svc(format('select public.postona_x_stop_account_publishing(%L, ''X_DISCONNECTED'')::text', 'th' || replace(:'a', '-', ''))) = 'ERR:X_ACCOUNT_NOT_FOUND', 'E6 Threads account refused');
select pg_temp.expect(pg_temp.as_role(format('select public.postona_x_stop_publishing_for_user(%L, ''X'')::text', :'a'), 'authenticated', :'a') like 'ERR:permission denied%', 'E6 authenticated cannot stop');
select 'E6_X_STOP_CONTRACT_PASS' as result;

select 'X_PUBLISH_ENTITLEMENT_BEHAVIOR_PASS' as result;
