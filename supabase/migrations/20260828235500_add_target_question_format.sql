alter table public.scheduled_posts
  add column if not exists target_question_format text;

alter table public.scheduled_posts
  drop constraint if exists scheduled_posts_target_question_format_check;

alter table public.scheduled_posts
  add constraint scheduled_posts_target_question_format_check
  check (target_question_format is null or target_question_format in (
    'choice', 'experience', 'beginner_question',
    'market_sentiment', 'watchlist', 'how_do_you_see'
  ));
