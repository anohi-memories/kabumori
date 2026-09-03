-- A per-day, per-post-type atomic publish claim. The unique constraint below *is* the duplicate-prevention
-- mechanism: the first INSERT for a given (post_type, date_jst) wins and every later attempt for the same
-- day is ignored by Postgres, not by racy application-level "check then act" logic (Storage receipt
-- existence checks, etc.). Scoped to post_type rather than a morning_greeting-only table so any future
-- post type that must publish at most once per date_jst can reuse it the same way.
create table if not exists public.publish_claims (
  id uuid primary key default gen_random_uuid(),
  post_type text not null,
  date_jst date not null,
  status text not null default 'publishing' check (status in ('publishing', 'published', 'failed')),
  execution_id text not null,
  started_at timestamptz not null default now(),
  x_post_id text,
  published_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  unique (post_type, date_jst)
);

alter table public.publish_claims enable row level security;

grant select, insert, update on public.publish_claims to service_role;
