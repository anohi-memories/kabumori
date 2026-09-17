-- Phase 1 candidate only. This migration is intentionally not applied by H1.
-- target_date is the Asia/Tokyo calendar date used by scheduled_posts.schedule_date.
-- plan is operator-authored structured content data, for example:
-- {
--   "day_theme": "...",
--   "narrative_arc": "...",
--   "items": [{
--     "id": "morning-1", "slot_no": 1, "priority": 10,
--     "topic": "...", "context": "...", "tone_override": "...",
--     "key_points": ["..."], "must_include": ["..."], "must_avoid": ["..."]
--   }]
-- }
-- slot_no may be omitted/null; such items are deterministically assigned to
-- otherwise-unassigned scheduled slots by priority then id.
create table if not exists public.daily_content_plans (
  id uuid primary key default gen_random_uuid(),
  brand_id text not null references public.brands(id) on delete cascade,
  target_date date not null,
  version integer not null default 1 check (version > 0),
  source text not null default 'manual'
    check (source in ('chatgpt', 'app_ai', 'manual')),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'archived')),
  plan jsonb not null
    check (jsonb_typeof(plan) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, target_date, version)
);

create unique index if not exists daily_content_plans_one_active_per_day_idx
  on public.daily_content_plans (brand_id, target_date)
  where status = 'active';

create index if not exists daily_content_plans_lookup_idx
  on public.daily_content_plans (brand_id, target_date, status, version desc);

-- Plans are server-authored and consumed by service-role Edge Functions only.
-- No authenticated/anon policy or write grant is added in this candidate.
alter table public.daily_content_plans enable row level security;
grant select on public.daily_content_plans to service_role;
