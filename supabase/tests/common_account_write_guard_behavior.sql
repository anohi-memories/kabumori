-- Behavior proof for 20261010051938_common_account_service_write_guard (common account Phase 3b, G5).
-- Fake data only, disposable database only. The runner applies the production-shaped fixtures, the real
-- onboarding RPCs, the social-mobile deletion candidate, Phase 1, Phase 2, Phase 3a, the guard fixture
-- (auth.sessions, GoTrue's auth.uid(), fixture writers) and the candidate. Prints
-- COMMON_ACCOUNT_WRITE_GUARD_BEHAVIOR_PASS.
--
-- TEST STAND-INS, never in the candidate: "insert into / delete from auth.sessions" is GoTrue issuing /
-- revoking a session; "delete from auth.users" is a login removal; owner UPDATEs of common_accounts /
-- service_entitlements build states (locked, suspended, inconsistent) no client can reach.
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
-- Runs p_sql as p_db_role with the given JWT claims; 'OK' or the error message.
--   p_style 'legacy': request.jwt.claim.{sub,role,session_id}; 'json': request.jwt.claims; 'none': no claims.
create function pg_temp.call(p_sql text, p_sub text, p_session text, p_claim_role text default 'authenticated',
                             p_style text default 'legacy', p_db_role text default 'authenticated', p_raw_claims text default null)
returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.session_id', '', true);
  perform set_config('request.jwt.claims', '', true);
  if p_style = 'legacy' then
    perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
    perform set_config('request.jwt.claim.role', coalesce(p_claim_role, ''), true);
    perform set_config('request.jwt.claim.session_id', coalesce(p_session, ''), true);
  elsif p_style = 'json' then
    perform set_config('request.jwt.claims', coalesce(p_raw_claims,
      jsonb_strip_nulls(jsonb_build_object('sub', p_sub, 'role', p_claim_role, 'session_id', p_session))::text), true);
  end if;
  if p_db_role is not null then execute format('set local role %I', p_db_role); end if;
  execute p_sql;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return 'OK';
exception when others then
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return sqlerrm;
end;
$$;
create function pg_temp.write(p_user uuid, p_session uuid, p_service text default 'x_autopost', p_style text default 'legacy') returns text language sql as $$
  select pg_temp.call(format('select public.fixture_guarded_service_write(%L)', p_service), p_user::text, p_session::text, 'authenticated', p_style)
$$;
create function pg_temp.session(p_user uuid, p_not_after timestamptz default null) returns uuid language sql as $$
  insert into auth.sessions (user_id, not_after) values (p_user, p_not_after) returning id
$$;
-- A person with the given services started through the real Phase 2 start RPCs, and a live session.
create function pg_temp.person(p_n integer, p_services text[]) returns uuid language plpgsql as $$
declare
  v_user uuid := pg_temp.uid(p_n);
  v_service text;
begin
  perform public.fixture_login(v_user);
  foreach v_service in array p_services loop
    perform pg_temp.expect(pg_temp.call(format('select public.start_%s_service()', v_service), v_user::text, null) = 'OK',
                           format('setup: start %s', v_service));
  end loop;
  return v_user;
end;
$$;
create function pg_temp.footprints(p_user uuid) returns bigint language sql as $$
  select count(*) from public.fixture_service_footprint where user_id = p_user
$$;
create function pg_temp.svc(p_sql text) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  execute p_sql into v;
  reset role;
  return v;
end;
$$;

-- G0. Nobody but the owner can execute the guard; only a reviewed definer writer reaches it. ---------------
select pg_temp.expect(not has_function_privilege(r, 'private.account_lifecycle_assert_active_service_write(uuid,text)', 'EXECUTE'),
                      format('G0: %s cannot execute the guard', r))
  from unnest(array['anon', 'authenticated', 'service_role', 'kb_cal_auth_child', 'kb_cal_svc_child']) r;
select pg_temp.expect((select array_to_string(proacl::text[], ',') from pg_proc
                        where oid = 'private.account_lifecycle_assert_active_service_write(uuid,text)'::regprocedure)
                      = format('%s=X/%s', current_user, current_user), 'G0: owner-only ACL');
select pg_temp.expect(prosecdef and proconfig = array['search_path=""'] and provolatile = 'v', 'G0: definer, empty search_path, volatile')
  from pg_proc where oid = 'private.account_lifecycle_assert_active_service_write(uuid,text)'::regprocedure;

select pg_temp.person(1, array['x_autopost']) \gset g0_
select pg_temp.session(:'g0_person') \gset g0_
select pg_temp.expect(pg_temp.call(format('select private.account_lifecycle_assert_active_service_write(%L, ''x_autopost'')', :'g0_person'),
                                   :'g0_person', :'g0_session') like 'permission denied for function account_lifecycle_assert_active_service_write%',
                      'G0: an authenticated person cannot call the guard directly');
select pg_temp.expect(pg_temp.call(format('select private.account_lifecycle_assert_active_service_write(%L, ''x_autopost'')', :'g0_person'),
                                   :'g0_person', :'g0_session', 'service_role', 'legacy', 'service_role') like 'permission denied for function%',
                      'G0: service_role cannot call the guard directly');
select pg_temp.expect(pg_temp.call('select public.fixture_invoker_service_write(''x_autopost'')', :'g0_person', :'g0_session')
                        like 'permission denied for function account_lifecycle_assert_active_service_write%',
                      'G0: an invoker-rights writer cannot reach the guard (fails closed)');
select pg_temp.expect(pg_temp.call('select public.fixture_foreign_owner_service_write(''x_autopost'')', :'g0_person', :'g0_session')
                        like 'permission denied for function account_lifecycle_assert_active_service_write%',
                      'G0: a definer writer owned by another role cannot reach the guard (fails closed)');
select pg_temp.expect(pg_temp.footprints(:'g0_person') = 0, 'G0: nothing was written');

-- A. The reviewed writer, for an active person with a live session, writes. ----------------------------
select pg_temp.expect(pg_temp.write(:'g0_person', :'g0_session') = 'OK', 'A: active X person writes (per-claim settings)');
select pg_temp.expect(pg_temp.write(:'g0_person', :'g0_session', 'x_autopost', 'json') = 'OK', 'A: active X person writes (JSON claims)');
select pg_temp.expect(pg_temp.footprints(:'g0_person') = 2, 'A: two writes');
select pg_temp.person(2, array['kabumori']) \gset a_
select pg_temp.session(:'a_person') \gset a_
select pg_temp.expect(pg_temp.write(:'a_person', :'a_session', 'kabumori') = 'OK', 'A: active Kabumori person writes Kabumori');
select pg_temp.expect(pg_temp.write(:'a_person', :'a_session', 'x_autopost') = 'SERVICE_NOT_REGISTERED', 'A: ... but not POSTONA');
select pg_temp.session(:'a_person', now() + interval '1 hour') \gset a_future_
select pg_temp.expect(pg_temp.write(:'a_person', :'a_future_session', 'kabumori') = 'OK', 'A: a time-boxed session before its end writes');

-- B. The caller must be the person, through a live session. --------------------------------------------
select pg_temp.person(3, array['x_autopost']) \gset b_
select pg_temp.session(:'b_person') \gset b_
select pg_temp.person(4, array['x_autopost']) \gset b_other_
select pg_temp.session(:'b_other_person') \gset b_other_
select pg_temp.expect(pg_temp.call(format('select public.fixture_guarded_write_for(%L, ''x_autopost'')', :'b_person'), null, null, null, 'none')
                      = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B1: no JWT');
select pg_temp.expect(pg_temp.call(format('select public.fixture_guarded_write_for(%L, ''x_autopost'')', :'b_person'), null, null, null, 'none', 'service_role')
                      = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B1: service_role with no JWT subject, trusting its input');
select pg_temp.expect(pg_temp.call('select public.fixture_guarded_service_write(''x_autopost'')', :'b_person', :'b_session', 'anon')
                      = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B2: an anon role claim');
select pg_temp.expect(pg_temp.call('select public.fixture_guarded_service_write(''x_autopost'')', :'b_person', :'b_session', 'service_role')
                      = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B2: a service_role claim with a subject');
select pg_temp.expect(pg_temp.call('select public.fixture_guarded_service_write(''x_autopost'')', :'b_person', :'b_session', 'service_role', 'json')
                      = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B2: a service_role claim (JSON claims)');
select pg_temp.expect(pg_temp.call('select public.fixture_guarded_service_write(''x_autopost'')', :'b_person', :'b_session', null)
                      = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B2: no role claim');
select pg_temp.expect(pg_temp.call('select public.fixture_guarded_service_write(''x_autopost'')', :'b_person', null)
                      = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B3: no session id');
select pg_temp.expect(pg_temp.call('select public.fixture_guarded_service_write(''x_autopost'')', :'b_person', 'not-a-session')
                      = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B3: a malformed session id');
select pg_temp.expect(pg_temp.call(format('select public.fixture_guarded_write_for(%L, ''x_autopost'')', :'b_person'), 'not-a-user', :'b_session')
                      = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B3: a malformed subject');
select pg_temp.expect(pg_temp.call(format('select public.fixture_guarded_write_for(%L, ''x_autopost'')', :'b_person'), null, null, null, 'json',
                                   'authenticated', '{not json') = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B4: malformed JSON claims');
select pg_temp.expect(pg_temp.call(format('select public.fixture_guarded_write_for(%L, ''x_autopost'')', :'b_person'), null, null, null, 'json',
                                   'authenticated', '"a string"') = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B4: JSON claims that are not an object');
select pg_temp.expect(pg_temp.call(format('select public.fixture_guarded_write_for(%L, ''x_autopost'')', :'b_other_person'), :'b_person', :'b_session')
                      = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B5: a writer that hands the guard another person''s id');
select pg_temp.expect(pg_temp.call(format('select private.account_lifecycle_assert_active_service_write(%L, ''x_autopost'')', :'b_other_person'),
                                   :'b_person', :'b_session', 'authenticated', 'legacy', null) = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED',
                      'B5: even the privileged owner cannot assert for someone the JWT does not name');
select pg_temp.expect(pg_temp.write(:'b_person', :'b_other_session') = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B6: another person''s session');
select pg_temp.expect(pg_temp.write(:'b_person', gen_random_uuid()) = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B6: an unknown session');
delete from auth.sessions where id = :'b_session';
select pg_temp.expect(pg_temp.write(:'b_person', :'b_session') = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B7: a revoked session (still-valid access token)');
select pg_temp.expect(pg_temp.write(:'b_person', :'b_session', 'x_autopost', 'json') = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B7: a revoked session (JSON claims)');
select pg_temp.session(:'b_person', now() - interval '1 second') \gset b_expired_
select pg_temp.expect(pg_temp.write(:'b_person', :'b_expired_session') = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B8: a time-boxed session past its end');
-- B9. One claim source: with per-claim settings present, a JSON session id is not borrowed.
select pg_temp.session(:'b_person') \gset b_live_
select pg_temp.expect(pg_temp.call(format('
  select set_config(''request.jwt.claims'', %L, true), public.fixture_guarded_service_write(''x_autopost'')',
    jsonb_build_object('sub', :'b_person', 'role', 'authenticated', 'session_id', :'b_live_session')::text),
  :'b_person', null) = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'B9: claim sources are not mixed');
select pg_temp.expect(pg_temp.write(:'b_person', :'b_live_session') = 'OK', 'B9: the live session writes');
select pg_temp.expect(pg_temp.footprints(:'b_person') = 1 and pg_temp.footprints(:'b_other_person') = 0, 'B: only the one authorized write');

-- C. The common account. --------------------------------------------------------------------------------
-- C1: a still-valid token of a removed login (the session row went with the login, so make a fresh row
--     impossible: the lock finds no login first).
select pg_temp.person(5, array['x_autopost']) \gset c1_
select pg_temp.session(:'c1_person') \gset c1_
delete from auth.users where id = :'c1_person';
select pg_temp.expect(pg_temp.write(:'c1_person', :'c1_session') = 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', 'C1: removed login (stale JWT)');
-- C2: a login with no common account yet: refused, and nothing is created.
select public.fixture_login(pg_temp.uid(6));
select pg_temp.session(pg_temp.uid(6)) \gset c2_
select pg_temp.expect(pg_temp.write(pg_temp.uid(6), :'c2_session') = 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', 'C2: no common account');
select pg_temp.expect(not exists (select 1 from public.common_accounts where user_id = pg_temp.uid(6))
                      and not exists (select 1 from public.service_entitlements where user_id = pg_temp.uid(6)), 'C2: nothing created');
-- C3: whole-account deletion begun.
select pg_temp.person(7, array['x_autopost', 'kabumori']) \gset c3_
select pg_temp.session(:'c3_person') \gset c3_
select pg_temp.expect(pg_temp.svc(format('select public.begin_common_account_deletion(%L::uuid, %s)', :'c3_person',
         (select lifecycle_version from public.common_accounts where user_id = :'c3_person'))) ->> 'status' = 'started', 'C3 setup: deletion begun');
select pg_temp.expect(pg_temp.write(:'c3_person', :'c3_session', 'x_autopost') = 'ACCOUNT_DELETION_IN_PROGRESS', 'C3: deleting (POSTONA)');
select pg_temp.expect(pg_temp.write(:'c3_person', :'c3_session', 'kabumori') = 'ACCOUNT_DELETION_IN_PROGRESS', 'C3: deleting (Kabumori)');
-- C4: an inconsistent state -- the account says active, but a deletion is open: still refused.
update public.common_accounts set status = 'active' where user_id = :'c3_person';
select pg_temp.expect(pg_temp.write(:'c3_person', :'c3_session', 'x_autopost') = 'ACCOUNT_DELETION_IN_PROGRESS', 'C4: open deletion with an active account row');
-- C5: locked.
select pg_temp.person(8, array['x_autopost']) \gset c5_
select pg_temp.session(:'c5_person') \gset c5_
update public.common_accounts set status = 'locked' where user_id = :'c5_person';
select pg_temp.expect(pg_temp.write(:'c5_person', :'c5_session') = 'ACCOUNT_LOCKED', 'C5: locked account');
select pg_temp.expect(pg_temp.footprints(:'c3_person') + pg_temp.footprints(:'c5_person') + pg_temp.footprints(pg_temp.uid(6)) = 0, 'C: nothing written');

-- D. The service entitlement. ---------------------------------------------------------------------------
select pg_temp.person(9, array['x_autopost']) \gset d_
select pg_temp.session(:'d_person') \gset d_
select pg_temp.expect(pg_temp.write(:'d_person', :'d_session', 'kabumori') = 'SERVICE_NOT_REGISTERED', 'D1: not registered');
select pg_temp.expect(pg_temp.write(:'d_person', :'d_session', 'threads') = 'ACCOUNT_LIFECYCLE_SERVICE_INVALID', 'D1: unknown service key');
select pg_temp.expect(pg_temp.call(format('select public.fixture_guarded_write_for(%L, null)', :'d_person'), :'d_person', :'d_session')
                      = 'ACCOUNT_LIFECYCLE_SERVICE_INVALID', 'D1: no service key');
select pg_temp.expect(pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, ''x_autopost'')', :'d_person')) ->> 'status' = 'started',
                      'D2 setup: POSTONA deletion begun');
select pg_temp.expect(pg_temp.write(:'d_person', :'d_session') = 'SERVICE_DELETION_IN_PROGRESS', 'D2: service deletion in progress');
update public.service_entitlements set status = 'active' where user_id = :'d_person' and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.write(:'d_person', :'d_session') = 'SERVICE_DELETION_IN_PROGRESS', 'D3: open service deletion with an active entitlement row');
update private.account_lifecycle_operations set status = 'aborted', finished_at = now()
 where user_id = :'d_person' and operation_type = 'service_deletion' and status = 'in_progress';
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'d_person' and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.write(:'d_person', :'d_session') = 'SERVICE_NOT_ACTIVE', 'D4: ended');
update public.service_entitlements set status = 'suspended', ended_at = null where user_id = :'d_person' and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.write(:'d_person', :'d_session') = 'SERVICE_NOT_ACTIVE', 'D4: suspended');
update public.service_entitlements set status = 'provisioning' where user_id = :'d_person' and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.write(:'d_person', :'d_session') = 'SERVICE_NOT_ACTIVE', 'D4: provisioning');
update public.service_entitlements set status = 'active' where user_id = :'d_person' and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.write(:'d_person', :'d_session') = 'OK', 'D5: active again writes');
select pg_temp.expect(pg_temp.footprints(:'d_person') = 1, 'D: only the one authorized write');

-- E. Refusals create and write nothing anywhere. ---------------------------------------------------------
select pg_temp.expect((select count(*) from public.fixture_service_footprint) = 6, 'E: exactly the six authorized writes exist');
select pg_temp.expect((select count(*) from public.common_accounts where user_id = pg_temp.uid(6)) = 0, 'E: no account row was created');

select 'COMMON_ACCOUNT_WRITE_GUARD_BEHAVIOR_PASS';
