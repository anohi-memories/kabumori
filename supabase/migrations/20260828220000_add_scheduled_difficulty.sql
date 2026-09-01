alter table public.scheduled_posts
  add column if not exists target_difficulty text;

alter table public.scheduled_posts
  drop constraint if exists scheduled_posts_target_difficulty_check;

alter table public.scheduled_posts
  add constraint scheduled_posts_target_difficulty_check
  check (target_difficulty is null or target_difficulty in ('初級', '中級', '実践'));
