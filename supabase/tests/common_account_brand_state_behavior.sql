-- Behavior proof for 20261012230000_common_account_service_brand_state (common account Phase 5, F5).
-- Fake data only, disposable database only. The runner applies the production-shaped fixtures, the real
-- onboarding RPCs, the social-mobile deletion candidate, Phase 1, Phase 2, Phase 3a, the Phase 3b guard, the
-- Phase 4 fence and the candidate. Prints COMMON_ACCOUNT_BRAND_STATE_BEHAVIOR_PASS.
--
-- TEST STAND-INS, never in the candidate: owner INSERTs of brands / brand_memberships build workspaces the
-- onboarding RPC would; owner UPDATEs of common_accounts / service_entitlements build states no client can reach.
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
create function pg_temp.set_claims(p_sub uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p_sub is null then '' else 'authenticated' end, true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;
-- Runs one statement that returns one text as a database role; the text, or the error message prefixed 'ERR:'.
create function pg_temp.as_role(p_sql text, p_role text, p_sub uuid default null) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.set_claims(p_sub);
  if p_role <> current_user then execute format('set local role %I', p_role); end if;
  execute p_sql into v;
  reset role;
  perform pg_temp.set_claims(null);
  return coalesce(v, '<null>');
exception when others then
  reset role;
  perform pg_temp.set_claims(null);
  return 'ERR:' || sqlerrm;
end;
$$;
create function pg_temp.person(p_n integer, p_services text[]) returns uuid language plpgsql as $$
declare
  v_user uuid := pg_temp.uid(p_n);
  v_service text;
begin
  perform public.fixture_login(v_user);
  foreach v_service in array p_services loop
    perform pg_temp.expect(pg_temp.as_role(format('select (public.start_%s_service() ->> ''status'')', v_service), 'authenticated', v_user) = 'active',
                           format('setup: start %s', v_service));
  end loop;
  return v_user;
end;
$$;
-- A person's own workspace, as the onboarding RPC makes it (owner membership included).
create function pg_temp.workspace(p_user uuid, p_profile text default 'social_mobile_user_v1') returns text language plpgsql as $$
declare v_brand text := public.social_mobile_account_deletion_workspace(p_user);
begin
  insert into public.brands (id, code_profile_key) values (v_brand, p_profile) on conflict (id) do nothing;
  insert into public.brand_memberships (brand_id, user_id, role) values (v_brand, p_user, 'owner') on conflict do nothing;
  return v_brand;
end;
$$;
create function pg_temp.state(p_brand text) returns text language sql as $$
  select pg_temp.as_role(format('select public.common_account_brand_service_state(%L, ''x_autopost'')', p_brand), 'service_role')
$$;
-- The Phase 4 locking decision for the same person, as the reference answer.
create function pg_temp.reference(p_user uuid) returns text language sql as $$
  select coalesce(private.account_lifecycle_service_state_refusal(p_user, 'x_autopost'), 'active')
$$;
create function pg_temp.same(p_user uuid, p_label text) returns void language plpgsql as $$
declare
  v_brand text := pg_temp.workspace(p_user);
  a text := pg_temp.state(v_brand);
  b text := pg_temp.reference(p_user);
begin
  perform pg_temp.expect(a = b, format('state %s: brand predicate=%s locking decision=%s', p_label, a, b));
end;
$$;

-- 0. Shape and ACL. ------------------------------------------------------------------------------------
select pg_temp.expect(not has_function_privilege(r, f, 'EXECUTE'), format('0: %s cannot execute %s', r, f))
  from unnest(array['anon', 'authenticated', 'service_role', 'kb_cal_auth_child', 'kb_cal_svc_child']) r,
       unnest(array['private.account_lifecycle_brand_owner(text)', 'private.account_lifecycle_service_state_readonly(uuid,text)',
                    'private.account_lifecycle_assert_brand_service_active(text,text)']) f;
select pg_temp.expect(has_function_privilege('service_role', 'public.common_account_brand_service_state(text,text)', 'EXECUTE')
                      and not has_function_privilege('authenticated', 'public.common_account_brand_service_state(text,text)', 'EXECUTE')
                      and not has_function_privilege('anon', 'public.common_account_brand_service_state(text,text)', 'EXECUTE')
                      and not has_function_privilege('kb_cal_auth_child', 'public.common_account_brand_service_state(text,text)', 'EXECUTE'),
                      '0: the public predicate is service_role only');
select pg_temp.expect(provolatile = 's', '0: the readonly decision and the predicate are STABLE (no row lock, usable inside a STABLE predicate)')
  from pg_proc where oid in ('private.account_lifecycle_service_state_readonly(uuid,text)'::regprocedure,
                             'public.common_account_brand_service_state(text,text)'::regprocedure);
select pg_temp.expect(provolatile = 'v', '0: the ordering variant is VOLATILE')
  from pg_proc where oid = 'private.account_lifecycle_assert_brand_service_active(text,text)'::regprocedure;
select pg_temp.expect(pg_temp.as_role('select public.common_account_brand_service_state(''x'', ''x_autopost'')', 'authenticated', pg_temp.uid(1))
                      like 'ERR:permission denied for function%', '0: a person cannot ask');
select pg_temp.expect(pg_temp.as_role('select public.common_account_brand_service_state(''x'', ''x_autopost'')', 'anon') like 'ERR:permission denied for function%',
                      '0: anon cannot ask');
select pg_temp.expect(pg_temp.as_role('select private.account_lifecycle_brand_owner(''x'')::text', 'service_role') like 'ERR:permission denied%',
                      '0: service_role cannot call the private owner lookup');

-- A. Who a workspace belongs to. --------------------------------------------------------------------------
select pg_temp.person(1, array['x_autopost']) as u \gset a_
select pg_temp.workspace(:'a_u') as ws \gset a_
select pg_temp.expect(private.account_lifecycle_brand_owner(:'a_ws') = :'a_u', 'A1: the single owner');
select pg_temp.expect(private.account_lifecycle_brand_owner('no-such-brand') is null and private.account_lifecycle_brand_owner(null) is null,
                      'A2: unknown brand / null: no owner');
select pg_temp.person(2, array['x_autopost']) as u \gset a2_
select pg_temp.workspace(:'a2_u', 'kabumori_v1') as ws \gset a2_
select pg_temp.expect(private.account_lifecycle_brand_owner(:'a2_ws') is null, 'A3: not a user workspace: no owner');
select pg_temp.person(3, array['x_autopost']) as u \gset a3_
select pg_temp.workspace(:'a3_u') as ws \gset a3_
select pg_temp.person(4, array['x_autopost']) as u \gset a3b_
insert into public.brand_memberships (brand_id, user_id, role) values (:'a3_ws', :'a3b_u', 'owner');
select pg_temp.expect(private.account_lifecycle_brand_owner(:'a3_ws') is null, 'A4: two owners: no owner (a refusal, not a guess)');
delete from public.brand_memberships where brand_id = :'a3_ws' and user_id = :'a3b_u';
insert into public.brand_memberships (brand_id, user_id, role) values (:'a3_ws', :'a3b_u', 'admin');
select pg_temp.expect(private.account_lifecycle_brand_owner(:'a3_ws') = :'a3_u', 'A5: an admin beside the owner does not change the owner');
delete from public.brand_memberships where brand_id = :'a3_ws' and role = 'owner';
select pg_temp.expect(private.account_lifecycle_brand_owner(:'a3_ws') is null, 'A6: no owner membership: no owner');

-- B. The predicate answers exactly what the locking decision answers, in every state. -----------------
select pg_temp.person(10, array['x_autopost', 'kabumori']) as u \gset b1_
select pg_temp.same(:'b1_u', 'active');
select pg_temp.expect(pg_temp.state(public.social_mobile_account_deletion_workspace(:'b1_u')) = 'active', 'B: active is "active"');
select pg_temp.person(11, array['x_autopost']) as u \gset b2_
select pg_temp.expect(pg_temp.as_role(format('select (public.begin_common_account_deletion(%L::uuid, %s) ->> ''status'')', :'b2_u',
         (select lifecycle_version from public.common_accounts where user_id = :'b2_u')), 'service_role') = 'started', 'B setup: deletion begun');
select pg_temp.same(:'b2_u', 'account deleting');
update public.common_accounts set status = 'active' where user_id = :'b2_u';
select pg_temp.same(:'b2_u', 'open deletion, account row active');
select pg_temp.person(12, array['x_autopost']) as u \gset b3_
update public.common_accounts set status = 'locked' where user_id = :'b3_u';
select pg_temp.same(:'b3_u', 'locked');
select pg_temp.person(13, array['x_autopost']) as u \gset b4_
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'b4_u';
select pg_temp.same(:'b4_u', 'ended');
update public.service_entitlements set status = 'suspended', ended_at = null where user_id = :'b4_u';
select pg_temp.same(:'b4_u', 'suspended');
update public.service_entitlements set status = 'provisioning' where user_id = :'b4_u';
select pg_temp.same(:'b4_u', 'provisioning');
select pg_temp.person(14, array['x_autopost']) as u \gset b5_
select pg_temp.expect(pg_temp.as_role(format('select (public.begin_service_deletion(%L::uuid, ''x_autopost'') ->> ''status'')', :'b5_u'), 'service_role') = 'started', 'B setup: service deletion');
select pg_temp.same(:'b5_u', 'service deleting');
update public.service_entitlements set status = 'active' where user_id = :'b5_u';
select pg_temp.same(:'b5_u', 'open service deletion, entitlement row active');
select pg_temp.person(15, array['kabumori']) as u \gset b6_
select pg_temp.same(:'b6_u', 'not registered for this service');
select public.fixture_login(pg_temp.uid(16));
select pg_temp.same(pg_temp.uid(16), 'no common account');
-- A refusal changes nothing: no account was created.
select pg_temp.expect(not exists (select 1 from public.common_accounts where user_id = pg_temp.uid(16)), 'B: nothing created');
-- An unknown workspace and an unknown service key.
select pg_temp.expect(pg_temp.state('no-such-brand') = 'WORKSPACE_OWNER_UNKNOWN', 'B: unknown workspace');
select pg_temp.expect(pg_temp.as_role('select public.common_account_brand_service_state(null, ''x_autopost'')', 'service_role') = 'WORKSPACE_OWNER_UNKNOWN', 'B: null workspace');
select pg_temp.expect(pg_temp.as_role(format('select public.common_account_brand_service_state(%L, ''threads'')', :'a_ws'), 'service_role') = 'ACCOUNT_LIFECYCLE_SERVICE_INVALID', 'B: unknown service key');
select pg_temp.expect(pg_temp.as_role(format('select public.common_account_brand_service_state(%L, null)', :'a_ws'), 'service_role') = 'ACCOUNT_LIFECYCLE_SERVICE_INVALID', 'B: null service key');
select pg_temp.expect(pg_temp.as_role(format('select public.common_account_brand_service_state(%L)', :'a_ws'), 'service_role') = 'active', 'B: the default service is x_autopost');
-- A removed login: its workspace goes with it (membership cascade): no owner, refused.
select pg_temp.person(17, array['x_autopost']) as u \gset b7_
select pg_temp.workspace(:'b7_u') as ws \gset b7_
delete from auth.users where id = :'b7_u';
select pg_temp.expect(pg_temp.state(:'b7_ws') in ('WORKSPACE_OWNER_UNKNOWN', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'), 'B: a removed login is never active');

-- C. It composes inside a STABLE SECURITY INVOKER predicate run by service_role (the publish predicate's shape).
create function public.fixture_publish_predicate(p_brand text) returns text
language sql stable security invoker set search_path = ''
as $$ select case public.common_account_brand_service_state(p_brand, 'x_autopost') when 'active' then 'allowed' else 'VAULT_PUBLISH_SERVICE_NOT_ACTIVE' end $$;
revoke all on function public.fixture_publish_predicate(text) from public, anon, authenticated, service_role;
grant execute on function public.fixture_publish_predicate(text) to service_role;
select pg_temp.expect(pg_temp.as_role(format('select public.fixture_publish_predicate(%L)', :'a_ws'), 'service_role') = 'allowed', 'C: allowed while active');
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'a_u' and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.as_role(format('select public.fixture_publish_predicate(%L)', :'a_ws'), 'service_role') = 'VAULT_PUBLISH_SERVICE_NOT_ACTIVE', 'C: refused once the service ended');
update public.service_entitlements set status = 'active', ended_at = null where user_id = :'a_u' and service_key = 'x_autopost';

-- D. The ordering variant: same decision, fixed codes, SQLSTATE 42501, no lookup without an owner. ----------
create function pg_temp.assert_msg(p_brand text, p_service text default 'x_autopost') returns text language plpgsql as $$
begin
  perform private.account_lifecycle_assert_brand_service_active(p_brand, p_service);
  return 'OK';
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;
select pg_temp.expect(pg_temp.assert_msg(:'a_ws') = 'OK', 'D: active passes');
select pg_temp.expect(pg_temp.assert_msg(pg_temp.workspace(:'b2_u')) = '42501:ACCOUNT_DELETION_IN_PROGRESS', 'D: an open account deletion');
select pg_temp.expect(pg_temp.assert_msg(pg_temp.workspace(:'b3_u')) = '42501:ACCOUNT_LOCKED', 'D: locked');
select pg_temp.expect(pg_temp.assert_msg(pg_temp.workspace(:'b4_u')) = '42501:SERVICE_NOT_ACTIVE', 'D: provisioning is not active');
select pg_temp.expect(pg_temp.assert_msg(pg_temp.workspace(:'b5_u')) = '42501:SERVICE_DELETION_IN_PROGRESS', 'D: service deleting');
select pg_temp.expect(pg_temp.assert_msg(pg_temp.workspace(:'b6_u')) = '42501:SERVICE_NOT_REGISTERED', 'D: not registered');
select pg_temp.expect(pg_temp.assert_msg('no-such-brand') = '42501:WORKSPACE_OWNER_UNKNOWN', 'D: unknown workspace');
select pg_temp.expect(pg_temp.assert_msg(:'a_ws', 'threads') = '42501:ACCOUNT_LIFECYCLE_SERVICE_INVALID', 'D: unknown service key');
select pg_temp.expect(pg_temp.assert_msg(null) = '42501:WORKSPACE_OWNER_UNKNOWN', 'D: null workspace');

select 'COMMON_ACCOUNT_BRAND_STATE_BEHAVIOR_PASS';
