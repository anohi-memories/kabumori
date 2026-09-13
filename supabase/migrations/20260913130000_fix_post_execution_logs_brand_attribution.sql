-- multibrand-phase3d-ai-lab-dry-run-routing-safety: post_execution_logs.brand_id defaults to
-- 'kabumori' (not null, column default 'kabumori'::text) and every RPC that inserts into this table
-- omits brand_id from its INSERT column list, so every row silently gets the default regardless of the
-- actual scheduled_posts row's own brand_id. This is invisible today because 100% of scheduled_posts
-- rows are Kabumori's, but it means execution-log brand attribution would silently be wrong the moment
-- any other brand gets even one scheduled row -- exactly what this task's "Logging" safety requirement
-- (brand attribution must persist through scheduled_posts -> execution log) is checking for.
--
-- NOT applied to production by this task (see task safety rules: schema/RPC changes need K2 review
-- before deploy). Fix is purely additive to each function body: every insert now carries the real
-- scheduled_posts.brand_id for the row being logged, via a subselect keyed on the same
-- p_scheduled_post_id / claimed_id these functions already use. No column, table, or call signature
-- changes -- callers (x-test-post/index.ts) are unaffected.

create or replace function public.claim_due_post()
returns setof public.scheduled_posts
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
begin
  -- Dedicated report planners retain their own settings, JPX-business-day,
  -- fixed-center-time, and ON CONFLICT duplicate safeguards.
  perform public.plan_morning_report();
  perform public.plan_close_report();

  -- Keep the existing generic and specialised planner sequence intact.
  perform public.plan_daily_posts();
  perform public.plan_weekly_useful_tips();
  perform public.plan_us_premarket_report();

  select id into claimed_id
  from public.scheduled_posts
  where status = 'pending'
    and scheduled_for <= now()
  order by scheduled_for
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  update public.scheduled_posts
  set status = 'running',
      started_at = now(),
      attempt_count = attempt_count + 1
  where id = claimed_id;

  insert into public.post_execution_logs (scheduled_post_id, post_type, status, message, brand_id)
  select id, post_type, 'started', 'Scheduled post claimed', brand_id
  from public.scheduled_posts
  where id = claimed_id;

  return query
  select * from public.scheduled_posts
  where id = claimed_id;
end;
$$;

create or replace function public.complete_close_report_post(
  p_scheduled_post_id uuid,
  p_close_report_run_id uuid,
  p_x_post_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare selected_run public.close_report_runs%rowtype;
begin
  update public.close_report_runs
  set status = 'succeeded', x_post_id = p_x_post_id, error = null
  where id = p_close_report_run_id
  returning * into selected_run;

  if selected_run.id is null then
    raise exception 'CLOSE_REPORT_RUN_NOT_FOUND';
  end if;

  update public.scheduled_posts
  set status = 'succeeded', finished_at = now()
  where id = p_scheduled_post_id and status = 'running';

  insert into public.post_execution_logs (
    scheduled_post_id, post_type, status, x_post_id, message,
    source_urls, verified_at, model_used, input_tokens, output_tokens, api_cost_usd, brand_id
  ) values (
    p_scheduled_post_id, 'close_report', 'succeeded', p_x_post_id,
    'Close report posted', selected_run.source_urls, selected_run.generated_at,
    selected_run.model_used, selected_run.input_tokens, selected_run.output_tokens,
    selected_run.api_cost_usd,
    (select brand_id from public.scheduled_posts where id = p_scheduled_post_id)
  );
end;
$$;

create or replace function public.complete_interaction_post(
  p_scheduled_post_id uuid,
  p_interaction_topic_id uuid,
  p_x_post_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.interaction_topics
  set last_used_at = now(), use_count = use_count + 1
  where id = p_interaction_topic_id;

  update public.scheduled_posts
  set status = 'succeeded', finished_at = now()
  where id = p_scheduled_post_id and status = 'running';

  insert into public.post_execution_logs
    (scheduled_post_id, post_type, status, x_post_id, message, brand_id)
  values
    (p_scheduled_post_id, 'interaction', 'succeeded', p_x_post_id,
     'Interaction X post created; topic=' || p_interaction_topic_id::text,
     (select brand_id from public.scheduled_posts where id = p_scheduled_post_id));

  insert into public.interaction_post_metrics
    (scheduled_post_id, interaction_topic_id, x_post_id)
  values (p_scheduled_post_id, p_interaction_topic_id, p_x_post_id);
end;
$$;

create or replace function public.complete_morning_greeting_post(
  p_scheduled_post_id uuid,
  p_x_post_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.scheduled_posts
  set status = 'succeeded', finished_at = now()
  where id = p_scheduled_post_id and status = 'running';

  insert into public.post_execution_logs
    (scheduled_post_id, post_type, status, x_post_id, message, brand_id)
  values
    (p_scheduled_post_id, 'morning_greeting', 'succeeded', p_x_post_id, 'X post created',
     (select brand_id from public.scheduled_posts where id = p_scheduled_post_id));
end;
$$;

create or replace function public.complete_morning_report_post(
  p_scheduled_post_id uuid,
  p_morning_report_run_id uuid,
  p_x_post_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_run public.morning_report_runs%rowtype;
begin
  update public.morning_report_runs
  set status = 'succeeded', x_post_id = p_x_post_id, error = null
  where id = p_morning_report_run_id
  returning * into selected_run;

  if selected_run.id is null then
    raise exception 'MORNING_REPORT_RUN_NOT_FOUND';
  end if;

  update public.scheduled_posts
  set status = 'succeeded', finished_at = now()
  where id = p_scheduled_post_id and status = 'running';

  insert into public.post_execution_logs (
    scheduled_post_id, post_type, status, x_post_id, message,
    source_urls, verified_at, model_used, input_tokens, output_tokens, api_cost_usd, brand_id
  ) values (
    p_scheduled_post_id, 'morning_report', 'succeeded', p_x_post_id,
    'Morning report posted', selected_run.source_urls, selected_run.generated_at,
    selected_run.model_used, selected_run.input_tokens, selected_run.output_tokens,
    selected_run.api_cost_usd,
    (select brand_id from public.scheduled_posts where id = p_scheduled_post_id)
  );
end;
$$;

create or replace function public.complete_tip_post(
  p_scheduled_post_id uuid,
  p_tip_id uuid,
  p_x_post_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tips
  set last_used_at = now(), use_count = use_count + 1
  where id = p_tip_id;

  update public.scheduled_posts
  set status = 'succeeded', finished_at = now()
  where id = p_scheduled_post_id and status = 'running';

  insert into public.post_execution_logs
    (scheduled_post_id, post_type, status, tip_id, x_post_id, message, brand_id)
  values
    (p_scheduled_post_id, 'tip', 'succeeded', p_tip_id, p_x_post_id, 'X post created',
     (select brand_id from public.scheduled_posts where id = p_scheduled_post_id));
end;
$$;

create or replace function public.complete_us_premarket_report_post(
  p_scheduled_post_id uuid,
  p_run_id uuid,
  p_x_post_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare selected_run public.us_premarket_report_runs%rowtype;
begin
  update public.us_premarket_report_runs
  set status = 'succeeded', x_post_id = p_x_post_id, error = null
  where id = p_run_id returning * into selected_run;
  if selected_run.id is null then raise exception 'US_PREMARKET_REPORT_RUN_NOT_FOUND'; end if;

  update public.scheduled_posts set status = 'succeeded', finished_at = now()
  where id = p_scheduled_post_id and status = 'running';

  insert into public.post_execution_logs (
    scheduled_post_id, post_type, status, x_post_id, message,
    source_urls, verified_at, model_used, input_tokens, output_tokens, api_cost_usd, brand_id
  ) values (
    p_scheduled_post_id, 'us_premarket_report', 'succeeded', p_x_post_id,
    'US premarket report posted', selected_run.source_urls, selected_run.generated_at,
    selected_run.model_used, selected_run.input_tokens, selected_run.output_tokens,
    selected_run.api_cost_usd,
    (select brand_id from public.scheduled_posts where id = p_scheduled_post_id)
  );
end;
$$;

create or replace function public.complete_useful_tip_post(
  p_scheduled_post_id uuid,
  p_useful_tip_id uuid,
  p_x_post_id text,
  p_source_urls jsonb,
  p_model_used text,
  p_escalated boolean,
  p_input_tokens integer,
  p_output_tokens integer,
  p_api_cost numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.useful_tips set last_used_at=now(),use_count=use_count+1 where id=p_useful_tip_id;
  update public.scheduled_posts set status='succeeded',finished_at=now()
    where id=p_scheduled_post_id and status='running';
  insert into public.post_execution_logs(
    scheduled_post_id,post_type,status,useful_tip_id,x_post_id,message,
    source_urls,verified_at,model_used,escalated_to_sol,input_tokens,output_tokens,api_cost_usd,brand_id
  ) values (
    p_scheduled_post_id,'useful_tip','succeeded',p_useful_tip_id,p_x_post_id,
    'Verified useful tip posted',p_source_urls,now(),p_model_used,p_escalated,
    p_input_tokens,p_output_tokens,p_api_cost,
    (select brand_id from public.scheduled_posts where id = p_scheduled_post_id)
  );
end
$$;

create or replace function public.fail_scheduled_post(
  p_scheduled_post_id uuid,
  p_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_type text;
  selected_brand_id text;
begin
  update public.scheduled_posts
  set status = 'failed', finished_at = now()
  where id = p_scheduled_post_id and status = 'running'
  returning post_type, brand_id into selected_type, selected_brand_id;

  if selected_type is not null then
    insert into public.post_execution_logs
      (scheduled_post_id, post_type, status, message, brand_id)
    values
      (p_scheduled_post_id, selected_type, 'failed', left(p_message, 300), selected_brand_id);
  end if;
end;
$$;

create or replace function public.retry_scheduled_post(
  p_scheduled_post_id uuid,
  p_retry_at timestamptz,
  p_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_type text;
  selected_brand_id text;
begin
  update public.scheduled_posts
  set status = 'pending', scheduled_for = p_retry_at, started_at = null, finished_at = null
  where id = p_scheduled_post_id and status = 'running'
  returning post_type, brand_id into selected_type, selected_brand_id;

  if selected_type is not null then
    insert into public.post_execution_logs (scheduled_post_id, post_type, status, message, brand_id)
    values (p_scheduled_post_id, selected_type, 'failed', left(p_message, 300), selected_brand_id);
  end if;
end;
$$;
