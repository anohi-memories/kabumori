-- Market Intelligence Core (MIC) Phase 3A: State -> Scenario layer foundation.
--
-- NOT YET APPLIED ANYWHERE. Source-only candidate; once applied to a shared
-- database this file must never be edited again.
--
-- Facts -> State -> Scenario. A Scenario is a conditional synthesis across
-- several domain States ("under which conditions could things go which
-- way"). It never overwrites State, never forecasts prices and is not
-- connected to any consumer yet.
--
-- Tables (one scope, 'market', for now):
--   mic_scenario_evaluation_runs  claim / terminal status / usage link / audit
--   mic_scenario_current          the latest Scenario (one row per scope)
--   mic_scenario_history          append-only copy of each superseded current row
--   mic_scenario_evidence         append-only immutable snapshot of every State
--                                 the Scenario AI actually saw
--
-- One RPC, apply_mic_scenario_update, writes history + current + evidence +
-- the run's terminal 'evaluated' status in one transaction, after
-- re-verifying under lock that every source State is still exactly what the
-- evaluator read. no_change / failed runs are terminalized by a single
-- status=eq.running PATCH from the Edge Function (one statement, atomic).
--
-- Reads only market_state_current; writes nothing outside these four tables.
begin;

-- ---------------------------------------------------------------------------
-- 1. Evaluation runs
-- ---------------------------------------------------------------------------
create table if not exists public.mic_scenario_evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  scenario_key text not null check (scenario_key = 'market'),
  run_window text not null,
  attempt_no integer not null default 1 check (attempt_no >= 1),
  status text not null default 'running'
    check (status in ('running', 'no_change', 'evaluated', 'failed')),
  -- Deterministic identity of the State set a Scenario was built from; only
  -- set by apply_mic_scenario_update when the run becomes 'evaluated'.
  input_fingerprint text,
  decision_detail jsonb,
  ai_usage_event_id bigint references public.ai_usage_events(id),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error text,
  constraint mic_scenario_runs_evaluated_shape check (
    status <> 'evaluated' or (input_fingerprint is not null and ai_usage_event_id is not null and completed_at is not null)
  )
);

-- At most one running Scenario evaluation at a time: a second concurrent
-- invocation cannot claim, so it can never make a duplicate AI call.
create unique index if not exists mic_scenario_runs_one_running_uidx
  on public.mic_scenario_evaluation_runs (scenario_key) where status = 'running';
-- The same State set can produce at most one evaluated Scenario.
create unique index if not exists mic_scenario_runs_fingerprint_uidx
  on public.mic_scenario_evaluation_runs (input_fingerprint) where status = 'evaluated';
create index if not exists mic_scenario_runs_started_at_idx
  on public.mic_scenario_evaluation_runs (started_at desc);
create index if not exists mic_scenario_runs_window_attempt_idx
  on public.mic_scenario_evaluation_runs (scenario_key, run_window, attempt_no desc);

-- A terminal run (no_change / evaluated / failed) never changes again.
create or replace function public.mic_scenario_runs_guard_terminal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'running' then
    raise exception 'MIC_SCENARIO_RUN_TERMINAL_IMMUTABLE:%', old.status;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_mic_scenario_runs_guard_terminal on public.mic_scenario_evaluation_runs;
create trigger trg_mic_scenario_runs_guard_terminal
before update on public.mic_scenario_evaluation_runs
for each row execute function public.mic_scenario_runs_guard_terminal();

-- ---------------------------------------------------------------------------
-- 2. Current Scenario (one row per scope, seeded empty)
-- ---------------------------------------------------------------------------
create table if not exists public.mic_scenario_current (
  scenario_key text primary key check (scenario_key = 'market'),
  assessment_status text check (assessment_status in ('assessed', 'indeterminate')),
  base_case jsonb,
  upside_case jsonb,
  downside_case jsonb,
  state_conflicts jsonb,
  -- Stored confidence = min(AI's own confidence, data-quality cap); see the
  -- Edge Function (mic_scenario_state_logic.ts) for the cap rule.
  confidence numeric(4, 3) check (confidence is null or confidence between 0 and 1),
  ai_confidence numeric(4, 3) check (ai_confidence is null or ai_confidence between 0 and 1),
  -- Oldest ai_evaluated_at among the States used (the most dated input).
  state_as_of timestamptz,
  source_state_run_ids uuid[],
  source_state_domains text[],
  input_fingerprint text,
  source_scenario_run_id uuid references public.mic_scenario_evaluation_runs(id),
  prompt_version text,
  ai_model text,
  ai_input_tokens integer check (ai_input_tokens is null or ai_input_tokens >= 0),
  ai_output_tokens integer check (ai_output_tokens is null or ai_output_tokens >= 0),
  ai_cost_usd numeric(12, 8) check (ai_cost_usd is null or ai_cost_usd >= 0),
  ai_evaluated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mic_scenario_current_confidence_clamped check (
    confidence is null or ai_confidence is null or confidence <= ai_confidence
  )
);

drop trigger if exists trg_mic_scenario_current_updated_at on public.mic_scenario_current;
create trigger trg_mic_scenario_current_updated_at
before update on public.mic_scenario_current
for each row execute function public.kabumori_set_updated_at();

insert into public.mic_scenario_current (scenario_key)
values ('market')
on conflict (scenario_key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. History (append-only)
-- ---------------------------------------------------------------------------
create table if not exists public.mic_scenario_history (
  id uuid primary key default gen_random_uuid(),
  scenario_key text not null check (scenario_key = 'market'),
  -- The entire superseded mic_scenario_current row.
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  superseded_by_run_id uuid not null references public.mic_scenario_evaluation_runs(id) on delete restrict,
  created_at timestamptz not null default now()
);

create unique index if not exists mic_scenario_history_superseded_by_uidx
  on public.mic_scenario_history (superseded_by_run_id);
create index if not exists mic_scenario_history_created_idx
  on public.mic_scenario_history (scenario_key, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. Evidence: the immutable State snapshots the Scenario AI saw
-- ---------------------------------------------------------------------------
create table if not exists public.mic_scenario_evidence (
  id uuid primary key default gen_random_uuid(),
  scenario_run_id uuid not null references public.mic_scenario_evaluation_runs(id) on delete restrict,
  domain text not null check (domain in ('rates', 'macro', 'equity_index')),
  state_evaluation_run_id uuid not null references public.mic_state_evaluation_runs(id) on delete restrict,
  freshness text not null check (freshness in ('fresh', 'recent')),
  usability text not null check (usability in ('strong', 'weak')),
  state_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  constraint mic_scenario_evidence_snapshot_shape check (
    jsonb_typeof(state_snapshot) = 'object'
    and state_snapshot ?& array[
      'domain', 'narrative', 'bullish_factors', 'bearish_factors', 'key_risks', 'ai_confidence',
      'data_confidence', 'coverage_status', 'observation_status', 'ai_evaluated_at', 'source_evaluation_run_id'
    ]
    and (state_snapshot - array[
      'domain', 'narrative', 'bullish_factors', 'bearish_factors', 'key_risks', 'ai_confidence',
      'data_confidence', 'coverage_status', 'observation_status', 'ai_evaluated_at', 'source_evaluation_run_id'
    ]::text[]) = '{}'::jsonb
    and state_snapshot->>'domain' = domain
    and state_snapshot->>'source_evaluation_run_id' = state_evaluation_run_id::text
  )
);

create unique index if not exists mic_scenario_evidence_run_domain_uidx
  on public.mic_scenario_evidence (scenario_run_id, domain);
create index if not exists mic_scenario_evidence_state_run_idx
  on public.mic_scenario_evidence (state_evaluation_run_id);

-- History and evidence are append-only: no UPDATE / DELETE / TRUNCATE, even
-- for the table owner.
create or replace function public.mic_scenario_reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'MIC_SCENARIO_APPEND_ONLY:%', tg_table_name;
end;
$$;

drop trigger if exists trg_mic_scenario_history_reject_mutation on public.mic_scenario_history;
create trigger trg_mic_scenario_history_reject_mutation
before update or delete on public.mic_scenario_history
for each row execute function public.mic_scenario_reject_mutation();
drop trigger if exists trg_mic_scenario_history_reject_truncate on public.mic_scenario_history;
create trigger trg_mic_scenario_history_reject_truncate
before truncate on public.mic_scenario_history
for each statement execute function public.mic_scenario_reject_mutation();

drop trigger if exists trg_mic_scenario_evidence_reject_mutation on public.mic_scenario_evidence;
create trigger trg_mic_scenario_evidence_reject_mutation
before update or delete on public.mic_scenario_evidence
for each row execute function public.mic_scenario_reject_mutation();
drop trigger if exists trg_mic_scenario_evidence_reject_truncate on public.mic_scenario_evidence;
create trigger trg_mic_scenario_evidence_reject_truncate
before truncate on public.mic_scenario_evidence
for each statement execute function public.mic_scenario_reject_mutation();

-- ---------------------------------------------------------------------------
-- 5. RLS / grants -- same convention as the rest of MIC: service_role writes,
--    admins may read through RLS, anon gets nothing.
-- ---------------------------------------------------------------------------
alter table public.mic_scenario_evaluation_runs enable row level security;
alter table public.mic_scenario_current enable row level security;
alter table public.mic_scenario_history enable row level security;
alter table public.mic_scenario_evidence enable row level security;

revoke all on public.mic_scenario_evaluation_runs from public, anon, authenticated, service_role;
revoke all on public.mic_scenario_current from public, anon, authenticated, service_role;
revoke all on public.mic_scenario_history from public, anon, authenticated, service_role;
revoke all on public.mic_scenario_evidence from public, anon, authenticated, service_role;

grant select, insert, update on public.mic_scenario_evaluation_runs to service_role;
grant select, update on public.mic_scenario_current to service_role;
grant select, insert on public.mic_scenario_history to service_role;
grant select, insert on public.mic_scenario_evidence to service_role;

grant select on public.mic_scenario_evaluation_runs to authenticated;
grant select on public.mic_scenario_current to authenticated;
grant select on public.mic_scenario_history to authenticated;
grant select on public.mic_scenario_evidence to authenticated;

drop policy if exists admin_select_mic_scenario_evaluation_runs on public.mic_scenario_evaluation_runs;
create policy admin_select_mic_scenario_evaluation_runs on public.mic_scenario_evaluation_runs
  for select to authenticated using ((select private.is_admin()));
drop policy if exists admin_select_mic_scenario_current on public.mic_scenario_current;
create policy admin_select_mic_scenario_current on public.mic_scenario_current
  for select to authenticated using ((select private.is_admin()));
drop policy if exists admin_select_mic_scenario_history on public.mic_scenario_history;
create policy admin_select_mic_scenario_history on public.mic_scenario_history
  for select to authenticated using ((select private.is_admin()));
drop policy if exists admin_select_mic_scenario_evidence on public.mic_scenario_evidence;
create policy admin_select_mic_scenario_evidence on public.mic_scenario_evidence
  for select to authenticated using ((select private.is_admin()));

-- ---------------------------------------------------------------------------
-- 6. apply_mic_scenario_update
--
-- One transaction: validate -> lock + re-verify source States -> history ->
-- current -> evidence -> run 'evaluated'. Any RAISE rolls everything back.
--
-- Lock order: mic_scenario_current (FOR UPDATE, the only row per scope, so
-- Scenario writers are serialized) -> the run row (FOR UPDATE) -> the source
-- market_state_current rows (FOR SHARE, ordered by domain). State writers
-- (apply_mic_state_*) never touch Scenario tables, so no lock cycle exists;
-- a State write to a verified row simply waits until this commits.
--
-- Response-loss retry: a run reaches 'evaluated' only here. An evaluated run
-- that is (or was, per history) the writer of current returns
-- 'already_applied' without writing anything.
-- ---------------------------------------------------------------------------
create or replace function public.apply_mic_scenario_update(
  p_scenario_key text,
  p_run_id uuid,
  p_expected_current_updated_at timestamptz,
  p_input_fingerprint text,
  p_prompt_version text,
  p_assessment_status text,
  p_base_case jsonb,
  p_upside_case jsonb,
  p_downside_case jsonb,
  p_state_conflicts jsonb,
  p_confidence numeric,
  p_ai_confidence numeric,
  p_state_snapshots jsonb,
  p_evidence_meta jsonb,
  p_ai_model text,
  p_ai_input_tokens integer,
  p_ai_output_tokens integer,
  p_ai_cost_usd numeric,
  p_decision_detail jsonb,
  p_ai_usage_event_id bigint
)
returns table(result_status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_current public.mic_scenario_current%rowtype;
  v_run public.mic_scenario_evaluation_runs%rowtype;
  v_domains text[];
  v_run_ids uuid[];
  v_expected_fingerprint text;
  v_min_data_confidence numeric;
  v_state_as_of timestamptz;
  v_updated integer;
  v_keys constant text[] := array[
    'domain', 'narrative', 'bullish_factors', 'bearish_factors', 'key_risks', 'ai_confidence',
    'data_confidence', 'coverage_status', 'observation_status', 'ai_evaluated_at', 'source_evaluation_run_id'
  ];
begin
  select * into v_current from public.mic_scenario_current where scenario_key = p_scenario_key for update;
  if not found then
    raise exception 'MIC_SCENARIO_CURRENT_ROW_NOT_FOUND';
  end if;

  select * into v_run from public.mic_scenario_evaluation_runs where id = p_run_id for update;
  if not found then
    raise exception 'MIC_SCENARIO_RUN_NOT_FOUND';
  end if;
  if v_run.scenario_key <> p_scenario_key then
    raise exception 'MIC_SCENARIO_RUN_SCOPE_MISMATCH';
  end if;

  if v_run.status = 'evaluated' then
    if v_current.source_scenario_run_id = p_run_id or exists (
      select 1 from public.mic_scenario_history h
      where h.scenario_key = p_scenario_key and h.snapshot->>'source_scenario_run_id' = p_run_id::text
    ) then
      result_status := 'already_applied';
      return next;
      return;
    end if;
    raise exception 'MIC_SCENARIO_RUN_NOT_RUNNING:evaluated';
  end if;
  if v_current.source_scenario_run_id = p_run_id then
    raise exception 'MIC_SCENARIO_RUN_STATE_INCONSISTENT:%', v_run.status;
  end if;

  if p_expected_current_updated_at is null or v_current.updated_at is distinct from p_expected_current_updated_at then
    raise exception 'MIC_SCENARIO_STALE_DECISION';
  end if;
  if v_run.status <> 'running' then
    raise exception 'MIC_SCENARIO_RUN_NOT_RUNNING:%', v_run.status;
  end if;
  if v_current.updated_at > v_run.started_at then
    raise exception 'MIC_SCENARIO_STALE_RUN';
  end if;

  -- Output shape (the Edge Function validates content in detail; this is the
  -- last line of defence against a malformed write).
  if p_assessment_status is null or p_assessment_status not in ('assessed', 'indeterminate')
     or jsonb_typeof(p_base_case) is distinct from 'object'
     or jsonb_typeof(p_upside_case) is distinct from 'object'
     or jsonb_typeof(p_downside_case) is distinct from 'object'
     or jsonb_typeof(p_state_conflicts) is distinct from 'array'
     or p_prompt_version is null or length(p_prompt_version) = 0
     or p_ai_model is null or length(p_ai_model) = 0 then
    raise exception 'MIC_SCENARIO_OUTPUT_INVALID';
  end if;
  if p_decision_detail is null or jsonb_typeof(p_decision_detail) <> 'object' then
    raise exception 'MIC_SCENARIO_DECISION_DETAIL_INVALID';
  end if;
  if p_ai_confidence is null or p_ai_confidence < 0 or p_ai_confidence > 1
     or p_confidence is null or p_confidence < 0 or p_confidence > p_ai_confidence then
    raise exception 'MIC_SCENARIO_CONFIDENCE_INVALID';
  end if;

  -- The usage row must be this run's own Scenario AI call, for the model saved.
  if p_ai_usage_event_id is null or not exists (
    select 1 from public.ai_usage_events u
    where u.id = p_ai_usage_event_id
      and u.related_table = 'mic_scenario_evaluation_runs'
      and u.related_id = p_run_id::text
      and u.feature = 'mic_scenario_evaluation'
      and u.model = p_ai_model
  ) then
    raise exception 'MIC_SCENARIO_AI_USAGE_EVENT_RUN_MISMATCH';
  end if;

  -- State snapshots: strict shape, distinct allowed domains, at least two.
  if p_state_snapshots is null or jsonb_typeof(p_state_snapshots) <> 'array'
     or jsonb_array_length(p_state_snapshots) < 2 then
    raise exception 'MIC_SCENARIO_STATE_SNAPSHOT_INVALID';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_state_snapshots) as s(e)
    where case
      when jsonb_typeof(s.e) <> 'object' then true
      else not (s.e ?& v_keys)
        or (select count(*) from jsonb_object_keys(s.e)) <> 11
        or (s.e->>'domain') not in ('rates', 'macro', 'equity_index')
        or jsonb_typeof(s.e->'source_evaluation_run_id') <> 'string'
        or (s.e->>'source_evaluation_run_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(s.e->'data_confidence') <> 'number'
    end
  ) then
    raise exception 'MIC_SCENARIO_STATE_SNAPSHOT_INVALID';
  end if;

  select array_agg(s.e->>'domain' order by s.e->>'domain'),
         array_agg((s.e->>'source_evaluation_run_id')::uuid order by s.e->>'domain'),
         min((s.e->>'data_confidence')::numeric),
         min((s.e->>'ai_evaluated_at')::timestamptz)
  into v_domains, v_run_ids, v_min_data_confidence, v_state_as_of
  from jsonb_array_elements(p_state_snapshots) as s(e);

  if cardinality(v_domains) <> (select count(distinct d) from unnest(v_domains) as x(d)) then
    raise exception 'MIC_SCENARIO_STATE_SNAPSHOT_DUPLICATE';
  end if;

  -- The fingerprint must be exactly the one derived from these snapshots.
  v_expected_fingerprint := p_prompt_version || '|' || (
    select string_agg((s.e->>'domain') || ':' || (s.e->>'source_evaluation_run_id'), '|' order by s.e->>'domain')
    from jsonb_array_elements(p_state_snapshots) as s(e)
  );
  if p_input_fingerprint is distinct from v_expected_fingerprint then
    raise exception 'MIC_SCENARIO_FINGERPRINT_MISMATCH';
  end if;

  -- Confidence can never exceed the weakest input State's data quality.
  if p_confidence > v_min_data_confidence then
    raise exception 'MIC_SCENARIO_CONFIDENCE_ABOVE_STATE_QUALITY';
  end if;

  -- Evidence metadata: one {domain, freshness, usability} per snapshot.
  if p_evidence_meta is null or jsonb_typeof(p_evidence_meta) <> 'array'
     or jsonb_array_length(p_evidence_meta) <> cardinality(v_domains)
     or exists (
       select 1 from jsonb_array_elements(p_evidence_meta) as m(e)
       where jsonb_typeof(m.e) <> 'object'
         or (m.e->>'freshness') is null or (m.e->>'freshness') not in ('fresh', 'recent')
         or (m.e->>'usability') is null or (m.e->>'usability') not in ('strong', 'weak')
         or not ((m.e->>'domain') = any(v_domains))
     )
     or (select count(distinct m.e->>'domain') from jsonb_array_elements(p_evidence_meta) as m(e)) <> cardinality(v_domains) then
    raise exception 'MIC_SCENARIO_EVIDENCE_META_INVALID';
  end if;

  -- Hold the source States still and require them to be exactly what the
  -- evaluator read. Any change (a new narrative, or even a status-only
  -- refresh of the quality signals) means the Scenario was built on input
  -- that no longer holds: fail closed and let the next run rebuild it.
  perform 1 from public.market_state_current c
  where c.domain = any(v_domains)
  order by c.domain
  for share;

  if exists (
    select 1
    from jsonb_array_elements(p_state_snapshots) as s(e)
    left join public.market_state_current c on c.domain = s.e->>'domain'
    where c.domain is null
      or c.source_evaluation_run_id is distinct from (s.e->>'source_evaluation_run_id')::uuid
      or c.narrative is distinct from s.e->>'narrative'
      or coalesce(c.bullish_factors, 'null'::jsonb) is distinct from s.e->'bullish_factors'
      or coalesce(c.bearish_factors, 'null'::jsonb) is distinct from s.e->'bearish_factors'
      or coalesce(c.key_risks, 'null'::jsonb) is distinct from s.e->'key_risks'
      or c.ai_confidence is distinct from (s.e->>'ai_confidence')::numeric
      or c.data_confidence is distinct from (s.e->>'data_confidence')::numeric
      or c.coverage_status is distinct from s.e->>'coverage_status'
      or c.observation_status is distinct from s.e->>'observation_status'
      or c.ai_evaluated_at is distinct from (s.e->>'ai_evaluated_at')::timestamptz
  ) then
    raise exception 'MIC_SCENARIO_STATE_CHANGED_DURING_EVALUATION';
  end if;

  insert into public.mic_scenario_history (scenario_key, snapshot, superseded_by_run_id)
  values (p_scenario_key, to_jsonb(v_current), p_run_id);

  update public.mic_scenario_current
  set
    assessment_status = p_assessment_status,
    base_case = p_base_case,
    upside_case = p_upside_case,
    downside_case = p_downside_case,
    state_conflicts = p_state_conflicts,
    confidence = p_confidence,
    ai_confidence = p_ai_confidence,
    state_as_of = v_state_as_of,
    source_state_run_ids = v_run_ids,
    source_state_domains = v_domains,
    input_fingerprint = p_input_fingerprint,
    source_scenario_run_id = p_run_id,
    prompt_version = p_prompt_version,
    ai_model = p_ai_model,
    ai_input_tokens = p_ai_input_tokens,
    ai_output_tokens = p_ai_output_tokens,
    ai_cost_usd = p_ai_cost_usd,
    ai_evaluated_at = now()
  where scenario_key = p_scenario_key;

  insert into public.mic_scenario_evidence (
    scenario_run_id, domain, state_evaluation_run_id, freshness, usability, state_snapshot
  )
  select p_run_id, s.e->>'domain', (s.e->>'source_evaluation_run_id')::uuid,
         m.e->>'freshness', m.e->>'usability', s.e
  from jsonb_array_elements(p_state_snapshots) as s(e)
  join jsonb_array_elements(p_evidence_meta) as m(e) on m.e->>'domain' = s.e->>'domain';

  update public.mic_scenario_evaluation_runs
  set status = 'evaluated',
      input_fingerprint = p_input_fingerprint,
      decision_detail = p_decision_detail,
      ai_usage_event_id = p_ai_usage_event_id,
      completed_at = now(),
      error = null
  where id = p_run_id and status = 'running';
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'MIC_SCENARIO_RUN_COMPLETE_FAILED';
  end if;

  result_status := 'applied';
  return next;
end;
$$;

revoke all on function public.apply_mic_scenario_update(
  text, uuid, timestamptz, text, text, text, jsonb, jsonb, jsonb, jsonb, numeric, numeric,
  jsonb, jsonb, text, integer, integer, numeric, jsonb, bigint
) from public, anon, authenticated;
grant execute on function public.apply_mic_scenario_update(
  text, uuid, timestamptz, text, text, text, jsonb, jsonb, jsonb, jsonb, numeric, numeric,
  jsonb, jsonb, text, integer, integer, numeric, jsonb, bigint
) to service_role;

commit;
