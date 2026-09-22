-- Central Banks Phase 2B5: deterministic Fed statement diffs.
-- This table is an append-only interpretation artifact; market_events remains
-- the immutable source Fact table and is intentionally not altered here.
create table if not exists public.mic_fed_statement_diffs (
  id uuid primary key default gen_random_uuid(),
  current_event_id uuid not null references public.market_events(id) on delete restrict,
  previous_event_id uuid references public.market_events(id) on delete restrict,
  current_document_hash text not null,
  previous_document_hash text,
  diff_hash text not null,
  meeting_date date not null,
  previous_meeting_date date,
  changed_paragraph_count integer not null check (changed_paragraph_count >= 0),
  material_change_count integer not null check (material_change_count >= 0),
  deterministic_diff jsonb not null,
  semantic_buckets text[] not null default '{}',
  ai_interpretation jsonb,
  model text,
  prompt_version text not null,
  generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- COALESCE makes first-statement rows idempotent too (NULLs in a normal
-- unique constraint would otherwise permit duplicates).
create unique index if not exists mic_fed_statement_diffs_identity_uidx
  on public.mic_fed_statement_diffs (
    current_event_id,
    coalesce(previous_event_id, '00000000-0000-0000-0000-000000000000'::uuid),
    diff_hash,
    prompt_version
  );
create index if not exists mic_fed_statement_diffs_meeting_idx
  on public.mic_fed_statement_diffs (meeting_date desc);

alter table public.mic_fed_statement_diffs enable row level security;
revoke all on public.mic_fed_statement_diffs from anon, authenticated;
grant select, insert, update on public.mic_fed_statement_diffs to service_role;
grant select on public.mic_fed_statement_diffs to authenticated;
drop policy if exists admin_select_mic_fed_statement_diffs on public.mic_fed_statement_diffs;
create policy admin_select_mic_fed_statement_diffs on public.mic_fed_statement_diffs
  for select to authenticated using ((select private.is_admin()));

drop trigger if exists trg_mic_fed_statement_diffs_updated_at on public.mic_fed_statement_diffs;
create trigger trg_mic_fed_statement_diffs_updated_at
before update on public.mic_fed_statement_diffs
for each row execute function public.kabumori_set_updated_at();
