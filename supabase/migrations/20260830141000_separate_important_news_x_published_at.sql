-- Keep the source-news timestamp (published_at) separate from the X publication timestamp.
alter table public.important_news_candidates
  add column if not exists x_published_at timestamptz;

create index if not exists important_news_candidates_x_published_at_idx
  on public.important_news_candidates (x_published_at desc)
  where x_published_at is not null;
