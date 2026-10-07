-- Behaviour proof of 20261007120000_market_report_generation_traces.sql on a disposable PostgreSQL.
-- Run by market_report_generation_traces_run.sh (roles anon / authenticated / service_role exist; the migration
-- is already applied). Every assertion raises on failure; ON_ERROR_STOP makes the runner fail.

\set ON_ERROR_STOP on

create or replace function pg_temp.expect_error(p_sql text, p_fragment text)
returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'EXPECTED_ERROR_NOT_RAISED: %', p_sql;
exception when others then
  if sqlerrm like 'EXPECTED_ERROR_NOT_RAISED%' or position(p_fragment in sqlerrm) = 0 then
    raise exception 'WRONG_ERROR for [%]: got [%] wanted [%]', p_sql, sqlerrm, p_fragment;
  end if;
end;
$$;

-- 1. service_role appends one row per generation, and a failed generation keeps its candidate.
set role service_role;
insert into public.market_report_generation_traces
  (report_type, trading_date, cycle_id, data_packet_id, invocation_id, attempt, generation_index, model, base_prompt_hash, request_hash,
   stage, hard_rejection, local_passed, local_issues, fact_ran, candidate, calls, input_tokens, output_tokens, api_cost_usd)
values
  ('morning', '2026-10-07', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
   '33333333-3333-4333-8333-333333333333', 1, 1, 'gpt-5.6-luna', '0123456789abcdef', 'aaaaaaaaaaaaaaaa',
   'local', 'local', false, '["TOPIXと書いている"]'::jsonb, false,
   '{"headline_ja":"日経平均とTOPIXがそろって上昇","x_post":{"points_ja":["a","b","c"]}}'::jsonb, 1, 1000, 400, 0.00123),
  ('morning', '2026-10-07', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
   '33333333-3333-4333-8333-333333333333', 1, 2, 'gpt-5.6-luna', '0123456789abcdef', 'bbbbbbbbbbbbbbbb',
   'fact', 'fact', true, '[]'::jsonb, true,
   '{"headline_ja":"第2世代"}'::jsonb, 3, 2000, 800, 0.0109);
-- Fact issues recorded on the second generation (an insert, not an update).
insert into public.market_report_generation_traces
  (report_type, trading_date, invocation_id, attempt, generation_index, stage, hard_rejection, fact_ran, fact_passed, fact_issues, candidate)
values ('morning', '2026-10-07', '44444444-4444-4444-8444-444444444444', 2, 1, 'fact', 'fact', true, false,
        '["「前回の引け以降に確認できたニュース」とする時間関係は入力で確認できません。"]'::jsonb, '{"headline_ja":"再試行の本文"}'::jsonb);
reset role;

-- 2. Two scheduled attempts of one cycle are distinguishable and both stay.
select count(*) as n, count(distinct invocation_id) as invocations, count(distinct attempt) as attempts
  from public.market_report_generation_traces where trading_date = '2026-10-07' \gset
select (:n = 3 and :invocations = 2 and :attempts = 2) as ok_attempts \gset
\if :ok_attempts
\else
  \echo 'FAIL: scheduled attempts are not distinguishable'
  select 1/0;
\endif

-- 3. The generated body is queryable after later generations / attempts.
select (candidate ->> 'headline_ja') = '日経平均とTOPIXがそろって上昇' as ok_body
  from public.market_report_generation_traces where generation_index = 1 and attempt = 1 \gset
\if :ok_body
\else
  \echo 'FAIL: first generation candidate not kept'
  select 1/0;
\endif

-- 4. Append-only: update, delete and truncate are refused, even for the superuser path through the table.
select pg_temp.expect_error($$update public.market_report_generation_traces set stage = 'delivered'$$, 'MARKET_REPORT_GENERATION_TRACE_IMMUTABLE');
select pg_temp.expect_error($$delete from public.market_report_generation_traces$$, 'MARKET_REPORT_GENERATION_TRACE_IMMUTABLE');
select pg_temp.expect_error($$truncate public.market_report_generation_traces$$, 'MARKET_REPORT_GENERATION_TRACE_IMMUTABLE');

-- 5. One row per (invocation, generation).
select pg_temp.expect_error(
  $$insert into public.market_report_generation_traces (report_type, trading_date, invocation_id, attempt, generation_index, stage)
    values ('morning', '2026-10-07', '33333333-3333-4333-8333-333333333333', 1, 1, 'local')$$,
  'market_report_generation_traces_invocation_generation_key');

-- 6. Shape checks reject malformed rows.
select pg_temp.expect_error($$insert into public.market_report_generation_traces (report_type, trading_date, invocation_id, attempt, generation_index, stage) values ('weekly', '2026-10-07', gen_random_uuid(), 1, 1, 'local')$$, 'report_type');
select pg_temp.expect_error($$insert into public.market_report_generation_traces (report_type, trading_date, invocation_id, attempt, generation_index, stage) values ('morning', '2026-10-07', gen_random_uuid(), 1, 1, 'bogus')$$, 'stage');
select pg_temp.expect_error($$insert into public.market_report_generation_traces (report_type, trading_date, invocation_id, attempt, generation_index, stage, source) values ('morning', '2026-10-07', gen_random_uuid(), 1, 1, 'local', 'x_post')$$, 'source');
select pg_temp.expect_error($$insert into public.market_report_generation_traces (report_type, trading_date, invocation_id, attempt, generation_index, stage, base_prompt_hash) values ('morning', '2026-10-07', gen_random_uuid(), 1, 1, 'local', 'not-a-hash')$$, 'base_prompt_hash');
select pg_temp.expect_error($$insert into public.market_report_generation_traces (report_type, trading_date, invocation_id, attempt, generation_index, stage, request_hash) values ('morning', '2026-10-07', gen_random_uuid(), 1, 1, 'local', 'ZZZZ')$$, 'request_hash');
-- Truncation is declared or absent, never half-declared.
select pg_temp.expect_error($$insert into public.market_report_generation_traces (report_type, trading_date, invocation_id, attempt, generation_index, stage, truncated) values ('morning', '2026-10-07', gen_random_uuid(), 1, 1, 'local', true)$$, 'truncation_consistent');
select pg_temp.expect_error($$insert into public.market_report_generation_traces (report_type, trading_date, invocation_id, attempt, generation_index, stage, truncation) values ('morning', '2026-10-07', gen_random_uuid(), 1, 1, 'local', '{"candidate":{}}'::jsonb)$$, 'truncation_consistent');
select pg_temp.expect_error($$insert into public.market_report_generation_traces (report_type, trading_date, invocation_id, attempt, generation_index, stage, local_issues) values ('morning', '2026-10-07', gen_random_uuid(), 1, 1, 'local', '{}'::jsonb)$$, 'local_issues');

-- 6b. Full retention: a long candidate, a long issue and 13 findings are stored whole and counted.
set role service_role;
insert into public.market_report_generation_traces
  (report_type, trading_date, invocation_id, attempt, generation_index, stage, candidate, candidate_chars, fact_issues, fact_issue_count, local_issues, local_issue_count)
values ('morning', '2026-10-07', '55555555-5555-4555-8555-555555555555', 1, 1, 'fact',
        jsonb_build_object('text', repeat('あ', 9000) || 'TAIL'), 9010,
        (select jsonb_agg('finding ' || g || repeat('い', 800)) from generate_series(1, 13) g), 13,
        jsonb_build_array(repeat('う', 800) || 'ISSUE-TAIL'), 1);
reset role;
select (candidate ->> 'text') like '%TAIL' and jsonb_array_length(fact_issues) = 13 and fact_issue_count = 13
       and (local_issues ->> 0) like '%ISSUE-TAIL' and not truncated as ok_full
  from public.market_report_generation_traces where invocation_id = '55555555-5555-4555-8555-555555555555' \gset
\if :ok_full
\else
  \echo 'FAIL: full retention'
  select 1/0;
\endif
-- A declared truncation is allowed and consistent.
set role service_role;
insert into public.market_report_generation_traces (report_type, trading_date, invocation_id, attempt, generation_index, stage, truncated, truncation)
values ('morning', '2026-10-07', gen_random_uuid(), 1, 1, 'fact', true, '{"candidate":{"reason":"field_bound","original_chars":300000,"kept_chars":200000}}'::jsonb);
reset role;

-- 7. A future personalized report fits the same table without a cycle or a packet.
set role service_role;
insert into public.market_report_generation_traces (source, subject_ref, report_type, trading_date, invocation_id, attempt, generation_index, stage, candidate)
values ('personalized_report', 'report-123', 'morning', '2026-10-07', gen_random_uuid(), 1, 1, 'delivered', '{"overview_ja":"個人向け本文"}'::jsonb);
reset role;

-- 8. No client read or write path: anon and authenticated are refused outright.
set role anon;
select pg_temp.expect_error($$select count(*) from public.market_report_generation_traces$$, 'permission denied');
select pg_temp.expect_error($$insert into public.market_report_generation_traces (report_type, trading_date, invocation_id, attempt, generation_index, stage) values ('morning', '2026-10-07', gen_random_uuid(), 1, 1, 'local')$$, 'permission denied');
reset role;
set role authenticated;
select pg_temp.expect_error($$select count(*) from public.market_report_generation_traces$$, 'permission denied');
reset role;

-- 9. service_role holds select + insert only: it cannot rewrite history (no update / delete / truncate grant;
--    the triggers of step 4 are the second lock, for any role that is ever granted more).
set role service_role;
select pg_temp.expect_error($$update public.market_report_generation_traces set candidate = '{}'::jsonb$$, 'permission denied');
select pg_temp.expect_error($$delete from public.market_report_generation_traces$$, 'permission denied');
select pg_temp.expect_error($$truncate public.market_report_generation_traces$$, 'permission denied');
reset role;

-- 10. RLS is on and there is no policy (the secret key bypasses RLS; nothing else gets a path).
select (relrowsecurity and not exists (select 1 from pg_policies where tablename = 'market_report_generation_traces')) as ok_rls
  from pg_class where oid = 'public.market_report_generation_traces'::regclass \gset
\if :ok_rls
\else
  \echo 'FAIL: RLS / policy posture'
  select 1/0;
\endif

\echo 'market_report_generation_traces behaviour: PASS'
