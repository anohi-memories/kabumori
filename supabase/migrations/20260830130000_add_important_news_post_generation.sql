alter table public.important_news_candidates
  add column if not exists generated_text text,
  add column if not exists generation_model text,
  add column if not exists generation_input_tokens integer,
  add column if not exists generation_output_tokens integer,
  add column if not exists generation_estimated_cost_usd numeric(12, 8),
  add column if not exists generation_fact_status text,
  add column if not exists generation_voice_status text,
  add column if not exists generation_error text,
  add column if not exists generated_at timestamptz;

alter table public.important_news_candidates
  add constraint important_news_candidates_generation_model_check
    check (generation_model is null or generation_model in ('gpt-5.6-luna', 'gpt-5.6-sol')),
  add constraint important_news_candidates_generation_usage_check
    check (
      (generation_input_tokens is null or generation_input_tokens >= 0)
      and (generation_output_tokens is null or generation_output_tokens >= 0)
      and (generation_estimated_cost_usd is null or generation_estimated_cost_usd >= 0)
    ),
  add constraint important_news_candidates_generation_fact_status_check
    check (generation_fact_status is null or generation_fact_status in ('passed', 'failed', 'not_run')),
  add constraint important_news_candidates_generation_voice_status_check
    check (generation_voice_status is null or generation_voice_status in ('passed', 'failed', 'not_run'));

do $$
declare constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'public.important_news_candidates'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%ready_for_generation%'
      and pg_get_constraintdef(oid) ilike '%published%'
  loop
    execute format(
      'alter table public.important_news_candidates drop constraint %I',
      constraint_row.conname
    );
  end loop;
end $$;

alter table public.important_news_candidates
  add constraint important_news_candidates_status_check
  check (status in (
    'fetched', 'duplicate', 'pending_judgement', 'rejected',
    'ready_for_generation', 'ready_for_publish', 'generation_failed',
    'published', 'failed'
  ));

create index if not exists important_news_candidates_publish_ready_idx
  on public.important_news_candidates (importance desc, published_at asc)
  where status = 'ready_for_publish';

-- Ver.1 stage 4 only stores generated drafts and checks. No cron or X publication is enabled.
