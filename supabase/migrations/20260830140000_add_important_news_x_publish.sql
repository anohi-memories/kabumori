alter table public.important_news_candidates
  add column if not exists x_published_at timestamptz,
  add column if not exists x_post_id text,
  add column if not exists publish_attempts integer not null default 0,
  add column if not exists last_publish_http_status smallint,
  add column if not exists publish_error text;

alter table public.important_news_candidates
  add constraint important_news_candidates_publish_attempts_check
    check (publish_attempts >= 0),
  add constraint important_news_candidates_publish_http_status_check
    check (last_publish_http_status is null or last_publish_http_status between 100 and 599);

create unique index if not exists important_news_candidates_x_post_id_uidx
  on public.important_news_candidates (x_post_id)
  where x_post_id is not null;

do $$
declare constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'public.important_news_candidates'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%ready_for_publish%'
      and pg_get_constraintdef(oid) ilike '%generation_failed%'
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
    'publishing', 'publish_failed', 'published', 'failed'
  ));

create index if not exists important_news_candidates_publishing_idx
  on public.important_news_candidates (updated_at)
  where status = 'publishing';

alter table public.post_execution_logs
  add column if not exists important_news_candidate_id uuid
    references public.important_news_candidates(id),
  add column if not exists http_status smallint;

alter table public.post_execution_logs
  add constraint post_execution_logs_http_status_check
    check (http_status is null or http_status between 100 and 599);

create index if not exists post_execution_logs_important_news_idx
  on public.post_execution_logs (important_news_candidate_id, created_at desc)
  where important_news_candidate_id is not null;

grant insert on public.post_execution_logs to service_role;
grant usage, select on sequence public.post_execution_logs_id_seq to service_role;

-- Ver.1 stage 5 adds safe publication state only. No cron or automatic invocation is enabled.
