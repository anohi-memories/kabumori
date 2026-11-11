-- G3 TASK 30/50 (Issue #318): the X reservation store under the worker's UNKNOWN / idempotency interleavings -- a lost success
-- response, a send that outlives its lease (finish first vs sweep first), finish replays, a crash between the check and the send, a
-- hand-back after the lease deadline, cancel against claim / hand-back, cancel while not owner, a check with too little lease left.
-- Not repeated: G3-29 E1-E9 (owner epoch), G3-25 / G3-26 / G3-28 cells, PR #392's worker_test.ts cases. Throw-away LOCAL PostgreSQL
-- only, fake people / sessions / claims; X candidates 001-006 read at PR #392's head by run.sh (unchanged). Prepended by run.sh with
-- the T13 guard helpers. Calls are made as the worker would make them; nothing reaches a provider. Records today's answers in
-- t_ux.results; run.sh adds the two real-concurrency cells (U5, U8b), pins everything and classifies each cell.
create schema t_ux;
create table t_ux.results (scenario text, step text, actual text, primary key (scenario, step));
create table t_ux.people (n integer primary key, user_id uuid not null, account text not null, brand text not null, session uuid not null);
create table t_ux.race (tag text primary key, reservation_id uuid not null, lease_token uuid, revision integer not null, n integer not null);
grant usage on schema t_ux to public;
grant select on t_ux.race, t_ux.people to public;

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
  select jsonb_build_object('sub', user_id, 'role', 'authenticated', 'session_id', session) from t_ux.people where n = p_n $$;
create function pg_temp.api(p_n integer, p_sql text) returns text language sql as $$ select pg_temp.as_role_sql('postona_resv_api', p_sql, pg_temp.c(p_n)) $$;
create function pg_temp.worker(p_sql text) returns text language sql as $$ select pg_temp.as_role_sql('postona_resv_worker', p_sql, null) $$;
create function pg_temp.u(p_n integer) returns uuid language sql as $$ select user_id from t_ux.people where n = p_n $$;
create function pg_temp.a(p_n integer) returns text language sql as $$ select account from t_ux.people where n = p_n $$;
create function pg_temp.b(p_n integer) returns text language sql as $$ select brand from t_ux.people where n = p_n $$;
create function pg_temp.rec(p_s text, p_step text, p_v text) returns void language sql as $$ insert into t_ux.results values (p_s, p_step, p_v) $$;

create function pg_temp.person(p_n integer) returns void language plpgsql as $$
declare v_user uuid := pg_temp.enrolled(p_n); v_session uuid := pg_temp.session(pg_temp.uid(p_n)); v_account text; v_state uuid;
begin
  v_account := pg_temp.as_person(pg_temp.begin_sql('ux' || p_n), v_user, v_session);
  v_state := pg_temp.as_person(pg_temp.consume_sql('ux' || p_n), v_user, v_session)::uuid;
  perform pg_temp.expect(pg_temp.as_person(pg_temp.complete_sql(v_state, (6000 + p_n)::text), v_user, v_session) not like 'ERR:%', 'setup: connect ' || p_n);
  update public.social_accounts set publish_enabled = true where id = v_account;
  insert into t_ux.people values (p_n, v_user, v_account, (select sa.brand_id from public.social_accounts sa where sa.id = v_account), v_session);
end $$;
-- one planned reservation made due (the dispatch tests' clock move)
create function pg_temp.due(p_n integer, p_tag text) returns uuid language plpgsql as $$
declare v_out text; v_id uuid;
begin
  v_out := pg_temp.api(p_n, format('select string_agg(reservation_id::text, '','') from postona_x_resv.create_batch(%L, gen_random_uuid(), 1, ''manual_exact'', null, %L::jsonb)',
    pg_temp.a(p_n), jsonb_build_array(jsonb_build_object('draft_id', 'ux_' || p_tag,
      'scheduled_at', ((now() at time zone 'Asia/Tokyo')::date + 3 + time '10:00') at time zone 'Asia/Tokyo', 'body', 'UX ' || p_tag,
      'consent', jsonb_build_object('confirmed', true, 'content_sha256', encode(sha256(convert_to('UX ' || p_tag, 'UTF8')), 'hex'))))));
  perform pg_temp.expect(v_out ~ '^ok:[0-9a-f-]{36}$', 'setup: reserve ' || p_tag || ' ' || v_out);
  v_id := substr(v_out, 4)::uuid;
  update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute',
         expires_at = now() + interval '6 hours' where id = v_id;
  return v_id;
end $$;
-- the worker's claim round (it also sweeps expired leases): whether THIS row was claimed
create function pg_temp.claimed(p_id uuid) returns text language plpgsql as $$
declare v text := pg_temp.worker('select coalesce(string_agg(reservation_id::text, '',''), ''-'') from postona_x_resv.claim_due(''ux_worker'', 60, 50)');
begin
  return case when v !~ '^ok:' then v when position(p_id::text in v) > 0 then 'claimed' else 'not_claimed' end;
end $$;
create function pg_temp.lease(p_id uuid) returns uuid language sql as $$ select lease_token from postona_x_resv.reservations where id = p_id $$;
create function pg_temp.rev(p_id uuid) returns integer language sql as $$ select revision from postona_x_resv.reservations where id = p_id $$;
create function pg_temp.check1(p_id uuid) returns text language sql as $$
  select pg_temp.worker(format('select postona_x_resv.pre_publish_check(%L, %L)', p_id, pg_temp.lease(p_id))) $$;
create function pg_temp.fin(p_id uuid, p_lease uuid, p_outcome text, p_post text, p_code text) returns text language sql as $$
  select pg_temp.worker(format('select postona_x_resv.finish(%L, %L, %L, %L, %L)', p_id, p_lease, p_outcome, p_post, p_code)) $$;
create function pg_temp.release1(p_id uuid, p_lease uuid) returns text language sql as $$
  select pg_temp.worker(format('select postona_x_resv.release_unsent(%L, %L)', p_id, p_lease)) $$;
create function pg_temp.cancel1(p_n integer, p_id uuid, p_rev integer) returns text language sql as $$
  select pg_temp.api(p_n, format('select status from postona_x_resv.cancel(%L, %s)', p_id, p_rev)) $$;
create function pg_temp.expire(p_id uuid) returns void language sql as $$
  update postona_x_resv.reservations set lease_expires_at = clock_timestamp() - interval '1 second' where id = p_id $$;
create function pg_temp.st(p_id uuid) returns text language sql as $$
  select coalesce((select status || '/' || coalesce(outcome_code, '-') from postona_x_resv.reservations where id = p_id), 'gone') $$;
-- is the provider post id the worker reported anywhere in the row or the audit trail (the only evidence a reconciliation could use)?
create function pg_temp.id_kept(p_id uuid, p_post text) returns text language sql as $$
  select ((select count(*) from postona_x_resv.reservations where id = p_id and provider_post_id = p_post)
        + (select count(*) from postona_x_resv.audit where reservation_id = p_id and detail::text like '%' || p_post || '%'))::text $$;

select pg_temp.person(n) from generate_series(501, 511) n;

-- U1 the provider posted but the response was lost (timeout): uncertain is recorded; a late success report afterwards
select pg_temp.due(501, 'U1') as u1 \gset
select pg_temp.rec('U1_success_lost_then_late_success', 'claim', pg_temp.claimed(:'u1'));
select pg_temp.lease(:'u1') as u1l \gset
select pg_temp.rec('U1_success_lost_then_late_success', 'pre_publish_check', pg_temp.check1(:'u1'));
select pg_temp.rec('U1_success_lost_then_late_success', 'finish_uncertain', pg_temp.fin(:'u1', :'u1l', 'uncertain', null, 'X_TIMEOUT'));
select pg_temp.rec('U1_success_lost_then_late_success', 'late_published', pg_temp.fin(:'u1', :'u1l', 'published', '1000000001', null));
select pg_temp.rec('U1_success_lost_then_late_success', 'late_id_kept', pg_temp.id_kept(:'u1', '1000000001'));
select pg_temp.rec('U1_success_lost_then_late_success', 'row', pg_temp.st(:'u1'));
select pg_temp.rec('U1_success_lost_then_late_success', 'cancel_after', pg_temp.cancel1(501, :'u1', pg_temp.rev(:'u1')));
select pg_temp.rec('U1_success_lost_then_late_success', 'next_round', pg_temp.claimed(:'u1'));

-- U2 the send outlives the lease; the worker's finish arrives BEFORE any sweep
select pg_temp.due(502, 'U2') as u2 \gset
select pg_temp.rec('U2_send_past_lease_finish_first', 'claim', pg_temp.claimed(:'u2'));
select pg_temp.lease(:'u2') as u2l \gset
select pg_temp.rec('U2_send_past_lease_finish_first', 'pre_publish_check', pg_temp.check1(:'u2'));
select pg_temp.expire(:'u2');
select pg_temp.rec('U2_send_past_lease_finish_first', 'finish_published', pg_temp.fin(:'u2', :'u2l', 'published', '1000000002', null));
select pg_temp.rec('U2_send_past_lease_finish_first', 'row', pg_temp.st(:'u2'));
select pg_temp.rec('U2_send_past_lease_finish_first', 'id_kept', pg_temp.id_kept(:'u2', '1000000002'));
select pg_temp.rec('U2_send_past_lease_finish_first', 'next_round', pg_temp.claimed(:'u2'));

-- U3 the same, but another run's claim round (a restarted worker) sweeps the expired lease BEFORE the finish arrives
select pg_temp.due(503, 'U3') as u3 \gset
select pg_temp.rec('U3_send_past_lease_sweep_first', 'claim', pg_temp.claimed(:'u3'));
select pg_temp.lease(:'u3') as u3l \gset
select pg_temp.rec('U3_send_past_lease_sweep_first', 'pre_publish_check', pg_temp.check1(:'u3'));
select pg_temp.expire(:'u3');
select pg_temp.rec('U3_send_past_lease_sweep_first', 'sweep_round', pg_temp.claimed(:'u3'));
select pg_temp.rec('U3_send_past_lease_sweep_first', 'row_after_sweep', pg_temp.st(:'u3'));
select pg_temp.rec('U3_send_past_lease_sweep_first', 'finish_published', pg_temp.fin(:'u3', :'u3l', 'published', '1000000003', null));
select pg_temp.rec('U3_send_past_lease_sweep_first', 'id_kept', pg_temp.id_kept(:'u3', '1000000003'));

-- U4 finish replays on one lease: the same success again, a different id, uncertain, failed_before_send
select pg_temp.due(504, 'U4') as u4 \gset
select pg_temp.rec('U4_finish_replays', 'claim', pg_temp.claimed(:'u4'));
select pg_temp.lease(:'u4') as u4l \gset
select pg_temp.rec('U4_finish_replays', 'pre_publish_check', pg_temp.check1(:'u4'));
select pg_temp.rec('U4_finish_replays', 'finish_published', pg_temp.fin(:'u4', :'u4l', 'published', '1000000004', null));
select pg_temp.rec('U4_finish_replays', 'replay_same_id', pg_temp.fin(:'u4', :'u4l', 'published', '1000000004', null));
select pg_temp.rec('U4_finish_replays', 'replay_other_id', pg_temp.fin(:'u4', :'u4l', 'published', '1000000044', null));
select pg_temp.rec('U4_finish_replays', 'replay_uncertain', pg_temp.fin(:'u4', :'u4l', 'uncertain', null, 'X_TIMEOUT'));
select pg_temp.rec('U4_finish_replays', 'replay_failed_before_send', pg_temp.fin(:'u4', :'u4l', 'failed_before_send', null, 'X_REJECTED_400'));
select pg_temp.rec('U4_finish_replays', 'replay_wrong_lease', pg_temp.fin(:'u4', gen_random_uuid(), 'published', '1000000004', null));
select pg_temp.rec('U4_finish_replays', 'row', pg_temp.st(:'u4') || '/' || (select provider_post_id from postona_x_resv.reservations where id = :'u4'));
select pg_temp.rec('U4_finish_replays', 'finish_audit_rows', (select count(*)::text from postona_x_resv.audit where reservation_id = :'u4' and action = 'finish'));

-- U5 (prepared here, raced by run.sh) two finishes on one lease at the same time: published holds the row, uncertain waits
select pg_temp.due(505, 'U5') as u5 \gset
select pg_temp.rec('U5_concurrent_finish', 'claim', pg_temp.claimed(:'u5'));
select pg_temp.rec('U5_concurrent_finish', 'pre_publish_check', pg_temp.check1(:'u5'));
insert into t_ux.race values ('U5', :'u5', pg_temp.lease(:'u5'), pg_temp.rev(:'u5'), 505);

-- U6 the worker crashed after the check said OK and before the send: nothing was sent, the lease expires, a sweep fences it
select pg_temp.due(506, 'U6') as u6 \gset
select pg_temp.rec('U6_crash_after_check_before_send', 'claim', pg_temp.claimed(:'u6'));
select pg_temp.lease(:'u6') as u6l \gset
select pg_temp.rec('U6_crash_after_check_before_send', 'pre_publish_check', pg_temp.check1(:'u6'));
select pg_temp.expire(:'u6');
select pg_temp.rec('U6_crash_after_check_before_send', 'sweep_round', pg_temp.claimed(:'u6'));
select pg_temp.rec('U6_crash_after_check_before_send', 'row', pg_temp.st(:'u6'));
select pg_temp.rec('U6_crash_after_check_before_send', 'late_release_unsent', pg_temp.release1(:'u6', :'u6l'));
select pg_temp.rec('U6_crash_after_check_before_send', 'cancel_after', pg_temp.cancel1(506, :'u6', pg_temp.rev(:'u6')));

-- U7 a hand-back (release_unsent) that arrives AFTER the lease deadline but before any sweep
select pg_temp.due(507, 'U7') as u7 \gset
select pg_temp.rec('U7_release_after_deadline_before_sweep', 'claim', pg_temp.claimed(:'u7'));
select pg_temp.lease(:'u7') as u7l \gset
select pg_temp.expire(:'u7');
select pg_temp.rec('U7_release_after_deadline_before_sweep', 'release_unsent', pg_temp.release1(:'u7', :'u7l'));
select pg_temp.rec('U7_release_after_deadline_before_sweep', 'row', pg_temp.st(:'u7'));
select pg_temp.rec('U7_release_after_deadline_before_sweep', 'next_round', pg_temp.claimed(:'u7'));

-- U8 cancel against a claimed row, then after the worker handed it back unsent (same revision the person saw)
select pg_temp.due(508, 'U8') as u8 \gset
select pg_temp.rev(:'u8') as u8r \gset
select pg_temp.rec('U8_cancel_vs_claim_and_hand_back', 'claim', pg_temp.claimed(:'u8'));
select pg_temp.lease(:'u8') as u8l \gset
select pg_temp.rec('U8_cancel_vs_claim_and_hand_back', 'cancel_while_claimed', pg_temp.cancel1(508, :'u8', :u8r));
select pg_temp.rec('U8_cancel_vs_claim_and_hand_back', 'release_unsent', pg_temp.release1(:'u8', :'u8l'));
select pg_temp.rec('U8_cancel_vs_claim_and_hand_back', 'cancel_after_hand_back', pg_temp.cancel1(508, :'u8', :u8r));
select pg_temp.rec('U8_cancel_vs_claim_and_hand_back', 'row', pg_temp.st(:'u8'));
select pg_temp.rec('U8_cancel_vs_claim_and_hand_back', 'next_round', pg_temp.claimed(:'u8'));
select pg_temp.rec('U8_cancel_vs_claim_and_hand_back', 'stale_lease_check', pg_temp.worker(format('select postona_x_resv.pre_publish_check(%L, %L)', :'u8', :'u8l')));

-- U8b (prepared here, raced by run.sh) a claim round while the person's cancel holds the row lock
select pg_temp.due(509, 'U8b') as u8b \gset
-- kept out of the later claim rounds until run.sh makes it due again right before the race
update postona_x_resv.reservations set scheduled_at = now() + interval '1 day', consent_scheduled_at = now() + interval '1 day' where id = :'u8b';
insert into t_ux.race values ('U8b', :'u8b', null, pg_temp.rev(:'u8b'), 509);

-- U9 the person tries to cancel while they are not the owner of the workspace (the row is planned and due)  [PENDING_POLICY]
select pg_temp.due(510, 'U9') as u9 \gset
delete from public.brand_memberships where brand_id = pg_temp.b(510) and role = 'owner';
select pg_temp.rec('U9_cancel_while_not_owner', 'cancel', pg_temp.cancel1(510, :'u9', pg_temp.rev(:'u9')));
select pg_temp.rec('U9_cancel_while_not_owner', 'row', pg_temp.st(:'u9'));
insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.b(510), pg_temp.u(510), 'owner');

-- U10 the check is asked with 5 seconds of lease left (the X publisher's timeout is 20 s: x_publisher.ts:45)
select pg_temp.due(511, 'U10') as u10 \gset
select pg_temp.rec('U10_check_with_short_lease', 'claim', pg_temp.claimed(:'u10'));
update postona_x_resv.reservations set lease_expires_at = clock_timestamp() + interval '5 seconds' where id = :'u10';
select pg_temp.rec('U10_check_with_short_lease', 'pre_publish_check', pg_temp.check1(:'u10'));
select pg_temp.rec('U10_check_with_short_lease', 'row', pg_temp.st(:'u10'));

select pg_temp.rec('Z_store', 'published_rows_other_than_U4', (select count(*)::text from postona_x_resv.reservations where status = 'published' and id <> :'u4'));
select format('RESULT|%s|%s|%s', scenario, step, actual) from t_ux.results order by scenario, step;
select 'X_WORKER_UNKNOWN_IDEMPOTENCY_MATRIX_DONE';
