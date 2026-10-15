-- Behavior proof for 20261015090000_common_account_enrollment_session_fence (common account Phase 9, F5). Fake data only,
-- disposable database only. Run by common_account_phase9_shared_login_run.sh (section fence) against the world WITH the
-- migration applied; prints COMMON_ACCOUNT_ENROLLMENT_FENCE_BEHAVIOR_PASS.
--
-- The HTTP-level counterpart (the real apps' modules over the fake GoTrue / PostgREST seams) is
-- common_account_phase9_shared_login_test.ts; this file proves the database's own answers for both claim sources
-- (the per-claim settings of an older PostgREST and the JSON claims) and the edges the HTTP layer cannot reach.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create function pg_temp.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL %', p_label; end if;
end;
$$;
create function pg_temp.uid(p_n integer) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad((990000 + p_n)::text, 12, '0'))::uuid
$$;
-- One statement as `authenticated` with the given claim source; jsonb/uuid text, or 'ERR:<message>'.
--   mode 'json'   : request.jwt.claims only
--   mode 'legacy' : the per-claim settings only (an older PostgREST)
create function pg_temp.call(p_sql text, p_mode text, p_sub uuid, p_session uuid default null, p_anonymous boolean default null)
returns text language plpgsql as $$
declare v text;
begin
  if p_mode = 'json' then
    perform set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object(
      'sub', p_sub, 'role', 'authenticated', 'session_id', p_session, 'is_anonymous', p_anonymous))::text, true);
    perform set_config('request.jwt.claim.sub', '', true);
  else
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('request.jwt.claim.session_id', coalesce(p_session::text, ''), true);
    perform set_config('request.jwt.claim.is_anonymous', coalesce(p_anonymous::text, ''), true);
  end if;
  set local role authenticated;
  execute p_sql into v;
  reset role;
  return coalesce(v, '<null>');
exception when others then
  reset role;
  return 'ERR:' || sqlerrm;
end;
$$;
create function pg_temp.login(p_n integer) returns uuid language plpgsql as $$
declare v uuid := pg_temp.uid(p_n);
begin
  insert into auth.users (id) values (v) on conflict do nothing;
  return v;
end;
$$;
create function pg_temp.session(p_user uuid, p_not_after timestamptz default null) returns uuid language sql as $$
  insert into auth.sessions (user_id, not_after) values (p_user, p_not_after) returning id
$$;
create function pg_temp.owner_sql(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute p_sql into v;
  return v;
end;
$$;

-- B0. the fence function is reachable by nobody; the five public ones are `authenticated` only
select pg_temp.expect(not has_function_privilege('authenticated', 'private.account_lifecycle_enrollment_fence(uuid,boolean)', 'EXECUTE')
                      and not has_function_privilege('service_role', 'private.account_lifecycle_enrollment_fence(uuid,boolean)', 'EXECUTE')
                      and not has_function_privilege('anon', 'private.account_lifecycle_enrollment_fence(uuid,boolean)', 'EXECUTE')
                      and not has_function_privilege('public', 'private.account_lifecycle_enrollment_fence(uuid,boolean)', 'EXECUTE'),
                      'B0 the internal check is owner-only');

-- B1. automatic start: both claim sources, a person with NO session row at all is still enrolled (the sign-up path
--     gains no dependency on auth.sessions); a guest session is refused and nothing is created
select pg_temp.login(1) as u1 \gset
select pg_temp.expect(pg_temp.call('select public.start_x_autopost_service()::text', 'json', :'u1'::uuid) like '%"started": true%',
                      'B1 json claims: start without any session row is enrolled');
select pg_temp.expect(pg_temp.call('select public.start_x_autopost_service()::text', 'legacy', :'u1'::uuid) like '%"started": false%',
                      'B1 legacy claims: the second start is idempotent');
select pg_temp.login(2) as u2 \gset
select pg_temp.expect(pg_temp.call('select public.start_x_autopost_service()::text', 'json', :'u2'::uuid, null, true) = 'ERR:ACCOUNT_LIFECYCLE_AUTH_REQUIRED',
                      'B1 json claims: a guest session is refused');
select pg_temp.expect(pg_temp.call('select public.start_x_autopost_service()::text', 'legacy', :'u2'::uuid, null, true) = 'ERR:ACCOUNT_LIFECYCLE_AUTH_REQUIRED',
                      'B1 legacy claims: a guest session is refused');
select pg_temp.expect(pg_temp.call('select public.start_kabumori_service()::text', 'json', :'u2'::uuid, null, true) = 'ERR:ACCOUNT_LIFECYCLE_AUTH_REQUIRED',
                      'B1 Kabumori start: a guest session is refused');
select pg_temp.expect(pg_temp.call('select public.ensure_my_profile()::text', 'json', :'u2'::uuid, null, true) = 'ERR:ACCOUNT_LIFECYCLE_AUTH_REQUIRED',
                      'B1 ensure_my_profile: a guest session is refused');
select pg_temp.expect((select count(*) from public.common_accounts where user_id = :'u2'::uuid) = 0
                      and (select count(*) from public.service_entitlements where user_id = :'u2'::uuid) = 0
                      and (select count(*) from public.profiles where id = :'u2'::uuid) = 0,
                      'B1 a refused guest created nothing');
select pg_temp.expect(pg_temp.call('select public.start_x_autopost_service()::text', 'json', :'u2'::uuid, null, false) like '%"started": true%',
                      'B1 an explicit is_anonymous=false is an ordinary login');
select pg_temp.expect(pg_temp.call('select public.ensure_my_profile()::text', 'json', pg_temp.login(3)) = pg_temp.uid(3)::text,
                      'B1 ensure_my_profile still answers the person id (unchanged contract)');

-- B2. explicit restart: needs a live session of THIS login
select pg_temp.login(4) as u4 \gset
select pg_temp.expect(pg_temp.call('select public.start_x_autopost_service()::text', 'json', :'u4'::uuid) like '%"started": true%', 'B2 setup: started');
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'u4'::uuid and service_key = 'x_autopost';
select lifecycle_version as v4 from public.common_accounts where user_id = :'u4'::uuid \gset
select pg_temp.session(:'u4'::uuid) as s4 \gset
select pg_temp.session(:'u4'::uuid, now() - interval '1 minute') as s4_expired \gset
select pg_temp.session(pg_temp.login(5)) as s_other \gset
select pg_temp.expect(pg_temp.call(format('select public.reactivate_x_autopost_service(%s)::text', :'v4'), 'json', :'u4'::uuid) = 'ERR:ACCOUNT_LIFECYCLE_AUTH_REQUIRED',
                      'B2 no session claim: refused');
select pg_temp.expect(pg_temp.call(format('select public.reactivate_x_autopost_service(%s)::text', :'v4'), 'json', :'u4'::uuid, gen_random_uuid()) = 'ERR:ACCOUNT_LIFECYCLE_AUTH_REQUIRED',
                      'B2 a session id that is no row: refused');
select pg_temp.expect(pg_temp.call(format('select public.reactivate_x_autopost_service(%s)::text', :'v4'), 'json', :'u4'::uuid, :'s_other'::uuid) = 'ERR:ACCOUNT_LIFECYCLE_AUTH_REQUIRED',
                      'B2 another person''s live session: refused');
select pg_temp.expect(pg_temp.call(format('select public.reactivate_x_autopost_service(%s)::text', :'v4'), 'json', :'u4'::uuid, :'s4_expired'::uuid) = 'ERR:ACCOUNT_LIFECYCLE_AUTH_REQUIRED',
                      'B2 an expired session (not_after in the past): refused');
select pg_temp.expect(pg_temp.call(format('select public.reactivate_x_autopost_service(%s)::text', :'v4'), 'json', :'u4'::uuid, :'s4'::uuid, true) = 'ERR:ACCOUNT_LIFECYCLE_AUTH_REQUIRED',
                      'B2 a live session of a guest: refused');
select pg_temp.expect((select status from public.service_entitlements where user_id = :'u4'::uuid and service_key = 'x_autopost') = 'ended',
                      'B2 every refusal left the service ended');
select pg_temp.expect(pg_temp.call(format('select public.reactivate_x_autopost_service(%s)::text', :'v4'), 'legacy', :'u4'::uuid, :'s4'::uuid) like '%"started": true%',
                      'B2 legacy claims + a live session: restarted');
select pg_temp.expect((select status from public.service_entitlements where user_id = :'u4'::uuid and service_key = 'x_autopost') = 'active', 'B2 active again');
-- a session whose not_after is in the future is live
select pg_temp.session(:'u4'::uuid, now() + interval '1 hour') as s4_future \gset
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'u4'::uuid and service_key = 'x_autopost';
select lifecycle_version as v4b from public.common_accounts where user_id = :'u4'::uuid \gset
select pg_temp.expect(pg_temp.call(format('select public.reactivate_x_autopost_service(%s)::text', :'v4b'), 'json', :'u4'::uuid, :'s4_future'::uuid) like '%"started": true%',
                      'B2 a session with a future not_after is live');

-- B3. the Kabumori restart is fenced the same way
select pg_temp.login(6) as u6 \gset
select pg_temp.expect(pg_temp.call('select public.start_kabumori_service()::text', 'json', :'u6'::uuid) like '%"started": true%', 'B3 setup');
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'u6'::uuid and service_key = 'kabumori';
select lifecycle_version as v6 from public.common_accounts where user_id = :'u6'::uuid \gset
select pg_temp.expect(pg_temp.call(format('select public.reactivate_kabumori_service(%s)::text', :'v6'), 'json', :'u6'::uuid, gen_random_uuid()) = 'ERR:ACCOUNT_LIFECYCLE_AUTH_REQUIRED',
                      'B3 Kabumori restart with a stale session: refused');
select pg_temp.session(:'u6'::uuid) as s6 \gset
select pg_temp.expect(pg_temp.call(format('select public.reactivate_kabumori_service(%s)::text', :'v6'), 'json', :'u6'::uuid, :'s6'::uuid) like '%"started": true%',
                      'B3 Kabumori restart with a live session');

-- B4. what the fence does not change: the errors of the underlying functions (a deleted login, no login at all)
select pg_temp.expect(pg_temp.call('select public.start_x_autopost_service()::text', 'json', gen_random_uuid()) = 'ERR:ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND',
                      'B4 a token of a login that does not exist: the lifecycle''s own answer');
select pg_temp.expect(pg_temp.call('select public.start_x_autopost_service()::text', 'json', null) = 'ERR:ACCOUNT_LIFECYCLE_AUTH_REQUIRED',
                      'B4 no subject: the lifecycle''s own answer');

-- B5. fail closed when the session table cannot be read (undefined_table inside the fence): the restart is refused with
--     its own code, the automatic start is not affected. Done in a subtransaction that rolls the rename back.
create function pg_temp.sessions_unreadable() returns text language plpgsql as $$
declare v text;
begin
  begin
    alter table auth.sessions rename to sessions_hidden;
    v := pg_temp.call(format('select public.reactivate_x_autopost_service(%s)::text', 1), 'json', pg_temp.uid(4), gen_random_uuid());
    raise exception 'ROLLBACK_RENAME:%', v;
  exception when others then
    return sqlerrm;
  end;
end;
$$;
select pg_temp.expect(pg_temp.sessions_unreadable() like '%ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE%', 'B5 unreadable sessions: the restart fails closed');
select pg_temp.expect(to_regclass('auth.sessions') is not null, 'B5 the rename was rolled back');

select 'COMMON_ACCOUNT_ENROLLMENT_FENCE_BEHAVIOR_PASS';
