-- Market Intelligence Core (MIC) State Evidence Phase 2C1.
--
-- Problem: market_state_current.source_event_ids (uuid[], added in the
-- original Phase 1B migration) records which market_events rows were
-- consulted for the CURRENT evaluation, but cannot answer, in a way that
-- is guaranteed rather than guessed:
--   1. which mic_state_evaluation_runs row produced the current narrative
--      (no FK from market_state_current back to the run that wrote it)
--   2. which mic_fed_statement_diffs row (if any) a central_bank_decision
--      event's deterministic diff / AI interpretation corresponds to
--   3. how to reconstruct, from a market_state_history row alone, exactly
--      which run and which immutable artifacts justified that historical
--      narrative
-- "Guess by matching timestamps" is explicitly not an acceptable answer
-- to any of the above -- this migration adds two additive, FK-backed
-- structures instead:
--   (a) market_state_current.source_evaluation_run_id -- a direct FK to
--       the mic_state_evaluation_runs row that most recently wrote this
--       domain's narrative via a material change. market_state_history
--       needs no new column: its snapshot already copies the ENTIRE
--       market_state_current row (including this new column) at the
--       moment it is superseded, so a past source_evaluation_run_id is
--       automatically preserved inside snapshot->>'source_evaluation_run_id'
--       with zero additional writer code.
--   (b) mic_state_evidence -- a dedicated, typed evidence table (NOT a
--       polymorphic source_table/source_id text pair, which would give up
--       FK integrity). One row per (run, artifact) pair. evidence_kind is
--       constrained to exactly one of two mutually-exclusive typed FK
--       columns being populated, enforced by a CHECK constraint, so a
--       market_event evidence row can never silently point at nothing (or
--       at both) and a fed_statement_diff evidence row is symmetrically
--       constrained.
--
-- Both structures are purely additive: market_state_current gains one
-- nullable column (existing rows are NULL, no backfill), and
-- mic_state_evidence is a brand-new table referenced by nothing else yet.
-- No existing column, table, or RLS policy is altered.
--
-- Scope of this phase: market_event and fed_statement_diff evidence only.
-- metric_observation evidence is deliberately deferred (market_metrics
-- already has its own dedupe-key uniqueness and is referenced via
-- numeric_baseline_snapshot; extending evidence_kind to cover it later
-- only needs one more nullable FK column + a CHECK constraint update, no
-- redesign).
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
  -- (source_table text, source_id text) pair. Exactly one of these two is
  -- non-null per row, enforced below.
  market_event_id uuid
    references public.market_events(id) on delete restrict,
  fed_statement_diff_id uuid
    references public.mic_fed_statement_diffs(id) on delete restrict,

  created_at timestamptz not null default now(),

  check (
    (
      evidence_kind = 'market_event'
      and market_event_id is not null
      and fed_statement_diff_id is null
    )
    or
    (
      evidence_kind = 'fed_statement_diff'
      and fed_statement_diff_id is not null
      and market_event_id is null
    )
  )
);

-- Idempotency: a retried write for the same run must never create a
-- second evidence row for the same artifact. Partial unique indexes
-- (rather than a single composite unique constraint across both nullable
-- FK columns) so each evidence_kind's uniqueness is independent and a
-- future third kind's column addition needs only its own new partial
-- index, not a change to these two.
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
revoke all on public.mic_state_evidence from anon, authenticated;
grant select, insert on public.mic_state_evidence to service_role;
grant select on public.mic_state_evidence to authenticated;
drop policy if exists admin_select_mic_state_evidence on public.mic_state_evidence;
create policy admin_select_mic_state_evidence on public.mic_state_evidence
  for select to authenticated using ((select private.is_admin()));

-- ---------------------------------------------------------------------------
-- apply_mic_state_material_update: the single atomic transaction that
-- replaces the Edge Function's previous 3-step
-- (GET market_state_current -> PATCH market_state_current -> POST
-- market_state_history) sequence, now also writing
-- source_evaluation_run_id and the evidence rows in the SAME transaction.
--
-- Every PL/pgSQL function body already runs as one implicit transaction
-- (a single top-level statement invoking it is atomic by Postgres's own
-- rules -- the same property the existing
-- record_mic_fed_statement_diff_usage RPC's header comment relies on): if
-- any RAISE EXCEPTION fires anywhere in this function, EVERY effect of
-- this invocation (the history insert, the current update, all evidence
-- inserts) is rolled back together. There is no code path that can leave
-- market_state_current updated while market_state_history or
-- mic_state_evidence is missing its corresponding row, or vice versa --
-- this is exactly the failure mode the previous 3-separate-HTTP-calls
-- design could not prevent.
--
-- Idempotency: locks the domain's single market_state_current row with
-- FOR UPDATE first (this table has exactly one row per domain, so this
-- also serializes concurrent calls for the same domain). If that row's
-- source_evaluation_run_id already equals p_run_id, this exact run's
-- material update has already been durably applied by a prior successful
-- call -- returns 'already_applied' immediately without writing
-- history/current/evidence again, so a caller retry after e.g. losing the
-- HTTP response (but the transaction actually committed) can never
-- duplicate a history row. This guard is a defensive backstop: under the
-- existing claim design (a domain+run_window's active-claim unique index
-- keeps holding a 'running'/'no_change'/'evaluated' row until it
-- terminates), the exact same run_id calling this RPC twice should not
-- happen in the normal Cron/manual-invoke path, since a fresh claim for
-- the same window is blocked while the old row is still 'running'. It
-- exists for correctness under retry/repair scenarios regardless.
--
-- Evidence rows use ON CONFLICT ... DO NOTHING against the two partial
-- unique indexes above, so calling this RPC again for a run that already
-- has SOME but not all of its evidence recorded (only possible if a
-- previous attempt failed before reaching this point, since a fully
-- successful attempt returns 'already_applied' before ever reaching the
-- evidence inserts again) still converges to the same final evidence set
-- without erroring on the rows that already exist.
create or replace function public.apply_mic_state_material_update(
  p_domain text,
  p_run_id uuid,
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
  p_market_event_evidence_ids uuid[] default '{}',
  p_fed_statement_diff_evidence_ids uuid[] default '{}'
)
returns table(result_status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_current public.market_state_current%rowtype;
  v_run_status text;
begin
  select * into v_current
  from public.market_state_current
  where domain = p_domain
  for update;

  if not found then
    raise exception 'MIC_STATE_CURRENT_ROW_NOT_FOUND';
  end if;

  if v_current.source_evaluation_run_id = p_run_id then
    result_status := 'already_applied';
    return next;
    return;
  end if;

  select status into v_run_status
  from public.mic_state_evaluation_runs
  where id = p_run_id
  for update;

  if not found then
    raise exception 'MIC_STATE_RUN_NOT_FOUND';
  end if;
  if v_run_status <> 'running' then
    raise exception 'MIC_STATE_RUN_NOT_RUNNING:%', v_run_status;
  end if;

  -- Snapshot the OLD row (as it stood before this update) into history --
  -- to_jsonb(v_current) already includes its own source_evaluation_run_id
  -- (the run that produced THAT narrative), so history automatically
  -- carries the previous evidence trail forward with no extra write.
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

  insert into public.mic_state_evidence (state_evaluation_run_id, evidence_kind, market_event_id)
  select p_run_id, 'market_event', ids.id
  from unnest(p_market_event_evidence_ids) as ids(id)
  on conflict (state_evaluation_run_id, market_event_id) where market_event_id is not null do nothing;

  insert into public.mic_state_evidence (state_evaluation_run_id, evidence_kind, fed_statement_diff_id)
  select p_run_id, 'fed_statement_diff', ids.id
  from unnest(p_fed_statement_diff_evidence_ids) as ids(id)
  on conflict (state_evaluation_run_id, fed_statement_diff_id) where fed_statement_diff_id is not null do nothing;

  result_status := 'applied';
  return next;
end;
$$;

revoke all on function public.apply_mic_state_material_update(
  text, uuid, timestamptz, text, text, text, numeric, text, jsonb, jsonb, jsonb, jsonb,
  text[], uuid[], text, numeric, integer, integer, numeric, text, uuid[], uuid[]
) from public, anon, authenticated;
grant execute on function public.apply_mic_state_material_update(
  text, uuid, timestamptz, text, text, text, numeric, text, jsonb, jsonb, jsonb, jsonb,
  text[], uuid[], text, numeric, integer, integer, numeric, text, uuid[], uuid[]
) to service_role;

commit;
