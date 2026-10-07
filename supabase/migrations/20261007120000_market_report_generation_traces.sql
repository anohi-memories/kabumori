-- Market report generation traces: append-only debug evidence of every model generation.
--
-- Why (2026-10-07 morning): the shared analysis failed twice and left a report_status of
-- ANALYSIS_FACT_FAILED, a few fixed codes and the last Fact issue. The generated bodies, the local-guard
-- issues of the first generation and the 07:55 attempt were gone (each retry overwrites the cycle's
-- report_diagnostics), so nobody could tell whether the model had written something wrong or a guard had
-- rejected something safe. During the test phase the model output and the guards' findings are kept.
--
-- Model
--   market_report_generation_traces   append-only. One row per model generation of one invocation of
--                                     the analysis function (a scheduled attempt = one invocation). The
--                                     candidate is the structured output the model returned, so a failed
--                                     generation stays readable after the next generation or the next
--                                     scheduled retry. Written by the function after generating, never
--                                     in the path that delivers a report: a failed insert is only logged.
--
-- No existing object is changed. No client read path: RLS on, no policy, no grant to anon/authenticated;
-- service_role may insert and select (inspection happens with the secret key or the SQL editor).
-- source / subject_ref keep room for personalized reports entering QA later; nothing here generates one.
-- Never store credentials: the writer redacts token / key / Authorization shaped content (see
-- supabase/functions/market-report-analysis/debug_trace.ts); the table has no column for them.
--
-- Access is verified, not assumed. Direct grants alone say nothing about who can reach the table: a default
-- privilege for an unknown role, a membership in the owner, or a role the service role inherits can each
-- expose or tamper with the evidence. After the objects and grants are created, the migration checks the
-- exact direct ACL and the EFFECTIVE privileges (inheritance, PUBLIC, grant options, column privileges,
-- membership in the owner or a superuser) and refuses by raising, so the whole transaction rolls back and
-- leaves no partial object. It never repairs default privileges or memberships: that is a human decision.
-- Read-only preflight for a real project: supabase/tests/market_report_generation_traces_preflight.sql.

begin;

create table public.market_report_generation_traces (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- What produced the text: the shared market analysis today; a personalized report later.
  source text not null default 'shared_market_report'
    check (source in ('shared_market_report', 'personalized_report')),
  report_type text not null check (report_type in ('morning', 'close')),
  trading_date date not null,
  -- No foreign keys on purpose: a trace must outlive and never block cycle / packet maintenance.
  cycle_id uuid,
  data_packet_id uuid,
  report_packet_id uuid,
  -- Future personalized reports: user / account / report identifier. Null for the shared analysis.
  subject_ref text check (subject_ref is null or char_length(subject_ref) <= 120),
  -- One invocation of the analysis function; attempt is the cycle's report attempt (07:55 = 1, 08:05 = 2).
  invocation_id uuid not null,
  attempt integer not null check (attempt >= 1),
  generation_index integer not null check (generation_index between 1 and 4),
  model text,
  -- First 16 hex chars of SHA-256. base_prompt_hash: the instructions without any previous-issues note (the
  -- same for every generation of a prompt version). request_hash: the exact request this generation sent
  -- (instructions including a retry's issue note, plus the input), so a rewrite is told apart from a first try.
  base_prompt_hash text check (base_prompt_hash is null or base_prompt_hash ~ '^[0-9a-f]{16}$'),
  request_hash text check (request_hash is null or request_hash ~ '^[0-9a-f]{16}$'),
  stage text not null
    check (stage in ('invalid_output', 'local', 'fact', 'delivered', 'safe_candidate', 'request_failed')),
  hard_rejection text check (hard_rejection is null or hard_rejection in ('invalid_output', 'local', 'fact')),
  local_passed boolean,
  local_issues jsonb not null default '[]'::jsonb check (jsonb_typeof(local_issues) = 'array'),
  local_warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(local_warnings) = 'array'),
  fact_ran boolean not null default false,
  fact_passed boolean,
  fact_issues jsonb not null default '[]'::jsonb check (jsonb_typeof(fact_issues) = 'array'),
  selected_for_delivery boolean not null default false,
  fallback_reason text check (fallback_reason is null or char_length(fallback_reason) <= 120),
  error_code text check (error_code is null or char_length(error_code) <= 120),
  -- The structured model output (headline, summary, claims, x_post, app_story ...), null when it did not parse.
  -- Stored whole (after credential redaction). Only a declared per-field bound can shorten a field, and then
  -- `truncated` is true and `truncation` says which field, why and how large the original was.
  candidate jsonb,
  -- Size of each stored field before any bound was applied (after redaction): what the row would have held.
  candidate_chars integer check (candidate_chars is null or candidate_chars >= 0),
  local_issue_count integer check (local_issue_count is null or local_issue_count >= 0),
  fact_issue_count integer check (fact_issue_count is null or fact_issue_count >= 0),
  truncated boolean not null default false,
  truncation jsonb check (truncation is null or jsonb_typeof(truncation) = 'object'),
  constraint market_report_generation_traces_truncation_consistent check (truncated = (truncation is not null)),
  -- Cumulative for the invocation when this generation finished.
  calls integer check (calls is null or calls >= 0),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  api_cost_usd numeric(12, 6) check (api_cost_usd is null or api_cost_usd >= 0),
  constraint market_report_generation_traces_invocation_generation_key unique (invocation_id, generation_index)
);

comment on table public.market_report_generation_traces is
  'Test-phase debug evidence: append-only, one row per model generation (candidate JSON + local / Fact findings). Service role only. Never holds credentials. Written best-effort; its absence never blocks delivery.';

create index market_report_generation_traces_day_idx
  on public.market_report_generation_traces (trading_date, report_type, created_at desc);
create index market_report_generation_traces_cycle_idx
  on public.market_report_generation_traces (cycle_id, attempt, generation_index);

-- Append-only: the evidence of a failed generation must not change afterwards.
create function public.market_report_generation_traces_reject_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'MARKET_REPORT_GENERATION_TRACE_IMMUTABLE' using errcode = 'P0001';
end;
$$;

create trigger market_report_generation_traces_no_update
  before update on public.market_report_generation_traces
  for each row execute function public.market_report_generation_traces_reject_change();

create trigger market_report_generation_traces_no_delete
  before delete on public.market_report_generation_traces
  for each row execute function public.market_report_generation_traces_reject_change();

create trigger market_report_generation_traces_no_truncate
  before truncate on public.market_report_generation_traces
  for each statement execute function public.market_report_generation_traces_reject_change();

alter table public.market_report_generation_traces enable row level security;

revoke all on table public.market_report_generation_traces from public, anon, authenticated, service_role;
grant select, insert on table public.market_report_generation_traces to service_role;
revoke all on function public.market_report_generation_traces_reject_change() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- Access verification. Raises (rolling the whole migration back) unless the table and the helper are reachable
-- by exactly the intended roles. Nothing is repaired here.
-- ---------------------------------------------------------------------------------------------------------
do $$
declare
  v_table constant regclass := 'public.market_report_generation_traces'::regclass;
  v_helper constant regprocedure := 'public.market_report_generation_traces_reject_change()'::regprocedure;
  v_owner oid;
  v_owner_name name;
  v_roles constant text[] := array['anon', 'authenticated', 'service_role'];
  v_privs text[] := array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  v_role text;
  v_priv text;
  v_extra text;
  v_expected boolean;
begin
  if current_setting('server_version_num')::int >= 170000 then
    v_privs := array_append(v_privs, 'MAINTAIN');
  end if;

  select c.relowner into v_owner from pg_class c where c.oid = v_table;
  select r.rolname into v_owner_name from pg_roles r where r.oid = v_owner;

  -- 1. The creator / owner must not be one of the roles the table is meant to be closed to, nor a PUBLIC member.
  if v_owner_name in ('anon', 'authenticated', 'service_role') then
    raise exception 'MARKET_REPORT_TRACE_ACL_UNSAFE_OWNER: table owner % is an application role', v_owner_name
      using errcode = 'P0001';
  end if;
  if (select helper.proowner from pg_proc helper where helper.oid = v_helper) <> v_owner then
    raise exception 'MARKET_REPORT_TRACE_ACL_UNSAFE_OWNER: helper and table have different owners' using errcode = 'P0001';
  end if;

  -- 2. No application role may be a member of the owner or of any superuser (SET ROLE / inheritance path).
  foreach v_role in array v_roles loop
    if to_regrole(v_role) is null then
      continue;
    end if;
    if pg_has_role(v_role, v_owner, 'MEMBER') then
      raise exception 'MARKET_REPORT_TRACE_ACL_UNSAFE_MEMBERSHIP: % is a member of the table owner %', v_role, v_owner_name
        using errcode = 'P0001';
    end if;
    select string_agg(super.rolname, ', ' order by super.rolname) into v_extra
      from pg_roles super
     where super.rolsuper and pg_has_role(v_role, super.oid, 'MEMBER');
    if v_extra is not null then
      raise exception 'MARKET_REPORT_TRACE_ACL_UNSAFE_MEMBERSHIP: % is or inherits superuser % ', v_role, v_extra
        using errcode = 'P0001';
    end if;
  end loop;

  -- 3. Exact direct ACL of the table: nobody but the owner and service_role (SELECT, INSERT, no grant option).
  select string_agg(format('%s:%s%s', coalesce(r.rolname, 'PUBLIC'), a.privilege_type,
                           case when a.is_grantable then '+grant' else '' end), ', ' order by r.rolname, a.privilege_type)
    into v_extra
    from pg_class c
    cross join lateral aclexplode(c.relacl) a
    left join pg_roles r on r.oid = a.grantee
   where c.oid = v_table
     and a.grantee <> c.relowner
     and not (r.rolname = 'service_role' and a.privilege_type in ('SELECT', 'INSERT') and not a.is_grantable);
  if v_extra is not null then
    raise exception 'MARKET_REPORT_TRACE_ACL_UNEXPECTED_TABLE_GRANT: %', v_extra using errcode = 'P0001';
  end if;

  -- 4. Exact direct ACL of the helper: only the owner may execute it (a default EXECUTE grant must not survive).
  select string_agg(format('%s:%s', coalesce(r.rolname, 'PUBLIC'), a.privilege_type), ', ' order by r.rolname)
    into v_extra
    from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    left join pg_roles r on r.oid = a.grantee
   where p.oid = v_helper and a.grantee <> p.proowner;
  if v_extra is not null then
    raise exception 'MARKET_REPORT_TRACE_ACL_UNEXPECTED_HELPER_GRANT: %', v_extra using errcode = 'P0001';
  end if;

  -- 5. Effective privileges (inheritance, PUBLIC, grant options, column privileges) of each application role.
  foreach v_role in array v_roles loop
    if to_regrole(v_role) is null then
      continue;
    end if;
    foreach v_priv in array v_privs loop
      v_expected := v_role = 'service_role' and v_priv in ('SELECT', 'INSERT');
      if has_table_privilege(v_role, v_table, v_priv) is distinct from v_expected then
        raise exception 'MARKET_REPORT_TRACE_ACL_EFFECTIVE_PRIVILEGE: % % on the trace table is %, expected %',
          v_role, v_priv, not v_expected, v_expected using errcode = 'P0001';
      end if;
      if has_table_privilege(v_role, v_table, v_priv || ' WITH GRANT OPTION') then
        raise exception 'MARKET_REPORT_TRACE_ACL_EFFECTIVE_PRIVILEGE: % holds % with grant option', v_role, v_priv
          using errcode = 'P0001';
      end if;
    end loop;
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
      v_expected := v_role = 'service_role' and v_priv in ('SELECT', 'INSERT');
      if not v_expected and has_any_column_privilege(v_role, v_table, v_priv) then
        raise exception 'MARKET_REPORT_TRACE_ACL_EFFECTIVE_PRIVILEGE: % has column-level % privilege', v_role, v_priv
          using errcode = 'P0001';
      end if;
    end loop;
    if has_function_privilege(v_role, v_helper, 'EXECUTE') then
      raise exception 'MARKET_REPORT_TRACE_ACL_EFFECTIVE_PRIVILEGE: % can execute the append-only helper', v_role
        using errcode = 'P0001';
    end if;
  end loop;

  -- 6. No column carries its own ACL (a column grant would bypass the table-level checks above).
  if exists (select 1 from pg_attribute att where att.attrelid = v_table and att.attnum > 0 and att.attacl is not null) then
    raise exception 'MARKET_REPORT_TRACE_ACL_UNEXPECTED_COLUMN_GRANT' using errcode = 'P0001';
  end if;
end;
$$;

commit;
