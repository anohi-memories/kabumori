-- Internal run log for the JPX ticker master sync job. No app user ever reads
-- this; it exists purely so a failed/partial sync is debuggable after the fact.
create table public.stocks_master_sync_runs (
  id uuid primary key default gen_random_uuid(),
  trigger_type text not null default 'scheduled' check (trigger_type in ('manual', 'scheduled')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  added_count integer not null default 0 check (added_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  delisted_count integer not null default 0 check (delisted_count >= 0),
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index stocks_master_sync_runs_started_at_idx
  on public.stocks_master_sync_runs (started_at desc);

alter table public.stocks_master_sync_runs enable row level security;

revoke all on public.stocks_master_sync_runs from anon, authenticated;
grant select, insert, update on public.stocks_master_sync_runs to service_role;
