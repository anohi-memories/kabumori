-- Behavior proof for 20261015120000_common_account_x_unconfirmed_snapshot_record (common account Phase 10, F5).
-- Fake data only, disposable database only. Prints COMMON_ACCOUNT_X_UNCONFIRMED_BEHAVIOR_PASS.
-- TEST STAND-INS, never in the candidate: owner UPDATEs move a lease's expiry and probe the shape constraint; owner
-- INSERTs build workspaces.
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
create function pg_temp.snap(p_n integer) returns text language sql immutable as $$
  select md5('snapshot-' || p_n::text) || md5('name-' || p_n::text)
$$;
create function pg_temp.rec(p_user uuid, p_op uuid, p_lease uuid, p_count integer, p_snapshot text) returns text language sql as $$
  select pg_temp.as_role(format('select public.record_owned_service_deletion_x_unconfirmed(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid, %s, %L)',
                                p_user, p_op, p_lease, coalesce(p_count::text, 'null'), p_snapshot), 'service_role')
$$;
create function pg_temp.result(p_user uuid) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.common_account_service_end_result(%L::uuid, ''x_autopost'')', p_user))
$$;
create function pg_temp.check_refused(p_user uuid, p_value text) returns boolean language plpgsql as $$
begin
  begin
    execute format('update private.account_lifecycle_operations set reconciliation = %L::jsonb where user_id = %L and operation_type = ''service_deletion''', p_value, p_user);
  exception when check_violation then return true;
  end;
  return false;
end;
$$;
create function pg_temp.check_accepted(p_user uuid, p_value text) returns boolean language plpgsql as $$
begin
  execute format('update private.account_lifecycle_operations set reconciliation = %L::jsonb where user_id = %L and operation_type = ''service_deletion''', p_value, p_user);
  return true;
exception when check_violation then return false;
end;
$$;

-- 0. Shape and ACL.
select pg_temp.expect(
  has_function_privilege('service_role', f, 'EXECUTE') and not has_function_privilege('authenticated', f, 'EXECUTE')
  and not has_function_privilege('anon', f, 'EXECUTE') and not has_function_privilege('public', f, 'EXECUTE')
  and not has_function_privilege('kb_cal_auth_child', f, 'EXECUTE')
  and (select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = f::regprocedure),
  format('0: %s is a definer, empty search_path, service_role only', f))
  from unnest(array['public.record_owned_service_deletion_x_unconfirmed(uuid,text,uuid,uuid,integer,text)']) f;
select pg_temp.expect(pg_temp.as_role(format('select public.record_owned_service_deletion_x_unconfirmed(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid, 1, %L)',
                                             pg_temp.uid(1), gen_random_uuid(), gen_random_uuid(), pg_temp.snap(1)), 'authenticated', pg_temp.uid(1))
                      like 'ERR:permission denied%', '0: a person cannot record');

-- A. Recording: the pair, sticky count, snapshot appended once.
select pg_temp.person(1) as u \gset a_
select pg_temp.begin_service(:'a_u') as op \gset a_
select (pg_temp.claim(:'a_u', :'a_op') ->> 'lease') as lease \gset a_
select pg_temp.expect(pg_temp.result(:'a_u') -> 'reconciliation' = '{}'::jsonb, 'A1: an open end reads back with no facts');
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'a_lease', 3, pg_temp.snap(1))::jsonb = '{"status": "recorded", "count": 3, "snapshots": 1}'::jsonb, 'A2: recorded');
select pg_temp.expect(pg_temp.result(:'a_u') -> 'reconciliation' = jsonb_build_object('x_posts_unconfirmed', 3, 'x_unconfirmed_snapshots', jsonb_build_array(pg_temp.snap(1))),
                      'A3: the pair reads back');
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'a_lease', 3, pg_temp.snap(1))::jsonb = '{"status": "recorded", "count": 3, "snapshots": 1}'::jsonb, 'A4: the same pair again is a no-op');
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'a_lease', 2, pg_temp.snap(2))::jsonb = '{"status": "recorded", "count": 3, "snapshots": 2}'::jsonb
                      and pg_temp.result(:'a_u') -> 'reconciliation' = jsonb_build_object('x_posts_unconfirmed', 3, 'x_unconfirmed_snapshots', jsonb_build_array(pg_temp.snap(1), pg_temp.snap(2))),
                      'A5: a second evidence set is appended, a smaller count never lowers the first (stored, not just answered)');
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'a_lease', 7, pg_temp.snap(3))::jsonb = '{"status": "recorded", "count": 7, "snapshots": 3}'::jsonb, 'A6: a larger count raises it');
-- invalid arguments
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'a_lease', 1, s) like 'ERR:ACCOUNT_LIFECYCLE_X_UNCONFIRMED_INVALID%', 'A7: snapshot ' || coalesce(left(s, 12), '<null>') || ' is refused')
  from (values (null::text), (''), (upper(pg_temp.snap(1))), (left(pg_temp.snap(1), 63)), (pg_temp.snap(1) || '0'), (' ' || left(pg_temp.snap(1), 63)), ('g' || left(pg_temp.snap(1), 63))) v(s);
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'a_lease', c, pg_temp.snap(4)) like 'ERR:ACCOUNT_LIFECYCLE_X_UNCONFIRMED_INVALID%', 'A8: count ' || coalesce(c::text, '<null>') || ' is refused')
  from (values (null::integer), (0), (-1), (100001)) v(c);
select pg_temp.expect(pg_temp.as_role(format('select public.record_owned_service_deletion_x_unconfirmed(%L::uuid, ''kabumori'', %L::uuid, %L::uuid, 1, %L)',
                                             :'a_u', :'a_op', :'a_lease', pg_temp.snap(4)), 'service_role') like 'ERR:ACCOUNT_LIFECYCLE_SERVICE_INVALID%', 'A9: POSTONA only');
select pg_temp.expect(pg_temp.result(:'a_u') -> 'reconciliation' = jsonb_build_object('x_posts_unconfirmed', 7, 'x_unconfirmed_snapshots',
                        jsonb_build_array(pg_temp.snap(1), pg_temp.snap(2), pg_temp.snap(3))), 'A10: the refusals changed nothing');

-- B. Ownership: a wrong lease, another person's lease, an ended lease (wall clock) record nothing.
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', gen_random_uuid(), 9, pg_temp.snap(5))::jsonb ->> 'status' = 'lease_lost', 'B1: a wrong lease');
select pg_temp.person(2) as u \gset b_
select pg_temp.begin_service(:'b_u') as op \gset b_
select (pg_temp.claim(:'b_u', :'b_op') ->> 'lease') as lease \gset b_
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'b_lease', 9, pg_temp.snap(5))::jsonb ->> 'status' = 'lease_lost', 'B2: another person''s lease');
select pg_temp.expect(pg_temp.rec(:'b_u', :'a_op', :'a_lease', 9, pg_temp.snap(5))::jsonb ->> 'status' = 'lease_lost', 'B3: another person''s operation');
select pg_temp.expect(pg_temp.rec(:'b_u', :'b_op', :'a_lease', 9, pg_temp.snap(5))::jsonb ->> 'status' = 'lease_lost', 'B3b: a lease of another operation');
update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() - interval '1 millisecond' where id = :'a_op';
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'a_lease', 9, pg_temp.snap(5))::jsonb ->> 'status' = 'lease_lost', 'B4: an ended lease');
select pg_temp.expect(pg_temp.result(:'a_u') -> 'reconciliation' = jsonb_build_object('x_posts_unconfirmed', 7, 'x_unconfirmed_snapshots',
                        jsonb_build_array(pg_temp.snap(1), pg_temp.snap(2), pg_temp.snap(3))), 'B5: nothing changed by the refusals');
select pg_temp.expect(pg_temp.result(:'b_u') -> 'reconciliation' = '{}'::jsonb, 'B6: the other person has nothing recorded');
update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() + interval '5 minutes' where id = :'a_op';

-- C. The Phase 8 count-only recorder is still there, never lowers, and never drops the snapshots.
select pg_temp.expect(pg_temp.as_role(format('select public.record_owned_service_deletion_reconciliation(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid, ''x_posts_unconfirmed'', 2)',
                                             :'a_u', :'a_op', :'a_lease'), 'service_role')::jsonb = '{"status": "recorded", "count": 7}'::jsonb
                      and jsonb_array_length(pg_temp.result(:'a_u') -> 'reconciliation' -> 'x_unconfirmed_snapshots') = 3, 'C1: a count-only record keeps the snapshots');
select pg_temp.expect(pg_temp.as_role(format('select public.record_owned_service_deletion_reconciliation(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid, ''x_posts_unconfirmed'', 11)',
                                             :'a_u', :'a_op', :'a_lease'), 'service_role')::jsonb ->> 'count' = '11'
                      and pg_temp.result(:'a_u') -> 'reconciliation' ->> 'x_posts_unconfirmed' = '11', 'C2: a larger count-only record raises the count');

-- D. The cap: sixteen distinct sets, never more (and nothing half-written).
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'a_lease', 11, pg_temp.snap(n))::jsonb ->> 'status' = 'recorded', 'D1: record ' || n)
  from generate_series(4, 16) n;
select pg_temp.expect(jsonb_array_length(pg_temp.result(:'a_u') -> 'reconciliation' -> 'x_unconfirmed_snapshots') = 16, 'D2: sixteen on record');
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'a_lease', 11, pg_temp.snap(17)) like 'ERR:ACCOUNT_LIFECYCLE_X_UNCONFIRMED_TOO_MANY%', 'D3: the 17th distinct set is refused');
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'a_lease', 11, pg_temp.snap(9))::jsonb ->> 'snapshots' = '16', 'D4: an already recorded set is still accepted at the cap');
select pg_temp.expect(jsonb_array_length(pg_temp.result(:'a_u') -> 'reconciliation' -> 'x_unconfirmed_snapshots') = 16, 'D5: the refusal left the sixteen');

-- E. The end: the read-back after finishing still names the sets.
select pg_temp.svc(format('select public.record_owned_service_deletion_provider_result(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid, ''x'', ''done'')', :'a_u', :'a_op', :'a_lease'));
delete from public.brand_memberships where brand_id = public.social_mobile_account_deletion_workspace(:'a_u');
delete from public.brands where id = public.social_mobile_account_deletion_workspace(:'a_u');
select pg_temp.expect(pg_temp.svc(format('select public.finish_owned_service_deletion(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid)', :'a_u', :'a_op', :'a_lease')) ->> 'status' = 'ended', 'E1: ended by the owner');
select pg_temp.expect(pg_temp.result(:'a_u') ->> 'status' = 'completed'
                      and jsonb_array_length(pg_temp.result(:'a_u') -> 'reconciliation' -> 'x_unconfirmed_snapshots') = 16
                      and pg_temp.result(:'a_u') -> 'reconciliation' ->> 'x_posts_unconfirmed' = '11', 'E2: the ended operation still names the evidence sets');
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'a_lease', 11, pg_temp.snap(30))::jsonb ->> 'status' = 'lease_lost', 'E3: nothing can be recorded after the end');

-- F. The shape constraint is the last line (owner-level writes, a stand-in for a bug).
select pg_temp.person(3) as u \gset f_
select pg_temp.begin_service(:'f_u') as op \gset f_
select pg_temp.expect(pg_temp.check_accepted(:'f_u', '{}'), 'F1: empty');
select pg_temp.expect(pg_temp.check_accepted(:'f_u', '{"x_posts_unconfirmed": 2}'), 'F2: a Phase 8 count-only row is still valid');
select pg_temp.expect(pg_temp.check_accepted(:'f_u', jsonb_build_object('x_posts_unconfirmed', 2, 'x_unconfirmed_snapshots', jsonb_build_array(pg_temp.snap(1)))::text), 'F3: a pair is valid');
select pg_temp.expect(pg_temp.check_refused(:'f_u', v), 'F4: refused ' || left(v, 70))
  from (values
    ('{"other": 1}'),
    ('{"x_posts_unconfirmed": "three"}'),
    (jsonb_build_object('x_unconfirmed_snapshots', jsonb_build_array(pg_temp.snap(1)))::text),
    (jsonb_build_object('x_posts_unconfirmed', 2, 'x_unconfirmed_snapshots', '[]'::jsonb)::text),
    (jsonb_build_object('x_posts_unconfirmed', 2, 'x_unconfirmed_snapshots', jsonb_build_array(5))::text),
    (jsonb_build_object('x_posts_unconfirmed', 2, 'x_unconfirmed_snapshots', jsonb_build_array(pg_temp.snap(1), null))::text),
    (jsonb_build_object('x_posts_unconfirmed', 2, 'x_unconfirmed_snapshots', jsonb_build_array(upper(pg_temp.snap(1))))::text),
    (jsonb_build_object('x_posts_unconfirmed', 2, 'x_unconfirmed_snapshots', jsonb_build_array(left(pg_temp.snap(1), 63)))::text),
    (jsonb_build_object('x_posts_unconfirmed', 2, 'x_unconfirmed_snapshots', pg_temp.snap(1))::text),
    (jsonb_build_object('x_posts_unconfirmed', 2, 'x_unconfirmed_snapshots', '{"a": 1}'::jsonb)::text),
    (jsonb_build_object('x_posts_unconfirmed', 2, 'x_unconfirmed_snapshots', (select jsonb_agg(pg_temp.snap(i)) from generate_series(1, 17) i))::text),
    (jsonb_build_object('x_posts_unconfirmed', 2, 'x_unconfirmed_snapshots', jsonb_build_array(pg_temp.snap(1)), 'extra', 1)::text)) v(v);
select pg_temp.expect(pg_temp.check_accepted(:'f_u', jsonb_build_object('x_posts_unconfirmed', 2, 'x_unconfirmed_snapshots', (select jsonb_agg(pg_temp.snap(i)) from generate_series(1, 16) i))::text),
                      'F5: sixteen is valid');

\echo COMMON_ACCOUNT_X_UNCONFIRMED_BEHAVIOR_PASS
