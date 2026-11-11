-- G3 TASK 25/50 (Issue #318): revoked-session negative QA for the X reservation candidates' person-facing RPCs (001-006, read at
-- PR #392's head by qa_run.sh). Throw-away LOCAL PostgreSQL only, fake people / sessions / claims, no product file changed.
-- Prepended by qa_run.sh with the X OAuth T13 guard helpers (pg_temp.expect / uid / session / enrolled / begin_sql / consume_sql /
-- complete_sql). Runs as the schema owner; every call is ONE statement as postona_resv_api with the claims a scenario gives it.
-- It RECORDS what each entry answers today (t_qa.results); qa_run.sh compares that with the pinned current behaviour and with the
-- desired contract (G5-11 C-3: a dead / foreign / unknown / missing / anonymous session is refused before any row is touched).
create schema t_qa;
create table t_qa.results (scenario text, entry text, actual text, primary key (scenario, entry));
create table t_qa.people (n integer primary key, user_id uuid not null, account text not null);

-- one statement as postona_resv_api with explicit claims (jsonb; null = no claims at all); 'ok:<value>' or 'ERR:<first word>'
create function pg_temp.as_api(p_sql text, p_claims jsonb) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  set local role postona_resv_api;
  execute p_sql into v;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return 'ok:' || coalesce(v, '<null>');
exception when others then
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return 'ERR:' || split_part(sqlerrm, ' ', 1);
end $$;
create function pg_temp.qclaims(p_sub uuid, p_session uuid, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('sub', p_sub, 'role', 'authenticated', 'session_id', p_session)) || p_extra $$;

-- a person: enrolled through G5's real RPC (x_autopost active, live session), X connected through PR #257's guarded onboarding
-- (G4's TEST DOUBLE sees it verified), publish switch ON (single post needs it)
create function pg_temp.person(p_n integer) returns void language plpgsql as $$
declare v_user uuid := pg_temp.enrolled(p_n); v_session uuid := pg_temp.session(pg_temp.uid(p_n)); v_account text; v_state uuid;
begin
  v_account := pg_temp.as_person(pg_temp.begin_sql('xq' || p_n), v_user, v_session);
  v_state := pg_temp.as_person(pg_temp.consume_sql('xq' || p_n), v_user, v_session)::uuid;
  perform pg_temp.expect(pg_temp.as_person(pg_temp.complete_sql(v_state, (7000 + p_n)::text), v_user, v_session) not like 'ERR:%', 'setup: connect ' || p_n);
  update public.social_accounts set publish_enabled = true where id = v_account;
  insert into t_qa.people values (p_n, v_user, v_account);
end $$;
create function pg_temp.u(p_n integer) returns uuid language sql as $$ select user_id from t_qa.people where n = p_n $$;
create function pg_temp.a(p_n integer) returns text language sql as $$ select account from t_qa.people where n = p_n $$;
create function pg_temp.live(p_n integer) returns uuid language sql as $$ insert into auth.sessions (user_id) values (pg_temp.u(p_n)) returning id $$;

-- reservations made with a LIVE session (setup): two planned ones and one single post (begun, never sent)
create function pg_temp.reserve(p_n integer, p_session uuid, p_tag text) returns uuid language plpgsql as $$
declare v_body text := 'QA ' || p_tag; v_out text;
begin
  v_out := pg_temp.as_api(format('select string_agg(reservation_id::text, '','') from postona_x_resv.create_batch(%L, gen_random_uuid(), 1, ''manual_exact'', null, %L::jsonb)',
    pg_temp.a(p_n), jsonb_build_array(jsonb_build_object('draft_id', 'qa_' || p_tag,
      'scheduled_at', ((now() at time zone 'Asia/Tokyo')::date + 3 + time '10:00' + case when p_tag like '%\_2' then interval '4 hours' else interval '0' end) at time zone 'Asia/Tokyo', 'body', v_body,
      'consent', jsonb_build_object('confirmed', true, 'content_sha256', encode(sha256(convert_to(v_body, 'UTF8')), 'hex'))))),
    pg_temp.qclaims(pg_temp.u(p_n), p_session));
  perform pg_temp.expect(v_out ~ '^ok:[0-9a-f-]{36}$', 'setup: reserve ' || p_tag || ' ' || v_out);
  return substr(v_out, 4)::uuid;
end $$;
create function pg_temp.single(p_n integer, p_session uuid, p_tag text) returns uuid language plpgsql as $$
declare v_out text;
begin
  v_out := pg_temp.as_api(format('select reservation_id::text from postona_x_resv.post_now_begin(%L, gen_random_uuid(), %L, %L)',
    pg_temp.a(p_n), 'QA single ' || p_tag, encode(sha256(convert_to('QA single ' || p_tag, 'UTF8')), 'hex')), pg_temp.qclaims(pg_temp.u(p_n), p_session));
  perform pg_temp.expect(v_out ~ '^ok:[0-9a-f-]{36}$', 'setup: single ' || p_tag || ' ' || v_out);
  return substr(v_out, 4)::uuid;
end $$;
create function pg_temp.rev(p_id uuid) returns integer language sql as $$ select revision from postona_x_resv.reservations where id = p_id $$;
create function pg_temp.sha(p_id uuid) returns text language sql as $$ select encode(sha256(convert_to(body, 'UTF8')), 'hex') from postona_x_resv.reservations where id = p_id $$;

-- every person-facing entry once, with the scenario's claims; the reads first, the writes after, cancel last
create function pg_temp.sweep(p_scenario text, p_n integer, p_claims jsonb) returns void language plpgsql as $$
declare r1 uuid; r2 uuid; s1 uuid; body text := 'QA new ' || p_scenario;
begin
  select id into r1 from postona_x_resv.reservations where user_id = pg_temp.u(p_n) and draft_id = 'qa_' || p_scenario || '_1';
  select id into r2 from postona_x_resv.reservations where user_id = pg_temp.u(p_n) and draft_id = 'qa_' || p_scenario || '_2';
  select id into s1 from postona_x_resv.reservations where user_id = pg_temp.u(p_n) and draft_id ~ '^single:' order by created_at desc limit 1;
  insert into t_qa.results values
    (p_scenario, 'list_reservations', pg_temp.as_api(format('select count(*)::text from postona_x_resv.list_reservations(%L)', pg_temp.a(p_n)), p_claims)),
    (p_scenario, 'get_reservation', pg_temp.as_api(format('select status from postona_x_resv.get_reservation(%L)', r1), p_claims)),
    (p_scenario, 'post_now_readback', pg_temp.as_api(format('select state from postona_x_resv.post_now_readback(%L)', s1), p_claims));
  insert into t_qa.results values (p_scenario, 'reconfirm',
    pg_temp.as_api(format('select status from postona_x_resv.reconfirm(%L, %s, %L)', r1, pg_temp.rev(r1), pg_temp.sha(r1)), p_claims));
  insert into t_qa.results values (p_scenario, 'reschedule',
    pg_temp.as_api(format('select status from postona_x_resv.reschedule(%L, %s, %L)', r1, pg_temp.rev(r1),
      ((now() at time zone 'Asia/Tokyo')::date + 4 + time '11:00') at time zone 'Asia/Tokyo'), p_claims));
  insert into t_qa.results values (p_scenario, 'cancel',
    pg_temp.as_api(format('select status from postona_x_resv.cancel(%L, %s)', r2, pg_temp.rev(r2)), p_claims));
  insert into t_qa.results values (p_scenario, 'create_batch',
    pg_temp.as_api(format('select count(*)::text from postona_x_resv.create_batch(%L, gen_random_uuid(), 1, ''manual_exact'', null, %L::jsonb)',
      pg_temp.a(p_n), jsonb_build_array(jsonb_build_object('draft_id', 'qa_' || p_scenario || '_new',
        'scheduled_at', ((now() at time zone 'Asia/Tokyo')::date + 5 + time '12:00') at time zone 'Asia/Tokyo', 'body', body,
        'consent', jsonb_build_object('confirmed', true, 'content_sha256', encode(sha256(convert_to(body, 'UTF8')), 'hex'))))), p_claims));
  insert into t_qa.results values (p_scenario, 'post_now_begin',
    pg_temp.as_api(format('select state from postona_x_resv.post_now_begin(%L, gen_random_uuid(), %L, %L)', pg_temp.a(p_n),
      'QA begin ' || p_scenario, encode(sha256(convert_to('QA begin ' || p_scenario, 'UTF8')), 'hex')), p_claims));
end $$;

-- a scenario: its own person, reservations made while the session is live, then the session (or the claims) changed, then the sweep
create function pg_temp.scenario(p_scenario text, p_n integer, p_kind text) returns void language plpgsql as $$
declare v_s uuid; v_claims jsonb; v_other uuid;
begin
  perform pg_temp.person(p_n);
  v_s := pg_temp.live(p_n);
  perform pg_temp.reserve(p_n, v_s, p_scenario || '_1');
  perform pg_temp.reserve(p_n, v_s, p_scenario || '_2');
  perform pg_temp.single(p_n, v_s, p_scenario);
  v_claims := pg_temp.qclaims(pg_temp.u(p_n), v_s);
  case p_kind
    when 'live' then null;
    when 'signed_out' then delete from auth.sessions where id = v_s;
    when 'expired' then update auth.sessions set not_after = now() - interval '1 minute' where id = v_s;
    when 'foreign_session' then
      v_other := (select id from auth.sessions where user_id = pg_temp.u(199) order by id limit 1);
      v_claims := pg_temp.qclaims(pg_temp.u(p_n), v_other);
    when 'unknown_session' then v_claims := pg_temp.qclaims(pg_temp.u(p_n), gen_random_uuid());
    when 'no_session_id' then v_claims := pg_temp.qclaims(pg_temp.u(p_n), null);
    when 'anonymous' then v_claims := pg_temp.qclaims(pg_temp.u(p_n), v_s, '{"is_anonymous": true}');
    when 'refreshed' then null;  -- a refreshed access token carries the same sub and session_id: the same claims
    when 'new_session_after_signout' then delete from auth.sessions where id = v_s; v_claims := pg_temp.qclaims(pg_temp.u(p_n), pg_temp.live(p_n));
    when 'no_claims' then v_claims := null;
    when 'service_ended' then perform pg_temp.end_service(pg_temp.u(p_n));
    else raise exception 'unknown scenario kind %', p_kind;
  end case;
  perform pg_temp.sweep(p_scenario, p_n, v_claims);
end $$;

-- the foreign person (199) with a live session; then the scenarios
select pg_temp.person(199);
select pg_temp.live(199) is not null as foreign_ready;
select pg_temp.scenario('S00_live', 101, 'live');
select pg_temp.scenario('S01_signed_out', 102, 'signed_out');
select pg_temp.scenario('S02_expired', 103, 'expired');
select pg_temp.scenario('S03_foreign_session', 104, 'foreign_session');
select pg_temp.scenario('S04_unknown_session', 105, 'unknown_session');
select pg_temp.scenario('S05_no_session_id', 106, 'no_session_id');
select pg_temp.scenario('S06_anonymous', 107, 'anonymous');
select pg_temp.scenario('S07_refreshed', 108, 'refreshed');
select pg_temp.scenario('S08_new_session_after_signout', 109, 'new_session_after_signout');
select pg_temp.scenario('S09_no_claims', 110, 'no_claims');
select pg_temp.scenario('S10_service_ended', 111, 'service_ended');

-- S11 user switch: person 112's rows called with person 199's LIVE session and sub; compared with an id that does not exist
select pg_temp.person(112);
select pg_temp.live(112) as s112 \gset
select pg_temp.reserve(112, :'s112', 'S11_1') is not null, pg_temp.reserve(112, :'s112', 'S11_2') is not null, pg_temp.single(112, :'s112', 'S11') is not null;
select (select id from auth.sessions where user_id = pg_temp.u(199) order by id limit 1) as s199 \gset
insert into t_qa.results
select 'S11_user_switch', e, pg_temp.as_api(format(q, (select id from postona_x_resv.reservations where user_id = pg_temp.u(112) and draft_id = 'qa_S11_1')),
                                            pg_temp.qclaims(pg_temp.u(199), :'s199'))
  from (values ('get_reservation', 'select status from postona_x_resv.get_reservation(%L)'),
               ('cancel', 'select status from postona_x_resv.cancel(%L, 1)')) v(e, q);
insert into t_qa.results
select 'S11_unknown_id', e, pg_temp.as_api(format(q, gen_random_uuid()), pg_temp.qclaims(pg_temp.u(199), :'s199'))
  from (values ('get_reservation', 'select status from postona_x_resv.get_reservation(%L)'),
               ('cancel', 'select status from postona_x_resv.cancel(%L, 1)')) v(e, q);

-- S12 user deleted (auth.users row removed; the reservations and sessions go with it if they cascade) -- recorded as it is
select pg_temp.person(113);
select pg_temp.live(113) as s113 \gset
select pg_temp.reserve(113, :'s113', 'S12_1') is not null, pg_temp.reserve(113, :'s113', 'S12_2') is not null, pg_temp.single(113, :'s113', 'S12') is not null;
select count(*) as rows_before_delete from postona_x_resv.reservations where user_id = pg_temp.u(113) \gset
\set ON_ERROR_STOP 0
delete from auth.users where id = pg_temp.u(113);
\set ON_ERROR_STOP 1
insert into t_qa.results values
  ('S12_user_deleted', 'auth_users_delete', case when exists (select 1 from auth.users where id = pg_temp.u(113)) then 'refused (row kept)' else 'deleted' end),
  ('S12_user_deleted', 'rows_left', (select count(*)::text from postona_x_resv.reservations where user_id = pg_temp.u(113))),
  ('S12_user_deleted', 'list_reservations', pg_temp.as_api(format('select count(*)::text from postona_x_resv.list_reservations(%L)', pg_temp.a(113)), pg_temp.qclaims(pg_temp.u(113), :'s113')));

-- nothing was sent: no reservation reached published / a provider id
select pg_temp.expect((select count(*) from postona_x_resv.reservations where status = 'published' or provider_post_id is not null) = 0, 'nothing published');
select format('RESULT|%s|%s|%s', scenario, entry, actual) from t_qa.results order by scenario, entry;
select 'X_REVOKED_SESSION_QA_MATRIX_DONE';
