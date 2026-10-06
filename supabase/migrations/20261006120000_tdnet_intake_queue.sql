-- TDnet T1: lightweight intake queue for TDnet disclosures (Stage A) drained by a bounded PDF worker (Stage B).
--
-- Why a dedicated table instead of important_news_candidates: a candidate row is judged, generated and published
-- by status, and its status CHECK is read by several consumers. An "awaiting PDF" row there could be judged
-- title-only by mistake. This queue keeps un-enriched disclosures completely outside that pipeline; a row becomes
-- a candidate only after the worker has built its body and inserted it through the normal candidate path.
--
-- States: queued -> enriching -> candidate_created, or -> skipped_routine (strictly routine notice, kept for audit,
-- never a candidate; only when the worker's skip flag is on), or -> failed_retryable (with next_attempt_at) -> failed_terminal.
-- The claim is an atomic conditional UPDATE (PostgREST PATCH with state / lease filters): two workers racing on the
-- same row cannot both see it as claimable because the UPDATE re-checks the filter under the row lock.
-- Additive only: no existing table, function or policy is touched. RLS is on with no policy; only service_role
-- (the Edge Function) has table privileges.

create table if not exists public.tdnet_intake_queue (
  id uuid primary key default gen_random_uuid(),
  source_url text not null check (source_url ~ '^https://'),
  company_code text not null,
  company_name text not null,
  title text not null,
  published_at timestamptz not null,
  priority_tier smallint not null check (priority_tier in (1, 2, 3)),
  priority_reason text not null,
  group_key text not null,
  state text not null default 'queued'
    check (state in ('queued', 'enriching', 'candidate_created', 'skipped_routine', 'failed_retryable', 'failed_terminal')),
  attempt_count smallint not null default 0 check (attempt_count >= 0),
  last_error text,
  next_attempt_at timestamptz not null default now(),
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  candidate_id uuid references public.important_news_candidates(id) on delete set null,
  discovered_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((state = 'enriching') = (claimed_by is not null and lease_expires_at is not null)),
  check ((state in ('candidate_created', 'skipped_routine', 'failed_terminal')) = (completed_at is not null))
);

create unique index if not exists tdnet_intake_queue_source_url_uidx
  on public.tdnet_intake_queue (source_url);
-- Worker read path: claimable rows ordered by tier / age.
create index if not exists tdnet_intake_queue_claimable_idx
  on public.tdnet_intake_queue (priority_tier, published_at)
  where state in ('queued', 'failed_retryable', 'enriching');
create index if not exists tdnet_intake_queue_completed_idx
  on public.tdnet_intake_queue (completed_at)
  where completed_at is not null;

create or replace function public.set_tdnet_intake_queue_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tdnet_intake_queue_updated_at on public.tdnet_intake_queue;
create trigger tdnet_intake_queue_updated_at
before update on public.tdnet_intake_queue
for each row execute function public.set_tdnet_intake_queue_updated_at();

revoke all on function public.set_tdnet_intake_queue_updated_at() from public, anon, authenticated;

alter table public.tdnet_intake_queue enable row level security;
revoke all on public.tdnet_intake_queue from anon, authenticated;
grant select, insert, update, delete on public.tdnet_intake_queue to service_role;
