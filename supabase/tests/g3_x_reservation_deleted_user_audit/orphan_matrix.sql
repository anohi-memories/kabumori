-- G3 TASK 26/50 (Issue #318): what happens to X reservations when the person's login (auth.users) is deleted -- on a throw-away
-- LOCAL PostgreSQL only, fake people / sessions / claims, the X candidates 001-006 read at PR #392's head by run.sh (unchanged).
-- Prepended by run.sh with the X OAuth T13 guard helpers. Runs as the schema owner; a person calls as postona_resv_api with claims,
-- the worker calls as postona_resv_worker. It RECORDS answers in t_od.results; run.sh pins them and checks the desired boundary
-- (no row of a deleted person is ever claimed or reported publishable; one deleted person never stops the worker's round).
create schema t_od;
create table t_od.results (scenario text, step text, actual text, primary key (scenario, step));
create table t_od.people (n integer primary key, user_id uuid not null, account text not null, brand text not null, session uuid not null);

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
  select jsonb_build_object('sub', user_id, 'role', 'authenticated', 'session_id', session) from t_od.people where n = p_n $$;
create function pg_temp.api(p_n integer, p_sql text) returns text language sql as $$ select pg_temp.as_role_sql('postona_resv_api', p_sql, pg_temp.c(p_n)) $$;
create function pg_temp.worker(p_sql text) returns text language sql as $$ select pg_temp.as_role_sql('postona_resv_worker', p_sql, null) $$;
create function pg_temp.u(p_n integer) returns uuid language sql as $$ select user_id from t_od.people where n = p_n $$;
create function pg_temp.a(p_n integer) returns text language sql as $$ select account from t_od.people where n = p_n $$;
create function pg_temp.b(p_n integer) returns text language sql as $$ select brand from t_od.people where n = p_n $$;

-- a person (G5 enrolment, guarded X onboarding, G4 test double verified, publish switch ON) with a live session
create function pg_temp.person(p_n integer) returns void language plpgsql as $$
declare v_user uuid := pg_temp.enrolled(p_n); v_session uuid := pg_temp.session(pg_temp.uid(p_n)); v_account text; v_state uuid;
begin
  v_account := pg_temp.as_person(pg_temp.begin_sql('od' || p_n), v_user, v_session);
  v_state := pg_temp.as_person(pg_temp.consume_sql('od' || p_n), v_user, v_session)::uuid;
  perform pg_temp.expect(pg_temp.as_person(pg_temp.complete_sql(v_state, (6000 + p_n)::text), v_user, v_session) not like 'ERR:%', 'setup: connect ' || p_n);
  update public.social_accounts set publish_enabled = true where id = v_account;
  insert into t_od.people values (p_n, v_user, v_account, (select sa.brand_id from public.social_accounts sa where sa.id = v_account), v_session);
end $$;
-- one planned reservation, then made DUE (as the dispatch tests do: its consent moves with it)
create function pg_temp.due(p_n integer, p_tag text) returns uuid language plpgsql as $$
declare v_body text := 'OD ' || p_tag; v_out text; v_id uuid;
begin
  v_out := pg_temp.api(p_n, format('select string_agg(reservation_id::text, '','') from postona_x_resv.create_batch(%L, gen_random_uuid(), 1, ''manual_exact'', null, %L::jsonb)',
    pg_temp.a(p_n), jsonb_build_array(jsonb_build_object('draft_id', 'od_' || p_tag,
      'scheduled_at', ((now() at time zone 'Asia/Tokyo')::date + 3 + time '10:00') at time zone 'Asia/Tokyo', 'body', v_body,
      'consent', jsonb_build_object('confirmed', true, 'content_sha256', encode(sha256(convert_to(v_body, 'UTF8')), 'hex'))))));
  perform pg_temp.expect(v_out ~ '^ok:[0-9a-f-]{36}$', 'setup: reserve ' || p_tag || ' ' || v_out);
  v_id := substr(v_out, 4)::uuid;
  update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute',
         expires_at = now() + interval '6 hours' where id = v_id;
  return v_id;
end $$;
create function pg_temp.st(p_id uuid) returns text language sql as $$
  select coalesce((select status || '/' || coalesce(outcome_code, '-') from postona_x_resv.reservations where id = p_id), 'gone') $$;
-- the worker's claim: the reservation ids it claimed, as a sorted list
create function pg_temp.claim() returns text language sql as $$
  select pg_temp.worker('select coalesce(string_agg(reservation_id::text, '','' order by reservation_id), ''-'') from postona_x_resv.claim_due(''od_worker'', 60, 50)') $$;
create function pg_temp.lease(p_id uuid) returns uuid language sql as $$ select lease_token from postona_x_resv.reservations where id = p_id $$;
create function pg_temp.raw_delete(p_n integer) returns text language plpgsql as $$
begin
  delete from auth.users where id = pg_temp.u(p_n);
  return 'deleted';
exception when others then return 'ERR:' || split_part(sqlerrm, ' ', 1);
end $$;
create function pg_temp.footprint(p_n integer) returns text language sql as $$
  select format('memberships=%s accounts=%s sessions=%s common_account=%s',
    (select count(*) from public.brand_memberships where user_id = (select user_id from t_od.people where n = p_n)),
    (select count(*) from public.social_accounts where id = pg_temp.a(p_n)),
    (select count(*) from auth.sessions where user_id = (select user_id from t_od.people where n = p_n)),
    (select count(*) from public.common_accounts where user_id = (select user_id from t_od.people where n = p_n))) $$;
create function pg_temp.rec(p_s text, p_step text, p_v text) returns void language sql as $$ insert into t_od.results values (p_s, p_step, p_v) $$;

select pg_temp.person(n) from generate_series(201, 208) n;

-- O1 a due planned row; the login is deleted directly (no saga); the worker's next round: the deleted person's row is not claimed,
--    a live person's due row in the same round still is (one deleted person does not stop the round)
select pg_temp.due(201, 'O1') as o1, pg_temp.due(208, 'O1_control') as o1c \gset
select pg_temp.rec('O1_raw_delete_planned', 'delete', pg_temp.raw_delete(201));
select pg_temp.rec('O1_raw_delete_planned', 'footprint_after', pg_temp.footprint(201));
select pg_temp.rec('O1_raw_delete_planned', 'row_after_delete', pg_temp.st(:'o1'));
select pg_temp.claim() as o1claim \gset
select pg_temp.rec('O1_raw_delete_planned', 'deleted_row_claimed', (position(:'o1' in :'o1claim') > 0)::text);
select pg_temp.rec('O1_raw_delete_planned', 'control_row_claimed', (position(:'o1c' in :'o1claim') > 0)::text);
select pg_temp.rec('O1_raw_delete_planned', 'row_after_round', pg_temp.st(:'o1'));
-- O1x the row expires: the sweep marks it expired (never sent)
update postona_x_resv.reservations set expires_at = now() - interval '1 second' where id = :'o1';
select pg_temp.claim() is not null;
select pg_temp.rec('O1_raw_delete_planned', 'row_after_expiry', pg_temp.st(:'o1'));

-- O2 the worker claimed the row, THEN the login is deleted; the pre-send check refuses and fails the row (nothing sent)
select pg_temp.due(202, 'O2') as o2 \gset
select pg_temp.claim() as o2claim \gset
select pg_temp.rec('O2_claimed_then_deleted', 'claimed_before_delete', (position(:'o2' in :'o2claim') > 0)::text);
select pg_temp.lease(:'o2') as o2lease \gset
select pg_temp.rec('O2_claimed_then_deleted', 'delete', pg_temp.raw_delete(202));
select pg_temp.rec('O2_claimed_then_deleted', 'pre_publish_check', pg_temp.worker(format('select postona_x_resv.pre_publish_check(%L, %L)', :'o2', :'o2lease')));
select pg_temp.rec('O2_claimed_then_deleted', 'row_after_check', pg_temp.st(:'o2'));

-- O3 claimed, deleted, and the worker died (no check): the lease expires; the sweep fences the row to uncertain (outcome unknown)
select pg_temp.due(203, 'O3') as o3 \gset
select pg_temp.claim() is not null;
select pg_temp.rec('O3_claimed_deleted_lease_expired', 'delete', pg_temp.raw_delete(203));
update postona_x_resv.reservations set lease_expires_at = now() - interval '1 second' where id = :'o3';
select pg_temp.claim() is not null;
select pg_temp.rec('O3_claimed_deleted_lease_expired', 'row_after_sweep', pg_temp.st(:'o3'));

-- O4 a single post begun (lease held by the person's request), then the login is deleted; the request's preflight with the old claims
select pg_temp.api(204, format('select reservation_id || '' '' || lease_token from postona_x_resv.post_now_begin(%L, gen_random_uuid(), %L, %L)',
  pg_temp.a(204), 'OD single', encode(sha256(convert_to('OD single', 'UTF8')), 'hex'))) as o4begin \gset
select split_part(substr(:'o4begin', 4), ' ', 1) as o4, split_part(substr(:'o4begin', 4), ' ', 2) as o4lease \gset
select pg_temp.rec('O4_single_post_deleted_mid_request', 'begin', case when :'o4begin' ~ '^ok:' then 'ok' else :'o4begin' end);
select pg_temp.rec('O4_single_post_deleted_mid_request', 'delete', pg_temp.raw_delete(204));
select pg_temp.rec('O4_single_post_deleted_mid_request', 'preflight_old_claims', pg_temp.api(204, format('select verdict from postona_x_resv.post_now_preflight(%L, %L)', :'o4', :'o4lease')));
select pg_temp.rec('O4_single_post_deleted_mid_request', 'row_after_preflight', pg_temp.st(:'o4'::uuid));

-- O5 after the deletion, the person's still-signed (not yet expired) token reaches the database (if a verifier let it through):
--    what the person-facing entries answer (the Edge's GoTrue /user check would refuse a removed login [S]; recorded at the DB layer)
select pg_temp.due(205, 'O5') as o5 \gset
select pg_temp.api(205, format('select reservation_id::text from postona_x_resv.post_now_begin(%L, gen_random_uuid(), %L, %L)',
  pg_temp.a(205), 'OD single 5', encode(sha256(convert_to('OD single 5', 'UTF8')), 'hex'))) as o5single \gset
select pg_temp.rec('O5_old_token_after_delete', 'delete', pg_temp.raw_delete(205));
select pg_temp.rec('O5_old_token_after_delete', 'list_reservations', pg_temp.api(205, format('select count(*)::text from postona_x_resv.list_reservations(%L)', pg_temp.a(205))));
select pg_temp.rec('O5_old_token_after_delete', 'get_reservation', pg_temp.api(205, format('select status from postona_x_resv.get_reservation(%L)', :'o5')));
select pg_temp.rec('O5_old_token_after_delete', 'cancel', pg_temp.api(205, format('select status from postona_x_resv.cancel(%L, %s)', :'o5', (select revision from postona_x_resv.reservations where id = :'o5'))));
select pg_temp.rec('O5_old_token_after_delete', 'post_now_readback', pg_temp.api(205, format('select state from postona_x_resv.post_now_readback(%L)', substr(:'o5single', 4))));
select pg_temp.rec('O5_old_token_after_delete', 'rows_left', (select count(*)::text from postona_x_resv.reservations where user_id = pg_temp.u(205)));
select pg_temp.rec('O5_old_token_after_delete', 'bodies_left', (select count(*)::text from postona_x_resv.reservations where user_id = pg_temp.u(205) and body is not null));
select pg_temp.rec('O5_old_token_after_delete', 'audit_rows_left', (select count(*)::text from postona_x_resv.audit where user_id = pg_temp.u(205)));

-- O6 the intended order (control): the X stop for that person first (F3 001's postona_x_stop_publishing_for_user), then the login
select pg_temp.due(206, 'O6') as o6 \gset
update postona_x_resv.reservations set scheduled_at = now() + interval '1 day', consent_scheduled_at = now() + interval '1 day' where id = :'o6';
create function pg_temp.stop_x(p_user uuid) returns text language plpgsql as $$
begin
  if to_regprocedure('public.postona_x_stop_publishing_for_user(uuid,text)') is null then return 'NOT_AVAILABLE'; end if;
  execute 'select public.postona_x_stop_publishing_for_user($1, ''OD_TEST'')' using p_user;
  return 'called';
exception when others then return 'ERR:' || split_part(sqlerrm, ' ', 1);
end $$;
select pg_temp.rec('O6_stop_then_delete', 'stop', pg_temp.stop_x(pg_temp.u(206)));
select pg_temp.rec('O6_stop_then_delete', 'row_after_stop', pg_temp.st(:'o6'));
select pg_temp.rec('O6_stop_then_delete', 'delete', pg_temp.raw_delete(206));
select pg_temp.rec('O6_stop_then_delete', 'row_after_delete', pg_temp.st(:'o6'));

-- O7 the purge order (control): a MODEL of the delete order of public.social_mobile_account_deletion_purge (main 20260928160000,
--    lines ~568-579; not the function itself, which needs the deletion state machine): the workspace's dependants, its social accounts,
--    then the brand -> the X reservation rows go with the social account (FK on delete cascade)
select pg_temp.due(207, 'O7') as o7 \gset
create function pg_temp.purge_model(p_brand text) returns text language plpgsql as $$
declare v_accounts text[] := array(select id from public.social_accounts where brand_id = p_brand);
begin
  delete from public.x_account_refresh_state_v2 where social_account_id = any (v_accounts);
  if to_regclass('public.x_account_refresh_rollout') is not null then
    execute 'delete from public.x_account_refresh_rollout where social_account_id = any ($1)' using v_accounts;
  end if;
  delete from public.social_account_oauth_states where brand_id = p_brand or social_account_id = any (v_accounts);
  delete from public.published_content_fingerprints where brand_id = p_brand or social_account_id = any (v_accounts);
  delete from public.publish_claims where brand_id = p_brand;
  delete from public.post_execution_logs where brand_id = p_brand;
  delete from public.posting_windows where brand_id = p_brand;
  delete from public.scheduled_posts where brand_id = p_brand;
  delete from public.social_accounts where brand_id = p_brand;
  delete from public.brands where id = p_brand;
  return 'purged';
exception when others then return 'ERR:' || split_part(sqlerrm, ' ', 1) || ' ' || split_part(sqlerrm, ' ', 2);
end $$;
select pg_temp.rec('O7_purge_order_model', 'purge', pg_temp.purge_model(pg_temp.b(207)));
select pg_temp.rec('O7_purge_order_model', 'row_after_purge', pg_temp.st(:'o7'));
select pg_temp.rec('O7_purge_order_model', 'audit_rows_left', (select count(*)::text from postona_x_resv.audit where user_id = pg_temp.u(207)));

-- nothing was published anywhere
select pg_temp.expect((select count(*) from postona_x_resv.reservations where status = 'published' or provider_post_id is not null) = 0, 'nothing published');
select format('RESULT|%s|%s|%s', scenario, step, actual) from t_od.results order by scenario, step;
select 'X_DELETED_USER_AUDIT_MATRIX_DONE';
