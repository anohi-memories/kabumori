-- G3 TASK 31/50 (Issue #318), part X: the X reservation cancel / receipt (get_reservation, list_reservations, post_now_readback)
-- against row states, another person, an owner move and a lease that ran out -- the crosses G3-25 (session states x entries, planned
-- rows), G3-26 (deleted user) and G3-30 (U8 / U8b / U9) did not cover. Throw-away LOCAL PostgreSQL only, fake people / sessions /
-- claims; X candidates 001-006 read at PR #392's head by run.sh (unchanged). Prepended by run.sh with the T13 guard helpers.
create schema t_cx;
create table t_cx.results (scenario text, step text, actual text, primary key (scenario, step));
create table t_cx.people (n integer primary key, user_id uuid not null, account text not null, brand text not null, session uuid not null);

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
  select jsonb_build_object('sub', user_id, 'role', 'authenticated', 'session_id', session) from t_cx.people where n = p_n $$;
create function pg_temp.api(p_n integer, p_sql text) returns text language sql as $$ select pg_temp.as_role_sql('postona_resv_api', p_sql, pg_temp.c(p_n)) $$;
create function pg_temp.worker(p_sql text) returns text language sql as $$ select pg_temp.as_role_sql('postona_resv_worker', p_sql, null) $$;
create function pg_temp.u(p_n integer) returns uuid language sql as $$ select user_id from t_cx.people where n = p_n $$;
create function pg_temp.a(p_n integer) returns text language sql as $$ select account from t_cx.people where n = p_n $$;
create function pg_temp.b(p_n integer) returns text language sql as $$ select brand from t_cx.people where n = p_n $$;
create function pg_temp.rec(p_s text, p_step text, p_v text) returns void language sql as $$ insert into t_cx.results values (p_s, p_step, p_v) $$;

create function pg_temp.person(p_n integer) returns void language plpgsql as $$
declare v_user uuid := pg_temp.enrolled(p_n); v_session uuid := pg_temp.session(pg_temp.uid(p_n)); v_account text; v_state uuid;
begin
  v_account := pg_temp.as_person(pg_temp.begin_sql('cx' || p_n), v_user, v_session);
  v_state := pg_temp.as_person(pg_temp.consume_sql('cx' || p_n), v_user, v_session)::uuid;
  perform pg_temp.expect(pg_temp.as_person(pg_temp.complete_sql(v_state, (8000 + p_n)::text), v_user, v_session) not like 'ERR:%', 'setup: connect ' || p_n);
  update public.social_accounts set publish_enabled = true where id = v_account;
  insert into t_cx.people values (p_n, v_user, v_account, (select sa.brand_id from public.social_accounts sa where sa.id = v_account), v_session);
end $$;
-- one planned reservation (3 days ahead; p_hours apart so one person can hold several); optionally made due
create function pg_temp.mk(p_n integer, p_tag text, p_hours integer, p_due boolean) returns uuid language plpgsql as $$
declare v_out text; v_id uuid;
begin
  v_out := pg_temp.api(p_n, format('select string_agg(reservation_id::text, '','') from postona_x_resv.create_batch(%L, gen_random_uuid(), 1, ''manual_exact'', null, %L::jsonb)',
    pg_temp.a(p_n), jsonb_build_array(jsonb_build_object('draft_id', 'cx_' || p_tag,
      'scheduled_at', ((now() at time zone 'Asia/Tokyo')::date + 3 + time '09:00' + make_interval(hours => p_hours)) at time zone 'Asia/Tokyo', 'body', 'CX ' || p_tag,
      'consent', jsonb_build_object('confirmed', true, 'content_sha256', encode(sha256(convert_to('CX ' || p_tag, 'UTF8')), 'hex'))))));
  perform pg_temp.expect(v_out ~ '^ok:[0-9a-f-]{36}$', 'setup: reserve ' || p_tag || ' ' || v_out);
  v_id := substr(v_out, 4)::uuid;
  if p_due then
    update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute',
           expires_at = now() + interval '6 hours' where id = v_id;
  end if;
  return v_id;
end $$;
create function pg_temp.claim_round() returns text language sql as $$
  select pg_temp.worker('select coalesce(string_agg(reservation_id::text, '',''), ''-'') from postona_x_resv.claim_due(''cx_worker'', 60, 50)') $$;
create function pg_temp.lease(p_id uuid) returns uuid language sql as $$ select lease_token from postona_x_resv.reservations where id = p_id $$;
create function pg_temp.rev(p_id uuid) returns integer language sql as $$ select revision from postona_x_resv.reservations where id = p_id $$;
create function pg_temp.fin(p_id uuid, p_outcome text, p_post text, p_code text) returns text language sql as $$
  select pg_temp.worker(format('select postona_x_resv.finish(%L, %L, %L, %L, %L)', p_id, pg_temp.lease(p_id), p_outcome, p_post, p_code)) $$;
create function pg_temp.get1(p_n integer, p_id uuid) returns text language sql as $$
  select pg_temp.api(p_n, format('select status from postona_x_resv.get_reservation(%L)', p_id)) $$;
create function pg_temp.cancel1(p_n integer, p_id uuid) returns text language sql as $$
  select pg_temp.api(p_n, format('select status from postona_x_resv.cancel(%L, %s)', p_id, coalesce(pg_temp.rev(p_id), 1))) $$;
create function pg_temp.list_ids(p_n integer, p_account text) returns text language sql as $$
  select pg_temp.api(p_n, format('select coalesce(string_agg(reservation_id::text, '','' order by reservation_id), ''-'') from postona_x_resv.list_reservations(%L)', p_account)) $$;
create function pg_temp.st(p_id uuid) returns text language sql as $$
  select coalesce((select status || '/' || coalesce(outcome_code, '-') from postona_x_resv.reservations where id = p_id), 'gone') $$;

select pg_temp.person(n) from generate_series(701, 706) n;

-- XS rows of person 701 in five states (planned rows made due, claimed by the worker, then finished as the worker would)
select pg_temp.mk(701, 'claimed', 0, false) as xc \gset
select pg_temp.mk(701, 'uncertain', 1, false) as xu \gset
select pg_temp.mk(701, 'published', 2, false) as xp \gset
select pg_temp.mk(701, 'failed', 3, false) as xf \gset
select pg_temp.mk(701, 'cancelled', 4, false) as xx \gset
-- made due only after all five exist, minutes apart (the slot check compares a new row with the existing ones)
update postona_x_resv.reservations set scheduled_at = now() - k * interval '1 minute', consent_scheduled_at = now() - k * interval '1 minute',
       expires_at = now() + interval '6 hours'
from (values (:'xc'::uuid, 4), (:'xu'::uuid, 3), (:'xp'::uuid, 2), (:'xf'::uuid, 1)) d(id, k) where reservations.id = d.id;
select pg_temp.expect(pg_temp.claim_round() ~ :'xc' and pg_temp.lease(:'xu') is not null and pg_temp.lease(:'xp') is not null and pg_temp.lease(:'xf') is not null, 'setup: claimed');
select pg_temp.expect(pg_temp.fin(:'xu', 'uncertain', null, 'X_TIMEOUT') = 'ok:uncertain', 'setup: uncertain');
select pg_temp.expect(pg_temp.fin(:'xp', 'published', '1100000001', null) = 'ok:published', 'setup: published');
select pg_temp.expect(pg_temp.fin(:'xf', 'failed_before_send', null, 'X_REJECTED_400') = 'ok:failed_before_send', 'setup: failed');
select pg_temp.expect(pg_temp.cancel1(701, :'xx') = 'ok:cancelled', 'setup: cancelled');
create temp table xs (state text primary key, id uuid not null);
insert into xs values ('claimed', :'xc'), ('uncertain', :'xu'), ('published', :'xp'), ('failed', :'xf'), ('cancelled', :'xx');

-- X1 another person (702, live session) asks for / cancels 701's rows in every state: the answer must equal an unknown id's
select pg_temp.rec('X1_other_person_by_state', 'get_' || state, pg_temp.get1(702, id)) from xs;
select pg_temp.rec('X1_other_person_by_state', 'cancel_' || state, pg_temp.cancel1(702, id)) from xs;
select pg_temp.rec('X1_other_person_by_state', 'get_unknown_id', pg_temp.get1(702, gen_random_uuid()));
select pg_temp.rec('X1_other_person_by_state', 'cancel_unknown_id', pg_temp.cancel1(702, gen_random_uuid()));
select pg_temp.rec('X1_other_person_by_state', 'rows_unchanged', (select string_agg(xs.state || '=' || pg_temp.st(xs.id), ',' order by xs.state) from xs));

-- X2 the owner (701) on their own rows in every state: what the receipt says, whether cancel is allowed
select pg_temp.rec('X2_owner_by_state', 'get_' || state, pg_temp.get1(701, id)) from xs;
select pg_temp.rec('X2_owner_by_state', 'cancel_' || state, pg_temp.cancel1(701, id)) from xs where state <> 'cancelled';
select pg_temp.rec('X2_owner_by_state', 'cancel_again_cancelled', pg_temp.cancel1(701, :'xx'));
select pg_temp.rec('X2_owner_by_state', 'cancel_audit_rows', (select count(*)::text from postona_x_resv.audit where reservation_id = :'xx' and action = 'cancel'));

-- X3 what a receipt carries: the columns of the person-facing reservation view (no lease token / worker / provider id / outcome)
select pg_temp.rec('X3_receipt_columns', 'reservation_view',
  (select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a where a.attrelid = 'postona_x_resv.reservation_view'::regclass and a.attnum > 0 and not a.attisdropped));
select pg_temp.rec('X3_receipt_columns', 'single_post_readback',
  (select array_to_string(p.proargnames[2:], ',') from pg_proc p where p.oid = 'postona_x_resv.post_now_readback(uuid)'::regprocedure));

-- X4 the workspace owner moves A (703) -> B (704) while A's planned row exists: B's view of A's row, and A's own
select pg_temp.mk(703, 'X4', 0, false) as x4 \gset
delete from public.brand_memberships where brand_id = pg_temp.b(703) and role = 'owner';
insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.b(703), pg_temp.u(704), 'owner');
select pg_temp.rec('X4_owner_moved_A_to_B', 'B_get_A_row', pg_temp.get1(704, :'x4'));
select pg_temp.rec('X4_owner_moved_A_to_B', 'B_cancel_A_row', pg_temp.cancel1(704, :'x4'));
select pg_temp.rec('X4_owner_moved_A_to_B', 'B_get_unknown_id', pg_temp.get1(704, gen_random_uuid()));
select pg_temp.rec('X4_owner_moved_A_to_B', 'B_list_account', pg_temp.list_ids(704, pg_temp.a(703)));
select pg_temp.rec('X4_owner_moved_A_to_B', 'A_get_own_row', pg_temp.get1(703, :'x4'));
select pg_temp.rec('X4_owner_moved_A_to_B', 'A_cancel_own_row', pg_temp.cancel1(703, :'x4'));
select pg_temp.rec('X4_owner_moved_A_to_B', 'A_list_account', pg_temp.list_ids(703, pg_temp.a(703)));
select pg_temp.rec('X4_owner_moved_A_to_B', 'row', pg_temp.st(:'x4'));

-- X5 a single post whose lease ran out before any sweep: what the readback says (705), then after a claim round swept it
select pg_temp.api(705, format('select reservation_id from postona_x_resv.post_now_begin(%L, gen_random_uuid(), %L, %L)', pg_temp.a(705), 'CX single',
  encode(sha256(convert_to('CX single', 'UTF8')), 'hex'))) as x5raw \gset
select pg_temp.expect(:'x5raw' ~ '^ok:[0-9a-f-]{36}$', 'setup: single post begin ' || :'x5raw');
select substr(:'x5raw', 4) as x5 \gset
select pg_temp.rec('X5_single_post_lease_ran_out', 'row_after_begin', pg_temp.st(:'x5'));
select pg_temp.rec('X5_single_post_lease_ran_out', 'readback_live_lease', pg_temp.api(705, format('select state from postona_x_resv.post_now_readback(%L)', :'x5')));
update postona_x_resv.reservations set lease_expires_at = clock_timestamp() - interval '1 second' where id = :'x5';
select pg_temp.rec('X5_single_post_lease_ran_out', 'readback_expired_before_sweep', pg_temp.api(705, format('select state from postona_x_resv.post_now_readback(%L)', :'x5')));
select pg_temp.claim_round() is not null as swept \gset
select pg_temp.rec('X5_single_post_lease_ran_out', 'row_after_sweep', pg_temp.st(:'x5'));
select pg_temp.rec('X5_single_post_lease_ran_out', 'readback_after_sweep', pg_temp.api(705, format('select state from postona_x_resv.post_now_readback(%L)', :'x5')));
select pg_temp.rec('X5_single_post_lease_ran_out', 'other_person_readback', pg_temp.api(706, format('select state from postona_x_resv.post_now_readback(%L)', :'x5')));
select pg_temp.rec('X5_single_post_lease_ran_out', 'other_person_readback_unknown_id', pg_temp.api(706, format('select state from postona_x_resv.post_now_readback(%L)', gen_random_uuid())));

select pg_temp.rec('Z_x_store', 'published_rows', (select count(*)::text from postona_x_resv.reservations where status = 'published'));
select format('RESULT|%s|%s|%s', scenario, step, actual) from t_cx.results order by scenario, step;
select 'X_CANCEL_RECEIPT_MATRIX_DONE';
