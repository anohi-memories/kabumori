-- FAIL-BEFORE (before 007): a Threads reservation has nowhere to go. Run by postona_threads_reservations_run.sh after the
-- baseline (001-006), the multi-provider stand-in, the test tables and people.sql -- and BEFORE 007. Every marker
-- means "the gap exists". Fake data only.
\ir ../../postona_x_oauth_t13_guard/helpers.sql
select user_id as u61, threads_account as th61, x_account as x61 from t_ids.people where n = 61 \gset
select pg_temp.session(:'u61') as s61 \gset

-- FB1: the X reservation / single-post API refuses a Threads account (X-only by design: assert_account_access).
select pg_temp.expect(pg_temp.as_person(format('select state from postona_x_resv.post_now_begin(%L, gen_random_uuid(), %L, %L)',
  :'th61', 'threads text', encode(sha256(convert_to('threads text', 'UTF8')), 'hex')), :'u61', :'s61', 'postona_resv_api') like 'ERR:%', 'FB1 refused');
select pg_temp.expect(pg_temp.as_person(format('select count(*)::text from postona_x_resv.list_reservations(%L)', :'th61'), :'u61', :'s61', 'postona_resv_api')
  = 'ERR:POSTONA_RESV_ACCOUNT_NOT_FOUND', 'FB1 list refused');
select 'FB1_GAP_X_RESERVATIONS_REFUSE_THREADS_ACCOUNTS' as result;

-- FB2: no Threads reservation store exists for the dispatcher (PR #334's ThreadsDispatchStore has nothing to call).
select pg_temp.expect(to_regnamespace('postona_threads_resv') is null
  and not exists (select 1 from pg_proc p where p.proname in ('claim_due', 'preflight', 'record') and p.pronamespace::regnamespace::text like '%threads%'), 'FB2');
select 'FB2_GAP_NO_THREADS_RESERVATION_STORE' as result;

-- FB3: the X dispatcher never sees a Threads account (its claim reads only postona_x_resv rows of X accounts).
select pg_temp.expect(not exists (select 1 from postona_x_resv.reservations r join public.social_accounts sa on sa.id = r.social_account_id where sa.platform = 'threads'), 'FB3');
select 'FB3_GAP_X_DISPATCHER_HAS_NO_THREADS_ROWS' as result;
select 'THREADS_FAIL_BEFORE_ALL_GAPS_CONFIRMED' as result;
