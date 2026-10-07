-- Behavior proof for 20261006230000_common_account_service_start_intent (Phase 2, H1/C1 R1).
-- Fake data only, disposable database only; the runner applies Phase 1 and this candidate first.
-- Prints COMMON_ACCOUNT_START_INTENT_BEHAVIOR_PASS.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create function pg_temp.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL %', p_label; end if;
end;
$$;
create function pg_temp.error_as(p_role text, p_sql text, p_sub uuid default null) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
  execute format('set local role %I', p_role);
  execute p_sql;
  reset role;
  return null;
exception when others then
  reset role;
  return sqlerrm;
end;
$$;
create function pg_temp.svc(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  execute 'set local role service_role';
  execute p_sql into v;
  reset role;
  return v;
end;
$$;
create function pg_temp.usr(p_sub uuid, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  execute 'set local role authenticated';
  execute p_sql into v;
  reset role;
  return v;
end;
$$;
create function pg_temp.uid(p_n integer) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
create function pg_temp.ws(p_user uuid) returns text language sql as $$ select 'u_' || substr(md5(p_user::text), 1, 24) $$;
create function pg_temp.start(p_user uuid, p_service text) returns jsonb language sql as $$
  select pg_temp.usr(p_user, format('select public.start_%s_service()', p_service))
$$;
create function pg_temp.reactivate(p_user uuid, p_service text, p_version bigint) returns jsonb language sql as $$
  select pg_temp.usr(p_user, format('select public.reactivate_%s_service(%s)', p_service, p_version))
$$;
create function pg_temp.entitlement(p_user uuid, p_service text) returns text language sql as $$
  select coalesce((select status from public.service_entitlements where user_id = p_user and service_key = p_service), 'none')
$$;
create function pg_temp.ent_row(p_user uuid, p_service text) returns text language sql as $$
  select coalesce((select status || '/' || source || '/' || activated_at || '/' || coalesce(ended_at::text, '-') || '/' || updated_at
                     from public.service_entitlements where user_id = p_user and service_key = p_service), 'none')
$$;
create function pg_temp.account(p_user uuid) returns text language sql as $$
  select coalesce((select status from public.common_accounts where user_id = p_user), 'none')
$$;
create function pg_temp.version(p_user uuid) returns bigint language sql as $$
  select coalesce((select lifecycle_version from public.common_accounts where user_id = p_user), 0)
$$;
create function pg_temp.has_profile(p_user uuid) returns boolean language sql as $$
  select exists (select 1 from public.profiles where id = p_user)
$$;
create function pg_temp.ws_rows(p_user uuid) returns bigint language sql as $$
  select (select count(*) from public.brands where id = pg_temp.ws(p_user))
       + (select count(*) from public.brand_memberships where brand_id = pg_temp.ws(p_user) or user_id = p_user)
       + (select count(*) from public.social_accounts where brand_id = pg_temp.ws(p_user))
       + (select count(*) from public.social_account_oauth_states where brand_id = pg_temp.ws(p_user) or initiated_by_user_id = p_user)
$$;
create function pg_temp.end_service(p_user uuid, p_service text) returns jsonb language plpgsql as $$
declare v_begin jsonb;
begin
  if p_service = 'kabumori' then
    return pg_temp.svc(format('select public.withdraw_kabumori_service(%L::uuid)', p_user));
  end if;
  v_begin := pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, %L)', p_user, p_service));
  return pg_temp.svc(format('select public.finish_service_deletion(%L::uuid, %L, %L::uuid)', p_user, p_service, v_begin ->> 'operation_id'));
end;
$$;

-- ---------------------------------------------------------------------------
-- A. Automatic start: missing -> only the requested service; active -> idempotent.
select public.fixture_login(pg_temp.uid(1001));
select pg_temp.start(pg_temp.uid(1001), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"active","service":"kabumori","started":true,"shared_account":false}'::jsonb,
  'A1 missing Kabumori: created, exact answer');
select pg_temp.expect(pg_temp.account(pg_temp.uid(1001)) = 'active' and pg_temp.entitlement(pg_temp.uid(1001), 'kabumori') = 'active'
  and pg_temp.has_profile(pg_temp.uid(1001)) and pg_temp.entitlement(pg_temp.uid(1001), 'x_autopost') = 'none',
  'A1 account + Kabumori entitlement + profile; no X entitlement');
select pg_temp.version(pg_temp.uid(1001)) as v1 \gset
select pg_temp.start(pg_temp.uid(1001), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"active","service":"kabumori","started":false,"shared_account":false}'::jsonb
  and pg_temp.version(pg_temp.uid(1001)) = :v1, 'A2 active: idempotent, nothing moved');
select pg_temp.ent_row(pg_temp.uid(1001), 'kabumori') as k_before \gset
select pg_temp.start(pg_temp.uid(1001), 'x_autopost') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"active","service":"x_autopost","started":true,"shared_account":true}'::jsonb
  and pg_temp.ws_rows(pg_temp.uid(1001)) = 0, 'A3 X added to the same identity: shared_account, no workspace rows');
select pg_temp.expect(pg_temp.ent_row(pg_temp.uid(1001), 'kabumori') = :'k_before',
  'A3 adding X does not touch the Kabumori entitlement');
select pg_temp.start(pg_temp.uid(1001), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'shared_account' = 'true', 'A3 Kabumori now reports the shared account too');

-- B. Automatic start never restarts an ended service (the H1 R1 sequences, both services).
select public.fixture_login(pg_temp.uid(1002));
select pg_temp.start(pg_temp.uid(1002), 'kabumori') as r \gset
select pg_temp.end_service(pg_temp.uid(1002), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'ended' and pg_temp.entitlement(pg_temp.uid(1002), 'kabumori') = 'ended'
  and not pg_temp.has_profile(pg_temp.uid(1002)), 'B1 Kabumori withdrawn by the backend');
select pg_temp.version(pg_temp.uid(1002)) as v2 \gset
select pg_temp.ent_row(pg_temp.uid(1002), 'kabumori') as e_before \gset
select pg_temp.start(pg_temp.uid(1002), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb = jsonb_build_object('status', 'reenroll_required', 'service', 'kabumori', 'lifecycle_version', :v2),
  'B1 stale automatic start answers reenroll_required with the current version');
select pg_temp.expect(pg_temp.ent_row(pg_temp.uid(1002), 'kabumori') = :'e_before' and not pg_temp.has_profile(pg_temp.uid(1002))
  and pg_temp.version(pg_temp.uid(1002)) = :v2, 'B1 nothing restarted: entitlement still ended, no profile, version unchanged');

select public.fixture_login(pg_temp.uid(1003));
select pg_temp.start(pg_temp.uid(1003), 'x_autopost') as r \gset
select pg_temp.end_service(pg_temp.uid(1003), 'x_autopost') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'ended', 'B2 X ended by begin/finish service deletion');
select pg_temp.start(pg_temp.uid(1003), 'x_autopost') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'reenroll_required' and pg_temp.entitlement(pg_temp.uid(1003), 'x_autopost') = 'ended'
  and pg_temp.ws_rows(pg_temp.uid(1003)) = 0, 'B2 X stays ended, no workspace created');

-- C. Automatic start fails closed for every other state.
select public.fixture_login(pg_temp.uid(1004));
select pg_temp.start(pg_temp.uid(1004), 'x_autopost') as r \gset
select pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, %L)', pg_temp.uid(1004), 'x_autopost')) as r \gset
select pg_temp.start(pg_temp.uid(1004), 'x_autopost') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"blocked","reason":"SERVICE_DELETION_IN_PROGRESS"}'::jsonb, 'C1 deleting service');
select public.fixture_login(pg_temp.uid(1005));
select pg_temp.start(pg_temp.uid(1005), 'kabumori') as r \gset
update public.service_entitlements set status = 'suspended' where user_id = pg_temp.uid(1005);
select pg_temp.start(pg_temp.uid(1005), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"blocked","reason":"SERVICE_SUSPENDED"}'::jsonb, 'C2 suspended service');
update public.service_entitlements set status = 'provisioning' where user_id = pg_temp.uid(1005);
select pg_temp.start(pg_temp.uid(1005), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"blocked","reason":"SERVICE_NOT_READY"}'::jsonb, 'C3 provisioning service');
select public.fixture_login(pg_temp.uid(1006));
insert into public.common_accounts (user_id, status) values (pg_temp.uid(1006), 'locked');
select pg_temp.start(pg_temp.uid(1006), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"blocked","reason":"ACCOUNT_LOCKED"}'::jsonb
  and pg_temp.entitlement(pg_temp.uid(1006), 'kabumori') = 'none', 'C4 locked account');
select public.fixture_login(pg_temp.uid(1007));
select pg_temp.start(pg_temp.uid(1007), 'kabumori') as r \gset
update public.common_accounts set status = 'deleting' where user_id = pg_temp.uid(1007);
select pg_temp.start(pg_temp.uid(1007), 'x_autopost') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"blocked","reason":"ACCOUNT_DELETION_IN_PROGRESS"}'::jsonb
  and pg_temp.entitlement(pg_temp.uid(1007), 'x_autopost') = 'none', 'C5 deleting account');
select coalesce(pg_temp.error_as('authenticated', 'select public.start_kabumori_service()'), '') as e \gset
select pg_temp.expect(:'e' like '%ACCOUNT_LIFECYCLE_AUTH_REQUIRED%', 'C6 no subject');
select coalesce(pg_temp.error_as('authenticated', 'select public.start_kabumori_service()', pg_temp.uid(1999)), '') as e \gset
select pg_temp.expect(:'e' like '%ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND%' and pg_temp.account(pg_temp.uid(1999)) = 'none', 'C7 removed login');

-- D. Explicit restart: only a currently ended entitlement, only at the confirmed version, once.
select pg_temp.reactivate(pg_temp.uid(1002), 'kabumori', :v2 + 5) as r \gset
select pg_temp.expect(:'r'::jsonb = jsonb_build_object('status', 'lifecycle_changed', 'service', 'kabumori', 'lifecycle_version', :v2)
  and pg_temp.ent_row(pg_temp.uid(1002), 'kabumori') = :'e_before', 'D1 wrong version: lifecycle_changed, nothing restarted');
select pg_temp.reactivate(pg_temp.uid(1002), 'kabumori', :v2) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"active","service":"kabumori","started":true,"shared_account":false}'::jsonb
  and pg_temp.entitlement(pg_temp.uid(1002), 'kabumori') = 'active' and pg_temp.has_profile(pg_temp.uid(1002))
  and (select source || '/' || coalesce(ended_at::text, '-') from public.service_entitlements
        where user_id = pg_temp.uid(1002) and service_key = 'kabumori') = 'self_service/-'
  and pg_temp.version(pg_temp.uid(1002)) = :v2 + 1, 'D2 confirmed version: restarted, profile recreated, version moved');
select pg_temp.reactivate(pg_temp.uid(1002), 'kabumori', :v2) as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'lifecycle_changed' and pg_temp.version(pg_temp.uid(1002)) = :v2 + 1,
  'D3 the same confirmation cannot be used twice');
select pg_temp.version(pg_temp.uid(1001)) as v1b \gset
select pg_temp.ent_row(pg_temp.uid(1001), 'kabumori') as a_before \gset
select pg_temp.reactivate(pg_temp.uid(1001), 'kabumori', :v1b) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"active","service":"kabumori","started":false,"shared_account":true}'::jsonb
  and pg_temp.ent_row(pg_temp.uid(1001), 'kabumori') = :'a_before' and pg_temp.version(pg_temp.uid(1001)) = :v1b,
  'D4 active: deterministic answer, no mutation');
select public.fixture_login(pg_temp.uid(1008));
select pg_temp.reactivate(pg_temp.uid(1008), 'kabumori', 1) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_registered","service":"kabumori"}'::jsonb
  and pg_temp.account(pg_temp.uid(1008)) = 'none', 'D5 no account: not_registered and no account is created');
select pg_temp.start(pg_temp.uid(1008), 'x_autopost') as r \gset
select pg_temp.version(pg_temp.uid(1008)) as v8 \gset
select pg_temp.reactivate(pg_temp.uid(1008), 'kabumori', :v8) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_registered","service":"kabumori"}'::jsonb
  and pg_temp.entitlement(pg_temp.uid(1008), 'kabumori') = 'none', 'D6 never registered: not_registered, nothing created');
select pg_temp.version(pg_temp.uid(1004)) as v4 \gset
select pg_temp.reactivate(pg_temp.uid(1004), 'x_autopost', :v4) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"blocked","reason":"SERVICE_DELETION_IN_PROGRESS"}'::jsonb
  and pg_temp.entitlement(pg_temp.uid(1004), 'x_autopost') = 'deleting', 'D7 deleting service is not restarted');
select pg_temp.version(pg_temp.uid(1007)) as v7 \gset
select pg_temp.reactivate(pg_temp.uid(1007), 'kabumori', :v7) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"blocked","reason":"ACCOUNT_DELETION_IN_PROGRESS"}'::jsonb, 'D8 deleting account');
-- The person is always auth.uid(): another signed-in person restarts nothing of 1003's.
select pg_temp.version(pg_temp.uid(1003)) as v3 \gset
select pg_temp.reactivate(pg_temp.uid(1001), 'x_autopost', :v3) as r \gset
select pg_temp.expect(pg_temp.entitlement(pg_temp.uid(1003), 'x_autopost') = 'ended', 'D9 another person cannot restart 1003');
select pg_temp.reactivate(pg_temp.uid(1003), 'x_autopost', :v3) as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'started' = 'true' and pg_temp.ws_rows(pg_temp.uid(1003)) = 0,
  'D10 X restart by its own person, still no workspace rows');
select coalesce(pg_temp.error_as('authenticated', 'select public.reactivate_kabumori_service(null)', pg_temp.uid(1002)), '') as e \gset
select pg_temp.expect(:'e' like '%ACCOUNT_LIFECYCLE_VERSION_REQUIRED%', 'D11 a version is required');
select coalesce(pg_temp.error_as('authenticated', 'select public.reactivate_kabumori_service(1)', pg_temp.uid(1999)), '') as e \gset
select pg_temp.expect(:'e' like '%ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND%', 'D12 removed login');

-- E. Privileges: the new RPCs are for signed-in people only; the helpers for nobody.
select pg_temp.expect(
  has_function_privilege('authenticated', 'public.reactivate_kabumori_service(bigint)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.reactivate_x_autopost_service(bigint)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.reactivate_kabumori_service(bigint)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.reactivate_x_autopost_service(bigint)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.account_lifecycle_reactivate_service(uuid,text,bigint)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.account_lifecycle_start_service(uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.account_lifecycle_active_answer(uuid,text,boolean)', 'EXECUTE'),
  'E1 EXECUTE: authenticated on the two public RPCs only');
select coalesce(pg_temp.error_as('anon', 'select public.reactivate_kabumori_service(1)'), '') as e \gset
select pg_temp.expect(:'e' like '%permission denied%', 'E2 anon cannot call the restart');

select 'COMMON_ACCOUNT_START_INTENT_BEHAVIOR_PASS';
