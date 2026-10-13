-- Behavior proof for 20261013140000_common_account_service_reconciliation_facts (common account Phase 8, F5).
-- Fake data only, disposable database only. Prints COMMON_ACCOUNT_RECONCILIATION_BEHAVIOR_PASS.
-- TEST STAND-INS, never in the candidate: owner UPDATEs move a lease's expiry; owner INSERTs build workspaces.
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
create function pg_temp.svc(p_sql text) returns jsonb language plpgsql as $$
declare v text := pg_temp.as_role(p_sql, 'service_role');
begin
  if v like 'ERR:%' then return jsonb_build_object('error', substr(v, 5)); end if;
  return v::jsonb;
end;
$$;
create function pg_temp.person(p_n integer) returns uuid language plpgsql as $$
declare
  v_user uuid := pg_temp.uid(p_n);
  v_ws text := public.social_mobile_account_deletion_workspace(pg_temp.uid(p_n));
begin
  perform public.fixture_login(v_user);
  perform pg_temp.expect(pg_temp.as_role('select (public.start_x_autopost_service() ->> ''status'')', 'authenticated', v_user) = 'active', 'setup: start POSTONA');
  insert into public.brands (id, code_profile_key) values (v_ws, 'social_mobile_user_v1') on conflict (id) do nothing;
  insert into public.brand_memberships (brand_id, user_id, role) values (v_ws, v_user, 'owner') on conflict do nothing;
  return v_user;
end;
$$;
create function pg_temp.begin_service(p_user uuid) returns uuid language plpgsql as $$
declare v jsonb := pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, ''x_autopost'')', p_user));
begin
  perform pg_temp.expect(v ->> 'status' = 'started', 'setup: begin ' || v::text);
  return (v ->> 'operation_id')::uuid;
end;
$$;
create function pg_temp.claim(p_user uuid, p_op uuid) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.claim_service_deletion(%L::uuid, ''x_autopost'', %L::uuid)', p_user, p_op))
$$;
create function pg_temp.fact(p_user uuid, p_op uuid, p_lease uuid, p_fact text, p_count integer) returns text language sql as $$
  select pg_temp.as_role(format('select public.record_owned_service_deletion_reconciliation(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid, %L, %s)',
                                p_user, p_op, p_lease, p_fact, coalesce(p_count::text, 'null')), 'service_role')
$$;
create function pg_temp.result(p_user uuid) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.common_account_service_end_result(%L::uuid, ''x_autopost'')', p_user))
$$;

-- 0. Shape and ACL.
select pg_temp.expect(
  has_function_privilege('service_role', f, 'EXECUTE') and not has_function_privilege('authenticated', f, 'EXECUTE')
  and not has_function_privilege('anon', f, 'EXECUTE') and not has_function_privilege('public', f, 'EXECUTE')
  and not has_function_privilege('kb_cal_auth_child', f, 'EXECUTE')
  and (select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = f::regprocedure),
  format('0: %s is a definer, empty search_path, service_role only', f))
  from unnest(array['public.record_owned_service_deletion_reconciliation(uuid,text,uuid,uuid,text,integer)',
                    'public.common_account_service_end_result(uuid,text)']) f;
select pg_temp.expect(pg_temp.as_role(format('select public.common_account_service_end_result(%L::uuid, ''x_autopost'')', pg_temp.uid(1)), 'authenticated', pg_temp.uid(1))
                      like 'ERR:permission denied%', '0: a person cannot read it');

-- A. Recording: owned, bounded, sticky at the maximum.
select pg_temp.person(1) as u \gset a_
select pg_temp.begin_service(:'a_u') as op \gset a_
select (pg_temp.claim(:'a_u', :'a_op') ->> 'lease') as lease \gset a_
select pg_temp.expect(pg_temp.result(:'a_u') ->> 'status' = 'in_progress' and pg_temp.result(:'a_u') -> 'reconciliation' = '{}'::jsonb, 'A1: an open end reads back with no facts');
select pg_temp.expect(pg_temp.fact(:'a_u', :'a_op', :'a_lease', 'x_posts_unconfirmed', 3)::jsonb = '{"status": "recorded", "count": 3}'::jsonb, 'A2: recorded');
select pg_temp.expect(pg_temp.fact(:'a_u', :'a_op', :'a_lease', 'x_posts_unconfirmed', 2)::jsonb = '{"status": "recorded", "count": 3}'::jsonb
                      and pg_temp.result(:'a_u') -> 'reconciliation' = '{"x_posts_unconfirmed": 3}'::jsonb, 'A3: a smaller count never lowers it (stored, not just answered)');
select pg_temp.expect(pg_temp.fact(:'a_u', :'a_op', :'a_lease', 'x_posts_unconfirmed', 5)::jsonb ->> 'count' = '5', 'A4: a larger one raises it');
select pg_temp.expect(pg_temp.result(:'a_u') -> 'reconciliation' = '{"x_posts_unconfirmed": 5}'::jsonb, 'A5: read back');
select pg_temp.expect(pg_temp.fact(:'a_u', :'a_op', :'a_lease', 'other_fact', 1) like 'ERR:ACCOUNT_LIFECYCLE_RECONCILIATION_FACT_INVALID%', 'A6: only the known fact');
select pg_temp.expect(pg_temp.fact(:'a_u', :'a_op', :'a_lease', 'x_posts_unconfirmed', 0) like 'ERR:ACCOUNT_LIFECYCLE_RECONCILIATION_FACT_INVALID%'
                      and pg_temp.fact(:'a_u', :'a_op', :'a_lease', 'x_posts_unconfirmed', -1) like 'ERR:ACCOUNT_LIFECYCLE_RECONCILIATION_FACT_INVALID%'
                      and pg_temp.fact(:'a_u', :'a_op', :'a_lease', 'x_posts_unconfirmed', 100001) like 'ERR:ACCOUNT_LIFECYCLE_RECONCILIATION_FACT_INVALID%'
                      and pg_temp.fact(:'a_u', :'a_op', :'a_lease', 'x_posts_unconfirmed', null) like 'ERR:ACCOUNT_LIFECYCLE_RECONCILIATION_FACT_INVALID%', 'A7: the count is bounded');
select pg_temp.expect(pg_temp.as_role(format('select public.record_owned_service_deletion_reconciliation(%L::uuid, ''kabumori'', %L::uuid, %L::uuid, ''x_posts_unconfirmed'', 1)',
                                             :'a_u', :'a_op', :'a_lease'), 'service_role') like 'ERR:ACCOUNT_LIFECYCLE_SERVICE_INVALID%', 'A8: POSTONA only');

-- B. Ownership: a wrong lease, another person's lease, an ended lease (wall clock) record nothing.
select pg_temp.expect(pg_temp.fact(:'a_u', :'a_op', gen_random_uuid(), 'x_posts_unconfirmed', 9)::jsonb ->> 'status' = 'lease_lost', 'B1: a wrong lease');
select pg_temp.person(2) as u \gset b_
select pg_temp.begin_service(:'b_u') as op \gset b_
select (pg_temp.claim(:'b_u', :'b_op') ->> 'lease') as lease \gset b_
select pg_temp.expect(pg_temp.fact(:'a_u', :'a_op', :'b_lease', 'x_posts_unconfirmed', 9)::jsonb ->> 'status' = 'lease_lost', 'B2: another person''s lease');
select pg_temp.expect(pg_temp.fact(:'b_u', :'a_op', :'a_lease', 'x_posts_unconfirmed', 9)::jsonb ->> 'status' = 'lease_lost', 'B3: another person''s operation');
update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() - interval '1 millisecond' where id = :'a_op';
select pg_temp.expect(pg_temp.fact(:'a_u', :'a_op', :'a_lease', 'x_posts_unconfirmed', 9)::jsonb ->> 'status' = 'lease_lost', 'B4: an ended lease');
select pg_temp.expect(pg_temp.result(:'a_u') -> 'reconciliation' = '{"x_posts_unconfirmed": 5}'::jsonb, 'B5: nothing changed by the refusals');
update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() + interval '5 minutes' where id = :'a_op';

-- C. The end result: the unverified rule, the acknowledgement, the facts; readable after the end.
select pg_temp.svc(format('select public.record_owned_service_deletion_provider_result(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid, ''x'', ''done'')', :'a_u', :'a_op', :'a_lease'));
select pg_temp.svc(format('select public.record_owned_service_deletion_provider_result(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid, ''threads'', ''not_connected'')', :'a_u', :'a_op', :'a_lease'));
select pg_temp.svc(format('select public.acknowledge_owned_remote_unverified(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid, array[''threads''])', :'a_u', :'a_op', :'a_lease'));
select pg_temp.expect(pg_temp.result(:'a_u') -> 'remote_unverified' = '["threads"]'::jsonb and pg_temp.result(:'a_u') -> 'acknowledged' = '["threads"]'::jsonb,
                      'C1: an acknowledged provider that only says "not connected" is unverified (the finish rule)');
select pg_temp.svc(format('select public.record_owned_service_deletion_provider_result(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid, ''instagram'', ''not_connected'')', :'a_u', :'a_op', :'a_lease'));
select pg_temp.expect(pg_temp.result(:'a_u') -> 'remote_unverified' = '["threads"]'::jsonb, 'C2: not acknowledged and not connected is nothing to report');
delete from public.brand_memberships where brand_id = public.social_mobile_account_deletion_workspace(:'a_u');
delete from public.brands where id = public.social_mobile_account_deletion_workspace(:'a_u');
select pg_temp.expect(pg_temp.svc(format('select public.finish_owned_service_deletion(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid)', :'a_u', :'a_op', :'a_lease')) ->> 'status' = 'ended', 'C3: ended by the owner');
select pg_temp.expect(pg_temp.result(:'a_u') ->> 'status' = 'completed' and pg_temp.result(:'a_u') -> 'reconciliation' = '{"x_posts_unconfirmed": 5}'::jsonb
                      and pg_temp.result(:'a_u') -> 'remote_unverified' = '["threads"]'::jsonb and pg_temp.result(:'a_u') -> 'provider_results' ->> 'x' = 'done',
                      'C4: the ended operation still says what it could not confirm');
select pg_temp.expect(pg_temp.fact(:'a_u', :'a_op', :'a_lease', 'x_posts_unconfirmed', 99)::jsonb ->> 'status' = 'lease_lost', 'C5: nothing can be recorded after the end');
select pg_temp.expect(pg_temp.result(:'b_u') ->> 'status' = 'in_progress' and pg_temp.result(:'b_u') -> 'reconciliation' = '{}'::jsonb, 'C6: another person is untouched');
select pg_temp.expect(pg_temp.result(pg_temp.uid(9999)) = '{"status": "none"}'::jsonb, 'C7: no operation reads as none');
-- Kabumori's own withdrawal is a service deletion too (its own operation): it is not this record.
select pg_temp.person(3) as u \gset k_
select pg_temp.expect(pg_temp.as_role('select (public.start_kabumori_service() ->> ''status'')', 'authenticated', :'k_u') = 'active', 'C8 setup: start Kabumori');
select pg_temp.expect(pg_temp.svc(format('select public.withdraw_kabumori_service(%L::uuid)', :'k_u')) ->> 'status' = 'ended', 'C8 setup: Kabumori ended');
select pg_temp.expect(exists (select 1 from private.account_lifecycle_operations where user_id = :'k_u' and service_key = 'kabumori'), 'C8 setup: Kabumori has its operation');
select pg_temp.expect(pg_temp.svc(format('select public.common_account_service_end_result(%L::uuid, ''kabumori'')', :'k_u')) = '{"status": "none"}'::jsonb
                      and pg_temp.svc(format('select public.common_account_service_end_result(%L::uuid, ''kabumori'')', :'a_u')) = '{"status": "none"}'::jsonb, 'C8: only POSTONA has this record');

-- D. The shape constraint is the last line.
select pg_temp.expect((select pg_temp.as_role(format('update private.account_lifecycle_operations set reconciliation = ''{"other": 1}'' where id = %L', :'b_op'), 'kb_cal_svc_child') like 'ERR:%'), 'D0 setup (a child role cannot write)');
do $$
declare
  v_ok boolean := false;
begin
  begin
    update private.account_lifecycle_operations set reconciliation = '{"other": 1}'::jsonb where id = (select id from private.account_lifecycle_operations limit 1);
  exception when check_violation then v_ok := true;
  end;
  perform pg_temp.expect(v_ok, 'D1: an unknown key is refused by the constraint');
  v_ok := false;
  begin
    update private.account_lifecycle_operations set reconciliation = '{"x_posts_unconfirmed": "three"}'::jsonb where id = (select id from private.account_lifecycle_operations limit 1);
  exception when check_violation then v_ok := true;
  end;
  perform pg_temp.expect(v_ok, 'D2: a non-number is refused by the constraint');
end $$;

\echo COMMON_ACCOUNT_RECONCILIATION_BEHAVIOR_PASS
