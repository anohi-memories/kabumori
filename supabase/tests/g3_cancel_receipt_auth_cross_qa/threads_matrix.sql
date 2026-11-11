-- G3 TASK 31/50 (Issue #318), part Threads: candidate 007's cancel_reservation / receipt against row states, another person, the
-- new owner after an owner move, a deleted owner and the audit trail -- the crosses PR #392's P7 run (D1-D5 session states, I2 another
-- person with a dead session, Q1 the old owner after A -> B) did not cover. Throw-away LOCAL PostgreSQL only; people 61-99 from PR
-- #392's tests/people.sql (fake identities, G4 / G5 test doubles as in postona_threads_reservations_run.sh). Prepended by run.sh with
-- the T13 guard helpers. Nothing reaches Threads (transport 'simulated').
create schema t_ct;
create table t_ct.results (scenario text, step text, actual text, primary key (scenario, step));
create table t_ct.race (tag text primary key, reservation_id uuid not null, n integer not null);
grant usage on schema t_ct to public;
grant select on t_ct.race to public;

create function pg_temp.api(p_sql text, p_user uuid, p_session uuid) returns text language sql as $$ select pg_temp.as_person(p_sql, p_user, p_session, 'postona_resv_api') $$;
create function pg_temp.wk(p_sql text) returns text language sql as $$ select pg_temp.as_person(p_sql, null, null, 'postona_resv_worker') $$;
create function pg_temp.p(p_n integer) returns uuid language sql as $$ select user_id from t_ids.people where n = p_n $$;
create function pg_temp.th(p_n integer) returns text language sql as $$ select threads_account from t_ids.people where n = p_n $$;
create function pg_temp.br(p_n integer) returns text language sql as $$ select brand from t_ids.people where n = p_n $$;
create function pg_temp.rec(p_s text, p_step text, p_v text) returns void language sql as $$ insert into t_ct.results values (p_s, p_step, p_v) $$;
-- each person's live session, made once (a deleted person keeps the id their old token carried)
create temp table sess (n integer primary key, session uuid not null);
create function pg_temp.s(p_n integer) returns uuid language plpgsql as $$
declare v uuid;
begin
  select session into v from sess where n = p_n;
  if v is null then
    v := pg_temp.session(pg_temp.p(p_n));
    insert into sess values (p_n, v);
  end if;
  return v;
end $$;
create function pg_temp.as_n(p_n integer, p_sql text) returns text language sql as $$ select pg_temp.api(p_sql, pg_temp.p(p_n), pg_temp.s(p_n)) $$;
-- a planned reservation of person n (10 minutes ahead, its own client request id)
create function pg_temp.mk(p_n integer, p_text text) returns uuid language plpgsql as $$
declare v text := pg_temp.as_n(p_n, format('select status || ''/'' || reservation_id || ''/'' || created from postona_threads_resv.create_reservation(%L, gen_random_uuid(), %L, %L, now() + interval ''10 minutes'')',
                                     pg_temp.th(p_n), p_text, encode(sha256(convert_to(p_text, 'UTF8')), 'hex')));
begin
  perform pg_temp.expect(v like 'planned/%/true', 'mk ' || p_n || ' ' || v);
  return split_part(v, '/', 2)::uuid;
end $$;
create function pg_temp.req(p_rid uuid) returns uuid language sql as $$ select client_request_id from postona_threads_resv.reservations where id = p_rid $$;
create function pg_temp.lease(p_rid uuid) returns uuid language sql as $$ select lease_token from postona_threads_resv.reservations where id = p_rid $$;
/** Make exactly this row due and claim it as the dispatcher. */
create function pg_temp.claim(p_rid uuid) returns void language plpgsql as $$
declare v text;
begin
  update postona_threads_resv.reservations set scheduled_at = now() - interval '1 second' where id = p_rid;
  v := pg_temp.wk('select string_agg(reservation_id::text, '','') from postona_threads_resv.claim_due(''ct'', 60, 50)');
  perform pg_temp.expect(v = p_rid::text, 'claim exactly ' || p_rid || ': ' || coalesce(v, '<none>'));
end $$;
create function pg_temp.pre(p_rid uuid) returns text language sql as $$
  select pg_temp.wk(format('select verdict from postona_threads_resv.preflight(%L, %L)', p_rid, pg_temp.lease(p_rid))) $$;
create function pg_temp.record1(p_rid uuid, p_outcome text, p_id text, p_code text) returns text language sql as $$
  select pg_temp.wk(format('select postona_threads_resv.record(%L, %L, %L, %L, %L, ''simulated'')', p_rid, pg_temp.lease(p_rid), p_outcome, p_id, p_code)) $$;
create function pg_temp.cancel1(p_n integer, p_rid uuid) returns text language sql as $$
  select pg_temp.as_n(p_n, format('select postona_threads_resv.cancel_reservation(%L)', p_rid)) $$;
-- the receipt as person n asks for it: (account, client request id) of the row
create function pg_temp.receipt1(p_n integer, p_account text, p_req uuid) returns text language sql as $$
  select pg_temp.as_n(p_n, format('select state || ''/'' || coalesce(provider_post_id, ''-'') || ''/'' || coalesce(outcome_code, ''-'') from postona_threads_resv.receipt(%L, %L)', p_account, p_req)) $$;
create function pg_temp.st(p_rid uuid) returns text language sql as $$
  select coalesce((select status || '/' || coalesce(outcome_code, '-') from postona_threads_resv.reservations where id = p_rid), 'gone') $$;

-- TS rows of person 61 in four states
select pg_temp.mk(61, 'TS claimed') as tc \gset
select pg_temp.claim(:'tc');
select pg_temp.mk(61, 'TS uncertain') as tu \gset
select pg_temp.claim(:'tu');
update postona_threads_resv.reservations set lease_expires_at = clock_timestamp() - interval '1 second' where id = :'tu';
select pg_temp.mk(61, 'TS published') as tp \gset
select pg_temp.claim(:'tp');
select pg_temp.pre(:'tp') as tpv \gset
select pg_temp.expect(:'tpv' = 'OK', 'setup: preflight ' || :'tpv');
select pg_temp.expect(pg_temp.record1(:'tp', 'published', '18000000000000061', null) = 'published', 'setup: published');
select pg_temp.mk(61, 'TS cancelled') as tx \gset
select pg_temp.expect(pg_temp.cancel1(61, :'tx') = 'cancelled', 'setup: cancelled');
create temp table ts (state text primary key, id uuid not null);
insert into ts values ('claimed', :'tc'), ('lease_ran_out', :'tu'), ('published', :'tp'), ('cancelled', :'tx');

-- T1 another person (62, live session) on 61's rows in every state: cancel / receipt must answer as for an unknown id
select pg_temp.rec('T1_other_person_by_state', 'cancel_' || state, pg_temp.cancel1(62, id)) from ts;
select pg_temp.rec('T1_other_person_by_state', 'receipt_' || state, pg_temp.receipt1(62, pg_temp.th(61), pg_temp.req(id))) from ts;
select pg_temp.rec('T1_other_person_by_state', 'cancel_unknown_id', pg_temp.cancel1(62, gen_random_uuid()));
select pg_temp.rec('T1_other_person_by_state', 'receipt_unknown_request', pg_temp.receipt1(62, pg_temp.th(61), gen_random_uuid()));
select pg_temp.rec('T1_other_person_by_state', 'receipt_own_account_foreign_request', pg_temp.receipt1(62, pg_temp.th(62), pg_temp.req(:'tp')));
select pg_temp.rec('T1_other_person_by_state', 'rows_unchanged', (select string_agg(ts.state || '=' || pg_temp.st(ts.id), ',' order by ts.state) from ts));

-- T2 the owner (61) on their own rows in every state: the receipt (a claimed row whose lease ran out, before any sweep) and cancel
select pg_temp.rec('T2_owner_by_state', 'receipt_' || state, pg_temp.receipt1(61, pg_temp.th(61), pg_temp.req(id))) from ts;
select pg_temp.rec('T2_owner_by_state', 'cancel_' || state, pg_temp.cancel1(61, id)) from ts;
select pg_temp.wk('select count(*) from postona_threads_resv.claim_due(''ct_sweep'', 60, 50)') as swept \gset
select pg_temp.rec('T2_owner_by_state', 'row_lease_ran_out_after_sweep', pg_temp.st(:'tu'));
select pg_temp.rec('T2_owner_by_state', 'receipt_lease_ran_out_after_sweep', pg_temp.receipt1(61, pg_temp.th(61), pg_temp.req(:'tu')));

-- T3 the workspace owner moves A (63) -> B (64) while A's planned row exists: the NEW owner's view of A's row
select pg_temp.mk(63, 'T3') as t3 \gset
delete from public.brand_memberships where brand_id = pg_temp.br(63) and role = 'owner';
insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.br(63), pg_temp.p(64), 'owner');
select pg_temp.rec('T3_new_owner_on_old_rows', 'B_cancel_A_row', pg_temp.cancel1(64, :'t3'));
select pg_temp.rec('T3_new_owner_on_old_rows', 'B_receipt_A_row', pg_temp.receipt1(64, pg_temp.th(63), pg_temp.req(:'t3')));
select pg_temp.rec('T3_new_owner_on_old_rows', 'B_cancel_unknown_id', pg_temp.cancel1(64, gen_random_uuid()));
update postona_threads_resv.reservations set scheduled_at = now() - interval '1 second' where id = :'t3';
select pg_temp.rec('T3_new_owner_on_old_rows', 'worker_claim',
  case when coalesce(pg_temp.wk('select string_agg(reservation_id::text, '','') from postona_threads_resv.claim_due(''ct3'', 60, 50)'), '') like '%' || :'t3' || '%'
       then 'claimed' else 'not_claimed' end);
select pg_temp.rec('T3_new_owner_on_old_rows', 'row', pg_temp.st(:'t3'));

-- T4 the owner (65) is deleted (the auth.users row, as a direct login delete would) while two planned rows exist: the old token on
--    one of them, the dispatcher on the other
select pg_temp.mk(65, 'T4') as t4 \gset
select pg_temp.mk(65, 'T4 worker') as t4w \gset
select pg_temp.s(65) as s65 \gset
select pg_temp.p(65) as p65 \gset
delete from auth.users where id = :'p65';
select pg_temp.rec('T4_deleted_owner', 'sessions_left', (select count(*)::text from auth.sessions where user_id = :'p65'));
select pg_temp.rec('T4_deleted_owner', 'old_token_receipt',
  pg_temp.api(format('select state from postona_threads_resv.receipt(%L, %L)', pg_temp.th(65), pg_temp.req(:'t4')), :'p65', :'s65'));
select pg_temp.rec('T4_deleted_owner', 'old_token_cancel',
  pg_temp.api(format('select postona_threads_resv.cancel_reservation(%L)', :'t4'), :'p65', :'s65'));
select pg_temp.rec('T4_deleted_owner', 'row_after_old_token_cancel', pg_temp.st(:'t4'));
update postona_threads_resv.reservations set scheduled_at = now() - interval '1 second' where id = :'t4w';
select pg_temp.rec('T4_deleted_owner', 'worker_claim',
  case when coalesce(pg_temp.wk('select string_agg(reservation_id::text, '','') from postona_threads_resv.claim_due(''ct4'', 60, 50)'), '') like '%' || :'t4w' || '%'
       then 'claimed' else 'not_claimed' end);
select pg_temp.rec('T4_deleted_owner', 'row_after_worker', pg_temp.st(:'t4w'));
select pg_temp.rec('T4_deleted_owner', 'bodies_left', (select count(*)::text from postona_threads_resv.reservations where id in (:'t4', :'t4w') and body is not null));

-- T5 the audit trail of a Threads cancel (X writes one audit row per cancel: x_matrix X2)
select pg_temp.rec('T5_cancel_audit', 'threads_audit_relations',
  (select coalesce(string_agg(c.relname, ','), '-') from pg_class c where c.relnamespace = 'postona_threads_resv'::regnamespace and c.relkind = 'r' and c.relname like '%audit%'));

-- T6 (prepared here, raced by run.sh) the person's cancel while the dispatcher's claim holds the row
select pg_temp.mk(66, 'T6') as t6 \gset
update postona_threads_resv.reservations set scheduled_at = now() + interval '1 day' where id = :'t6';
insert into t_ct.race values ('T6', :'t6', 66);

select pg_temp.rec('Z_threads_store', 'published_rows', (select count(*)::text from postona_threads_resv.reservations where status = 'published'));
select format('RESULT|%s|%s|%s', scenario, step, actual) from t_ct.results order by scenario, step;
select 'THREADS_CANCEL_RECEIPT_MATRIX_DONE';
