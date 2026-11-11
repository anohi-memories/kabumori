-- G3 TASK 29/50 (Issue #318): the X reservation worker between CLAIM and SEND -- owner changes (A -> B, A -> B -> A, A -> none -> A),
-- a lease that expires, an outcome reported after an owner change, a changed X identity on the same account row, a second claim.
-- G3-28's W4 (a PLANNED row re-claimed after A -> B -> A) is not repeated. Throw-away LOCAL PostgreSQL only, fake people / sessions /
-- claims; X candidates 001-006 read at PR #392's head by run.sh (unchanged). Prepended by run.sh with the T13 guard helpers.
-- Records today's answers in t_ef.results; run.sh pins them, asserts the fail-closed invariants and lists the PROPOSED gaps by name.
create schema t_ef;
create table t_ef.results (scenario text, step text, actual text, primary key (scenario, step));
create table t_ef.people (n integer primary key, user_id uuid not null, account text not null, brand text not null, session uuid not null);

create function pg_temp.as_role_sql(p_role text, p_sql text, p_claims jsonb) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  execute format('set local role %I', p_role);
  execute p_sql into v;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return 'ok:' || coalesce(v, '<null>');
exception when others then
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return 'ERR:' || split_part(sqlerrm, ' ', 1);
end $$;
create function pg_temp.c(p_n integer) returns jsonb language sql as $$
  select jsonb_build_object('sub', user_id, 'role', 'authenticated', 'session_id', session) from t_ef.people where n = p_n $$;
create function pg_temp.api(p_n integer, p_sql text) returns text language sql as $$ select pg_temp.as_role_sql('postona_resv_api', p_sql, pg_temp.c(p_n)) $$;
create function pg_temp.worker(p_sql text) returns text language sql as $$ select pg_temp.as_role_sql('postona_resv_worker', p_sql, null) $$;
create function pg_temp.u(p_n integer) returns uuid language sql as $$ select user_id from t_ef.people where n = p_n $$;
create function pg_temp.a(p_n integer) returns text language sql as $$ select account from t_ef.people where n = p_n $$;
create function pg_temp.b(p_n integer) returns text language sql as $$ select brand from t_ef.people where n = p_n $$;
create function pg_temp.rec(p_s text, p_step text, p_v text) returns void language sql as $$ insert into t_ef.results values (p_s, p_step, p_v) $$;

create function pg_temp.person(p_n integer) returns void language plpgsql as $$
declare v_user uuid := pg_temp.enrolled(p_n); v_session uuid := pg_temp.session(pg_temp.uid(p_n)); v_account text; v_state uuid;
begin
  v_account := pg_temp.as_person(pg_temp.begin_sql('ef' || p_n), v_user, v_session);
  v_state := pg_temp.as_person(pg_temp.consume_sql('ef' || p_n), v_user, v_session)::uuid;
  perform pg_temp.expect(pg_temp.as_person(pg_temp.complete_sql(v_state, (4000 + p_n)::text), v_user, v_session) not like 'ERR:%', 'setup: connect ' || p_n);
  update public.social_accounts set publish_enabled = true where id = v_account;
  insert into t_ef.people values (p_n, v_user, v_account, (select sa.brand_id from public.social_accounts sa where sa.id = v_account), v_session);
end $$;
-- one planned reservation made due (the dispatch tests' clock move)
create function pg_temp.due(p_n integer, p_tag text) returns uuid language plpgsql as $$
declare v_out text; v_id uuid;
begin
  v_out := pg_temp.api(p_n, format('select string_agg(reservation_id::text, '','') from postona_x_resv.create_batch(%L, gen_random_uuid(), 1, ''manual_exact'', null, %L::jsonb)',
    pg_temp.a(p_n), jsonb_build_array(jsonb_build_object('draft_id', 'ef_' || p_tag,
      'scheduled_at', ((now() at time zone 'Asia/Tokyo')::date + 3 + time '10:00') at time zone 'Asia/Tokyo', 'body', 'EF ' || p_tag,
      'consent', jsonb_build_object('confirmed', true, 'content_sha256', encode(sha256(convert_to('EF ' || p_tag, 'UTF8')), 'hex'))))));
  perform pg_temp.expect(v_out ~ '^ok:[0-9a-f-]{36}$', 'setup: reserve ' || p_tag || ' ' || v_out);
  v_id := substr(v_out, 4)::uuid;
  update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute',
         expires_at = now() + interval '6 hours' where id = v_id;
  return v_id;
end $$;
-- the worker's claim round: whether THIS row was claimed
create function pg_temp.claimed(p_id uuid) returns text language plpgsql as $$
declare v text := pg_temp.worker('select coalesce(string_agg(reservation_id::text, '',''), ''-'') from postona_x_resv.claim_due(''ef_worker'', 60, 50)');
begin
  return case when v !~ '^ok:' then v when position(p_id::text in v) > 0 then 'claimed' else 'not_claimed' end;
end $$;
create function pg_temp.lease(p_id uuid) returns uuid language sql as $$ select lease_token from postona_x_resv.reservations where id = p_id $$;
create function pg_temp.check1(p_id uuid) returns text language sql as $$
  select pg_temp.worker(format('select postona_x_resv.pre_publish_check(%L, %L)', p_id, pg_temp.lease(p_id))) $$;
create function pg_temp.finish1(p_id uuid, p_lease uuid, p_outcome text) returns text language sql as $$
  select pg_temp.worker(format('select postona_x_resv.finish(%L, %L, %L, null, null)', p_id, p_lease, p_outcome)) $$;
create function pg_temp.st(p_id uuid) returns text language sql as $$
  select coalesce((select status || '/' || coalesce(outcome_code, '-') from postona_x_resv.reservations where id = p_id), 'gone') $$;
-- owner moves (as in the workspace fixtures of the X tests): the owner row of A removed / B added, and back
create function pg_temp.owner_to(p_n integer, p_new integer) returns void language sql as $$
  delete from public.brand_memberships where brand_id = pg_temp.b(p_n) and role = 'owner';
  insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.b(p_n), pg_temp.u(p_new), 'owner') $$;
create function pg_temp.owner_none(p_n integer) returns void language sql as $$
  delete from public.brand_memberships where brand_id = pg_temp.b(p_n) and role = 'owner' $$;

select pg_temp.person(n) from generate_series(401, 412) n;

-- E1 claimed -> owner A -> B -> the pre-send check: refused, row failed (nothing sent)
select pg_temp.due(401, 'E1') as e1 \gset
select pg_temp.rec('E1_claim_then_A_to_B', 'claim', pg_temp.claimed(:'e1'));
select pg_temp.owner_to(401, 412);
select pg_temp.rec('E1_claim_then_A_to_B', 'pre_publish_check', pg_temp.check1(:'e1'));
select pg_temp.rec('E1_claim_then_A_to_B', 'row', pg_temp.st(:'e1'));

-- E2 claimed -> A -> B -> A (back) -> the pre-send check
select pg_temp.due(402, 'E2') as e2 \gset
select pg_temp.rec('E2_claim_then_ABA', 'claim', pg_temp.claimed(:'e2'));
select pg_temp.owner_to(402, 411);
select pg_temp.owner_to(402, 402);
select pg_temp.rec('E2_claim_then_ABA', 'pre_publish_check', pg_temp.check1(:'e2'));
select pg_temp.rec('E2_claim_then_ABA', 'row', pg_temp.st(:'e2'));

-- E3 claimed -> A leaves the workspace -> A comes back (no B) -> the pre-send check
select pg_temp.due(403, 'E3') as e3 \gset
select pg_temp.rec('E3_claim_then_A_none_A', 'claim', pg_temp.claimed(:'e3'));
select pg_temp.owner_none(403);
select pg_temp.owner_to(403, 403);
select pg_temp.rec('E3_claim_then_A_none_A', 'pre_publish_check_after_return', pg_temp.check1(:'e3'));

-- E4 planned (due) -> A leaves -> A comes back -> the worker's claim (no B: differs from G3-28 W4)
select pg_temp.due(404, 'E4') as e4 \gset
select pg_temp.owner_none(404);
select pg_temp.rec('E4_planned_A_none_A', 'claim_while_none', pg_temp.claimed(:'e4'));
select pg_temp.owner_to(404, 404);
select pg_temp.rec('E4_planned_A_none_A', 'claim_after_return', pg_temp.claimed(:'e4'));

-- E5 claimed -> A -> B -> A -> the lease expires before any check: the sweep fences it to uncertain; never claimed again
select pg_temp.due(405, 'E5') as e5 \gset
select pg_temp.rec('E5_claim_ABA_lease_expired', 'claim', pg_temp.claimed(:'e5'));
select pg_temp.owner_to(405, 410);
select pg_temp.owner_to(405, 405);
update postona_x_resv.reservations set lease_expires_at = now() - interval '1 second' where id = :'e5';
select pg_temp.rec('E5_claim_ABA_lease_expired', 'next_round', pg_temp.claimed(:'e5'));
select pg_temp.rec('E5_claim_ABA_lease_expired', 'row', pg_temp.st(:'e5'));
select pg_temp.rec('E5_claim_ABA_lease_expired', 'round_after', pg_temp.claimed(:'e5'));

-- E6 the check said OK (send in flight) -> A -> B -> A -> the worker reports an UNKNOWN outcome: recorded as uncertain; never re-claimed
select pg_temp.due(406, 'E6') as e6 \gset
select pg_temp.rec('E6_check_ok_then_ABA_uncertain', 'claim', pg_temp.claimed(:'e6'));
select pg_temp.rec('E6_check_ok_then_ABA_uncertain', 'pre_publish_check', pg_temp.check1(:'e6'));
select pg_temp.lease(:'e6') as e6lease \gset
select pg_temp.owner_to(406, 409);
select pg_temp.owner_to(406, 406);
select pg_temp.rec('E6_check_ok_then_ABA_uncertain', 'finish_uncertain', pg_temp.finish1(:'e6', :'e6lease', 'uncertain'));
select pg_temp.rec('E6_check_ok_then_ABA_uncertain', 'row', pg_temp.st(:'e6'));
select pg_temp.rec('E6_check_ok_then_ABA_uncertain', 'round_after', pg_temp.claimed(:'e6'));
select pg_temp.rec('E6_check_ok_then_ABA_uncertain', 'finish_replay', pg_temp.finish1(:'e6', :'e6lease', 'uncertain'));

-- E7 the check said OK -> the owner moves to B (A gone) -> the worker reports failed_before_send: recorded failed; never re-claimed
select pg_temp.due(407, 'E7') as e7 \gset
select pg_temp.rec('E7_check_ok_then_A_to_B_failed', 'claim', pg_temp.claimed(:'e7'));
select pg_temp.rec('E7_check_ok_then_A_to_B_failed', 'pre_publish_check', pg_temp.check1(:'e7'));
select pg_temp.lease(:'e7') as e7lease \gset
select pg_temp.owner_to(407, 408);
select pg_temp.rec('E7_check_ok_then_A_to_B_failed', 'finish_failed_before_send', pg_temp.finish1(:'e7', :'e7lease', 'failed_before_send'));
select pg_temp.rec('E7_check_ok_then_A_to_B_failed', 'row', pg_temp.st(:'e7'));
select pg_temp.rec('E7_check_ok_then_A_to_B_failed', 'round_after', pg_temp.claimed(:'e7'));

-- E8 the X identity behind the same account row changes after the reservation was made (as a reconnect with ANOTHER X user would)
select pg_temp.due(408, 'E8') as e8 \gset
update public.social_accounts set platform_user_id = '9' || platform_user_id where id = pg_temp.a(408);
select pg_temp.rec('E8_x_identity_changed', 'claim', pg_temp.claimed(:'e8'));
select pg_temp.rec('E8_x_identity_changed', 'pre_publish_check', pg_temp.check1(:'e8'));

-- E9 a claimed row is not claimed a second time by the next round (one lease; no double send)
select pg_temp.due(409, 'E9') as e9 \gset
select pg_temp.rec('E9_second_claim', 'claim', pg_temp.claimed(:'e9'));
select pg_temp.rec('E9_second_claim', 'second_round', pg_temp.claimed(:'e9'));

select pg_temp.expect((select count(*) from postona_x_resv.reservations where status = 'published' or provider_post_id is not null) = 0, 'nothing published');
select format('RESULT|%s|%s|%s', scenario, step, actual) from t_ef.results order by scenario, step;
select 'X_WORKER_OWNER_EPOCH_FENCE_MATRIX_DONE';
