-- Test-only helpers for the AI provider budget ledger proofs (disposable databases only; never a migration).
-- ail_test.rpc() calls a public.ai_ledger_* RPC AS a given application role (default service_role) from a
-- superuser session, so the behaviour file can assert on the owner-only tables in between calls.
create schema ail_test;

create function ail_test.check(p_ok boolean, p_label text)
returns void
language plpgsql
as $$
begin
  if p_ok is not true then
    raise exception 'AIL_TEST_FAIL: %', p_label;
  end if;
end;
$$;

create function ail_test.rpc(p_fn text, p jsonb, p_role text default 'service_role')
returns jsonb
language plpgsql
as $$
declare
  v jsonb;
begin
  execute format('set local role %I', p_role);
  execute format('select public.%I($1)', p_fn) into v using p;
  execute 'reset role';
  return v;
end;
$$;

-- The SQLSTATE and message of a failing RPC call, or null when it succeeded (the failed call is rolled back).
create function ail_test.rpc_error(p_fn text, p jsonb, p_role text default 'service_role')
returns text
language plpgsql
as $$
begin
  perform ail_test.rpc(p_fn, p, p_role);
  return null;
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;

create function ail_test.reserve(
  p_request text, p_attempt integer, p_provider text, p_model text, p_application text, p_feature text,
  p_subject text default 'system', p_user uuid default null, p_brand uuid default null, p_amount numeric default 0.1)
returns jsonb
language sql
as $$
  select ail_test.rpc('ai_ledger_reserve', jsonb_strip_nulls(jsonb_build_object(
    'request_id', p_request, 'attempt', p_attempt, 'provider', p_provider, 'model', p_model,
    'application', p_application, 'feature', p_feature, 'logical_role', p_application || '.' || p_feature,
    'subject_kind', p_subject, 'user_id', p_user, 'brand_id', p_brand, 'amount_usd', p_amount)))
$$;

create function ail_test.mark_sent(p_reservation jsonb)
returns jsonb
language sql
as $$
  select ail_test.rpc('ai_ledger_mark_sent', jsonb_build_object('reservation_id', p_reservation ->> 'reservation_id'))
$$;

create function ail_test.settle_measured(
  p_reservation jsonb, p_cost numeric, p_input bigint, p_output bigint, p_cache_read bigint default 0,
  p_cache_5m bigint default 0, p_outcome text default 'succeeded', p_error text default null)
returns jsonb
language sql
as $$
  select ail_test.rpc('ai_ledger_settle', jsonb_strip_nulls(jsonb_build_object(
    'reservation_id', p_reservation ->> 'reservation_id', 'outcome', p_outcome, 'cost_basis', 'measured',
    'estimated_cost_usd', p_cost, 'input_tokens', p_input, 'output_tokens', p_output,
    'cache_read_input_tokens', p_cache_read, 'cache_write_5m_input_tokens', p_cache_5m,
    'cache_write_1h_input_tokens', 0, 'error_code', p_error, 'actual_model', 'model-actual-1',
    'provider_request_id', 'req_provider_1', 'http_status', 200, 'latency_ms', 1234,
    'price_catalog_version', 'ai-provider-catalog/2026-10-10.1')))
$$;

create function ail_test.settle_unknown(p_reservation jsonb, p_cost numeric, p_error text default 'TIMEOUT')
returns jsonb
language sql
as $$
  select ail_test.rpc('ai_ledger_settle', jsonb_build_object(
    'reservation_id', p_reservation ->> 'reservation_id', 'outcome', 'unknown', 'cost_basis', 'upper_bound',
    'estimated_cost_usd', p_cost, 'error_code', p_error, 'price_catalog_version', 'ai-provider-catalog/2026-10-10.1'))
$$;

create function ail_test.bucket(p_policy_key text, p_brand uuid default null, p_user uuid default null)
returns ai_ledger.budget_buckets
language sql
as $$
  select b.* from ai_ledger.budget_buckets b join ai_ledger.budget_policies pol on pol.id = b.policy_id
   where pol.policy_key = p_policy_key and b.brand_id is not distinct from p_brand and b.user_id is not distinct from p_user
     and b.period_start = case pol.period when 'month' then ai_ledger.jst_month_start(now()) else ai_ledger.jst_day(now()) end
$$;

create function ail_test.this_month()
returns text
language sql
as $$
  select to_char(ai_ledger.jst_month_start(now()), 'YYYY-MM-DD')
$$;
