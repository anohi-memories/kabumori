-- SOURCE CANDIDATE ONLY. Do not apply to production until a separately reviewed activation
-- (Codex review of N3 first). Local disposable validation: supabase/tests/news_discovery_observer_run.sh
--
-- News discovery observer (N3): observation-only storage for the N2 pipeline
-- (supabase/functions/_shared/news_discovery/, Function news-discovery-observer).
--
-- * New objects only, all prefixed news_discovery_. No existing table, function, policy or grant
--   is altered (important_news_candidates, important_news_monitor_runs, ai_usage_events, shadow and
--   stocks_master are untouched).
-- * Nothing user-facing reads these tables. RLS is enabled with no policies; anon/authenticated
--   get nothing; service_role may SELECT for inspection only. All writes go through the
--   SECURITY DEFINER functions below, executable by service_role only.
-- * Source policy (N1 terms review) is enforced here too: DISCOVERY_ONLY (GDELT) and
--   SEARCH_DISCOVERY (the observer's own limited Web Search) rows can never carry a summary, an image
--   or a displayable title.
-- * Limited Web Search (N3 v2): a daily soft budget / hard cap / per-theme cooldown are enforced by
--   news_discovery_reserve_search under an advisory lock, reading news_discovery_search_config.
--   Model calls are only allowed as part of a search (ai_calls <= search_count).
-- * Dedupe safety (N2, learned from live data): the same source may reuse a title for a new
--   document (官邸 missile-launch instructions, Federal Register notices), so there is NO unique
--   constraint on title or URL; identity is the fingerprint id (source + external id, or
--   URL key + title fingerprint) and (source_id, external_id).
--
-- Transaction: one explicit transaction; not re-runnable (guarded). Rollback:
-- supabase/tests/news_discovery_observer_rollback.sql.
begin;

do $$
begin
  if to_regclass('public.news_discovery_runs') is not null
     or to_regclass('public.news_discovery_signals') is not null then
    raise exception 'NEWS_DISCOVERY_PRECONDITION_ALREADY_APPLIED';
  end if;
end $$;

-- ------------------------------------------------------------------------------------------------
-- Runs: one row per observer invocation.
create table public.news_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  trigger_type text not null check (trigger_type in ('manual', 'scheduled', 'local_validation')),
  status text not null default 'running'
    check (status in ('running', 'completed', 'completed_with_errors', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  code_version text check (code_version is null or char_length(code_version) <= 64),
  requested_sources text[] not null default '{}',
  source_count integer not null default 0 check (source_count >= 0),
  successful_sources integer not null default 0 check (successful_sources >= 0),
  failed_sources integer not null default 0 check (failed_sources >= 0),
  http_requests integer not null default 0 check (http_requests >= 0),
  fetched_count integer not null default 0 check (fetched_count >= 0),
  filtered_count integer not null default 0 check (filtered_count >= 0),
  normalized_count integer not null default 0 check (normalized_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  inserted_count integer not null default 0 check (inserted_count >= 0),
  insert_conflict_count integer not null default 0 check (insert_conflict_count >= 0),
  topic_matched_count integer not null default 0 check (topic_matched_count >= 0),
  ticker_confirmed_count integer not null default 0 check (ticker_confirmed_count >= 0),
  ticker_candidate_count integer not null default 0 check (ticker_candidate_count >= 0),
  -- Web Search (N3 v2): model calls exist only as part of a budgeted search.
  search_count integer not null default 0 check (search_count >= 0),
  search_denied_count integer not null default 0 check (search_denied_count >= 0),
  search_result_count integer not null default 0 check (search_result_count >= 0),
  search_useful_signal_count integer not null default 0 check (search_useful_signal_count >= 0),
  search_duplicate_count integer not null default 0 check (search_duplicate_count >= 0),
  ai_calls integer not null default 0 check (ai_calls >= 0),
  web_search_calls integer not null default 0 check (web_search_calls >= 0),
  check (ai_calls <= search_count),
  error_summary text check (error_summary is null or char_length(error_summary) <= 2000),
  -- Deadline / progress facts (deadline_reached, sources/searches completed or skipped,
  -- signals_persisted, elapsed_ms). One small object instead of more columns.
  execution jsonb not null default '{}'::jsonb
    check (jsonb_typeof(execution) = 'object' and octet_length(execution::text) <= 2000),
  check ((status = 'running') = (completed_at is null)),
  check (successful_sources + failed_sources <= source_count)
);
create index news_discovery_runs_started_idx on public.news_discovery_runs (started_at desc);

-- Per-source result of a run (the code registry stays canonical; policy is recorded per run).
create table public.news_discovery_run_sources (
  run_id uuid not null references public.news_discovery_runs (id) on delete cascade,
  source_id text not null check (source_id ~ '^[a-z0-9_]{2,64}$'),
  policy text not null check (policy in ('DIRECT_SOURCE', 'DISCOVERY_ONLY', 'SEARCH_DISCOVERY', 'DISABLED')),
  outcome text not null check (outcome in ('ok', 'partial', 'failed', 'refused')),
  -- [{via, outcome, http_status, duration_ms, items, detail}] — codes only, never article text.
  requests jsonb not null default '[]'::jsonb check (jsonb_typeof(requests) = 'array'),
  raw_items integer not null default 0 check (raw_items >= 0),
  filtered integer not null default 0 check (filtered >= 0),
  normalized integer not null default 0 check (normalized >= 0),
  duplicates integer not null default 0 check (duplicates >= 0),
  inserted integer not null default 0 check (inserted >= 0),
  with_published_at integer not null default 0 check (with_published_at >= 0),
  with_topic integer not null default 0 check (with_topic >= 0),
  with_confirmed_ticker integer not null default 0 check (with_confirmed_ticker >= 0),
  duration_ms integer not null default 0 check (duration_ms >= 0),
  primary key (run_id, source_id)
);

-- ------------------------------------------------------------------------------------------------
-- Limited Web Search budget (single row; the authority for soft budget / hard cap).
create table public.news_discovery_search_config (
  id boolean primary key default true check (id),
  daily_soft_budget integer not null check (daily_soft_budget between 0 and 500),
  daily_hard_limit integer not null check (daily_hard_limit between 0 and 500),
  lane_rotation_interval_minutes integer not null check (lane_rotation_interval_minutes between 10 and 10080),
  search_key_cooldown_minutes integer not null check (search_key_cooldown_minutes between 0 and 10080),
  max_escalations_per_key_per_day integer not null check (max_escalations_per_key_per_day between 0 and 5),
  updated_at timestamptz not null default now(),
  check (daily_soft_budget <= daily_hard_limit)
);
-- Same values as SEARCH_BUDGET_DEFAULTS (search_config.ts). Change both together.
insert into public.news_discovery_search_config
  (daily_soft_budget, daily_hard_limit, lane_rotation_interval_minutes, search_key_cooldown_minutes, max_escalations_per_key_per_day)
values (30, 48, 360, 180, 1);

-- One row per search attempt (reserved before the provider call, so the cap holds under concurrency).
create table public.news_discovery_searches (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.news_discovery_runs (id) on delete set null,
  search_day date not null, -- JST budget day
  lane text not null check (lane in ('WORLD', 'MARKET', 'ENERGY', 'JAPAN', 'TECH')),
  reason text not null check (reason in ('scheduled_rotation', 'trigger_market_anomaly', 'trigger_discovery_signal', 'escalation', 'manual')),
  search_key text not null check (char_length(search_key) between 1 and 200),
  triggered_by text check (triggered_by is null or char_length(triggered_by) <= 200),
  parent_search_id uuid references public.news_discovery_searches (id) on delete set null,
  query text not null check (char_length(query) between 1 and 500),
  provider text not null check (char_length(provider) <= 64),
  model text not null check (char_length(model) <= 64),
  status text not null check (status in ('reserved', 'succeeded', 'failed', 'denied')),
  deny_reason text check (deny_reason in ('hard_cap', 'soft_budget', 'duplicate_search_key', 'escalation_limit', 'bad_parent')),
  error_code text check (error_code is null or char_length(error_code) <= 64),
  result_count integer not null default 0 check (result_count >= 0),
  new_signal_count integer not null default 0 check (new_signal_count >= 0),
  useful_signal_count integer not null default 0 check (useful_signal_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  restricted_count integer not null default 0 check (restricted_count >= 0),
  policy_blocked_count integer not null default 0 check (policy_blocked_count >= 0),
  rejected_unverified_count integer not null default 0 check (rejected_unverified_count >= 0),
  -- Counted by complete_search from news_discovery_signals (search_id), i.e. what was really stored.
  -- new/useful_signal_count above are the in-memory discovered candidates.
  persisted_signal_count integer not null default 0 check (persisted_signal_count >= 0),
  persisted_useful_signal_count integer not null default 0 check (persisted_useful_signal_count >= 0),
  model_calls integer not null default 0 check (model_calls between 0 and 1),
  web_search_calls integer not null default 0 check (web_search_calls between 0 and 5),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  reserved_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((status = 'denied') = (deny_reason is not null)),
  -- Only escalations have a parent; an escalation that actually ran always has one.
  check (parent_search_id is null or reason = 'escalation'),
  check (reason <> 'escalation' or status = 'denied' or parent_search_id is not null),
  check (useful_signal_count <= new_signal_count and new_signal_count <= result_count),
  check (persisted_useful_signal_count <= persisted_signal_count)
);
create index news_discovery_searches_day_idx on public.news_discovery_searches (search_day, status);
create index news_discovery_searches_key_idx on public.news_discovery_searches (search_key, reserved_at desc);

-- ------------------------------------------------------------------------------------------------
-- Signals: one normalized item. Insert-only.
create table public.news_discovery_signals (
  id text primary key check (id ~ '^[0-9a-f]{64}$'), -- = fingerprint
  first_run_id uuid references public.news_discovery_runs (id) on delete set null,
  source_id text not null check (source_id ~ '^[a-z0-9_]{2,64}$'),
  source_type text not null
    check (source_type in ('rss', 'atom', 'rdf', 'federal_register_json', 'gdelt_doc_json', 'edinet_documents_json', 'web_search')),
  policy text not null check (policy in ('DIRECT_SOURCE', 'DISCOVERY_ONLY', 'SEARCH_DISCOVERY')),
  discovery_only boolean not null,
  -- Web Search result from a publisher that may not be fetched directly (never crawled, never shown).
  restricted_publisher boolean not null default false,
  search_id uuid references public.news_discovery_searches (id) on delete set null,
  discovered_via text not null check (char_length(discovered_via) <= 100),
  source_url text not null check (source_url ~ '^https?://' and char_length(source_url) <= 2048),
  canonical_url text not null check (canonical_url ~ '^https?://' and char_length(canonical_url) <= 2048),
  url_key text not null check (char_length(url_key) <= 2048),
  external_id text check (external_id is null or char_length(external_id) <= 512),
  title text not null check (char_length(title) between 1 and 1000),
  title_fingerprint text not null check (title_fingerprint ~ '^[0-9a-f]{32}$'),
  title_display_allowed boolean not null,
  summary_hint text check (summary_hint is null or char_length(summary_hint) <= 280),
  -- Never invented: datetime precision -> published_at; date-only (Federal Register) -> published_date.
  published_at timestamptz,
  published_date date,
  published_at_precision text check (published_at_precision in ('datetime', 'date')),
  source_updated_at timestamptz, -- Atom <updated>; not relabelled as published
  detected_at timestamptz, -- discovery service first-seen (GDELT seendate); not a publication time
  fetched_at timestamptz not null, -- observer first fetch = benchmark new_first_seen_at
  language text not null check (char_length(language) <= 32),
  country text not null check (char_length(country) <= 64),
  publisher text not null check (char_length(publisher) <= 300),
  topics text[] not null default '{}' check (topics <@ array[
    'monetary_policy', 'rates', 'fx', 'energy', 'oil', 'geopolitics', 'war', 'sanctions', 'tariffs',
    'semiconductor', 'ai', 'regulation', 'disaster', 'cyber', 'mna', 'earnings', 'product', 'lawsuit',
    'recall', 'supply_chain', 'fiscal', 'macro_data']::text[]),
  needs_verification text[] not null default '{}' check (needs_verification <@ array[
    'no_published_at', 'date_only_precision', 'future_timestamp', 'discovery_only_needs_primary',
    'restricted_publisher_needs_primary', 'weak_ticker_only']::text[]),
  same_event_group text check (same_event_group is null or same_event_group ~ '^[0-9a-f]{64}$'),
  image_url text check (image_url is null or char_length(image_url) <= 2048),
  image_usage_allowed boolean not null default false,
  raw_reference jsonb not null check (jsonb_typeof(raw_reference) = 'object'),
  created_at timestamptz not null default now(),
  check ((policy <> 'DIRECT_SOURCE') = discovery_only),
  check (policy <> 'SEARCH_DISCOVERY' or source_type = 'web_search'),
  check (not restricted_publisher or discovery_only),
  -- Discovery sources (GDELT, Web Search): metadata only.
  check (not discovery_only or (summary_hint is null and image_url is null and not title_display_allowed
                                and not image_usage_allowed)),
  check (not discovery_only or (
    raw_reference - array['feed_url', 'item_index']::text[] = '{}'::jsonb
    and (not (raw_reference ? 'feed_url') or jsonb_typeof(raw_reference -> 'feed_url') = 'string')
    and (not (raw_reference ? 'item_index') or jsonb_typeof(raw_reference -> 'item_index') = 'number')
  )),
  check (image_url is null or image_usage_allowed),
  check (
    (published_at_precision is null and published_at is null and published_date is null)
    or (published_at_precision = 'datetime' and published_at is not null and published_date is null)
    or (published_at_precision = 'date' and published_date is not null and published_at is null)
  )
);
-- Same source + same external id is the same document. Titles and URLs are intentionally not unique.
create unique index news_discovery_signals_source_external_uidx
  on public.news_discovery_signals (source_id, external_id) where external_id is not null;
create index news_discovery_signals_canonical_idx on public.news_discovery_signals (canonical_url);
create index news_discovery_signals_url_key_idx on public.news_discovery_signals (url_key);
create index news_discovery_signals_title_fp_idx on public.news_discovery_signals (title_fingerprint, fetched_at desc);
create index news_discovery_signals_fetched_idx on public.news_discovery_signals (fetched_at desc);
create index news_discovery_signals_source_fetched_idx on public.news_discovery_signals (source_id, fetched_at desc);
create index news_discovery_signals_topics_gin on public.news_discovery_signals using gin (topics);
create index news_discovery_signals_search_idx on public.news_discovery_signals (search_id) where search_id is not null;

create table public.news_discovery_signal_tickers (
  signal_id text not null references public.news_discovery_signals (id) on delete cascade,
  ticker_code text not null check (ticker_code ~ '^[0-9]{3}[0-9A-Z]$'),
  status text not null check (status in ('confirmed', 'candidate')),
  confirmation_basis text check (confirmation_basis in ('strong_match', 'ticker_code', 'weak_with_context', 'multiple_weak')),
  match_types text[] not null check (
    cardinality(match_types) >= 1
    and match_types <@ array['EXACT_COMPANY_NAME', 'STRONG_ALIAS', 'WEAK_ALIAS', 'TICKER_CODE']::text[]),
  matched_aliases text[] not null default '{}',
  in_title boolean not null,
  confidence numeric(3, 2) not null check (confidence between 0 and 1),
  alias_dictionary_version text not null check (char_length(alias_dictionary_version) <= 64),
  primary key (signal_id, ticker_code),
  -- A confirmed ticker always says why; a weak alias alone is never "strong_match".
  check ((status = 'confirmed') = (confirmation_basis is not null)),
  check (confirmation_basis is distinct from 'strong_match'
         or match_types && array['EXACT_COMPANY_NAME', 'STRONG_ALIAS']::text[]),
  check (confirmation_basis is distinct from 'ticker_code' or 'TICKER_CODE' = any (match_types)),
  check (confirmation_basis not in ('weak_with_context', 'multiple_weak') or match_types = array['WEAK_ALIAS']::text[]),
  check (confirmation_basis is distinct from 'multiple_weak' or cardinality(matched_aliases) >= 2)
);
create index news_discovery_signal_tickers_ticker_idx on public.news_discovery_signal_tickers (ticker_code, status);

create table public.news_discovery_signal_entities (
  signal_id text not null references public.news_discovery_signals (id) on delete cascade,
  entity_type text not null check (entity_type in ('country_or_region', 'institution', 'chokepoint', 'commodity', 'company_alias')),
  entity_value text not null check (char_length(entity_value) between 1 and 200),
  confidence numeric(3, 2) not null default 1.00 check (confidence between 0 and 1),
  method text not null default 'dictionary' check (method in ('dictionary')),
  primary key (signal_id, entity_type, entity_value)
);
create index news_discovery_signal_entities_value_idx on public.news_discovery_signal_entities (entity_type, entity_value);

-- ------------------------------------------------------------------------------------------------
-- Privileges: no client access; service_role reads for inspection; writes only via functions.
alter table public.news_discovery_runs enable row level security;
alter table public.news_discovery_run_sources enable row level security;
alter table public.news_discovery_signals enable row level security;
alter table public.news_discovery_signal_tickers enable row level security;
alter table public.news_discovery_signal_entities enable row level security;
alter table public.news_discovery_search_config enable row level security;
alter table public.news_discovery_searches enable row level security;
revoke all on public.news_discovery_runs, public.news_discovery_run_sources, public.news_discovery_signals,
  public.news_discovery_signal_tickers, public.news_discovery_signal_entities,
  public.news_discovery_search_config, public.news_discovery_searches
  from public, anon, authenticated, service_role;
grant select on public.news_discovery_runs, public.news_discovery_run_sources, public.news_discovery_signals,
  public.news_discovery_signal_tickers, public.news_discovery_signal_entities,
  public.news_discovery_search_config, public.news_discovery_searches
  to service_role;

-- ------------------------------------------------------------------------------------------------
-- begin_run: {trigger_type, requested_sources[], code_version} -> {run_id}
create function public.news_discovery_begin_run(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_sources text[];
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'NEWS_DISCOVERY_BAD_INPUT'; end if;
  select coalesce(array_agg(value), '{}') into v_sources
    from jsonb_array_elements_text(coalesce(p -> 'requested_sources', '[]'::jsonb));
  if cardinality(v_sources) > 100 then raise exception 'NEWS_DISCOVERY_TOO_MANY_SOURCES'; end if;
  insert into public.news_discovery_runs (trigger_type, requested_sources, code_version)
  values (coalesce(p ->> 'trigger_type', 'manual'), v_sources, p ->> 'code_version')
  returning id into v_id;
  return jsonb_build_object('run_id', v_id);
end;
$$;

-- find_duplicates: {lookups:[{i, source_id, external_id, canonical_url, url_key, title_fingerprint,
--   title_fingerprint_any, since}]} -> [{i, reason, signal_id}]
-- Mirrors store.ts InMemoryNewsSignalStore.findDuplicate exactly:
--   1 same source + external id; 2 canonical URL / 3 URL key, but from the same source only when the
--   title is also the same; 4 title fingerprint only from a DIFFERENT source within the window.
create function public.news_discovery_find_duplicates(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_lookup jsonb;
  v_hit record;
begin
  if p is null or jsonb_typeof(p -> 'lookups') <> 'array' then raise exception 'NEWS_DISCOVERY_BAD_INPUT'; end if;
  if jsonb_array_length(p -> 'lookups') > 500 then raise exception 'NEWS_DISCOVERY_BATCH_TOO_LARGE'; end if;
  for v_lookup in select value from jsonb_array_elements(p -> 'lookups') loop
    v_hit := null;
    if v_lookup ->> 'external_id' is not null then
      select 'source_external_id' as reason, s.id into v_hit from public.news_discovery_signals s
        where s.source_id = v_lookup ->> 'source_id' and s.external_id = v_lookup ->> 'external_id' limit 1;
    end if;
    if v_hit is null then
      select 'canonical_url' as reason, s.id into v_hit from public.news_discovery_signals s
        where s.canonical_url = v_lookup ->> 'canonical_url'
          and (s.source_id <> v_lookup ->> 'source_id' or s.title_fingerprint = v_lookup ->> 'title_fingerprint_any')
        order by s.fetched_at, s.id limit 1;
    end if;
    if v_hit is null then
      select 'normalized_url' as reason, s.id into v_hit from public.news_discovery_signals s
        where s.url_key = v_lookup ->> 'url_key'
          and (s.source_id <> v_lookup ->> 'source_id' or s.title_fingerprint = v_lookup ->> 'title_fingerprint_any')
        order by s.fetched_at, s.id limit 1;
    end if;
    if v_hit is null and v_lookup ->> 'title_fingerprint' is not null then
      select 'title_fingerprint' as reason, s.id into v_hit from public.news_discovery_signals s
        where s.title_fingerprint = v_lookup ->> 'title_fingerprint'
          and s.source_id <> v_lookup ->> 'source_id'
          and s.fetched_at >= (v_lookup ->> 'since')::timestamptz
        order by s.fetched_at, s.id limit 1;
    end if;
    if v_hit is not null then
      v_out := v_out || jsonb_build_array(jsonb_build_object('i', v_lookup -> 'i', 'reason', v_hit.reason, 'signal_id', v_hit.id));
    end if;
  end loop;
  return v_out;
end;
$$;

-- insert_signals: {run_id, alias_dictionary_version, signals:[{...signal, tickers:[...], entities:[...]}]}
-- One transaction per call: either every row of the batch is written or none is. Signals that
-- already exist (same id, or same source + external id) are skipped and reported as conflicts,
-- so a retried batch is safe. Relations are written only for newly inserted signals.
--
-- Concurrent runs (M2): the batch first takes a transaction advisory lock per url_key, in sorted
-- order (no deadlock between batches), then applies the URL rule of find_duplicates inside the
-- lock: an existing row with the same canonical URL / url_key from ANOTHER source, or from the SAME
-- source with the same title fingerprint, makes the new row a duplicate ('duplicates' in the result;
-- not written, not an error). No unique constraint is added: a source may reuse one URL for a new
-- title (ESRI), and same-source same-title documents with different URLs/ids are always kept
-- (官邸). The cross-source 72 h title rule stays application-level (find_duplicates), by design.
-- The lock protocol relies on READ COMMITTED (PostgREST default): each statement after the lock
-- sees rows committed by the run that held it.
create function public.news_discovery_insert_signals(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run uuid;
  v_signal jsonb;
  v_id text;
  v_inserted text[] := '{}';
  v_conflicted text[] := '{}';
  v_ticker jsonb;
  v_entity jsonb;
  v_key text;
  v_dup text;
  v_duplicates jsonb := '[]'::jsonb;
begin
  if p is null or jsonb_typeof(p -> 'signals') <> 'array' then raise exception 'NEWS_DISCOVERY_BAD_INPUT'; end if;
  if jsonb_array_length(p -> 'signals') > 500 then raise exception 'NEWS_DISCOVERY_BATCH_TOO_LARGE'; end if;
  v_run := (p ->> 'run_id')::uuid;
  perform 1 from public.news_discovery_runs r where r.id = v_run and r.status = 'running' for update;
  if not found then
    raise exception 'NEWS_DISCOVERY_RUN_NOT_RUNNING';
  end if;
  for v_key in select distinct x.value ->> 'url_key' from jsonb_array_elements(p -> 'signals') x
               where x.value ->> 'url_key' is not null order by 1 loop
    perform pg_advisory_xact_lock(hashtext('news_discovery_url'), hashtext(v_key));
  end loop;
  for v_signal in select value from jsonb_array_elements(p -> 'signals') loop
    if v_signal ->> 'search_id' is not null and not exists (
      select 1 from public.news_discovery_searches s
      where s.id = (v_signal ->> 'search_id')::uuid and s.run_id = v_run and s.status <> 'denied'
    ) then
      raise exception 'NEWS_DISCOVERY_SEARCH_RUN_MISMATCH';
    end if;
    v_dup := null;
    select s.id into v_dup from public.news_discovery_signals s
      where (s.canonical_url = v_signal ->> 'canonical_url' or s.url_key = v_signal ->> 'url_key')
        and s.id <> v_signal ->> 'id'
        and (s.source_id <> v_signal ->> 'source_id' or s.title_fingerprint = v_signal ->> 'title_fingerprint')
      order by s.fetched_at, s.id limit 1;
    if v_dup is not null then
      v_duplicates := v_duplicates || jsonb_build_array(jsonb_build_object('id', v_signal ->> 'id', 'duplicate_of', v_dup, 'reason', 'url'));
      continue;
    end if;
    v_id := null;
    insert into public.news_discovery_signals (
      id, first_run_id, source_id, source_type, policy, discovery_only, restricted_publisher, search_id, discovered_via, source_url,
      canonical_url, url_key, external_id, title, title_fingerprint, title_display_allowed, summary_hint,
      published_at, published_date, published_at_precision, source_updated_at, detected_at, fetched_at,
      language, country, publisher, topics, needs_verification, same_event_group, image_url,
      image_usage_allowed, raw_reference)
    values (
      v_signal ->> 'id', v_run, v_signal ->> 'source_id', v_signal ->> 'source_type', v_signal ->> 'policy',
      (v_signal ->> 'discovery_only')::boolean, coalesce((v_signal ->> 'restricted_publisher')::boolean, false),
      (v_signal ->> 'search_id')::uuid, v_signal ->> 'discovered_via', v_signal ->> 'source_url',
      v_signal ->> 'canonical_url', v_signal ->> 'url_key', v_signal ->> 'external_id', v_signal ->> 'title',
      v_signal ->> 'title_fingerprint', (v_signal ->> 'title_display_allowed')::boolean, v_signal ->> 'summary_hint',
      case when v_signal ->> 'published_at_precision' = 'datetime' then (v_signal ->> 'published_at')::timestamptz end,
      case when v_signal ->> 'published_at_precision' = 'date' then (v_signal ->> 'published_at')::date end,
      v_signal ->> 'published_at_precision', (v_signal ->> 'updated_at')::timestamptz,
      (v_signal ->> 'detected_at')::timestamptz, (v_signal ->> 'fetched_at')::timestamptz,
      v_signal ->> 'language', v_signal ->> 'country', v_signal ->> 'publisher',
      coalesce((select array_agg(value) from jsonb_array_elements_text(v_signal -> 'topics')), '{}'),
      coalesce((select array_agg(value) from jsonb_array_elements_text(v_signal -> 'needs_verification')), '{}'),
      v_signal ->> 'same_event_group', v_signal ->> 'image_url',
      coalesce((v_signal ->> 'image_usage_allowed')::boolean, false), coalesce(v_signal -> 'raw_reference', '{}'::jsonb))
    on conflict do nothing
    returning id into v_id;

    if v_id is null then
      v_conflicted := v_conflicted || (v_signal ->> 'id');
      continue;
    end if;
    v_inserted := v_inserted || v_id;

    for v_ticker in select value from jsonb_array_elements(coalesce(v_signal -> 'tickers', '[]'::jsonb)) loop
      if v_ticker ->> 'confirmation_basis' = 'multiple_weak' and (
        select count(distinct value) from jsonb_array_elements_text(coalesce(v_ticker -> 'matched_aliases', '[]'::jsonb))
      ) < 2 then
        raise check_violation using message = 'NEWS_DISCOVERY_MULTIPLE_WEAK_REQUIRES_DISTINCT_ALIASES';
      end if;
      insert into public.news_discovery_signal_tickers (
        signal_id, ticker_code, status, confirmation_basis, match_types, matched_aliases, in_title,
        confidence, alias_dictionary_version)
      values (
        v_id, v_ticker ->> 'ticker', v_ticker ->> 'status', v_ticker ->> 'confirmation_basis',
        (select array_agg(value) from jsonb_array_elements_text(v_ticker -> 'match_types')),
        coalesce((select array_agg(value) from jsonb_array_elements_text(v_ticker -> 'matched_aliases')), '{}'),
        (v_ticker ->> 'in_title')::boolean, (v_ticker ->> 'score')::numeric,
        coalesce(p ->> 'alias_dictionary_version', 'unknown'));
    end loop;
    for v_entity in select value from jsonb_array_elements(coalesce(v_signal -> 'entities', '[]'::jsonb)) loop
      insert into public.news_discovery_signal_entities (signal_id, entity_type, entity_value)
      values (v_id, v_entity ->> 'kind', v_entity ->> 'value')
      on conflict do nothing;
    end loop;
  end loop;
  return jsonb_build_object('inserted', to_jsonb(v_inserted), 'conflicted', to_jsonb(v_conflicted), 'duplicates', v_duplicates);
end;
$$;

-- recent_for_grouping: {since} -> [{id, source_id, title, fetched_at, topics, same_event_group,
--   confirmed_tickers}] (bounded) for cheap same-event grouping.
create function public.news_discovery_recent_for_grouping(p jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
  from (
    select s.id, s.source_id, s.title, s.fetched_at, s.topics, s.same_event_group,
      coalesce((select array_agg(t.ticker_code) from public.news_discovery_signal_tickers t
                where t.signal_id = s.id and t.status = 'confirmed'), '{}') as confirmed_tickers
    from public.news_discovery_signals s
    where s.fetched_at >= (p ->> 'since')::timestamptz
    order by s.fetched_at desc
    limit 2000
  ) x;
$$;

-- finish_run: {run_id, status, totals{...}, sources:[{source_id, policy, outcome, requests, ...}],
--   error_summary}. Only a running run can be finished (a retried finish is a no-op: returns false).
create function public.news_discovery_finish_run(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run uuid := (p ->> 'run_id')::uuid;
  v_totals jsonb := coalesce(p -> 'totals', '{}'::jsonb);
  v_source jsonb;
  v_updated integer;
  v_searches integer;
  v_denied integer;
  v_model integer;
  v_tool integer;
  v_results integer;
  v_persisted_useful integer;
  v_inserted integer;
begin
  if coalesce(p ->> 'status', '') not in ('completed', 'completed_with_errors', 'failed') then
    raise exception 'NEWS_DISCOVERY_BAD_STATUS';
  end if;
  if p -> 'execution' is not null and jsonb_typeof(p -> 'execution') <> 'object' then
    raise exception 'NEWS_DISCOVERY_BAD_INPUT';
  end if;
  -- Usage and persisted counts come from the rows themselves (M1): a failed run, or a client that
  -- lost its in-memory totals, can never hide searches/model calls that were actually made.
  select count(*) filter (where s.status <> 'denied'), count(*) filter (where s.status = 'denied'),
         coalesce(sum(s.model_calls), 0), coalesce(sum(s.web_search_calls), 0), coalesce(sum(s.result_count), 0)
    into v_searches, v_denied, v_model, v_tool, v_results
    from public.news_discovery_searches s where s.run_id = v_run;
  select count(*) into v_persisted_useful from public.news_discovery_signals g
    join public.news_discovery_searches s on s.id = g.search_id
    where s.run_id = v_run
      and (cardinality(g.topics) > 0 or exists (select 1 from public.news_discovery_signal_tickers t
                                                where t.signal_id = g.id and t.status = 'confirmed'));
  select count(*) into v_inserted from public.news_discovery_signals g where g.first_run_id = v_run;
  update public.news_discovery_runs r set
    status = p ->> 'status',
    completed_at = now(),
    source_count = coalesce((v_totals ->> 'source_count')::integer, 0),
    successful_sources = coalesce((v_totals ->> 'successful_sources')::integer, 0),
    failed_sources = coalesce((v_totals ->> 'failed_sources')::integer, 0),
    http_requests = coalesce((v_totals ->> 'http_requests')::integer, 0),
    fetched_count = coalesce((v_totals ->> 'fetched_count')::integer, 0),
    filtered_count = coalesce((v_totals ->> 'filtered_count')::integer, 0),
    normalized_count = coalesce((v_totals ->> 'normalized_count')::integer, 0),
    duplicate_count = coalesce((v_totals ->> 'duplicate_count')::integer, 0),
    inserted_count = v_inserted,
    insert_conflict_count = coalesce((v_totals ->> 'insert_conflict_count')::integer, 0),
    topic_matched_count = coalesce((v_totals ->> 'topic_matched_count')::integer, 0),
    ticker_confirmed_count = coalesce((v_totals ->> 'ticker_confirmed_count')::integer, 0),
    ticker_candidate_count = coalesce((v_totals ->> 'ticker_candidate_count')::integer, 0),
    search_count = v_searches,
    search_denied_count = v_denied,
    search_result_count = greatest(v_results, coalesce((v_totals ->> 'search_result_count')::integer, 0)),
    search_useful_signal_count = v_persisted_useful,
    search_duplicate_count = coalesce((v_totals ->> 'search_duplicate_count')::integer, 0),
    ai_calls = greatest(v_model, coalesce((v_totals ->> 'ai_calls')::integer, 0)),
    web_search_calls = greatest(v_tool, coalesce((v_totals ->> 'web_search_calls')::integer, 0)),
    error_summary = left(p ->> 'error_summary', 2000),
    execution = coalesce(p -> 'execution', '{}'::jsonb) || jsonb_build_object('signals_persisted', v_inserted)
  where r.id = v_run and r.status = 'running';
  get diagnostics v_updated = row_count;
  if v_updated = 0 then return jsonb_build_object('finished', false); end if;

  for v_source in select value from jsonb_array_elements(coalesce(p -> 'sources', '[]'::jsonb)) loop
    insert into public.news_discovery_run_sources (
      run_id, source_id, policy, outcome, requests, raw_items, filtered, normalized, duplicates, inserted,
      with_published_at, with_topic, with_confirmed_ticker, duration_ms)
    values (
      v_run, v_source ->> 'source_id', v_source ->> 'policy', v_source ->> 'outcome',
      coalesce(v_source -> 'requests', '[]'::jsonb),
      coalesce((v_source ->> 'raw_items')::integer, 0), coalesce((v_source ->> 'filtered')::integer, 0),
      coalesce((v_source ->> 'normalized')::integer, 0), coalesce((v_source ->> 'duplicates')::integer, 0),
      coalesce((v_source ->> 'inserted')::integer, 0), coalesce((v_source ->> 'with_published_at')::integer, 0),
      coalesce((v_source ->> 'with_topic')::integer, 0), coalesce((v_source ->> 'with_confirmed_ticker')::integer, 0),
      coalesce((v_source ->> 'duration_ms')::integer, 0));
  end loop;
  return jsonb_build_object('finished', true);
end;
$$;

-- reserve_search: {run_id, lane, reason, query, search_key, triggered_by, parent_search_id, provider,
--   model} -> {allowed, search_id | reason, searches_today}. Serialized by an advisory lock so two
--   concurrent runs can never pass the hard cap. Denials are recorded (status 'denied') and do not
--   count toward the budget. Rules mirror web_search.ts InMemorySearchBudget.
create function public.news_discovery_reserve_search(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_config public.news_discovery_search_config;
  v_day date := (now() at time zone 'Asia/Tokyo')::date;
  v_today integer;
  v_reason text := p ->> 'reason';
  v_key text := p ->> 'search_key';
  v_parent uuid := (p ->> 'parent_search_id')::uuid;
  v_cooldown integer;
  v_deny text;
  v_id uuid;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'NEWS_DISCOVERY_BAD_INPUT'; end if;
  perform pg_advisory_xact_lock(hashtext('news_discovery_search_budget'));
  -- Also create a row version: advisory locks alone cannot refresh a REPEATABLE READ snapshot.
  -- A stale snapshot now fails with serialization_failure instead of overbooking the cap.
  update public.news_discovery_search_config set updated_at = updated_at where id
    returning * into v_config;
  if not found then raise exception 'NEWS_DISCOVERY_SEARCH_CONFIG_MISSING'; end if;
  select count(*) into v_today from public.news_discovery_searches s
    where s.search_day = v_day and s.status <> 'denied';

  if v_today >= v_config.daily_hard_limit then
    v_deny := 'hard_cap';
  elsif v_reason = 'scheduled_rotation' and v_today >= v_config.daily_soft_budget then
    v_deny := 'soft_budget';
  elsif v_reason = 'escalation' then
    if v_parent is null or not exists (select 1 from public.news_discovery_searches s
                                       where s.id = v_parent and s.search_key = v_key and s.status <> 'denied'
                                         and s.run_id is not distinct from (p ->> 'run_id')::uuid
                                         and s.search_day = v_day and s.lane = p ->> 'lane'
                                         and s.reason in ('trigger_market_anomaly', 'trigger_discovery_signal')) then
      v_deny := 'bad_parent';
    elsif (select count(*) from public.news_discovery_searches s
           where s.search_day = v_day and s.reason = 'escalation' and s.search_key = v_key and s.status <> 'denied')
          >= v_config.max_escalations_per_key_per_day then
      v_deny := 'escalation_limit';
    end if;
  else
    v_cooldown := case when v_reason = 'scheduled_rotation' then v_config.lane_rotation_interval_minutes
                       else v_config.search_key_cooldown_minutes end;
    if exists (select 1 from public.news_discovery_searches s
               where s.search_key = v_key and s.status <> 'denied'
                 and s.reserved_at > now() - make_interval(mins => v_cooldown)) then
      v_deny := 'duplicate_search_key';
    end if;
  end if;

  insert into public.news_discovery_searches (
    run_id, search_day, lane, reason, search_key, triggered_by, parent_search_id, query, provider, model,
    status, deny_reason, completed_at)
  values (
    (p ->> 'run_id')::uuid, v_day, p ->> 'lane', v_reason, v_key, p ->> 'triggered_by',
    case when v_deny = 'bad_parent' then null else v_parent end, p ->> 'query', p ->> 'provider', p ->> 'model',
    case when v_deny is null then 'reserved' else 'denied' end, v_deny,
    case when v_deny is null then null else now() end)
  returning id into v_id;

  if v_deny is not null then
    return jsonb_build_object('allowed', false, 'reason', v_deny, 'searches_today', v_today);
  end if;
  return jsonb_build_object('allowed', true, 'search_id', v_id, 'searches_today', v_today + 1);
end;
$$;

-- complete_search: records the outcome of a reserved search (a second completion is a no-op).
create function public.news_discovery_complete_search(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
  v_search uuid := (p ->> 'search_id')::uuid;
  v_persisted integer;
  v_persisted_useful integer;
begin
  if coalesce(p ->> 'status', '') not in ('succeeded', 'failed') then raise exception 'NEWS_DISCOVERY_BAD_STATUS'; end if;
  -- What this search really stored (its signals are persisted before the row is completed).
  select count(*),
         count(*) filter (where cardinality(g.topics) > 0 or exists (
           select 1 from public.news_discovery_signal_tickers t where t.signal_id = g.id and t.status = 'confirmed'))
    into v_persisted, v_persisted_useful
    from public.news_discovery_signals g where g.search_id = v_search;
  update public.news_discovery_searches s set
    status = p ->> 'status',
    error_code = left(p ->> 'error_code', 64),
    result_count = coalesce((p ->> 'result_count')::integer, 0),
    new_signal_count = coalesce((p ->> 'new_signal_count')::integer, 0),
    useful_signal_count = coalesce((p ->> 'useful_signal_count')::integer, 0),
    duplicate_count = coalesce((p ->> 'duplicate_count')::integer, 0),
    restricted_count = coalesce((p ->> 'restricted_count')::integer, 0),
    policy_blocked_count = coalesce((p ->> 'policy_blocked_count')::integer, 0),
    rejected_unverified_count = coalesce((p ->> 'rejected_unverified_count')::integer, 0),
    model_calls = coalesce((p ->> 'model_calls')::integer, 0),
    web_search_calls = coalesce((p ->> 'web_search_calls')::integer, 0),
    input_tokens = coalesce((p ->> 'input_tokens')::integer, 0),
    output_tokens = coalesce((p ->> 'output_tokens')::integer, 0),
    persisted_signal_count = v_persisted,
    persisted_useful_signal_count = v_persisted_useful,
    completed_at = now()
  where s.id = v_search and s.status = 'reserved';
  get diagnostics v_updated = row_count;
  return jsonb_build_object('completed', v_updated = 1);
end;
$$;

revoke all on function public.news_discovery_begin_run(jsonb), public.news_discovery_find_duplicates(jsonb),
  public.news_discovery_insert_signals(jsonb), public.news_discovery_recent_for_grouping(jsonb),
  public.news_discovery_finish_run(jsonb), public.news_discovery_reserve_search(jsonb),
  public.news_discovery_complete_search(jsonb)
  from public, anon, authenticated;
grant execute on function public.news_discovery_begin_run(jsonb), public.news_discovery_find_duplicates(jsonb),
  public.news_discovery_insert_signals(jsonb), public.news_discovery_recent_for_grouping(jsonb),
  public.news_discovery_finish_run(jsonb), public.news_discovery_reserve_search(jsonb),
  public.news_discovery_complete_search(jsonb)
  to service_role;

commit;
