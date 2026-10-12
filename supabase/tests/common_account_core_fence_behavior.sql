-- Behavior proof for 20261012130000_common_account_core_service_fence (common account Phase 4, G5).
-- Fake data only, disposable database only. The runner applies the production-shaped fixtures, the real
-- onboarding RPCs, the social-mobile deletion candidate, Phase 1, Phase 2, Phase 3a, the Phase 3b guard
-- (with its fixture: auth.sessions, GoTrue's auth.uid(), fixture writers) and the candidate. Prints
-- COMMON_ACCOUNT_CORE_FENCE_BEHAVIOR_PASS.
--
-- TEST STAND-INS, never in the candidate: "delete from auth.users" is a login removal;
-- "insert into/delete from auth.sessions" is GoTrue issuing / revoking a session; owner UPDATEs of
-- common_accounts / service_entitlements build states no client can reach; "delete from public.profiles"
-- stands for a profile that was never created or was removed.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create function pg_temp.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL %', p_label; end if;
end;
$$;
create function pg_temp.uid(p_n integer) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
create function pg_temp.set_claims(p_sub uuid, p_session uuid, p_claim_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
  perform set_config('request.jwt.claim.role', coalesce(p_claim_role, ''), true);
  perform set_config('request.jwt.claim.session_id', coalesce(p_session::text, ''), true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;
-- Runs p_sql (which must return one jsonb) as a database role with the person's claims. {"error": message} on error.
create function pg_temp.rpc(p_sql text, p_sub uuid default null, p_db_role text default 'authenticated', p_session uuid default null)
returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pg_temp.set_claims(p_sub, p_session, case when p_sub is null then null else 'authenticated' end);
  execute format('set local role %I', p_db_role);
  execute p_sql into v;
  reset role;
  perform pg_temp.set_claims(null, null, null);
  return v;
exception when others then
  reset role;
  perform pg_temp.set_claims(null, null, null);
  return jsonb_build_object('error', sqlerrm);
end;
$$;
-- Runs a statement the same way; 'OK' or the error message.
create function pg_temp.try(p_sql text, p_sub uuid default null, p_db_role text default 'authenticated', p_session uuid default null)
returns text language plpgsql as $$
begin
  perform pg_temp.set_claims(p_sub, p_session, case when p_sub is null then null else 'authenticated' end);
  execute format('set local role %I', p_db_role);
  execute p_sql;
  reset role;
  perform pg_temp.set_claims(null, null, null);
  return 'OK';
exception when others then
  reset role;
  perform pg_temp.set_claims(null, null, null);
  return sqlerrm;
end;
$$;
create function pg_temp.session(p_user uuid) returns uuid language sql as $$
  insert into auth.sessions (user_id) values (p_user) returning id
$$;
create function pg_temp.version(p_user uuid) returns bigint language sql as $$
  select lifecycle_version from public.common_accounts where user_id = p_user
$$;
create function pg_temp.n_accounts(p_user uuid) returns bigint language sql as $$
  select count(*) from public.common_accounts where user_id = p_user $$;
create function pg_temp.n_entitlements(p_user uuid) returns bigint language sql as $$
  select count(*) from public.service_entitlements where user_id = p_user $$;
create function pg_temp.n_profiles(p_user uuid) returns bigint language sql as $$
  select count(*) from public.profiles where id = p_user $$;
create function pg_temp.status_of(p_user uuid, p_service text) returns text language sql as $$
  select status from public.service_entitlements where user_id = p_user and service_key = p_service $$;
-- A person with the services started through the real Phase 2 start RPCs.
create function pg_temp.person(p_n integer, p_services text[]) returns uuid language plpgsql as $$
declare
  v_user uuid := pg_temp.uid(p_n);
  v_service text;
begin
  perform public.fixture_login(v_user);
  foreach v_service in array p_services loop
    perform pg_temp.expect(pg_temp.rpc(format('select to_jsonb(public.start_%s_service())', v_service), v_user) ->> 'status' = 'active',
                           format('setup: start %s', v_service));
  end loop;
  return v_user;
end;
$$;
create function pg_temp.svc(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  execute 'set local role service_role';
  execute p_sql into v;
  reset role;
  return v;
exception when others then
  reset role;
  return jsonb_build_object('error', sqlerrm);
end;
$$;

-- public.fixture_fenced_rows (a service owner's own table, with the generic fence attached) and the service-role
-- privilege on profiles come from common_account_core_fence_fixture.sql (applied by the runner).
create function pg_temp.fenced_insert(p_user uuid, p_for uuid, p_db_role text default 'authenticated') returns text language sql as $$
  select pg_temp.try(format('insert into public.fixture_fenced_rows (owner_id) values (%L)', p_for), p_user, p_db_role)
$$;

-- 0. ACL and shape. -----------------------------------------------------------------------------------
select pg_temp.expect(not has_function_privilege(r, f, 'EXECUTE'), format('0: %s cannot execute %s', r, f))
  from unnest(array['anon', 'authenticated', 'service_role', 'kb_cal_auth_child', 'kb_cal_svc_child']) r,
       unnest(array['private.account_lifecycle_service_state_refusal(uuid,text)',
                    'private.account_lifecycle_service_insert_fence()']) f;
select pg_temp.expect(prosecdef and proconfig @> array['search_path=""'] and provolatile = 'v', '0: definer, empty search_path, volatile')
  from pg_proc where oid in ('private.account_lifecycle_service_state_refusal(uuid,text)'::regprocedure,
                             'private.account_lifecycle_service_insert_fence()'::regprocedure);
select pg_temp.expect((select proconfig @> array['lock_timeout=3s'] from pg_proc
                        where oid = 'private.account_lifecycle_service_state_refusal(uuid,text)'::regprocedure), '0: bounded lock wait');
select pg_temp.expect(has_function_privilege('authenticated', 'public.ensure_my_profile()', 'EXECUTE')
                      and not has_function_privilege('anon', 'public.ensure_my_profile()', 'EXECUTE')
                      and not has_function_privilege('service_role', 'public.ensure_my_profile()', 'EXECUTE'), '0: ensure_my_profile grants');
select pg_temp.expect((select pronargs = 0 and prorettype = 'uuid'::regtype and prosecdef from pg_proc where oid = 'public.ensure_my_profile()'::regprocedure),
                      '0: ensure_my_profile keeps its shape and takes no argument');
select pg_temp.expect(pg_temp.rpc('select to_jsonb(private.account_lifecycle_service_state_refusal(''00000000-0000-4000-8000-000000000001''::uuid, ''x_autopost''))', pg_temp.uid(900)) ->> 'error'
                      like 'permission denied%', '0: an authenticated person cannot call the decision');

-- V. THE VERTICAL SLICE: one common login, two services, isolation, idempotency. -------------------------
select public.fixture_login(pg_temp.uid(1));
select pg_temp.expect(pg_temp.n_accounts(pg_temp.uid(1)) = 0 and pg_temp.n_entitlements(pg_temp.uid(1)) = 0, 'V0: a login alone has no account');
-- V1. First app: account + Kabumori entitlement + profile, in one call.
select pg_temp.rpc('select to_jsonb(public.start_kabumori_service())', pg_temp.uid(1)) as r \gset v1_
select pg_temp.expect(:'v1_r'::jsonb ->> 'status' = 'active' and :'v1_r'::jsonb ->> 'service' = 'kabumori'
                      and (:'v1_r'::jsonb ->> 'started')::boolean and not (:'v1_r'::jsonb ->> 'shared_account')::boolean, 'V1: first start answer');
select pg_temp.expect(pg_temp.n_accounts(pg_temp.uid(1)) = 1 and pg_temp.n_entitlements(pg_temp.uid(1)) = 1
                      and pg_temp.status_of(pg_temp.uid(1), 'kabumori') = 'active' and pg_temp.n_profiles(pg_temp.uid(1)) = 1, 'V1: rows');
select pg_temp.expect((select source from public.service_entitlements where user_id = pg_temp.uid(1)) = 'self_service', 'V1: source is self_service');
select pg_temp.expect((select count(*) from auth.users where id = pg_temp.uid(1)) = 1
                      and (select count(*) from auth.identities where user_id = pg_temp.uid(1)) = 1, 'V1: the login and its identity are untouched');
select pg_temp.version(pg_temp.uid(1)) as v \gset v1_
-- V2. Double submit: the same call again changes nothing.
select pg_temp.rpc('select to_jsonb(public.start_kabumori_service())', pg_temp.uid(1)) as r \gset v2_
select pg_temp.expect(:'v2_r'::jsonb ->> 'status' = 'active' and not (:'v2_r'::jsonb ->> 'started')::boolean
                      and pg_temp.n_entitlements(pg_temp.uid(1)) = 1 and pg_temp.n_profiles(pg_temp.uid(1)) = 1
                      and pg_temp.version(pg_temp.uid(1)) = :v1_v, 'V2: idempotent, no new row, no version bump');
-- V3. Second app, same common ID: only that app's entitlement is added.
select pg_temp.rpc('select to_jsonb(public.start_x_autopost_service())', pg_temp.uid(1)) as r \gset v3_
select pg_temp.expect(:'v3_r'::jsonb ->> 'status' = 'active' and :'v3_r'::jsonb ->> 'service' = 'x_autopost'
                      and (:'v3_r'::jsonb ->> 'started')::boolean and (:'v3_r'::jsonb ->> 'shared_account')::boolean, 'V3: POSTONA start answer');
select pg_temp.expect(pg_temp.n_accounts(pg_temp.uid(1)) = 1 and pg_temp.n_entitlements(pg_temp.uid(1)) = 2
                      and pg_temp.status_of(pg_temp.uid(1), 'kabumori') = 'active' and pg_temp.status_of(pg_temp.uid(1), 'x_autopost') = 'active'
                      and pg_temp.n_profiles(pg_temp.uid(1)) = 1, 'V3: one account, two entitlements, still one profile');
select pg_temp.expect((select count(*) from auth.users where id = pg_temp.uid(1)) = 1
                      and (select count(*) from auth.identities where user_id = pg_temp.uid(1)) = 1, 'V3: no second login, no new identity');
select pg_temp.expect(not exists (select 1 from public.brand_memberships where user_id = pg_temp.uid(1))
                      and not exists (select 1 from public.brands where id like pg_temp.uid(1)::text || '%'), 'V3: a service start creates no workspace');
select pg_temp.rpc('select to_jsonb(public.start_x_autopost_service())', pg_temp.uid(1)) as r \gset v3b_
select pg_temp.expect(not (:'v3b_r'::jsonb ->> 'started')::boolean and pg_temp.n_entitlements(pg_temp.uid(1)) = 2, 'V3: POSTONA double submit');
-- V4. Isolation: another person, and a person's attempts to reach or escalate entitlements.
select pg_temp.person(2, array['x_autopost']) as b \gset v4_
select pg_temp.expect(pg_temp.n_entitlements(:'v4_b') = 1 and pg_temp.status_of(:'v4_b', 'kabumori') is null, 'V4: B has only POSTONA');
select pg_temp.expect((pg_temp.rpc('select to_jsonb(count(*)) from public.service_entitlements', :'v4_b')) = '1'::jsonb,
                      'V4: B sees only its own entitlement rows (RLS)');
select pg_temp.expect((pg_temp.rpc(format('select to_jsonb(count(*)) from public.service_entitlements where user_id = %L', pg_temp.uid(1)), :'v4_b')) = '0'::jsonb,
                      'V4: B cannot read A''s entitlements');
select pg_temp.expect(pg_temp.try(format('insert into public.service_entitlements (user_id, service_key, status, source) values (%L, ''kabumori'', ''active'', ''self_service'')', :'v4_b'), :'v4_b')
                      like 'permission denied%', 'V4: no direct entitlement insert');
select pg_temp.expect(pg_temp.try(format('update public.service_entitlements set status = ''active'' where user_id = %L', :'v4_b'), :'v4_b')
                      like 'permission denied%', 'V4: no direct entitlement update');
select pg_temp.expect(pg_temp.try('select private.account_lifecycle_start_service(''00000000-0000-4000-8000-000000000001''::uuid, ''kabumori'')', :'v4_b') like 'permission denied%',
                      'V4: the internal start is not reachable');
select pg_temp.expect(pg_temp.rpc('select to_jsonb(public.start_kabumori_service())', null, 'anon') ->> 'error' like 'permission denied%', 'V4: anon cannot start');
select pg_temp.expect(pg_temp.rpc('select to_jsonb(public.start_kabumori_service())', null, 'authenticated') ->> 'error' = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED',
                      'V4: no subject');
select pg_temp.expect(pg_temp.n_entitlements(pg_temp.uid(1)) = 2 and pg_temp.status_of(:'v4_b', 'kabumori') is null, 'V4: nothing escalated');
-- V5. POSTONA ends: Kabumori and the login stay; no implicit restart; explicit restart at the version shown.
select pg_temp.session(pg_temp.uid(1)) as s \gset v5_
select pg_temp.expect(pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, ''x_autopost'')', pg_temp.uid(1))) ->> 'status' = 'started', 'V5 setup: begin');
select pg_temp.expect(pg_temp.try('select public.fixture_guarded_service_write(''x_autopost'')', pg_temp.uid(1), 'authenticated', :'v5_s')
                      = 'SERVICE_DELETION_IN_PROGRESS', 'V5: POSTONA writes are refused while it is being ended');
select pg_temp.expect(pg_temp.try('select public.fixture_guarded_service_write(''kabumori'')', pg_temp.uid(1), 'authenticated', :'v5_s') = 'OK',
                      'V5: Kabumori still writes');
select pg_temp.expect(pg_temp.svc(format('select public.finish_service_deletion(%L::uuid, ''x_autopost'', %L::uuid)', pg_temp.uid(1),
        (select id from private.account_lifecycle_operations where user_id = pg_temp.uid(1) and operation_type = 'service_deletion' and status = 'in_progress'))) ->> 'status' = 'ended',
        'V5 setup: finish');
select pg_temp.expect(pg_temp.status_of(pg_temp.uid(1), 'x_autopost') = 'ended' and pg_temp.status_of(pg_temp.uid(1), 'kabumori') = 'active'
                      and pg_temp.n_profiles(pg_temp.uid(1)) = 1, 'V5: only POSTONA ended');
select pg_temp.expect(pg_temp.rpc('select to_jsonb(public.start_x_autopost_service())', pg_temp.uid(1)) ->> 'status' = 'reenroll_required'
                      and pg_temp.status_of(pg_temp.uid(1), 'x_autopost') = 'ended', 'V5: the automatic start does not restart it');
select pg_temp.expect(pg_temp.rpc('select to_jsonb(public.reactivate_x_autopost_service(1))', pg_temp.uid(1)) ->> 'status' = 'lifecycle_changed'
                      and pg_temp.status_of(pg_temp.uid(1), 'x_autopost') = 'ended', 'V5: a restart at a stale version changes nothing');
select pg_temp.expect(pg_temp.rpc(format('select to_jsonb(public.reactivate_x_autopost_service(%s))', pg_temp.version(pg_temp.uid(1))), pg_temp.uid(1)) ->> 'status' = 'active'
                      and pg_temp.status_of(pg_temp.uid(1), 'x_autopost') = 'active', 'V5: an explicit restart at the shown version');

-- F. THE PROFILE ROOT AND THE GENERIC FENCE. --------------------------------------------------------------
-- F1. Direct insert (the profiles_insert_own path) for a person without the Kabumori entitlement.
select pg_temp.person(10, array['x_autopost']) as p \gset f1_
select pg_temp.expect(pg_temp.try(format('insert into public.profiles (id) values (%L)', :'f1_p'), :'f1_p') = 'SERVICE_NOT_REGISTERED'
                      and pg_temp.n_profiles(:'f1_p') = 0, 'F1: no profile without an entitlement (direct insert)');
select pg_temp.expect(pg_temp.try(format('insert into public.profiles (id) values (%L)', :'f1_p'), :'f1_p', 'service_role') = 'SERVICE_NOT_REGISTERED',
                      'F1: ... nor for a service-role job');
-- F2. A login with no common account: refused, and nothing is created by the refusal.
select public.fixture_login(pg_temp.uid(11));
select pg_temp.expect(pg_temp.try(format('insert into public.profiles (id) values (%L)', pg_temp.uid(11)), pg_temp.uid(11)) = 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'
                      and pg_temp.n_accounts(pg_temp.uid(11)) = 0 and pg_temp.n_profiles(pg_temp.uid(11)) = 0, 'F2: no account, nothing created');
-- F3. Another person's id with my JWT: refused before any lock (RLS would refuse the row afterwards).
select pg_temp.expect(pg_temp.try(format('insert into public.profiles (id) values (%L)', pg_temp.uid(1)), :'f1_p') = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED',
                      'F3: a person cannot name another person');
-- F4. States of the Kabumori service and the account.
select pg_temp.person(12, array['kabumori']) as p \gset f4_
delete from public.profiles where id = :'f4_p';   -- stand-in: the root is missing
select pg_temp.expect(pg_temp.try(format('insert into public.profiles (id) values (%L)', :'f4_p'), :'f4_p') = 'OK' and pg_temp.n_profiles(:'f4_p') = 1,
                      'F4: an active person gets the root back');
select pg_temp.expect(pg_temp.try(format('insert into public.profiles (id) values (%L) on conflict (id) do nothing', :'f4_p'), :'f4_p') = 'OK',
                      'F4: an idempotent re-insert for an active person');
select pg_temp.person(13, array['kabumori']) as p \gset f5_
select pg_temp.expect(pg_temp.svc(format('select public.withdraw_kabumori_service(%L::uuid)', :'f5_p')) ->> 'status' = 'ended' and pg_temp.n_profiles(:'f5_p') = 0,
                      'F5 setup: Kabumori ended, profile gone');
select pg_temp.expect(pg_temp.try(format('insert into public.profiles (id) values (%L)', :'f5_p'), :'f5_p') = 'SERVICE_NOT_ACTIVE', 'F5: ended: direct insert refused');
select pg_temp.expect(pg_temp.rpc('select to_jsonb(public.ensure_my_profile())', :'f5_p') ->> 'error' = 'SERVICE_REENROLL_REQUIRED', 'F5: ended: ensure_my_profile refused');
select pg_temp.expect(pg_temp.try(format('insert into public.profiles (id) values (%L)', :'f5_p'), :'f5_p', 'service_role') = 'SERVICE_NOT_ACTIVE', 'F5: ended: a service-role job refused');
select pg_temp.expect(pg_temp.n_profiles(:'f5_p') = 0 and pg_temp.status_of(:'f5_p', 'kabumori') = 'ended', 'F5: nothing came back, nothing restarted');
select pg_temp.expect(pg_temp.rpc('select to_jsonb(public.start_kabumori_service())', :'f5_p') ->> 'status' = 'reenroll_required' and pg_temp.n_profiles(:'f5_p') = 0,
                      'F5: the automatic start still does not restart it');
select pg_temp.expect(pg_temp.rpc(format('select to_jsonb(public.reactivate_kabumori_service(%s))', pg_temp.version(:'f5_p')), :'f5_p') ->> 'status' = 'active'
                      and pg_temp.n_profiles(:'f5_p') = 1, 'F5: an explicit restart brings the profile back through the fence');
-- F6. Whole-account deletion begun: the root cannot come back, through any door.
select pg_temp.person(14, array['kabumori', 'x_autopost']) as p \gset f6_
select pg_temp.expect(pg_temp.svc(format('select public.begin_common_account_deletion(%L::uuid, %s)', :'f6_p', pg_temp.version(:'f6_p'))) ->> 'status' = 'started', 'F6 setup: begun');
delete from public.profiles where id = :'f6_p';   -- stand-in: the profile is gone at this point of the orchestrator
select pg_temp.expect(pg_temp.try(format('insert into public.profiles (id) values (%L)', :'f6_p'), :'f6_p') = 'ACCOUNT_DELETION_IN_PROGRESS', 'F6: direct insert refused');
select pg_temp.expect(pg_temp.rpc('select to_jsonb(public.ensure_my_profile())', :'f6_p') ->> 'error' = 'ACCOUNT_DELETION_IN_PROGRESS', 'F6: ensure_my_profile refused');
select pg_temp.expect(pg_temp.rpc('select to_jsonb(public.start_kabumori_service())', :'f6_p') ->> 'reason' = 'ACCOUNT_DELETION_IN_PROGRESS', 'F6: the start is blocked');
select pg_temp.expect(pg_temp.try(format('insert into public.profiles (id) values (%L)', :'f6_p'), :'f6_p', 'service_role') = 'ACCOUNT_DELETION_IN_PROGRESS', 'F6: a service-role job refused');
select pg_temp.expect(pg_temp.n_profiles(:'f6_p') = 0, 'F6: no profile');
-- F7. UPDATEs are not fenced (insert-only, by design): an owner-side update of a profile still works.
select pg_temp.expect(pg_temp.try(format('update public.profiles set created_at = created_at where id = %L', :'f4_p'), null, current_user) = 'OK'
                      and (select count(*) from public.profiles where id = :'f4_p') = 1, 'F7: updates are unaffected');

-- E. ensure_my_profile() for OLD builds: enrolls like the new start, refuses like it. ---------------------
select public.fixture_login(pg_temp.uid(20));
select pg_temp.expect(pg_temp.rpc('select to_jsonb(public.ensure_my_profile())', pg_temp.uid(20)) = to_jsonb(pg_temp.uid(20)::text), 'E1: returns the person''s id');
select pg_temp.expect(pg_temp.n_accounts(pg_temp.uid(20)) = 1 and pg_temp.status_of(pg_temp.uid(20), 'kabumori') = 'active'
                      and pg_temp.n_profiles(pg_temp.uid(20)) = 1 and pg_temp.n_entitlements(pg_temp.uid(20)) = 1, 'E1: account + entitlement + profile');
select pg_temp.expect(pg_temp.rpc('select to_jsonb(public.ensure_my_profile())', pg_temp.uid(20)) = to_jsonb(pg_temp.uid(20)::text)
                      and pg_temp.n_entitlements(pg_temp.uid(20)) = 1 and pg_temp.n_profiles(pg_temp.uid(20)) = 1, 'E2: idempotent');
select pg_temp.expect(pg_temp.rpc('select to_jsonb(public.ensure_my_profile())', null) ->> 'error' = 'AUTHENTICATION_REQUIRED', 'E3: no subject');
select pg_temp.expect(pg_temp.rpc('select to_jsonb(public.ensure_my_profile())', null, 'anon') ->> 'error' like 'permission denied%', 'E3: anon');
select pg_temp.expect(pg_temp.rpc('select to_jsonb(public.ensure_my_profile())', pg_temp.uid(9999)) ->> 'error' = 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'
                      and pg_temp.n_accounts(pg_temp.uid(9999)) = 0, 'E4: a removed or unknown login creates nothing');
-- E5. A person whose profile exists without an entitlement (an old-build sign-up before this file): enrolled.
select public.fixture_login(pg_temp.uid(21));
alter table public.profiles disable trigger account_lifecycle_profile_root_fence;   -- stand-in for a pre-existing row
insert into public.profiles (id) values (pg_temp.uid(21));
alter table public.profiles enable trigger account_lifecycle_profile_root_fence;
select pg_temp.expect(pg_temp.rpc('select to_jsonb(public.ensure_my_profile())', pg_temp.uid(21)) = to_jsonb(pg_temp.uid(21)::text)
                      and pg_temp.status_of(pg_temp.uid(21), 'kabumori') = 'active', 'E5: a legacy profile is enrolled, not duplicated');

-- G. THE GENERIC FENCE for another owner's table. -----------------------------------------------------------
select pg_temp.person(30, array['x_autopost']) as p \gset g_
select pg_temp.expect(pg_temp.fenced_insert(:'g_p', :'g_p') = 'OK', 'G1: an active POSTONA person');
select pg_temp.expect(pg_temp.fenced_insert(:'g_p', pg_temp.uid(1)) = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'G2: another person''s id');
select pg_temp.expect(pg_temp.fenced_insert(:'g_p', null) = 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', 'G3: no owner');
select pg_temp.person(31, array['kabumori']) as p \gset g4_
select pg_temp.expect(pg_temp.fenced_insert(:'g4_p', :'g4_p') = 'SERVICE_NOT_REGISTERED', 'G4: a Kabumori person has no POSTONA entitlement');
select pg_temp.expect(pg_temp.fenced_insert(null, :'g_p', 'service_role') = 'OK', 'G5: a service-role job writes for an active person');
select pg_temp.expect(pg_temp.fenced_insert(null, :'g4_p', 'service_role') = 'SERVICE_NOT_REGISTERED', 'G5: ... not for one without the service');
select pg_temp.expect(pg_temp.fenced_insert(null, pg_temp.uid(11), 'service_role') = 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', 'G5: ... not for one without an account');
select pg_temp.expect((select count(*) from public.fixture_fenced_rows) = 2, 'G: exactly the two authorized rows exist');
-- G6. Misconfigured attachments fail closed.
create table public.fixture_misfenced (id bigserial primary key, owner_id uuid, note text default '');
create trigger t_wrong_column before insert on public.fixture_misfenced for each row
  execute function private.account_lifecycle_service_insert_fence('no_such_column', 'x_autopost');
select pg_temp.expect(pg_temp.try(format('insert into public.fixture_misfenced (owner_id) values (%L)', :'g_p'), null, current_user) = 'ACCOUNT_LIFECYCLE_FENCE_MISCONFIGURED',
                      'G6: a wrong column');
drop trigger t_wrong_column on public.fixture_misfenced;
create trigger t_stmt before insert on public.fixture_misfenced for each statement
  execute function private.account_lifecycle_service_insert_fence('owner_id', 'x_autopost');
select pg_temp.expect(pg_temp.try(format('insert into public.fixture_misfenced (owner_id) values (%L)', :'g_p'), null, current_user) = 'ACCOUNT_LIFECYCLE_FENCE_MISCONFIGURED',
                      'G6: a statement-level attachment');
drop trigger t_stmt on public.fixture_misfenced;
create trigger t_upd before update on public.fixture_misfenced for each row
  execute function private.account_lifecycle_service_insert_fence('owner_id', 'x_autopost');
insert into public.fixture_misfenced (owner_id) values (:'g_p');
select pg_temp.expect(pg_temp.try(format('update public.fixture_misfenced set note = ''x'' where owner_id = %L', :'g_p'), null, current_user) = 'ACCOUNT_LIFECYCLE_FENCE_MISCONFIGURED',
                      'G6: an update attachment is refused (insert only)');
drop trigger t_upd on public.fixture_misfenced;
create trigger t_service before insert on public.fixture_misfenced for each row
  execute function private.account_lifecycle_service_insert_fence('owner_id', 'threads');
select pg_temp.expect(pg_temp.try(format('insert into public.fixture_misfenced (owner_id) values (%L)', :'g_p'), null, current_user) = 'ACCOUNT_LIFECYCLE_SERVICE_INVALID',
                      'G6: an unknown service key');
drop trigger t_service on public.fixture_misfenced;
create trigger t_args before insert on public.fixture_misfenced for each row
  execute function private.account_lifecycle_service_insert_fence('owner_id');
select pg_temp.expect(pg_temp.try(format('insert into public.fixture_misfenced (owner_id) values (%L)', :'g_p'), null, current_user) = 'ACCOUNT_LIFECYCLE_FENCE_MISCONFIGURED',
                      'G6: a missing argument');
drop trigger t_args on public.fixture_misfenced;

-- D. ONE DECISION: the fence and the Phase 3b writer guard answer the same way in every state. -------------
create function pg_temp.guard_msg(p_user uuid) returns text language plpgsql as $$
declare v_session uuid;
begin
  select id into v_session from auth.sessions where user_id = p_user order by created_at desc limit 1;
  if v_session is null then v_session := pg_temp.session(p_user); end if;
  return pg_temp.try('select public.fixture_guarded_service_write(''x_autopost'')', p_user, 'authenticated', v_session);
end;
$$;
create function pg_temp.same(p_user uuid, p_label text) returns void language plpgsql as $$
declare
  g text := pg_temp.guard_msg(p_user);
  f text := pg_temp.fenced_insert(p_user, p_user);
begin
  perform pg_temp.expect(g = f, format('D: %s: guard=%s fence=%s', p_label, g, f));
end;
$$;
select pg_temp.person(40, array['x_autopost', 'kabumori']) as p \gset d1_
select pg_temp.same(:'d1_p', 'active');
select pg_temp.person(41, array['x_autopost']) as p \gset d2_
select pg_temp.expect(pg_temp.svc(format('select public.begin_common_account_deletion(%L::uuid, %s)', :'d2_p', pg_temp.version(:'d2_p'))) ->> 'status' = 'started', 'D setup');
select pg_temp.same(:'d2_p', 'account deleting');
update public.common_accounts set status = 'active' where user_id = :'d2_p';
select pg_temp.same(:'d2_p', 'open deletion, account row active');
select pg_temp.person(42, array['x_autopost']) as p \gset d3_
update public.common_accounts set status = 'locked' where user_id = :'d3_p';
select pg_temp.same(:'d3_p', 'locked');
select pg_temp.person(43, array['x_autopost']) as p \gset d4_
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'d4_p';
select pg_temp.same(:'d4_p', 'ended');
update public.service_entitlements set status = 'suspended', ended_at = null where user_id = :'d4_p';
select pg_temp.same(:'d4_p', 'suspended');
update public.service_entitlements set status = 'provisioning' where user_id = :'d4_p';
select pg_temp.same(:'d4_p', 'provisioning');
update public.service_entitlements set status = 'active' where user_id = :'d4_p';
select pg_temp.same(:'d4_p', 'active again');
select pg_temp.person(44, array['x_autopost']) as p \gset d5_
select pg_temp.expect(pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, ''x_autopost'')', :'d5_p')) ->> 'status' = 'started', 'D setup 5');
select pg_temp.same(:'d5_p', 'service deleting');
update public.service_entitlements set status = 'active' where user_id = :'d5_p';
select pg_temp.same(:'d5_p', 'open service deletion, entitlement row active');
select pg_temp.person(45, array['kabumori']) as p \gset d6_
select pg_temp.same(:'d6_p', 'not registered');
select public.fixture_login(pg_temp.uid(46));
select pg_temp.same(pg_temp.uid(46), 'no account');
select pg_temp.expect(pg_temp.n_accounts(pg_temp.uid(46)) = 0, 'D: a refusal created no account');
select pg_temp.person(47, array['x_autopost']) as p \gset d7_
select pg_temp.session(:'d7_p');
delete from auth.users where id = :'d7_p';
select pg_temp.expect(pg_temp.fenced_insert(:'d7_p', :'d7_p') = 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', 'D: a removed login (fence)');
select pg_temp.expect(pg_temp.try('select public.fixture_guarded_service_write(''x_autopost'')', :'d7_p', 'authenticated', pg_temp.uid(9)) = 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND',
                      'D: a removed login (guard)');

select 'COMMON_ACCOUNT_CORE_FENCE_BEHAVIOR_PASS';
