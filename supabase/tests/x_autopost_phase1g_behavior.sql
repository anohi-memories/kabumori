-- Fake-only Phase1G behavior proof. Run by x_autopost_phase1g_run.sh after:
-- 1D/1E/1F/1G fixtures -> 1B -> 1D -> 1E -> 1F -> 1G migrations.
\set ON_ERROR_STOP on
set timezone = 'Asia/Tokyo';

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

-- 0. ACL.
do $$
declare r record;
begin
  for r in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             'acquire_greeting_publish_claim_v2', 'plan_provider_steps_v2', 'begin_planned_provider_step_v2',
             'complete_tip_post_v2', 'complete_morning_greeting_post_v2', 'x_v2_confirmed_thread_root',
             'x_v2_multistep_attempt_guard', 'x_v2_greeting_claim_on_finish')
  loop
    if not r.prosecdef or not ('search_path=""' = any(r.proconfig)) then raise exception 'secdef/search_path: %', r.proname; end if;
    if has_function_privilege('anon', r.oid, 'EXECUTE') or has_function_privilege('authenticated', r.oid, 'EXECUTE') then
      raise exception 'API role can execute %', r.proname;
    end if;
    if (r.proname like 'x\_v2\_%' escape '\') = has_function_privilege('service_role', r.oid, 'EXECUTE') then
      raise exception 'service_role ACL wrong for %', r.proname;
    end if;
  end loop;
  if has_function_privilege('service_role', 'public.begin_provider_step_v2(uuid,uuid,smallint,text,text)', 'EXECUTE') then
    raise exception 'unplanned step entry still callable';
  end if;
  if has_table_privilege('service_role', 'public.post_provider_step_plans_v2', 'INSERT')
     or not has_table_privilege('service_role', 'public.post_provider_step_plans_v2', 'SELECT') then
    raise exception 'plan table ACL wrong';
  end if;
end $$;

revoke execute on function public.claim_due_post() from service_role;  -- Phase1D activation gate
insert into public.publish_claims (brand_id, post_type, date_jst, execution_id, status, x_post_id, published_at)
values ('brand_g_pub', 'morning_greeting', current_date, 'legacy-exec', 'published', 'x_legacy', now());
insert into public.scheduled_posts (brand_id, schedule_date, post_type, slot_no, scheduled_for)
values ('brand_a', current_date, 'tip', 50, now() - interval '2 hours');  -- legacy/unbound
set role service_role;

-- 1. Seed and claim.
create temporary table plan (label text, post_type text, slot smallint, day integer, brand text, account text);
insert into plan values
  ('t2', 'tip', 1, 0, 'brand_a', 'acct_a'), ('t3', 'tip', 2, 0, 'brand_a', 'acct_a'),
  ('t_parent', 'tip', 3, 0, 'brand_a', 'acct_a'), ('t_gap', 'tip', 4, 0, 'brand_a', 'acct_a'),
  ('t_unc', 'tip', 5, 0, 'brand_a', 'acct_a'), ('t_rej', 'tip', 6, 0, 'brand_a', 'acct_a'),
  ('t_fail', 'tip', 7, 0, 'brand_a', 'acct_a'), ('t_noplan', 'tip', 9, 0, 'brand_a', 'acct_a'),
  ('g_ok', 'morning_greeting', 1, 0, 'brand_a', 'acct_a'),
  ('g_order', 'morning_greeting', 1, 0, 'brand_g_order', 'acct_brand_g_order'),
  ('g_mis', 'morning_greeting', 1, 0, 'brand_g_mis', 'acct_brand_g_mis'),
  ('g_unc', 'morning_greeting', 1, 0, 'brand_g_unc', 'acct_brand_g_unc'),
  ('g_fail', 'morning_greeting', 1, 0, 'brand_g_fail', 'acct_brand_g_fail'),
  ('g_comp', 'morning_greeting', 1, 0, 'brand_g_comp', 'acct_brand_g_comp'),
  ('g_pub', 'morning_greeting', 1, 0, 'brand_g_pub', 'acct_brand_g_pub'),
  ('g_stale', 'morning_greeting', 1, 1, 'brand_g_stale', 'acct_brand_g_stale');
select public.schedule_account_bound_post_v2(p.brand, p.account, current_date - p.day, p.post_type, p.slot,
  now() - interval '1 hour' - p.slot * interval '1 second' - p.day * interval '1 minute') from plan p;
create temporary table claims (label text primary key, attempt_id uuid, claim_token uuid, post_id uuid);
do $$
declare r record; n integer := 0;
begin
  loop
    select * into r from public.claim_due_post_v2();
    exit when r.scheduled_post_id is null;
    insert into claims select p.label, r.attempt_id, r.claim_token, r.scheduled_post_id
    from plan p join public.scheduled_posts s on s.post_type = p.post_type and s.slot_no = p.slot
      and s.schedule_date = current_date - p.day and s.brand_id = p.brand
    where s.id = r.scheduled_post_id;
    n := n + 1;
  end loop;
  if n <> 16 or (select count(*) from claims) <> 16 then raise exception 'setup: 16 claims expected, got %', n; end if;
end $$;
create function pg_temp.c(p_label text) returns claims language sql as $$ select * from claims where label = p_label $$;
create function pg_temp.q(p_fmt text, p_label text, variadic p_args text[] default '{}') returns text language sql as $$
  select format(p_fmt, variadic array[(pg_temp.c(p_label)).attempt_id::text, (pg_temp.c(p_label)).claim_token::text] || p_args)
$$;

-- 2. Plans are fixed before provider start; greeting plans need the day claim.
do $$
begin
  perform public.plan_provider_steps_v2((pg_temp.c('t2')).attempt_id, (pg_temp.c('t2')).claim_token, 'tip_thread', 2::smallint);
  if public.plan_provider_steps_v2((pg_temp.c('t2')).attempt_id, (pg_temp.c('t2')).claim_token, 'tip_thread', 2::smallint) <> 'already_planned' then
    raise exception 'plan not idempotent'; end if;
  perform pg_temp.expect_error(pg_temp.q('select public.plan_provider_steps_v2(%L,%L,%L,3::smallint)', 't2', 'tip_thread'), 'PROVIDER_STEP_PLAN_CONFLICT');
  perform pg_temp.expect_error(pg_temp.q('select public.plan_provider_steps_v2(%L,%L,%L,4::smallint)', 't3', 'tip_thread'), 'PROVIDER_STEP_PLAN_INVALID');
  perform pg_temp.expect_error(pg_temp.q('select public.plan_provider_steps_v2(%L,%L,%L,2::smallint)', 't3', 'morning_greeting_media_post'), 'X_COMPLETION_POST_TYPE_MISMATCH');
  perform pg_temp.expect_error(pg_temp.q('select public.plan_provider_steps_v2(%L,%L,%L,2::smallint)', 'g_ok', 'morning_greeting_media_post'), 'GREETING_PUBLISH_CLAIM_NOT_HELD');
  perform pg_temp.expect_error(format('select public.plan_provider_steps_v2(%L,gen_random_uuid(),%L,2::smallint)', (pg_temp.c('t3')).attempt_id, 'tip_thread'), 'X_COMPLETION_CLAIM_INVALID');
  perform public.plan_provider_steps_v2((pg_temp.c('t3')).attempt_id, (pg_temp.c('t3')).claim_token, 'tip_thread', 3::smallint);
  perform public.plan_provider_steps_v2((pg_temp.c('t_parent')).attempt_id, (pg_temp.c('t_parent')).claim_token, 'tip_thread', 2::smallint);
  perform public.plan_provider_steps_v2((pg_temp.c('t_gap')).attempt_id, (pg_temp.c('t_gap')).claim_token, 'tip_thread', 3::smallint);
  perform public.plan_provider_steps_v2((pg_temp.c('t_unc')).attempt_id, (pg_temp.c('t_unc')).claim_token, 'tip_thread', 3::smallint);
  perform public.plan_provider_steps_v2((pg_temp.c('t_rej')).attempt_id, (pg_temp.c('t_rej')).claim_token, 'tip_thread', 2::smallint);
  perform public.plan_provider_steps_v2((pg_temp.c('t_fail')).attempt_id, (pg_temp.c('t_fail')).claim_token, 'tip_thread', 1::smallint);
  -- greeting day claims
  if public.acquire_greeting_publish_claim_v2((pg_temp.c('g_ok')).attempt_id, (pg_temp.c('g_ok')).claim_token) <> 'claimed'
     or public.acquire_greeting_publish_claim_v2((pg_temp.c('g_ok')).attempt_id, (pg_temp.c('g_ok')).claim_token) <> 'claimed' then
    raise exception 'greeting claim not idempotent for its owner'; end if;
  perform pg_temp.expect_error(pg_temp.q('select public.acquire_greeting_publish_claim_v2(%L,%L)', 'g_pub'), 'GREETING_ALREADY_PUBLISHED');
  perform pg_temp.expect_error(pg_temp.q('select public.acquire_greeting_publish_claim_v2(%L,%L)', 'g_stale'), 'GREETING_SCHEDULE_DATE_STALE');
  perform pg_temp.expect_error(pg_temp.q('select public.acquire_greeting_publish_claim_v2(%L,%L)', 't3'), 'X_COMPLETION_POST_TYPE_MISMATCH');
  perform public.acquire_greeting_publish_claim_v2(c.attempt_id, c.claim_token) from claims c where c.label in ('g_order', 'g_mis', 'g_unc', 'g_fail', 'g_comp');
  perform public.plan_provider_steps_v2(c.attempt_id, c.claim_token, 'morning_greeting_media_post', 2::smallint)
  from claims c where c.label in ('g_ok', 'g_order', 'g_mis', 'g_unc', 'g_fail');
  if (select count(*) from public.publish_claims c join claims k on c.execution_id = k.attempt_id::text where c.status = 'publishing') <> 6 then
    raise exception 'greeting claims not owned by their attempts';
  end if;
end $$;

-- Even a legacy-privileged direct claim write cannot authorize an overdue
-- greeting's provider request through the plan-aware entry point.
insert into public.publish_claims (brand_id, post_type, date_jst, execution_id, status)
select 'brand_g_stale', 'morning_greeting', current_date - 1, c.attempt_id::text, 'publishing'
from claims c where c.label = 'g_stale';
select public.plan_provider_steps_v2(attempt_id, claim_token, 'morning_greeting_media_post', 2::smallint)
from claims where label = 'g_stale';
select public.mark_post_provider_started_v2(attempt_id, claim_token) from claims where label = 'g_stale';
do $$ begin
  perform pg_temp.expect_error(pg_temp.q('select public.begin_planned_provider_step_v2(%L,%L,1::smallint,%L)',
    'g_stale', 'media_upload'), 'GREETING_SCHEDULE_DATE_STALE');
end $$;

-- 3. Competing / stale attempt cannot take over a day claim; a pre-X end fails it.
select public.settle_post_pre_x_v2(attempt_id, claim_token, true, 'FAKE_PRE_X') from claims where label = 'g_comp';
do $$
declare r record; old_attempt uuid := (pg_temp.c('g_comp')).attempt_id;
begin
  if (select status || ':' || error_code from public.publish_claims where execution_id = old_attempt::text)
     <> 'failed:PRE_X_RETRYABLE:FAKE_PRE_X' then raise exception 'pre-X end did not fail the day claim'; end if;
  select * into r from public.claim_due_post_v2();
  if r.scheduled_post_id <> (pg_temp.c('g_comp')).post_id then raise exception 'g_comp not re-claimed'; end if;
  perform pg_temp.expect_error(format('select public.acquire_greeting_publish_claim_v2(%L,%L)', r.attempt_id, r.claim_token), 'GREETING_PUBLISH_CLAIM_HELD');
  perform pg_temp.expect_error(format('select public.plan_provider_steps_v2(%L,%L,%L,2::smallint)', r.attempt_id, r.claim_token, 'morning_greeting_media_post'), 'GREETING_PUBLISH_CLAIM_NOT_HELD');
  perform pg_temp.expect_error(format('select public.begin_planned_provider_step_v2(%L,%L,1::smallint,%L)', r.attempt_id, r.claim_token, 'media_upload'), 'PROVIDER_STEP_PLAN_REQUIRED');
end $$;

select public.mark_post_provider_started_v2(attempt_id, claim_token) from claims where label not in ('g_comp', 'g_pub', 'g_stale');

-- 4. Plan is mandatory and fixed after provider start; raw Phase1F entry is closed.
do $$ begin
  perform pg_temp.expect_error(pg_temp.q('select public.begin_planned_provider_step_v2(%L,%L,1::smallint,%L)', 't_noplan', 'create_post'), 'PROVIDER_STEP_PLAN_REQUIRED');
  perform pg_temp.expect_error(pg_temp.q('select public.plan_provider_steps_v2(%L,%L,%L,1::smallint)', 't_noplan', 'tip_thread'), 'X_CLAIM_NOT_PRE_X');
  perform pg_temp.expect_error(pg_temp.q('select public.begin_provider_step_v2(%L,%L,1::smallint,%L)', 't2', 'create_post'), '42501');
end $$;

-- 5. Tip: 2-part and 3-part threads complete exactly once, all ids kept.
do $$
declare lbl text; n integer; i integer; prev text;
begin
  foreach lbl in array array['t2', 't3'] loop
    n := case lbl when 't2' then 2 else 3 end;
    prev := null;
    for i in 1..n loop
      perform public.begin_planned_provider_step_v2((pg_temp.c(lbl)).attempt_id, (pg_temp.c(lbl)).claim_token, i::smallint,
        case when i = 1 then 'create_post' else 'create_reply' end, prev, null);
      perform public.finish_provider_step_v2((pg_temp.c(lbl)).attempt_id, (pg_temp.c(lbl)).claim_token, i::smallint,
        'provider_object_confirmed', 'x_' || lbl || '_' || i, null);
      prev := 'x_' || lbl || '_' || i;
    end loop;
  end loop;
  -- identity checks before the good completion
  perform pg_temp.expect_error(pg_temp.q('select public.complete_tip_post_v2(%L,%L,%L,%L,%L)', 't3', 'acct_b', 'brand_b', '00000000-0000-4000-8000-0000000000f2'), 'X_COMPLETION_ACCOUNT_MISMATCH');
  perform pg_temp.expect_error(format('select public.complete_tip_post_v2(%L,gen_random_uuid(),%L,%L,%L)', (pg_temp.c('t3')).attempt_id, 'acct_a', 'brand_a', '00000000-0000-4000-8000-0000000000f2'), 'X_COMPLETION_CLAIM_INVALID');
  perform pg_temp.expect_error(pg_temp.q('select public.complete_morning_greeting_post_v2(%L,%L,%L,%L)', 't3', 'acct_a', 'brand_a'), 'PROVIDER_STEP_PLAN_REQUIRED');
  if public.complete_tip_post_v2((pg_temp.c('t2')).attempt_id, (pg_temp.c('t2')).claim_token, 'acct_a', 'brand_a', '00000000-0000-4000-8000-0000000000f1') <> 'completed'
     or public.complete_tip_post_v2((pg_temp.c('t3')).attempt_id, (pg_temp.c('t3')).claim_token, 'acct_a', 'brand_a', '00000000-0000-4000-8000-0000000000f2') <> 'completed' then
    raise exception 'thread completion failed'; end if;
  if public.complete_tip_post_v2((pg_temp.c('t2')).attempt_id, (pg_temp.c('t2')).claim_token, 'acct_a', 'brand_a', '00000000-0000-4000-8000-0000000000f1') <> 'already_completed' then
    raise exception 'duplicate thread completion not idempotent'; end if;
  if (select use_count from public.tips where id = '00000000-0000-4000-8000-0000000000f1') <> 1
     or (select use_count from public.tips where id = '00000000-0000-4000-8000-0000000000f2') <> 1
     or (select count(*) from public.post_execution_logs l where l.scheduled_post_id = (pg_temp.c('t2')).post_id and l.status = 'succeeded'
         and l.tip_id = '00000000-0000-4000-8000-0000000000f1' and l.x_post_id = 'x_t2_1' and l.message = 'X post created') <> 1
     or (select count(*) from public.post_execution_logs l where l.scheduled_post_id = (pg_temp.c('t3')).post_id and l.status = 'succeeded') <> 1
     or (select x_post_id from public.post_queue_attempts_v2 where id = (pg_temp.c('t3')).attempt_id) <> 'x_t3_1'
     or (select status from public.scheduled_posts where id = (pg_temp.c('t3')).post_id) <> 'succeeded'
     or (select string_agg(provider_object_id || '<' || coalesce(parent_provider_object_id, '-'), ',' order by step_no)
         from public.post_provider_steps_v2 where attempt_id = (pg_temp.c('t3')).attempt_id) <> 'x_t3_1<-,x_t3_2<x_t3_1,x_t3_3<x_t3_2' then
    raise exception 'thread completion effects wrong';
  end if;
  perform pg_temp.expect_error(pg_temp.q('select public.begin_planned_provider_step_v2(%L,%L,3::smallint,%L,%L)', 't2', 'create_reply', 'x_t2_2'), 'PROVIDER_STEP_BEYOND_PLAN');
end $$;

-- 6. Wrong parent / wrong kind / input, missing middle, uncertain and rejected parts.
do $$
begin
  perform public.begin_planned_provider_step_v2((pg_temp.c('t_parent')).attempt_id, (pg_temp.c('t_parent')).claim_token, 1::smallint, 'create_post');
  perform public.finish_provider_step_v2((pg_temp.c('t_parent')).attempt_id, (pg_temp.c('t_parent')).claim_token, 1::smallint, 'provider_object_confirmed', 'x_p1', null);
  perform pg_temp.expect_error(pg_temp.q('select public.begin_planned_provider_step_v2(%L,%L,2::smallint,%L,%L)', 't_parent', 'create_reply', 'x_wrong'), 'PROVIDER_STEP_PARENT_MISMATCH');
  perform pg_temp.expect_error(pg_temp.q('select public.begin_planned_provider_step_v2(%L,%L,2::smallint,%L)', 't_parent', 'create_post'), 'PROVIDER_STEP_KIND_NOT_IN_PLAN');
  perform pg_temp.expect_error(pg_temp.q('select public.begin_planned_provider_step_v2(%L,%L,2::smallint,%L,%L,%L)', 't_parent', 'create_reply', 'x_p1', 'm'), 'PROVIDER_STEP_INPUT_MISMATCH');

  perform public.begin_planned_provider_step_v2((pg_temp.c('t_gap')).attempt_id, (pg_temp.c('t_gap')).claim_token, 1::smallint, 'create_post');
  perform public.finish_provider_step_v2((pg_temp.c('t_gap')).attempt_id, (pg_temp.c('t_gap')).claim_token, 1::smallint, 'provider_object_confirmed', 'x_g1', null);
  perform pg_temp.expect_error(pg_temp.q('select public.begin_planned_provider_step_v2(%L,%L,3::smallint,%L,%L)', 't_gap', 'create_reply', 'x_g1'), 'PROVIDER_STEP_OUT_OF_ORDER');
  perform pg_temp.expect_error(pg_temp.q('select public.complete_tip_post_v2(%L,%L,%L,%L,%L)', 't_gap', 'acct_a', 'brand_a', '00000000-0000-4000-8000-0000000000f1'), 'THREAD_STEPS_NOT_COMPLETE');
  perform public.begin_planned_provider_step_v2((pg_temp.c('t_gap')).attempt_id, (pg_temp.c('t_gap')).claim_token, 2::smallint, 'create_reply', 'x_g1');
  perform public.finish_provider_step_v2((pg_temp.c('t_gap')).attempt_id, (pg_temp.c('t_gap')).claim_token, 2::smallint, 'provider_object_confirmed', 'x_g2', null);
  perform pg_temp.expect_error(pg_temp.q('select public.complete_tip_post_v2(%L,%L,%L,%L,%L)', 't_gap', 'acct_a', 'brand_a', '00000000-0000-4000-8000-0000000000f1'), 'THREAD_STEPS_NOT_COMPLETE');

  perform public.begin_planned_provider_step_v2((pg_temp.c('t_unc')).attempt_id, (pg_temp.c('t_unc')).claim_token, 1::smallint, 'create_post');
  perform public.finish_provider_step_v2((pg_temp.c('t_unc')).attempt_id, (pg_temp.c('t_unc')).claim_token, 1::smallint, 'provider_object_confirmed', 'x_u1', null);
  perform public.begin_planned_provider_step_v2((pg_temp.c('t_unc')).attempt_id, (pg_temp.c('t_unc')).claim_token, 2::smallint, 'create_reply', 'x_u1');
  perform public.finish_provider_step_v2((pg_temp.c('t_unc')).attempt_id, (pg_temp.c('t_unc')).claim_token, 2::smallint, 'x_outcome_uncertain', null, 'X_CREATE_NETWORK_UNCERTAIN');
  perform pg_temp.expect_error(pg_temp.q('select public.begin_planned_provider_step_v2(%L,%L,3::smallint,%L,%L)', 't_unc', 'create_reply', 'x_u1'), 'PROVIDER_STEP_PREVIOUS_NOT_CONFIRMED');
  perform pg_temp.expect_error(pg_temp.q('select public.begin_planned_provider_step_v2(%L,%L,2::smallint,%L,%L)', 't_unc', 'create_reply', 'x_u1'), 'PROVIDER_STEP_ALREADY_STARTED');
  perform pg_temp.expect_error(pg_temp.q('select public.complete_tip_post_v2(%L,%L,%L,%L,%L)', 't_unc', 'acct_a', 'brand_a', '00000000-0000-4000-8000-0000000000f1'), 'THREAD_STEPS_NOT_COMPLETE');
  perform pg_temp.expect_error(pg_temp.q('select public.record_post_x_rejected_v2(%L,%L,%L)', 't_unc', 'X_CREATE_REJECTED_403'), 'X_REJECTED_AFTER_CONFIRMED_CREATE');
  perform public.record_post_x_uncertain_v2((pg_temp.c('t_unc')).attempt_id, (pg_temp.c('t_unc')).claim_token, 'X_THREAD_PART_UNCERTAIN');

  perform public.begin_planned_provider_step_v2((pg_temp.c('t_rej')).attempt_id, (pg_temp.c('t_rej')).claim_token, 1::smallint, 'create_post');
  perform public.finish_provider_step_v2((pg_temp.c('t_rej')).attempt_id, (pg_temp.c('t_rej')).claim_token, 1::smallint, 'x_rejected', null, 'X_CREATE_REJECTED_403');
  perform pg_temp.expect_error(pg_temp.q('select public.begin_planned_provider_step_v2(%L,%L,2::smallint,%L,%L)', 't_rej', 'create_reply', 'x'), 'PROVIDER_STEP_PREVIOUS_NOT_CONFIRMED');
  perform public.record_post_x_rejected_v2((pg_temp.c('t_rej')).attempt_id, (pg_temp.c('t_rej')).claim_token, 'X_CREATE_REJECTED_403');

  -- Terminal attempts accept no new step or step outcome.
  perform pg_temp.expect_error(pg_temp.q('select public.begin_planned_provider_step_v2(%L,%L,3::smallint,%L,%L)', 't_unc', 'create_reply', 'x_u1'), 'ATTEMPT_NOT_PROVIDER_STARTED');
  if exists (select 1 from public.claim_due_post_v2()) or public.reconcile_stale_pre_x_v2() <> 0 then
    raise exception 'partial thread became reclaimable';
  end if;
end $$;

-- 7. Forced side-effect failure rolls back; confirmed-incomplete recovers once.
do $$
declare c claims := pg_temp.c('t_fail');
        v_logs integer;
        v_result text;
begin
  perform public.begin_planned_provider_step_v2(c.attempt_id, c.claim_token, 1::smallint, 'create_post');
  perform public.finish_provider_step_v2(c.attempt_id, c.claim_token, 1::smallint, 'provider_object_confirmed', 'x_f1', null);
  v_logs := (select count(*) from public.post_execution_logs);
  perform pg_temp.expect_error(format('select public.complete_tip_post_v2(%L,%L,%L,%L,%L)', c.attempt_id, c.claim_token,
    'acct_a', 'brand_a', '00000000-0000-4000-8000-0000000000f9'), 'FIXTURE_FORCED_TIP_FAILURE');
  if (select status from public.scheduled_posts where id = c.post_id) <> 'running'
     or (select phase from public.post_queue_attempts_v2 where id = c.attempt_id) <> 'provider_started'
     or (select count(*) from public.post_execution_logs) <> v_logs then
    raise exception 'tip failure not rolled back';
  end if;
  perform public.record_post_x_confirmed_incomplete_v2(c.attempt_id, c.claim_token, 'x_f1', 'FAKE_TIP_COMPLETION');
  v_result := public.complete_tip_post_v2(c.attempt_id, c.claim_token, 'acct_a', 'brand_a', '00000000-0000-4000-8000-0000000000f1');
  if v_result <> 'completed' or (select use_count from public.tips where id = '00000000-0000-4000-8000-0000000000f1') <> 2 then
    raise exception 'tip recovery failed: % use_count=%', v_result, (select use_count from public.tips where id = '00000000-0000-4000-8000-0000000000f1');
  end if;
end $$;

-- 8. Greeting: happy path, ordering, media binding, uncertainty, rollback.
do $$
declare g claims;
begin
  g := pg_temp.c('g_order');
  perform pg_temp.expect_error(format('select public.begin_planned_provider_step_v2(%L,%L,2::smallint,%L,null,%L)', g.attempt_id, g.claim_token, 'create_post', 'm_x'), 'PROVIDER_STEP_INPUT_MISMATCH');
  perform pg_temp.expect_error(format('select public.begin_planned_provider_step_v2(%L,%L,1::smallint,%L)', g.attempt_id, g.claim_token, 'create_post'), 'PROVIDER_STEP_KIND_NOT_IN_PLAN');

  g := pg_temp.c('g_mis');
  perform public.begin_planned_provider_step_v2(g.attempt_id, g.claim_token, 1::smallint, 'media_upload');
  perform public.finish_provider_step_v2(g.attempt_id, g.claim_token, 1::smallint, 'provider_object_confirmed', 'm_mis', null);
  perform pg_temp.expect_error(format('select public.begin_planned_provider_step_v2(%L,%L,2::smallint,%L,null,%L)', g.attempt_id, g.claim_token, 'create_post', 'm_other'), 'PROVIDER_STEP_INPUT_MISMATCH');
  perform pg_temp.expect_error(format('select public.begin_planned_provider_step_v2(%L,%L,2::smallint,%L)', g.attempt_id, g.claim_token, 'create_post'), 'PROVIDER_STEP_INPUT_MISMATCH');
  -- another attempt's confirmed media cannot be consumed
  perform pg_temp.expect_error(format('select public.begin_planned_provider_step_v2(%L,%L,2::smallint,%L,null,%L)',
    (pg_temp.c('g_order')).attempt_id, (pg_temp.c('g_order')).claim_token, 'create_post', 'm_mis'), 'PROVIDER_STEP_INPUT_MISMATCH');

  g := pg_temp.c('g_ok');
  perform public.begin_planned_provider_step_v2(g.attempt_id, g.claim_token, 1::smallint, 'media_upload');
  perform public.finish_provider_step_v2(g.attempt_id, g.claim_token, 1::smallint, 'provider_object_confirmed', 'm_ok', null);
  perform pg_temp.expect_error(format('select public.complete_morning_greeting_post_v2(%L,%L,%L,%L)', g.attempt_id, g.claim_token, 'acct_a', 'brand_a'), 'GREETING_STEPS_NOT_COMPLETE');
  perform public.begin_planned_provider_step_v2(g.attempt_id, g.claim_token, 2::smallint, 'create_post', null, 'm_ok');
  perform public.finish_provider_step_v2(g.attempt_id, g.claim_token, 2::smallint, 'provider_object_confirmed', 'x_greet', null);
  perform pg_temp.expect_error(format('select public.complete_morning_greeting_post_v2(%L,%L,%L,%L)', g.attempt_id, g.claim_token, 'acct_b', 'brand_b'), 'X_COMPLETION_ACCOUNT_MISMATCH');
  perform pg_temp.expect_error(format('select public.complete_tip_post_v2(%L,%L,%L,%L,%L)', g.attempt_id, g.claim_token, 'acct_a', 'brand_a', '00000000-0000-4000-8000-0000000000f1'), 'PROVIDER_STEP_PLAN_REQUIRED');
  if public.complete_morning_greeting_post_v2(g.attempt_id, g.claim_token, 'acct_a', 'brand_a') <> 'completed'
     or public.complete_morning_greeting_post_v2(g.attempt_id, g.claim_token, 'acct_a', 'brand_a') <> 'already_completed' then
    raise exception 'greeting completion not exactly-once'; end if;
  if (select status || ':' || x_post_id from public.publish_claims where execution_id = g.attempt_id::text) <> 'published:x_greet'
     or (select published_at from public.publish_claims where execution_id = g.attempt_id::text) is null
     or (select status from public.scheduled_posts where id = g.post_id) <> 'succeeded'
     or (select outcome || ':' || x_post_id from public.post_queue_attempts_v2 where id = g.attempt_id) <> 'completed:x_greet'
     or (select count(*) from public.post_execution_logs where scheduled_post_id = g.post_id and status = 'succeeded'
         and x_post_id = 'x_greet' and message = 'X post created' and post_type = 'morning_greeting') <> 1 then
    raise exception 'greeting completion effects wrong';
  end if;

  g := pg_temp.c('g_unc');
  perform public.begin_planned_provider_step_v2(g.attempt_id, g.claim_token, 1::smallint, 'media_upload');
  perform public.finish_provider_step_v2(g.attempt_id, g.claim_token, 1::smallint, 'provider_object_confirmed', 'm_unc', null);
  perform public.begin_planned_provider_step_v2(g.attempt_id, g.claim_token, 2::smallint, 'create_post', null, 'm_unc');
  perform public.finish_provider_step_v2(g.attempt_id, g.claim_token, 2::smallint, 'x_outcome_uncertain', null, 'X_CREATE_HTTP_503');
  perform pg_temp.expect_error(format('select public.begin_planned_provider_step_v2(%L,%L,2::smallint,%L,null,%L)', g.attempt_id, g.claim_token, 'create_post', 'm_unc'), 'PROVIDER_STEP_ALREADY_STARTED');
  perform pg_temp.expect_error(format('select public.begin_planned_provider_step_v2(%L,%L,1::smallint,%L)', g.attempt_id, g.claim_token, 'media_upload'), 'PROVIDER_STEP_ALREADY_STARTED');
  perform pg_temp.expect_error(format('select public.complete_morning_greeting_post_v2(%L,%L,%L,%L)', g.attempt_id, g.claim_token, 'acct_brand_g_unc', 'brand_g_unc'), 'GREETING_STEPS_NOT_COMPLETE');
  perform public.record_post_x_uncertain_v2(g.attempt_id, g.claim_token, 'X_CREATE_HTTP_503');
  if (select status || ':' || error_code from public.publish_claims where execution_id = g.attempt_id::text)
     <> 'failed:X_OUTCOME_UNCERTAIN:X_CREATE_HTTP_503' then raise exception 'uncertain greeting did not fail its day claim'; end if;

  g := pg_temp.c('g_fail');
  perform public.begin_planned_provider_step_v2(g.attempt_id, g.claim_token, 1::smallint, 'media_upload');
  perform public.finish_provider_step_v2(g.attempt_id, g.claim_token, 1::smallint, 'provider_object_confirmed', 'm_fail', null);
  perform public.begin_planned_provider_step_v2(g.attempt_id, g.claim_token, 2::smallint, 'create_post', null, 'm_fail');
  perform public.finish_provider_step_v2(g.attempt_id, g.claim_token, 2::smallint, 'provider_object_confirmed', 'x_force_fail', null);
  perform pg_temp.expect_error(format('select public.complete_morning_greeting_post_v2(%L,%L,%L,%L)', g.attempt_id, g.claim_token, 'acct_brand_g_fail', 'brand_g_fail'), 'FIXTURE_FORCED_GREETING_LOG_FAILURE');
  if (select status from public.publish_claims where execution_id = g.attempt_id::text) <> 'publishing'
     or (select status from public.scheduled_posts where id = g.post_id) <> 'running'
     or (select phase from public.post_queue_attempts_v2 where id = g.attempt_id) <> 'provider_started' then
    raise exception 'greeting failure not rolled back';
  end if;
  perform public.record_post_x_confirmed_incomplete_v2(g.attempt_id, g.claim_token, 'x_force_fail', 'FAKE_GREETING_COMPLETION');
  if (select status from public.publish_claims where execution_id = g.attempt_id::text) <> 'publishing' then
    raise exception 'confirmed-incomplete greeting lost its claim';
  end if;
  if exists (select 1 from public.claim_due_post_v2()) or public.reconcile_stale_pre_x_v2() <> 0 then
    raise exception 'greeting became reclaimable';
  end if;
end $$;

-- 9. Legacy row and API roles.
do $$ begin
  perform pg_temp.expect_error($q$select public.complete_tip_post_v2(gen_random_uuid(), gen_random_uuid(), 'acct_a', 'brand_a', '00000000-0000-4000-8000-0000000000f1')$q$, 'X_COMPLETION_CLAIM_INVALID');
  if (select status from public.scheduled_posts where brand_id = 'brand_a' and slot_no = 50 and post_type = 'tip') <> 'pending' then
    raise exception 'legacy row touched'; end if;
  if coalesce(current_setting('kabumori.x_queue_domain', true), '') <> '' then raise exception 'domain leaked'; end if;
end $$;
reset role;
set role authenticated;
do $$ begin
  perform pg_temp.expect_error($q$select public.complete_tip_post_v2(gen_random_uuid(), gen_random_uuid(), 'a', 'b', gen_random_uuid())$q$, '42501');
  perform pg_temp.expect_error($q$select public.acquire_greeting_publish_claim_v2(gen_random_uuid(), gen_random_uuid())$q$, '42501');
end $$;
reset role;

select 'PHASE1G_BEHAVIOR_PASS' as result;
