-- Fake-only Phase1G additions, applied after the 1D/1E/1F fixtures and before
-- the 1B..1G migrations. Never production. tips and publish_claims mirror the
-- live-source columns (publish_claims in its brand-scoped Phase0c shape).
set timezone = 'UTC';

create table public.tips (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  last_used_at timestamptz,
  use_count integer not null default 0 check (use_count >= 0),
  is_active boolean not null default true
);
create table public.publish_claims (
  id uuid primary key default gen_random_uuid(),
  brand_id text not null default 'kabumori' references public.brands(id),
  post_type text not null,
  date_jst date not null,
  status text not null default 'publishing' check (status in ('publishing', 'published', 'failed')),
  execution_id text not null,
  started_at timestamptz not null default now(),
  x_post_id text,
  published_at timestamptz,
  error_code text,
  created_at timestamptz not null default now()
);
create unique index publish_claims_brand_post_type_date_key on public.publish_claims (brand_id, post_type, date_jst);
alter table public.publish_claims enable row level security;
-- Live grant used by the legacy REST helpers.
revoke all on public.publish_claims from anon, authenticated;
grant select, insert, update on public.publish_claims to service_role;

insert into public.tips (id, title) values
  ('00000000-0000-4000-8000-0000000000f1', 'tip one'),
  ('00000000-0000-4000-8000-0000000000f2', 'tip two'),
  ('00000000-0000-4000-8000-0000000000f9', 'force_fail');

-- Test-only fault injection: a side effect that fails inside the completion.
create function public.fixture_fail_tip_update() returns trigger language plpgsql as $$
begin
  if new.title = 'force_fail' then raise exception 'FIXTURE_FORCED_TIP_FAILURE'; end if;
  return new;
end;
$$;
create trigger fixture_fail_tip_update before update on public.tips
for each row execute function public.fixture_fail_tip_update();
create function public.fixture_fail_greeting_log() returns trigger language plpgsql as $$
begin
  if new.post_type = 'morning_greeting' and new.status = 'succeeded' and new.x_post_id = 'x_force_fail' then
    raise exception 'FIXTURE_FORCED_GREETING_LOG_FAILURE';
  end if;
  return new;
end;
$$;
create trigger fixture_fail_greeting_log before insert on public.post_execution_logs
for each row execute function public.fixture_fail_greeting_log();
