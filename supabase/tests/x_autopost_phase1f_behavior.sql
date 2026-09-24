-- Fake-only Phase1F behavior proof. Run by x_autopost_phase1f_run.sh after:
-- 1D fixture -> 1E fixture -> 1F fixture -> 1B -> 1D -> 1E -> 1F migrations.
\set ON_ERROR_STOP on
set timezone = 'UTC';

create function pg_temp.expect_error(p_sql text, p_expected text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'EXPECTED_ERROR_NOT_RAISED: % :: %', p_expected, p_sql;
exception when others then
  if sqlerrm like 'EXPECTED_ERROR_NOT_RAISED%' then raise; end if;
  if sqlerrm <> p_expected and sqlstate <> p_expected then
    raise exception 'WRONG_ERROR expected % got % (%) :: %', p_expected, sqlerrm, sqlstate, p_sql;
  end if;
end;
$$;

-- 0. ACL / security.
do $$
declare r record;
begin
  for r in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             'complete_interaction_post_v2', 'complete_useful_tip_post_v2', 'complete_report_post_v2',
             'record_post_x_rejected_v2', 'begin_provider_step_v2', 'finish_provider_step_v2',
             'x_v2_finish_confirmed_attempt', 'x_v2_complete_report_run',
             'x_v2_attempt_log_started', 'x_v2_attempt_log_finished')
  loop
    if not r.prosecdef or not ('search_path=""' = any(r.proconfig)) then
      raise exception 'security definer/search_path mismatch: %', r.proname;
    end if;
    if has_function_privilege('anon', r.oid, 'EXECUTE') or has_function_privilege('authenticated', r.oid, 'EXECUTE') then
      raise exception 'API role can execute %', r.proname;
    end if;
    if (r.proname like 'x\_v2\_%' escape '\') = has_function_privilege('service_role', r.oid, 'EXECUTE') then
      raise exception 'service_role ACL wrong for %', r.proname;
    end if;
  end loop;
  if has_function_privilege('service_role', 'public.complete_post_x_confirmed_v2(uuid,uuid,text)', 'EXECUTE') then
    raise exception 'effect-less generic completion still callable';
  end if;
  if has_table_privilege('service_role', 'public.post_provider_steps_v2', 'INSERT')
     or has_table_privilege('service_role', 'public.post_provider_steps_v2', 'UPDATE')
     or has_table_privilege('authenticated', 'public.post_provider_steps_v2', 'SELECT') then
    raise exception 'provider step table ACL too wide';
  end if;
  if has_table_privilege('service_role', 'public.post_queue_attempts_v2', 'UPDATE')
     or has_table_privilege('service_role', 'public.post_queue_attempts_v2', 'INSERT')
     or has_table_privilege('service_role', 'public.post_queue_account_turns_v2', 'UPDATE')
     or not has_table_privilege('service_role', 'public.post_queue_attempts_v2', 'SELECT') then
    raise exception 'v2 ledger writable by service_role';
  end if;
end $$;

revoke execute on function public.claim_due_post() from service_role;  -- Phase1D activation gate
set role service_role;

-- 1. Seed and claim bound posts for two accounts.
create temporary table plan (label text, brand text, account text, post_type text, slot smallint);
insert into plan values
  ('a_interaction', 'brand_a', 'acct_a', 'interaction', 1),
  ('a_useful', 'brand_a', 'acct_a', 'useful_tip', 2),
  ('a_morning', 'brand_a', 'acct_a', 'morning_report', 3),
  ('a_close', 'brand_a', 'acct_a', 'close_report', 4),
  ('a_us', 'brand_a', 'acct_a', 'us_premarket_report', 5),
  ('a_tip', 'brand_a', 'acct_a', 'tip', 6),
  ('a_greeting', 'brand_a', 'acct_a', 'morning_greeting', 7),
  ('a_rejected', 'brand_a', 'acct_a', 'interaction', 8),
  ('a_uncertain', 'brand_a', 'acct_a', 'useful_tip', 9),
  ('a_prex', 'brand_a', 'acct_a', 'close_report', 10),
  ('b_interaction', 'brand_b', 'acct_b', 'interaction', 1),
  ('b_close', 'brand_b', 'acct_b', 'close_report', 2);
select public.schedule_account_bound_post_v2(p.brand, p.account, current_date, p.post_type, p.slot,
  now() - interval '1 hour' - p.slot * interval '1 minute') from plan p;
insert into public.scheduled_posts (brand_id, schedule_date, post_type, slot_no, scheduled_for)
values ('brand_a', current_date, 'interaction', 50, now() - interval '2 hours');  -- legacy/unbound

create temporary table claims (label text primary key, attempt_id uuid, claim_token uuid,
  account text, brand text, post_id uuid, post_type text);
do $$
declare r record; n integer := 0;
begin
  loop
    select * into r from public.claim_due_post_v2();
    exit when r.scheduled_post_id is null;
    insert into claims select p.label, r.attempt_id, r.claim_token, r.social_account_id, r.brand_id,
      r.scheduled_post_id, r.post_type
    from plan p join public.scheduled_posts s on s.brand_id = p.brand and s.post_type = p.post_type
      and s.slot_no = p.slot and s.schedule_date = current_date
    where s.id = r.scheduled_post_id;
    n := n + 1;
  end loop;
  if n <> 12 or (select count(*) from claims) <> 12 then raise exception 'setup: expected 12 v2 claims, got %', n; end if;
  if exists (select 1 from claims c join public.scheduled_posts s on s.id = c.post_id where s.social_account_id is null) then
    raise exception 'setup: unbound row claimed by v2';
  end if;
end $$;
create function pg_temp.c(p_label text) returns claims language sql as $$ select * from claims where label = p_label $$;

-- 2. Started log per v2 claim (legacy-shaped observability).
do $$ begin
  if (select count(*) from public.post_execution_logs l join claims c on c.post_id = l.scheduled_post_id
      where l.status = 'started' and l.message like 'Scheduled post claimed (v2 attempt 1)') <> 12 then
    raise exception 'v2 started logs missing';
  end if;
end $$;

-- Report runs linked to their posts; a foreign run linked to b_close.
reset role;
insert into public.morning_report_runs (id, scheduled_post_id, generated_at, source_urls, model_used, input_tokens, output_tokens, api_cost_usd, status)
select '00000000-0000-4000-8000-0000000000e1', post_id, now(), '["https://m"]', 'model-m', 10, 20, 0.5, 'generating' from claims where label = 'a_morning';
insert into public.close_report_runs (id, scheduled_post_id, generated_at, source_urls, model_used, input_tokens, output_tokens, api_cost_usd, status)
select '00000000-0000-4000-8000-0000000000e2', post_id, now(), '["https://c"]', 'model-c', 11, 21, 0.6, 'generating' from claims where label = 'a_close';
insert into public.us_premarket_report_runs (id, scheduled_post_id, generated_at, source_urls, model_used, input_tokens, output_tokens, api_cost_usd, status)
select '00000000-0000-4000-8000-0000000000e3', post_id, now(), '["https://u"]', 'model-u', 12, 22, 0.7, 'generating' from claims where label = 'a_us';
insert into public.close_report_runs (id, scheduled_post_id, model_used, status)
select '00000000-0000-4000-8000-0000000000e4', post_id, 'model-b', 'generating' from claims where label = 'b_close';
set role service_role;

select public.mark_post_provider_started_v2(attempt_id, claim_token) from claims
where label in ('a_interaction', 'a_useful', 'a_morning', 'a_close', 'a_us', 'a_tip', 'a_greeting',
                'a_rejected', 'a_uncertain', 'b_interaction', 'b_close');

-- 3. Interaction: atomic completion + exact-once.
do $$
declare c claims := pg_temp.c('a_interaction');
begin
  if public.complete_interaction_post_v2(c.attempt_id, c.claim_token, 'acct_a', 'brand_a', 'x_int_1',
       '00000000-0000-4000-8000-0000000000c1') <> 'completed' then raise exception 'interaction not completed'; end if;
  if (select status from public.scheduled_posts where id = c.post_id) <> 'succeeded'
     or (select outcome || ':' || x_post_id from public.post_queue_attempts_v2 where id = c.attempt_id) <> 'completed:x_int_1'
     or (select use_count from public.interaction_topics where id = '00000000-0000-4000-8000-0000000000c1') <> 1
     or (select count(*) from public.interaction_post_metrics where x_post_id = 'x_int_1' and scheduled_post_id = c.post_id) <> 1
     or (select count(*) from public.post_execution_logs where scheduled_post_id = c.post_id and status = 'succeeded'
         and x_post_id = 'x_int_1' and message = 'Interaction X post created; topic=00000000-0000-4000-8000-0000000000c1') <> 1 then
    raise exception 'interaction completion effects wrong';
  end if;
  -- Duplicate: no second counter/log/metric.
  if public.complete_interaction_post_v2(c.attempt_id, c.claim_token, 'acct_a', 'brand_a', 'x_int_1',
       '00000000-0000-4000-8000-0000000000c1') <> 'already_completed' then raise exception 'duplicate not idempotent'; end if;
  if (select use_count from public.interaction_topics where id = '00000000-0000-4000-8000-0000000000c1') <> 1
     or (select count(*) from public.post_execution_logs where scheduled_post_id = c.post_id and status = 'succeeded') <> 1
     or (select count(*) from public.interaction_post_metrics where scheduled_post_id = c.post_id) <> 1 then
    raise exception 'duplicate completion duplicated side effects';
  end if;
  perform pg_temp.expect_error(format('select public.complete_interaction_post_v2(%L,%L,%L,%L,%L,%L)',
    c.attempt_id, c.claim_token, 'acct_a', 'brand_a', 'x_other', '00000000-0000-4000-8000-0000000000c1'), 'X_COMPLETION_CONFLICT');
end $$;

-- 4. Forced side-effect failure rolls everything back; confirmed-incomplete is
--    non-reclaimable and later completes exactly once.
reset role;
insert into public.interaction_post_metrics (scheduled_post_id, interaction_topic_id, x_post_id)
select post_id, '00000000-0000-4000-8000-0000000000c2', 'x_int_b' from claims where label = 'a_interaction';
set role service_role;
do $$
declare c claims := pg_temp.c('b_interaction');
        v_logs integer := (select count(*) from public.post_execution_logs);
begin
  perform pg_temp.expect_error(format('select public.complete_interaction_post_v2(%L,%L,%L,%L,%L,%L)',
    c.attempt_id, c.claim_token, 'acct_b', 'brand_b', 'x_int_b', '00000000-0000-4000-8000-0000000000c2'), '23505');
  if (select status from public.scheduled_posts where id = c.post_id) <> 'running'
     or (select phase || ':' || coalesce(outcome, '-') from public.post_queue_attempts_v2 where id = c.attempt_id) <> 'provider_started:-'
     or (select use_count from public.interaction_topics where id = '00000000-0000-4000-8000-0000000000c2') <> 0
     or (select count(*) from public.post_execution_logs) <> v_logs then
    raise exception 'failed completion was not fully rolled back';
  end if;
  perform public.record_post_x_confirmed_incomplete_v2(c.attempt_id, c.claim_token, 'x_int_b', 'FAKE_METRICS_CONFLICT');
  if exists (select 1 from public.claim_due_post_v2()) or public.reconcile_stale_pre_x_v2() <> 0 then
    raise exception 'confirmed-incomplete row became reclaimable';
  end if;
  if (select count(*) from public.post_execution_logs where scheduled_post_id = c.post_id and status = 'failed'
      and x_post_id = 'x_int_b' and message = 'X_CONFIRMED_DB_INCOMPLETE:FAKE_METRICS_CONFLICT') <> 1 then
    raise exception 'confirmed-incomplete failed log missing';
  end if;
end $$;
reset role;
delete from public.interaction_post_metrics where x_post_id = 'x_int_b';
set role service_role;
do $$
declare c claims := pg_temp.c('b_interaction');
begin
  perform pg_temp.expect_error(format('select public.complete_interaction_post_v2(%L,%L,%L,%L,%L,%L)',
    c.attempt_id, c.claim_token, 'acct_b', 'brand_b', 'x_different', '00000000-0000-4000-8000-0000000000c2'), 'X_COMPLETION_CONFLICT');
  if public.complete_interaction_post_v2(c.attempt_id, c.claim_token, 'acct_b', 'brand_b', 'x_int_b',
       '00000000-0000-4000-8000-0000000000c2') <> 'completed' then raise exception 'recovery completion failed'; end if;
  if (select status from public.scheduled_posts where id = c.post_id) <> 'succeeded'
     or (select use_count from public.interaction_topics where id = '00000000-0000-4000-8000-0000000000c2') <> 1
     or (select count(*) from public.post_execution_logs where scheduled_post_id = c.post_id and status = 'succeeded') <> 1 then
    raise exception 'recovery completion effects wrong';
  end if;
end $$;

-- 5. Useful tip and the three report types.
do $$
declare c claims;
begin
  c := pg_temp.c('a_useful');
  if public.complete_useful_tip_post_v2(c.attempt_id, c.claim_token, 'acct_a', 'brand_a', 'x_useful',
       '00000000-0000-4000-8000-0000000000d1', '["https://s"]'::jsonb, 'model-t', true, 1, 2, 0.25) <> 'completed' then
    raise exception 'useful tip not completed'; end if;
  if (select use_count from public.useful_tips) <> 1
     or (select count(*) from public.post_execution_logs where scheduled_post_id = c.post_id and status = 'succeeded'
         and useful_tip_id = '00000000-0000-4000-8000-0000000000d1' and model_used = 'model-t' and escalated_to_sol
         and input_tokens = 1 and output_tokens = 2 and api_cost_usd = 0.25 and verified_at is not null
         and message = 'Verified useful tip posted') <> 1 then
    raise exception 'useful tip effects wrong';
  end if;

  c := pg_temp.c('a_close');
  -- A run that belongs to another post is refused and nothing commits.
  perform pg_temp.expect_error(format('select public.complete_report_post_v2(%L,%L,%L,%L,%L,%L,%L)',
    c.attempt_id, c.claim_token, 'acct_a', 'brand_a', 'close_report', 'x_close', '00000000-0000-4000-8000-0000000000e4'),
    'X_COMPLETION_RUN_POST_MISMATCH');
  perform pg_temp.expect_error(format('select public.complete_report_post_v2(%L,%L,%L,%L,%L,%L,%L)',
    c.attempt_id, c.claim_token, 'acct_a', 'brand_a', 'close_report', 'x_close', gen_random_uuid()),
    'CLOSE_REPORT_RUN_NOT_FOUND');
  if (select status from public.scheduled_posts where id = c.post_id) <> 'running'
     or (select status from public.close_report_runs where id = '00000000-0000-4000-8000-0000000000e4') <> 'generating' then
    raise exception 'report mismatch was not rolled back';
  end if;
  if public.complete_report_post_v2(c.attempt_id, c.claim_token, 'acct_a', 'brand_a', 'close_report', 'x_close',
       '00000000-0000-4000-8000-0000000000e2') <> 'completed' then raise exception 'close not completed'; end if;

  c := pg_temp.c('a_morning');
  perform pg_temp.expect_error(format('select public.complete_report_post_v2(%L,%L,%L,%L,%L,%L,%L)',
    c.attempt_id, c.claim_token, 'acct_a', 'brand_a', 'close_report', 'x_m', '00000000-0000-4000-8000-0000000000e1'),
    'X_COMPLETION_POST_TYPE_MISMATCH');
  perform public.complete_report_post_v2(c.attempt_id, c.claim_token, 'acct_a', 'brand_a', 'morning_report', 'x_morning',
    '00000000-0000-4000-8000-0000000000e1');
  c := pg_temp.c('a_us');
  perform public.complete_report_post_v2(c.attempt_id, c.claim_token, 'acct_a', 'brand_a', 'us_premarket_report', 'x_us',
    '00000000-0000-4000-8000-0000000000e3');

  if (select count(*) from public.post_execution_logs l join claims c2 on c2.post_id = l.scheduled_post_id
      where l.status = 'succeeded' and (
        (c2.label = 'a_morning' and l.message = 'Morning report posted' and l.model_used = 'model-m' and l.x_post_id = 'x_morning'
           and l.input_tokens = 10 and l.api_cost_usd = 0.5 and l.source_urls = '["https://m"]')
     or (c2.label = 'a_close' and l.message = 'Close report posted' and l.model_used = 'model-c' and l.x_post_id = 'x_close')
     or (c2.label = 'a_us' and l.message = 'US premarket report posted' and l.model_used = 'model-u' and l.x_post_id = 'x_us'))) <> 3
  or (select count(*) from (
        select status, x_post_id, error from public.morning_report_runs where id = '00000000-0000-4000-8000-0000000000e1'
        union all select status, x_post_id, error from public.close_report_runs where id = '00000000-0000-4000-8000-0000000000e2'
        union all select status, x_post_id, error from public.us_premarket_report_runs where id = '00000000-0000-4000-8000-0000000000e3') r
      where r.status = 'succeeded' and r.x_post_id like 'x_%' and r.error is null) <> 3 then
    raise exception 'report completion effects wrong';
  end if;
end $$;

-- 6. Identity checks: wrong token, wrong/cross account, pre-X attempt, legacy row.
do $$
declare c claims := pg_temp.c('b_close');
        p claims := pg_temp.c('a_prex');
begin
  perform pg_temp.expect_error(format('select public.complete_report_post_v2(%L,%L,%L,%L,%L,%L,%L)',
    c.attempt_id, gen_random_uuid(), 'acct_b', 'brand_b', 'close_report', 'x_b', '00000000-0000-4000-8000-0000000000e4'),
    'X_COMPLETION_CLAIM_INVALID');
  perform pg_temp.expect_error(format('select public.complete_report_post_v2(%L,%L,%L,%L,%L,%L,%L)',
    c.attempt_id, c.claim_token, 'acct_a', 'brand_a', 'close_report', 'x_b', '00000000-0000-4000-8000-0000000000e4'),
    'X_COMPLETION_ACCOUNT_MISMATCH');
  perform pg_temp.expect_error(format('select public.complete_report_post_v2(%L,%L,%L,%L,%L,%L,%L)',
    c.attempt_id, c.claim_token, 'acct_b', 'brand_a', 'close_report', 'x_b', '00000000-0000-4000-8000-0000000000e4'),
    'X_COMPLETION_ACCOUNT_MISMATCH');
  perform pg_temp.expect_error(format('select public.complete_report_post_v2(%L,%L,%L,%L,%L,%L,%L)',
    p.attempt_id, p.claim_token, 'acct_a', 'brand_a', 'close_report', 'x_p', gen_random_uuid()),
    'ATTEMPT_NOT_CONFIRMABLE');
  perform pg_temp.expect_error(format('select public.complete_interaction_post_v2(%L,%L,%L,%L,%L,%L)',
    gen_random_uuid(), gen_random_uuid(), 'acct_a', 'brand_a', 'x_legacy', '00000000-0000-4000-8000-0000000000c1'),
    'X_COMPLETION_CLAIM_INVALID');
  perform pg_temp.expect_error($q$select public.complete_post_x_confirmed_v2(gen_random_uuid(), gen_random_uuid(), 'x')$q$, '42501');
  perform pg_temp.expect_error($q$select public.x_v2_finish_confirmed_attempt(gen_random_uuid(), gen_random_uuid(), 'a', 'b', 'tip', 'x')$q$, '42501');
  if (select status from public.scheduled_posts where brand_id = 'brand_a' and slot_no = 50) <> 'pending' then
    raise exception 'legacy row touched';
  end if;
end $$;

-- 7. x_rejected is durable, terminal, logged, and non-reclaimable; uncertain too.
do $$
declare r claims := pg_temp.c('a_rejected');
        u claims := pg_temp.c('a_uncertain');
        p claims := pg_temp.c('a_prex');
begin
  perform pg_temp.expect_error(format('select public.record_post_x_rejected_v2(%L,%L,%L)', p.attempt_id, p.claim_token, 'X_CREATE_REJECTED_403'),
    'ATTEMPT_NOT_PROVIDER_STARTED');
  perform pg_temp.expect_error(format('select public.record_post_x_rejected_v2(%L,%L,%L)', r.attempt_id, r.claim_token, 'bad code'),
    'INVALID_ERROR_CODE');
  perform public.record_post_x_rejected_v2(r.attempt_id, r.claim_token, 'X_CREATE_REJECTED_403');
  perform public.record_post_x_uncertain_v2(u.attempt_id, u.claim_token, 'X_CREATE_NETWORK_UNCERTAIN');
  if (select phase || ':' || outcome || ':' || error_code from public.post_queue_attempts_v2 where id = r.attempt_id)
       <> 'finished:x_rejected:X_CREATE_REJECTED_403'
     or (select x_post_id from public.post_queue_attempts_v2 where id = r.attempt_id) is not null
     or (select status from public.scheduled_posts where id = r.post_id) <> 'failed' then
    raise exception 'x_rejected not durable';
  end if;
  if exists (select 1 from public.claim_due_post_v2()) or public.reconcile_stale_pre_x_v2() <> 0 then
    raise exception 'rejected/uncertain became reclaimable';
  end if;
  perform pg_temp.expect_error(format('select public.record_post_x_rejected_v2(%L,%L,%L)', r.attempt_id, r.claim_token, 'X_CREATE_REJECTED_403'),
    'ATTEMPT_NOT_PROVIDER_STARTED');
  perform pg_temp.expect_error(format('select public.complete_interaction_post_v2(%L,%L,%L,%L,%L,%L)',
    r.attempt_id, r.claim_token, 'acct_a', 'brand_a', 'x_late', '00000000-0000-4000-8000-0000000000c1'), 'ATTEMPT_NOT_CONFIRMABLE');
  perform pg_temp.expect_error(format('select public.complete_useful_tip_post_v2(%L,%L,%L,%L,%L,%L,null,null,null,null,null,null)',
    u.attempt_id, u.claim_token, 'acct_a', 'brand_a', 'x_late', '00000000-0000-4000-8000-0000000000d1'), 'ATTEMPT_NOT_CONFIRMABLE');
  perform pg_temp.expect_error(format('select public.settle_post_pre_x_v2(%L,%L,true,%L)', r.attempt_id, r.claim_token, 'X_FAKE'),
    'ATTEMPT_NOT_PRE_X');
  if (select count(*) from public.post_execution_logs l where l.status = 'failed' and (
        (l.scheduled_post_id = r.post_id and l.message = 'X_REJECTED:X_CREATE_REJECTED_403' and l.error_code = 'X_CREATE_REJECTED_403')
     or (l.scheduled_post_id = u.post_id and l.message = 'X_OUTCOME_UNCERTAIN:X_CREATE_NETWORK_UNCERTAIN'))) <> 2 then
    raise exception 'rejected/uncertain failed logs missing';
  end if;
  begin
    reset role;
    update public.post_queue_attempts_v2 set outcome = 'x_rejected', x_post_id = 'x_forged' where id = r.attempt_id;
    raise exception 'x_rejected with an X post id was accepted';
  exception when check_violation then null;
  end;
  set role service_role;
end $$;
set role service_role;

-- 8. Multi-request provider-step foundation (tip thread, greeting media+create).
do $$
declare t claims := pg_temp.c('a_tip');
        g claims := pg_temp.c('a_greeting');
        p claims := pg_temp.c('a_prex');
begin
  perform pg_temp.expect_error(format('select public.begin_provider_step_v2(%L,%L,1::smallint,%L)', p.attempt_id, p.claim_token, 'create_post'),
    'ATTEMPT_NOT_PROVIDER_STARTED');
  perform pg_temp.expect_error(format('select public.begin_provider_step_v2(%L,%L,1::smallint,%L)', t.attempt_id, gen_random_uuid(), 'create_post'),
    'ATTEMPT_NOT_PROVIDER_STARTED');
  perform pg_temp.expect_error(format('select public.begin_provider_step_v2(%L,%L,2::smallint,%L)', t.attempt_id, t.claim_token, 'create_post'),
    'PROVIDER_STEP_OUT_OF_ORDER');
  perform public.begin_provider_step_v2(t.attempt_id, t.claim_token, 1::smallint, 'create_post');
  perform pg_temp.expect_error(format('select public.begin_provider_step_v2(%L,%L,1::smallint,%L)', t.attempt_id, t.claim_token, 'create_post'),
    'PROVIDER_STEP_ALREADY_STARTED');
  perform pg_temp.expect_error(format('select public.begin_provider_step_v2(%L,%L,2::smallint,%L,%L)', t.attempt_id, t.claim_token, 'create_reply', 't1'),
    'PROVIDER_STEP_PREVIOUS_NOT_CONFIRMED');
  if public.finish_provider_step_v2(t.attempt_id, t.claim_token, 1::smallint, 'provider_object_confirmed', 't1', null) <> 'finished'
     or public.finish_provider_step_v2(t.attempt_id, t.claim_token, 1::smallint, 'provider_object_confirmed', 't1', null) <> 'already_finished' then
    raise exception 'step finish not idempotent';
  end if;
  perform pg_temp.expect_error(format('select public.finish_provider_step_v2(%L,%L,1::smallint,%L,%L,null)', t.attempt_id, t.claim_token,
    'provider_object_confirmed', 't_other'), 'PROVIDER_STEP_CONFLICT');
  perform pg_temp.expect_error(format('select public.begin_provider_step_v2(%L,%L,2::smallint,%L,%L)', t.attempt_id, t.claim_token, 'create_reply', 'wrong'),
    'PROVIDER_STEP_PARENT_MISMATCH');
  perform public.begin_provider_step_v2(t.attempt_id, t.claim_token, 2::smallint, 'create_reply', 't1');
  perform public.finish_provider_step_v2(t.attempt_id, t.claim_token, 2::smallint, 'x_outcome_uncertain', null, 'X_CREATE_NETWORK_UNCERTAIN');
  perform pg_temp.expect_error(format('select public.begin_provider_step_v2(%L,%L,3::smallint,%L,%L)', t.attempt_id, t.claim_token, 'create_reply', 't1'),
    'PROVIDER_STEP_PREVIOUS_NOT_CONFIRMED');
  -- Greeting: media upload then create, each its own step.
  perform public.begin_provider_step_v2(g.attempt_id, g.claim_token, 1::smallint, 'media_upload');
  perform public.finish_provider_step_v2(g.attempt_id, g.claim_token, 1::smallint, 'provider_object_confirmed', 'media_1', null);
  perform public.begin_provider_step_v2(g.attempt_id, g.claim_token, 2::smallint, 'create_post');
  perform public.finish_provider_step_v2(g.attempt_id, g.claim_token, 2::smallint, 'x_outcome_uncertain', null, 'X_CREATE_HTTP_503');
  if (select string_agg(step_no || step_kind || ':' || outcome || ':' || coalesce(provider_object_id, '-'), ',' order by step_no)
      from public.post_provider_steps_v2 where attempt_id = t.attempt_id)
     <> '1create_post:provider_object_confirmed:t1,2create_reply:x_outcome_uncertain:-' then
    raise exception 'tip step ledger wrong';
  end if;
  -- tip / morning_greeting have no v2 completion: every typed completion refuses them.
  perform pg_temp.expect_error(format('select public.complete_interaction_post_v2(%L,%L,%L,%L,%L,%L)',
    t.attempt_id, t.claim_token, 'acct_a', 'brand_a', 't1', '00000000-0000-4000-8000-0000000000c1'), 'X_COMPLETION_POST_TYPE_MISMATCH');
  perform pg_temp.expect_error(format('select public.complete_report_post_v2(%L,%L,%L,%L,%L,%L,%L)',
    g.attempt_id, g.claim_token, 'acct_a', 'brand_a', 'morning_greeting', 'x', gen_random_uuid()), 'X_COMPLETION_POST_TYPE_MISMATCH');
  if (select status from public.scheduled_posts where id = t.post_id) <> 'running' then raise exception 'tip changed'; end if;
end $$;

-- 9. Domain restored; legacy rows untouched; API roles denied.
do $$ begin
  if coalesce(current_setting('kabumori.x_queue_domain', true), '') <> '' then raise exception 'domain leaked'; end if;
end $$;
reset role;
set role authenticated;
do $$ begin
  perform pg_temp.expect_error($q$select public.complete_interaction_post_v2(gen_random_uuid(), gen_random_uuid(), 'a', 'b', 'x', gen_random_uuid())$q$, '42501');
  perform pg_temp.expect_error($q$select public.record_post_x_rejected_v2(gen_random_uuid(), gen_random_uuid(), 'X')$q$, '42501');
end $$;
reset role;

select 'PHASE1F_BEHAVIOR_PASS' as result;
