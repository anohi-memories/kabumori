-- Market Intelligence Core (MIC) State Evidence Phase 2C1.
--
-- NOT YET APPLIED TO PRODUCTION. This file is still being revised on a
-- review branch; once it is applied anywhere shared it must never be edited
-- again (a follow-up migration is required instead).
--
-- Problem: market_state_current.source_event_ids (uuid[], Phase 1B) records
-- which market_events rows were consulted for the CURRENT evaluation, but
-- cannot answer, in a way that is guaranteed rather than guessed:
--   1. which mic_state_evaluation_runs row produced the current narrative
--   2. which mic_fed_statement_diffs row a central_bank_decision event's
--      deterministic diff corresponds to
--   3. what the event content the AI actually saw was -- market_events rows
--      keep their canonical id while their content is corrected in place
--      (e.g. Fed historical reprocessing), so an id alone cannot reproduce
--      a past State's input months later
--   4. whether the run that wrote State actually finished -- State writes
--      and the run's terminal status were separate HTTP calls
--
-- This migration adds:
--   (a) market_state_current.source_evaluation_run_id -- FK to the run that
--       most recently wrote this domain's narrative. market_state_history
--       needs no new column: its snapshot copies the ENTIRE current row, so
--       a past source_evaluation_run_id is preserved automatically.
--   (b) mic_state_evidence -- typed, append-only evidence rows. A
--       market_event row stores both the FK and an immutable
--       market_event_snapshot of exactly the fields the evaluator used
--       (material judgment + AI facts). A fed_statement_diff row references
--       the append-only diff artifact.
--   (c) apply_mic_state_material_update -- ONE transaction for history,
--       current, evidence, and the run's terminal 'evaluated' status. It
--       re-verifies under lock that every event is unchanged since the
--       evaluator read it.
--   (d) apply_mic_state_no_change_update -- ONE transaction for the
--       status-only current refresh and the run's terminal 'no_change'
--       status.
--   (e) terminal-status protection on mic_state_evaluation_runs: once a run
--       is no_change/evaluated/failed its status can never change again.
--
-- Scope: market_event and fed_statement_diff evidence only. metric evidence
-- is deliberately deferred.
begin;

alter table public.market_state_current
  add column if not exists source_evaluation_run_id uuid
    references public.mic_state_evaluation_runs(id);

create table if not exists public.mic_state_evidence (
  id uuid primary key default gen_random_uuid(),

  state_evaluation_run_id uuid not null
    references public.mic_state_evaluation_runs(id) on delete restrict,

  evidence_kind text not null
    check (evidence_kind in ('market_event', 'fed_statement_diff')),

  -- Typed, mutually-exclusive FKs -- never a polymorphic
  -- (source_table, source_id) pair.
  market_event_id uuid
    references public.market_events(id) on delete restrict,
  fed_statement_diff_id uuid
    references public.mic_fed_statement_diffs(id) on delete restrict,

  -- The event content exactly as the evaluator read it and fed to material
  -- judgment / AI facts. market_events rows are mutable in place under a
  -- stable id; this copy is not, so the State input stays reproducible.
  market_event_snapshot jsonb,

  created_at timestamptz not null default now(),

  constraint mic_state_evidence_kind_shape_check check (
    (
      evidence_kind = 'market_event'
      and market_event_id is not null
      and market_event_snapshot is not null
      and fed_statement_diff_id is null
    )
    or
    (
      evidence_kind = 'fed_statement_diff'
      and fed_statement_diff_id is not null
      and market_event_id is null
      and market_event_snapshot is null
    )
  ),

  -- A snapshot must describe the very row its FK points at, and carry every
  -- field the evaluator uses.
  constraint mic_state_evidence_event_snapshot_check check (
    market_event_snapshot is null
    or (
      jsonb_typeof(market_event_snapshot) = 'object'
      and market_event_snapshot ?& array[
        'id', 'title', 'summary', 'importance', 'event_type', 'published_at', 'updated_at'
      ]
      and market_event_snapshot->>'id' = market_event_id::text
    )
  )
);

-- Idempotency: one evidence row per (run, artifact).
create unique index if not exists mic_state_evidence_run_event_uidx
  on public.mic_state_evidence (state_evaluation_run_id, market_event_id)
  where market_event_id is not null;
create unique index if not exists mic_state_evidence_run_diff_uidx
  on public.mic_state_evidence (state_evaluation_run_id, fed_statement_diff_id)
  where fed_statement_diff_id is not null;

create index if not exists mic_state_evidence_run_idx
  on public.mic_state_evidence (state_evaluation_run_id);
create index if not exists mic_state_evidence_market_event_idx
  on public.mic_state_evidence (market_event_id) where market_event_id is not null;
create index if not exists mic_state_evidence_fed_diff_idx
  on public.mic_state_evidence (fed_statement_diff_id) where fed_statement_diff_id is not null;

alter table public.mic_state_evidence enable row level security;
revoke all on public.mic_state_evidence from public, anon, authenticated;
grant select, insert on public.mic_state_evidence to service_role;
grant select on public.mic_state_evidence to authenticated;
drop policy if exists admin_select_mic_state_evidence on public.mic_state_evidence;
create policy admin_select_mic_state_evidence on public.mic_state_evidence
  for select to authenticated using ((select private.is_admin()));

-- Evidence is append-only. No role is granted UPDATE, and this trigger also
-- stops the table owner, so a stored snapshot can never be rewritten.
create or replace function public.mic_state_evidence_reject_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'MIC_STATE_EVIDENCE_IMMUTABLE';
end;
$$;

drop trigger if exists trg_mic_state_evidence_reject_update on public.mic_state_evidence;
create trigger trg_mic_state_evidence_reject_update
before update on public.mic_state_evidence
for each row execute function public.mic_state_evidence_reject_update();

-- Terminal run status protection. Every writer already filters on
-- status='running', but the database itself now guarantees that an
-- evaluated / no_change / failed run can never be moved to a different
-- status (e.g. evaluated -> failed after a lost response).
create or replace function public.mic_state_evaluation_runs_guard_terminal_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'running' and new.status is distinct from old.status then
    raise exception 'MIC_STATE_RUN_TERMINAL_STATUS_IMMUTABLE:%->%', old.status, new.status;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_mic_state_evaluation_runs_guard_terminal_status on public.mic_state_evaluation_runs;
create trigger trg_mic_state_evaluation_runs_guard_terminal_status
before update on public.mic_state_evaluation_runs
for each row execute function public.mic_state_evaluation_runs_guard_terminal_status();

-- ---------------------------------------------------------------------------
-- apply_mic_state_material_update
--
-- One transaction: validate -> history -> current -> evidence -> run
-- 'evaluated'. Any RAISE rolls back every effect of the invocation, so
-- State, history, evidence and the run's terminal status always agree.
--
-- Lock order: market_state_current (one row per domain, serializes writers
-- for the domain) -> the run row -> the evidence market_events rows
-- (FOR SHARE, so an ingest update to one of them waits until this
-- transaction commits and cannot slip in between verification and commit).
--
-- Response-loss retry: a run can only reach 'evaluated' through this
-- function. If the run is already 'evaluated' and this run is provably the
-- writer of current (or of a later-superseded current preserved in
-- history), return 'already_applied' without writing anything.
-- ---------------------------------------------------------------------------
create or replace function public.apply_mic_state_material_update(
  p_domain text,
  p_run_id uuid,
  p_expected_current_updated_at timestamptz,
  p_as_of timestamptz,
  p_coverage_status text,
  p_fetch_status text,
  p_observation_status text,
  p_data_confidence numeric,
  p_narrative text,
  p_bullish_factors jsonb,
  p_bearish_factors jsonb,
  p_key_risks jsonb,
  p_numeric_baseline_snapshot jsonb,
  p_source_metric_keys text[],
  p_source_event_ids uuid[],
  p_ai_model text,
  p_ai_confidence numeric,
  p_ai_input_tokens integer,
  p_ai_output_tokens integer,
  p_ai_cost_usd numeric,
  p_reason text,
  p_decision_detail jsonb,
  p_ai_usage_event_id bigint,
  p_market_event_snapshots jsonb,
  p_fed_statement_diff_evidence_ids uuid[]
)
returns table(result_status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_current public.market_state_current%rowtype;
  v_run_status text;
  v_run_domain text;
  v_run_started_at timestamptz;
  v_snapshot_ids uuid[];
  v_updated integer;
begin
  select * into v_current
  from public.market_state_current
  where domain = p_domain
  for update;
  if not found then
    raise exception 'MIC_STATE_CURRENT_ROW_NOT_FOUND';
  end if;

  select domain, status, started_at
  into v_run_domain, v_run_status, v_run_started_at
  from public.mic_state_evaluation_runs
  where id = p_run_id
  for update;
  if not found then
    raise exception 'MIC_STATE_RUN_NOT_FOUND';
  end if;
  if v_run_domain <> p_domain then
    raise exception 'MIC_STATE_RUN_DOMAIN_MISMATCH';
  end if;

  if v_run_status = 'evaluated' then
    if v_current.source_evaluation_run_id = p_run_id or exists (
      select 1 from public.market_state_history h
      where h.domain = p_domain
        and h.snapshot->>'source_evaluation_run_id' = p_run_id::text
    ) then
      result_status := 'already_applied';
      return next;
      return;
    end if;
    raise exception 'MIC_STATE_RUN_NOT_RUNNING:evaluated';
  end if;
  -- Under this design current can only name a run whose transaction also
  -- marked it evaluated; anything else is corruption, never a retry.
  if v_current.source_evaluation_run_id = p_run_id then
    raise exception 'MIC_STATE_RUN_STATE_INCONSISTENT:%', v_run_status;
  end if;

  -- The decision was computed from a pre-claim read of current. Any write
  -- since then (material or status-only) invalidates it.
  if p_expected_current_updated_at is null or
     v_current.updated_at is distinct from p_expected_current_updated_at then
    raise exception 'MIC_STATE_STALE_DECISION';
  end if;
  if v_run_status <> 'running' then
    raise exception 'MIC_STATE_RUN_NOT_RUNNING:%', v_run_status;
  end if;
  if v_current.updated_at > v_run_started_at then
    raise exception 'MIC_STATE_STALE_RUN';
  end if;

  if p_decision_detail is null or jsonb_typeof(p_decision_detail) <> 'object' then
    raise exception 'MIC_STATE_DECISION_DETAIL_INVALID';
  end if;
  if p_ai_usage_event_id is null then
    raise exception 'MIC_STATE_AI_USAGE_EVENT_REQUIRED';
  end if;

  -- Snapshot shape: an array of objects with exactly the evaluator's event
  -- fields and a well-formed id.
  if p_market_event_snapshots is null or jsonb_typeof(p_market_event_snapshots) <> 'array' then
    raise exception 'MIC_STATE_EVENT_SNAPSHOT_INVALID';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_market_event_snapshots) as s(e)
    where case
      when jsonb_typeof(s.e) <> 'object' then true
      else not (s.e ?& array['id', 'title', 'summary', 'importance', 'event_type', 'published_at', 'updated_at'])
        or (select count(*) from jsonb_object_keys(s.e)) <> 7
        or jsonb_typeof(s.e->'id') <> 'string'
        or (s.e->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    end
  ) then
    raise exception 'MIC_STATE_EVENT_SNAPSHOT_INVALID';
  end if;

  select coalesce(array_agg((s.e->>'id')::uuid), '{}'::uuid[])
  into v_snapshot_ids
  from jsonb_array_elements(p_market_event_snapshots) as s(e);

  -- Evidence must describe exactly the event set saved on current as
  -- source_event_ids (and supplied to the AI).
  if exists (
    select id from unnest(coalesce(p_source_event_ids, '{}'::uuid[])) as ids(id)
    except
    select id from unnest(v_snapshot_ids) as ids(id)
  ) or exists (
    select id from unnest(v_snapshot_ids) as ids(id)
    except
    select id from unnest(coalesce(p_source_event_ids, '{}'::uuid[])) as ids(id)
  ) then
    raise exception 'MIC_STATE_EVENT_EVIDENCE_MISMATCH';
  end if;

  -- Hold every evidence event still until commit, then verify each one is
  -- byte-for-byte what the evaluator read before calling AI. A missing row
  -- or any differing field means State would be built on stale input.
  perform 1
  from public.market_events m
  where m.id = any(v_snapshot_ids)
  order by m.id
  for share;

  if exists (
    select 1
    from jsonb_array_elements(p_market_event_snapshots) as s(e)
    left join public.market_events m on m.id = (s.e->>'id')::uuid
    where m.id is null
      or m.title is distinct from s.e->>'title'
      or m.summary is distinct from s.e->>'summary'
      or m.importance is distinct from s.e->>'importance'
      or m.event_type is distinct from s.e->>'event_type'
      or m.published_at is distinct from (s.e->>'published_at')::timestamptz
      or m.updated_at is distinct from (s.e->>'updated_at')::timestamptz
  ) then
    raise exception 'MIC_STATE_EVENT_CHANGED_DURING_EVALUATION';
  end if;

  -- A Fed diff is evidence for its own current market_event only.
  if exists (
    select 1 from public.mic_fed_statement_diffs d
    where d.id = any(coalesce(p_fed_statement_diff_evidence_ids, '{}'::uuid[]))
      and not (d.current_event_id = any(v_snapshot_ids))
  ) then
    raise exception 'MIC_STATE_FED_DIFF_EVENT_MISMATCH';
  end if;

  insert into public.market_state_history (domain, as_of, snapshot, triggered_by, reason)
  values (p_domain, v_current.as_of, to_jsonb(v_current), 'material_change', p_reason);

  update public.market_state_current
  set
    as_of = p_as_of,
    narrative = p_narrative,
    bullish_factors = p_bullish_factors,
    bearish_factors = p_bearish_factors,
    key_risks = p_key_risks,
    numeric_baseline_snapshot = p_numeric_baseline_snapshot,
    source_metric_keys = p_source_metric_keys,
    source_event_ids = p_source_event_ids,
    source_evaluation_run_id = p_run_id,
    ai_model = p_ai_model,
    ai_confidence = p_ai_confidence,
    ai_input_tokens = p_ai_input_tokens,
    ai_output_tokens = p_ai_output_tokens,
    ai_cost_usd = p_ai_cost_usd,
    ai_evaluated_at = now(),
    coverage_status = p_coverage_status,
    fetch_status = p_fetch_status,
    observation_status = p_observation_status,
    data_confidence = p_data_confidence
  where domain = p_domain;

  insert into public.mic_state_evidence (
    state_evaluation_run_id, evidence_kind, market_event_id, market_event_snapshot
  )
  select p_run_id, 'market_event', (s.e->>'id')::uuid, s.e
  from jsonb_array_elements(p_market_event_snapshots) as s(e)
  on conflict (state_evaluation_run_id, market_event_id) where market_event_id is not null do nothing;

  insert into public.mic_state_evidence (state_evaluation_run_id, evidence_kind, fed_statement_diff_id)
  select p_run_id, 'fed_statement_diff', ids.id
  from unnest(coalesce(p_fed_statement_diff_evidence_ids, '{}'::uuid[])) as ids(id)
  on conflict (state_evaluation_run_id, fed_statement_diff_id) where fed_statement_diff_id is not null do nothing;

  update public.mic_state_evaluation_runs
  set
    status = 'evaluated',
    decision_detail = p_decision_detail,
    ai_usage_event_id = p_ai_usage_event_id,
    completed_at = now(),
    error = null
  where id = p_run_id and status = 'running';
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'MIC_STATE_RUN_COMPLETE_FAILED';
  end if;

  result_status := 'applied';
  return next;
end;
$$;

revoke all on function public.apply_mic_state_material_update(
  text, uuid, timestamptz, timestamptz, text, text, text, numeric, text, jsonb, jsonb, jsonb, jsonb,
  text[], uuid[], text, numeric, integer, integer, numeric, text, jsonb, bigint, jsonb, uuid[]
) from public, anon, authenticated;
grant execute on function public.apply_mic_state_material_update(
  text, uuid, timestamptz, timestamptz, text, text, text, numeric, text, jsonb, jsonb, jsonb, jsonb,
  text[], uuid[], text, numeric, integer, integer, numeric, text, jsonb, bigint, jsonb, uuid[]
) to service_role;

-- ---------------------------------------------------------------------------
-- apply_mic_state_no_change_update
--
-- One transaction: status-only current CAS update + run 'no_change'. Never
-- touches narrative/baseline/ai_*/source_* columns and writes no history
-- (routine status ticks are not interpretive changes).
--
-- Response-loss retry: a run can only reach 'no_change' through this
-- function, so an already-'no_change' run returns 'already_applied'.
-- ---------------------------------------------------------------------------
create or replace function public.apply_mic_state_no_change_update(
  p_domain text,
  p_run_id uuid,
  p_expected_current_updated_at timestamptz,
  p_as_of timestamptz,
  p_coverage_status text,
  p_fetch_status text,
  p_observation_status text,
  p_data_confidence numeric,
  p_decision_detail jsonb
)
returns table(result_status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_current public.market_state_current%rowtype;
  v_run_status text;
  v_run_domain text;
  v_run_started_at timestamptz;
  v_updated integer;
begin
  select * into v_current
  from public.market_state_current
  where domain = p_domain
  for update;
  if not found then
    raise exception 'MIC_STATE_CURRENT_ROW_NOT_FOUND';
  end if;

  select domain, status, started_at
  into v_run_domain, v_run_status, v_run_started_at
  from public.mic_state_evaluation_runs
  where id = p_run_id
  for update;
  if not found then
    raise exception 'MIC_STATE_RUN_NOT_FOUND';
  end if;
  if v_run_domain <> p_domain then
    raise exception 'MIC_STATE_RUN_DOMAIN_MISMATCH';
  end if;

  if v_run_status = 'no_change' then
    result_status := 'already_applied';
    return next;
    return;
  end if;

  if p_expected_current_updated_at is null or
     v_current.updated_at is distinct from p_expected_current_updated_at then
    raise exception 'MIC_STATE_STALE_DECISION';
  end if;
  if v_run_status <> 'running' then
    raise exception 'MIC_STATE_RUN_NOT_RUNNING:%', v_run_status;
  end if;
  if v_current.updated_at > v_run_started_at then
    raise exception 'MIC_STATE_STALE_RUN';
  end if;

  if p_decision_detail is null or jsonb_typeof(p_decision_detail) <> 'object' then
    raise exception 'MIC_STATE_DECISION_DETAIL_INVALID';
  end if;

  update public.market_state_current
  set
    as_of = p_as_of,
    coverage_status = p_coverage_status,
    fetch_status = p_fetch_status,
    observation_status = p_observation_status,
    data_confidence = p_data_confidence
  where domain = p_domain;

  update public.mic_state_evaluation_runs
  set
    status = 'no_change',
    decision_detail = p_decision_detail,
    ai_usage_event_id = null,
    completed_at = now(),
    error = null
  where id = p_run_id and status = 'running';
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'MIC_STATE_RUN_COMPLETE_FAILED';
  end if;

  result_status := 'applied';
  return next;
end;
$$;

revoke all on function public.apply_mic_state_no_change_update(
  text, uuid, timestamptz, timestamptz, text, text, text, numeric, jsonb
) from public, anon, authenticated;
grant execute on function public.apply_mic_state_no_change_update(
  text, uuid, timestamptz, timestamptz, text, text, text, numeric, jsonb
) to service_role;

commit;
