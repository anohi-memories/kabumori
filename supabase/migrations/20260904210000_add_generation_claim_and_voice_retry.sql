-- Important news P0.6: an explicit "generating" status is the atomic claim state for generation,
-- mirroring the existing "publishing" claim state used by the publish flow — an atomic conditional PATCH
-- (ready_for_generation -> generating) means at most one caller (immediate post-judgement trigger or the
-- generate_ready cron) ever actually calls the generation model for a given candidate, even if both run
-- at nearly the same time. generation_voice_retry is a single nullable jsonb diagnostics column for the
-- (at most one) voice_retry attempt, avoiding seven separate new columns for what is always written and
-- read together.
alter table public.important_news_candidates
  drop constraint if exists important_news_candidates_status_check;

alter table public.important_news_candidates
  add constraint important_news_candidates_status_check
  check (status in (
    'fetched', 'duplicate', 'pending_judgement', 'rejected',
    'ready_for_generation', 'generating', 'ready_for_publish', 'generation_failed',
    'publishing', 'publish_failed', 'published', 'failed'
  ));

alter table public.important_news_candidates
  add column if not exists generation_voice_retry jsonb;
