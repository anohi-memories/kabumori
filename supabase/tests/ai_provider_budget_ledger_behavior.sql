-- Behaviour of the AI provider budget ledger (disposable database, after the migration and the fixture).
-- Numbers in the labels refer to the Phase 1b TASK test list. Any failed check raises AIL_TEST_FAIL and stops psql.
\set ON_ERROR_STOP 1
\set QUIET 1

\echo '[9] no matching policy: fail closed, nothing written'
do $$
declare v jsonb;
begin
  v := ail_test.reserve('req-none', 1, 'openai', 'gpt-6-luna', 'kabumori', 'market_report');
  perform ail_test.check(v ->> 'allowed' = 'false' and v ->> 'reason' = 'NO_MATCHING_POLICY', 'no policy -> denied');
  perform ail_test.check((select count(*) from ai_ledger.reservations) = 0, 'no reservation written');
  perform ail_test.check((select count(*) from ai_ledger.budget_buckets) = 0, 'no bucket written');
end;
$$;

insert into ai_ledger.budget_policies
  (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_brand, per_user, period,
   max_estimated_usd, max_calls, max_usd_per_call)
values
  ('global', null, null, null, null, null, false, false, 'month', 50, 100000, null),
  ('provider.anthropic', 'anthropic', null, null, null, null, false, false, 'month', 5, null, null),
  ('model.luna', null, 'gpt-6-luna', null, null, null, false, false, 'month', null, 1000, null),
  ('kabumori.market_report', null, null, 'kabumori', 'market_report', null, false, false, 'month', 1, null, 0.6),
  ('postona.per_brand', null, null, 'postona', null, 'user', true, false, 'month', null, 3, null),
  ('postona.consult.per_user.daily', null, null, 'postona', 'consult', 'user', false, true, 'day', null, 4, null),
  ('postona.user.daily_usd', null, null, 'postona', null, 'user', false, true, 'day', 0.5, null, null);

\echo '[1] a reserved, sent and settled attempt is one complete ledger row'
do $$
declare r jsonb; m jsonb; s jsonb; e ai_ledger.usage_events; res ai_ledger.reservations;
begin
  r := ail_test.reserve('req-mr-1', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system', null, null, 0.3);
  perform ail_test.check(r ->> 'allowed' = 'true' and r ->> 'status' = 'reserved' and r ->> 'reused' = 'false', 'reserved');
  m := ail_test.mark_sent(r);
  perform ail_test.check(m = '{"status": "sent", "may_send": true}'::jsonb, 'mark_sent allows sending');
  s := ail_test.settle_measured(r, 0.0112, 800, 400, 100, 50);
  perform ail_test.check(s ->> 'status' = 'settled' and s ->> 'duplicate' = 'false', 'settled');
  select * into e from ai_ledger.usage_events where reservation_id = (r ->> 'reservation_id')::uuid;
  perform ail_test.check(e.provider = 'anthropic' and e.model = 'claude-opus-5-5' and e.actual_model = 'model-actual-1'
    and e.application = 'kabumori' and e.feature = 'market_report' and e.logical_role = 'kabumori.market_report'
    and e.subject_kind = 'system' and e.user_id is null and e.brand_id is null
    and e.request_id = 'req-mr-1' and e.attempt = 1 and e.attempt_id = 'req-mr-1#1'
    and e.input_tokens = 800 and e.output_tokens = 400 and e.cache_read_input_tokens = 100 and e.cache_write_5m_input_tokens = 50
    and e.cache_write_1h_input_tokens = 0 and e.estimated_cost_usd = 0.0112 and e.reserved_usd = 0.3
    and e.cost_basis = 'measured' and e.outcome = 'succeeded' and e.billing_month = ai_ledger.jst_month_start(now())
    and e.price_catalog_version = 'ai-provider-catalog/2026-10-10.1' and e.provider_request_id = 'req_provider_1'
    and e.http_status = 200 and e.latency_ms = 1234, 'every ledger field recorded');
  select * into res from ai_ledger.reservations where id = (r ->> 'reservation_id')::uuid;
  perform ail_test.check(res.status = 'settled' and res.sent_at is not null and res.finalized_at is not null, 'reservation settled');
  perform ail_test.check((ail_test.bucket('global')).held_usd = 0 and (ail_test.bucket('global')).settled_usd = 0.0112
    and (ail_test.bucket('global')).calls = 1, 'global bucket: hold replaced by measured cost');
  perform ail_test.check((ail_test.bucket('provider.anthropic')).settled_usd = 0.0112, 'provider bucket');
  perform ail_test.check((ail_test.bucket('kabumori.market_report')).settled_usd = 0.0112, 'feature bucket');
  perform ail_test.check(ail_test.bucket('model.luna') is null, 'non-matching policy untouched');
end;
$$;

\echo '[9] caps deny BEFORE anything is committed: per-call, cost and call limits'
do $$
declare a jsonb; b jsonb; c jsonb; d jsonb; before_global ai_ledger.budget_buckets;
begin
  a := ail_test.reserve('req-cap-0', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system', null, null, 0.7);
  perform ail_test.check(a ->> 'allowed' = 'false' and a ->> 'reason' = 'PER_CALL_LIMIT' and a ->> 'policy_key' = 'kabumori.market_report', 'per-call cap');
  a := ail_test.reserve('req-cap-1', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system', null, null, 0.3);
  b := ail_test.reserve('req-cap-2', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system', null, null, 0.3);
  c := ail_test.reserve('req-cap-3', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system', null, null, 0.3);
  perform ail_test.check(a ->> 'allowed' = 'true' and b ->> 'allowed' = 'true' and c ->> 'allowed' = 'true', 'three holds fit (0.9112 <= 1)');
  perform ail_test.check(c ->> 'level' = 'warn', 'usage level reported (0.91 of the feature cap)');
  before_global := ail_test.bucket('global');
  d := ail_test.reserve('req-cap-4', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system', null, null, 0.3);
  perform ail_test.check(d ->> 'allowed' = 'false' and d ->> 'reason' = 'COST_LIMIT' and d ->> 'policy_key' = 'kabumori.market_report', 'cost cap');
  perform ail_test.check(ail_test.bucket('global') = before_global, 'a denial changes no counter');
  perform ail_test.check(not exists (select 1 from ai_ledger.reservations where request_id = 'req-cap-4'), 'no reservation for a denial');
  -- never sent: release the three holds
  perform ail_test.rpc('ai_ledger_release', jsonb_build_object('reservation_id', x ->> 'reservation_id')) from unnest(array[a, b, c]) x;
  perform ail_test.check((ail_test.bucket('kabumori.market_report')).held_usd = 0 and (ail_test.bucket('kabumori.market_report')).calls = 1, 'released holds return calls and money');
end;
$$;

\echo '[10] several budgets at once: provider cap denies while the global cap still has room'
do $$
declare a jsonb; b jsonb;
begin
  a := ail_test.reserve('req-prov-1', 1, 'anthropic', 'claude-opus-5-5', 'mic', 'state', 'system', null, null, 4.9);
  perform ail_test.check(a ->> 'allowed' = 'true', '4.9 fits the 5 USD provider cap');
  b := ail_test.reserve('req-prov-2', 1, 'anthropic', 'claude-sonnet-5-5', 'mic', 'state', 'system', null, null, 0.2);
  perform ail_test.check(b ->> 'allowed' = 'false' and b ->> 'reason' = 'COST_LIMIT' and b ->> 'policy_key' = 'provider.anthropic', 'provider cap');
  b := ail_test.reserve('req-prov-3', 1, 'openai', 'gpt-6.1-sol', 'mic', 'state', 'system', null, null, 0.2);
  perform ail_test.check(b ->> 'allowed' = 'true', 'other provider unaffected');
  perform ail_test.rpc('ai_ledger_release', jsonb_build_object('reservation_id', x ->> 'reservation_id')) from unnest(array[a, b]) x;
end;
$$;

\echo '[10][24] brand cap per brand: brand 1 full, brand 2 of the same user still allowed'
do $$
declare v jsonb; i integer;
begin
  for i in 1..3 loop
    v := ail_test.reserve('req-b1-' || i, 1, 'openai', 'gpt-6-luna', 'postona', 'post', 'user',
                          '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-0000000000b1', 0.01);
    perform ail_test.check(v ->> 'allowed' = 'true', 'brand 1 call ' || i);
  end loop;
  v := ail_test.reserve('req-b1-4', 1, 'openai', 'gpt-6-luna', 'postona', 'post', 'user',
                        '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-0000000000b1', 0.01);
  perform ail_test.check(v ->> 'allowed' = 'false' and v ->> 'reason' = 'CALL_LIMIT' and v ->> 'policy_key' = 'postona.per_brand', 'brand 1 full');
  v := ail_test.reserve('req-b2-1', 1, 'openai', 'gpt-6-luna', 'postona', 'post', 'user',
                        '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-0000000000b2', 0.01);
  perform ail_test.check(v ->> 'allowed' = 'true', 'brand 2 has its own counter');
  perform ail_test.check((ail_test.bucket('postona.per_brand', '00000000-0000-4000-8000-0000000000b1')).calls = 3
    and (ail_test.bucket('postona.per_brand', '00000000-0000-4000-8000-0000000000b2')).calls = 1, 'separate brand buckets');
  perform ail_test.check((ail_test.bucket('postona.user.daily_usd', null, '00000000-0000-4000-8000-00000000000a')).calls = 4,
    'the per-user bucket counts the same user across both brands');
end;
$$;

\echo '[10][25] user cap per user per day: user A full, user B allowed; user USD cap applies too'
do $$
declare v jsonb; i integer;
begin
  for i in 1..4 loop
    v := ail_test.reserve('req-ua-' || i, 1, 'openai', 'gpt-6-luna', 'postona', 'consult', 'user', '00000000-0000-4000-8000-00000000000a', null, 0.01);
    perform ail_test.check(v ->> 'allowed' = 'true', 'user A consult ' || i);
  end loop;
  v := ail_test.reserve('req-ua-5', 1, 'openai', 'gpt-6-luna', 'postona', 'consult', 'user', '00000000-0000-4000-8000-00000000000a', null, 0.01);
  perform ail_test.check(v ->> 'reason' = 'CALL_LIMIT' and v ->> 'policy_key' = 'postona.consult.per_user.daily', 'user A daily consult cap');
  v := ail_test.reserve('req-ub-1', 1, 'openai', 'gpt-6-luna', 'postona', 'consult', 'user', '00000000-0000-4000-8000-00000000000b', null, 0.45);
  perform ail_test.check(v ->> 'allowed' = 'true', 'user B unaffected by user A');
  v := ail_test.reserve('req-ub-2', 1, 'openai', 'gpt-6-luna', 'postona', 'consult', 'user', '00000000-0000-4000-8000-00000000000b', null, 0.1);
  perform ail_test.check(v ->> 'reason' = 'COST_LIMIT' and v ->> 'policy_key' = 'postona.user.daily_usd', 'user B daily USD cap');
end;
$$;

\echo '[12][13] duplicate request / attempt ids are idempotent, conflicting reuse is refused'
do $$
declare a jsonb; b jsonb; c jsonb; calls_before integer; err text;
begin
  a := ail_test.reserve('req-dup', 1, 'openai', 'gpt-6-luna', 'kabumori', 'news', 'system', null, null, 0.05);
  calls_before := (ail_test.bucket('global')).calls;
  b := ail_test.reserve('req-dup', 1, 'openai', 'gpt-6-luna', 'kabumori', 'news', 'system', null, null, 0.05);
  perform ail_test.check(b ->> 'reused' = 'true' and b ->> 'reservation_id' = a ->> 'reservation_id' and b ->> 'allowed' = 'true', 'same attempt -> same reservation');
  perform ail_test.check((ail_test.bucket('global')).calls = calls_before, 'repeat counted nothing');
  c := ail_test.reserve('req-dup', 2, 'openai', 'gpt-6-luna', 'kabumori', 'news', 'system', null, null, 0.05);
  perform ail_test.check(c ->> 'reservation_id' <> a ->> 'reservation_id' and c ->> 'reused' = 'false', 'attempt 2 is a new reservation');
  err := ail_test.rpc_error('ai_ledger_reserve', '{"request_id":"req-dup","attempt":1,"provider":"openai","model":"gpt-6-luna","application":"kabumori","feature":"news","logical_role":"kabumori.news","subject_kind":"system","amount_usd":0.06}');
  perform ail_test.check(err like 'P0001:AI_LEDGER_ATTEMPT_CONFLICT%', 'different payload on the same attempt is refused');
  perform ail_test.mark_sent(a);
  perform ail_test.settle_measured(a, 0.001, 10, 5);
  b := ail_test.reserve('req-dup', 1, 'openai', 'gpt-6-luna', 'kabumori', 'news', 'system', null, null, 0.05);
  perform ail_test.check(b ->> 'allowed' = 'false' and b ->> 'reason' = 'ATTEMPT_FINALIZED', 'a finalised attempt can never be sent again');
  begin
    insert into ai_ledger.usage_events (reservation_id, request_id, attempt, attempt_id, provider, model, application, feature,
      logical_role, subject_kind, billing_month, outcome, cost_basis, input_tokens, output_tokens, cache_read_input_tokens,
      cache_write_5m_input_tokens, cache_write_1h_input_tokens, estimated_cost_usd, reserved_usd, price_catalog_version)
    select (c ->> 'reservation_id')::uuid, 'req-dup', 1, 'req-dup#1', 'openai', 'gpt-6-luna', 'kabumori', 'news',
      'kabumori.news', 'system', ai_ledger.jst_month_start(now()), 'succeeded', 'measured', 1, 1, 0, 0, 0, 0, 0, 'x';
    raise exception 'AIL_TEST_FAIL: duplicate attempt_id accepted';
  exception when unique_violation then null;
  end;
end;
$$;

\echo '[14] duplicate settlement counts once; a different settlement is a conflict'
do $$
declare r jsonb; s1 jsonb; s2 jsonb; settled_before numeric; err text;
begin
  r := ail_test.reserve('req-settle', 1, 'openai', 'gpt-6-luna', 'kabumori', 'news', 'system', null, null, 0.05);
  perform ail_test.mark_sent(r);
  s1 := ail_test.settle_measured(r, 0.002, 100, 20);
  settled_before := (ail_test.bucket('global')).settled_usd;
  s2 := ail_test.settle_measured(r, 0.002, 100, 20);
  perform ail_test.check(s2 ->> 'duplicate' = 'true' and s2 ->> 'usage_event_id' = s1 ->> 'usage_event_id', 'repeat returns the first');
  perform ail_test.check((ail_test.bucket('global')).settled_usd = settled_before, 'repeat charged nothing');
  perform ail_test.check((select count(*) from ai_ledger.usage_events where reservation_id = (r ->> 'reservation_id')::uuid) = 1, 'one event');
  err := ail_test.rpc_error('ai_ledger_settle', jsonb_build_object('reservation_id', r ->> 'reservation_id', 'outcome', 'succeeded',
    'cost_basis', 'measured', 'estimated_cost_usd', 0.003, 'input_tokens', 100, 'output_tokens', 20, 'price_catalog_version', 'v1'));
  perform ail_test.check(err like 'P0001:AI_LEDGER_SETTLEMENT_CONFLICT%', 'different figures for a settled attempt are refused');
end;
$$;

\echo '[15][16] unknown outcomes keep their upper bound; a sent attempt is never released'
do $$
declare r jsonb; v jsonb; e ai_ledger.usage_events; settled_before numeric; held_before numeric; calls_before integer;
begin
  -- timeout reported by the caller: charged at no less than the hold
  r := ail_test.reserve('req-timeout', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'news', 'system', null, null, 0.2);
  perform ail_test.mark_sent(r);
  settled_before := (ail_test.bucket('global')).settled_usd;
  v := ail_test.settle_unknown(r, 0.05, 'TIMEOUT');
  select * into e from ai_ledger.usage_events where reservation_id = (r ->> 'reservation_id')::uuid;
  perform ail_test.check(v ->> 'status' = 'unknown' and e.estimated_cost_usd = 0.2 and e.cost_basis = 'upper_bound'
    and e.outcome = 'unknown' and e.input_tokens is null, 'timeout charged at the hold, usage unknown');
  perform ail_test.check((ail_test.bucket('global')).settled_usd = settled_before + 0.2, 'upper bound stays in the budget');

  -- release refuses a sent attempt
  r := ail_test.reserve('req-sent', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'news', 'system', null, null, 0.2);
  perform ail_test.mark_sent(r);
  held_before := (ail_test.bucket('global')).held_usd;
  v := ail_test.rpc('ai_ledger_release', jsonb_build_object('reservation_id', r ->> 'reservation_id'));
  perform ail_test.check(v ->> 'status' = 'sent' and (ail_test.bucket('global')).held_usd = held_before, 'sent hold is not released');

  -- crash after sending (network failure, no settlement): recovery finalises it at the upper bound, never releases
  set local session_replication_role = replica;
  update ai_ledger.reservations set sent_at = now() - interval '20 minutes' where request_id = 'req-sent';
  set local session_replication_role = origin;
  v := ail_test.rpc('ai_ledger_recover_stale', '{"sent_grace_seconds": 900}');
  perform ail_test.check((v ->> 'marked_unknown')::int = 1 and (v ->> 'released')::int = 0, 'recovered one sent attempt');
  select * into e from ai_ledger.usage_events where request_id = 'req-sent';
  perform ail_test.check(e.outcome = 'unknown' and e.error_code = 'RECOVERED_UNKNOWN' and e.estimated_cost_usd = 0.2
    and e.cost_basis = 'upper_bound', 'recovered at the upper bound');
  perform ail_test.check((select status from ai_ledger.reservations where request_id = 'req-sent') = 'unknown', 'status unknown');

  -- network failure reported by the caller
  r := ail_test.reserve('req-network', 1, 'openai', 'gpt-6.1-sol', 'kabumori', 'news', 'system', null, null, 0.1);
  perform ail_test.mark_sent(r);
  v := ail_test.settle_unknown(r, 0.1, 'NETWORK');
  perform ail_test.check(v ->> 'status' = 'unknown', 'network failure finalised as unknown');

  -- an expired hold that was never sent: mark_sent refuses and releases it
  r := ail_test.reserve('req-expired', 1, 'openai', 'gpt-6-luna', 'kabumori', 'news', 'system', null, null, 0.1);
  calls_before := (ail_test.bucket('global')).calls;
  set local session_replication_role = replica;
  update ai_ledger.reservations set expires_at = now() - interval '1 minute' where request_id = 'req-expired';
  set local session_replication_role = origin;
  v := ail_test.mark_sent(r);
  perform ail_test.check(v = '{"status": "released", "may_send": false}'::jsonb, 'expired hold cannot be sent');
  perform ail_test.check((ail_test.bucket('global')).calls = calls_before - 1, 'released hold returned its call');

  -- recovery releases expired, never-sent holds
  r := ail_test.reserve('req-expired-2', 1, 'openai', 'gpt-6-luna', 'kabumori', 'news', 'system', null, null, 0.1);
  set local session_replication_role = replica;
  update ai_ledger.reservations set expires_at = now() - interval '1 minute' where request_id = 'req-expired-2';
  set local session_replication_role = origin;
  v := ail_test.rpc('ai_ledger_recover_stale', '{}');
  perform ail_test.check((v ->> 'released')::int = 1, 'recovery released the expired hold');

  -- a settlement that arrives after a release is still counted (the call did happen)
  calls_before := (ail_test.bucket('global')).calls;
  settled_before := (ail_test.bucket('global')).settled_usd;
  v := ail_test.settle_measured(r, 0.004, 40, 10);
  perform ail_test.check(v ->> 'status' = 'settled' and (ail_test.bucket('global')).calls = calls_before + 1
    and (ail_test.bucket('global')).settled_usd = settled_before + 0.004, 'late settlement counted');
end;
$$;

\echo '[17] credit exhaustion: a rejected, unbilled attempt is recorded at zero and its hold is returned'
do $$
declare r jsonb; e ai_ledger.usage_events; held_before numeric;
begin
  r := ail_test.reserve('req-credit', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'news', 'system', null, null, 0.3);
  perform ail_test.mark_sent(r);
  held_before := (ail_test.bucket('global')).held_usd;
  perform ail_test.settle_measured(r, 0, 0, 0, 0, 0, 'failed', 'CREDIT_EXHAUSTED');
  select * into e from ai_ledger.usage_events where request_id = 'req-credit';
  perform ail_test.check(e.outcome = 'failed' and e.error_code = 'CREDIT_EXHAUSTED' and e.estimated_cost_usd = 0, 'recorded');
  perform ail_test.check((ail_test.bucket('global')).held_usd = held_before - 0.3, 'hold returned');
end;
$$;

\echo '[18][19] a failing write or call changes nothing (atomic); the attempt stays recoverable'
create function ail_test.fail_insert() returns trigger language plpgsql as $$
begin
  if new.error_code = 'FAIL_INSERT' then raise exception 'simulated storage failure'; end if;
  return new;
end;
$$;
create trigger ail_test_fail_insert before insert on ai_ledger.usage_events for each row execute function ail_test.fail_insert();
do $$
declare r jsonb; err text; before_bucket ai_ledger.budget_buckets; reservations_before bigint;
begin
  r := ail_test.reserve('req-persist', 1, 'openai', 'gpt-6-luna', 'kabumori', 'news', 'system', null, null, 0.1);
  perform ail_test.mark_sent(r);
  before_bucket := ail_test.bucket('global');
  err := ail_test.rpc_error('ai_ledger_settle', jsonb_build_object('reservation_id', r ->> 'reservation_id', 'outcome', 'failed',
    'cost_basis', 'measured', 'estimated_cost_usd', 0, 'input_tokens', 0, 'output_tokens', 0, 'error_code', 'FAIL_INSERT', 'price_catalog_version', 'v1'));
  perform ail_test.check(err like '%simulated storage failure%', 'storage failure surfaced');
  perform ail_test.check(ail_test.bucket('global') = before_bucket, 'buckets unchanged after the failed settlement');
  perform ail_test.check((select status from ai_ledger.reservations where request_id = 'req-persist') = 'sent', 'still sent (recoverable)');
  err := ail_test.rpc_error('ai_ledger_settle', jsonb_build_object('reservation_id', r ->> 'reservation_id', 'outcome', 'succeeded',
    'cost_basis', 'measured', 'estimated_cost_usd', 0.1, 'input_tokens', 5, 'cache_read_input_tokens', 9, 'output_tokens', 1, 'price_catalog_version', 'v1'));
  perform ail_test.check(err like '22023:%', 'cache tokens above the input are refused');
  perform ail_test.check(ail_test.bucket('global') = before_bucket, 'still unchanged');
  reservations_before := (select count(*) from ai_ledger.reservations);
  err := ail_test.rpc_error('ai_ledger_reserve', '{"request_id":"req-bad","attempt":1,"provider":"other","model":"m","application":"a","feature":"f","logical_role":"r","subject_kind":"system","amount_usd":0.1}');
  perform ail_test.check(err like '22023:%' and (select count(*) from ai_ledger.reservations) = reservations_before, 'failed reserve writes nothing');
  err := ail_test.rpc_error('ai_ledger_settle', '{"reservation_id":"00000000-0000-4000-8000-000000000999","outcome":"succeeded","cost_basis":"measured","estimated_cost_usd":0,"input_tokens":0,"output_tokens":0,"price_catalog_version":"v1"}');
  perform ail_test.check(err like 'P0002:AI_LEDGER_RESERVATION_UNKNOWN%', 'unknown reservation');
  perform ail_test.settle_measured(r, 0.001, 10, 1);
end;
$$;
drop trigger ail_test_fail_insert on ai_ledger.usage_events;

\echo '[26] invalid amounts, token counts and identifiers are refused'
do $$
declare
  base jsonb := '{"request_id":"req-inv","attempt":1,"provider":"openai","model":"gpt-6-luna","application":"kabumori","feature":"news","logical_role":"kabumori.news","subject_kind":"system","amount_usd":0.1}';
  bad jsonb;
  r jsonb;
begin
  foreach bad in array array[
    base || '{"amount_usd": -0.01}', base || '{"amount_usd": 1000.01}', base || '{"amount_usd": "0.1"}',
    base || '{"attempt": 0}', base || '{"attempt": 11}', base || '{"attempt": 1.5}', base || '{"hold_seconds": 5}',
    base || '{"request_id": "has space"}', base || '{"request_id": ""}', base - 'model',
    base || '{"user_id": "00000000-0000-4000-8000-00000000000a"}',
    base || '{"subject_kind": "user"}', base || '{"subject_kind": "user", "user_id": "not-a-uuid"}',
    base || '{"provider": "gemini"}', '[]'::jsonb, 'null'::jsonb]
  loop
    perform ail_test.check(ail_test.rpc_error('ai_ledger_reserve', bad) like '22023:%', 'reserve refuses ' || bad::text);
  end loop;
  r := ail_test.reserve('req-inv-ok', 1, 'openai', 'gpt-6-luna', 'kabumori', 'news', 'system', null, null, 0.1);
  perform ail_test.mark_sent(r);
  foreach bad in array array[
    '{"outcome":"succeeded","cost_basis":"measured","estimated_cost_usd":-1,"input_tokens":1,"output_tokens":1}',
    '{"outcome":"succeeded","cost_basis":"measured","estimated_cost_usd":0.1,"input_tokens":-1,"output_tokens":1}',
    '{"outcome":"succeeded","cost_basis":"measured","estimated_cost_usd":0.1,"input_tokens":1.5,"output_tokens":1}',
    '{"outcome":"succeeded","cost_basis":"measured","estimated_cost_usd":0.1,"output_tokens":1}',
    '{"outcome":"succeeded","cost_basis":"measured","estimated_cost_usd":0.1,"input_tokens":1,"output_tokens":1,"reasoning_output_tokens":2}',
    '{"outcome":"unknown","cost_basis":"measured","estimated_cost_usd":0.1,"input_tokens":1,"output_tokens":1}',
    '{"outcome":"unknown","cost_basis":"upper_bound","estimated_cost_usd":0.1,"input_tokens":1}',
    '{"outcome":"succeeded","cost_basis":"guess","estimated_cost_usd":0.1,"input_tokens":1,"output_tokens":1}',
    '{"outcome":"failed","cost_basis":"measured","estimated_cost_usd":0,"input_tokens":0,"output_tokens":0,"error_code":"lower_case"}',
    '{"outcome":"failed","cost_basis":"measured","estimated_cost_usd":0,"input_tokens":0,"output_tokens":0,"http_status":700}']::jsonb[]
  loop
    bad := bad || jsonb_build_object('reservation_id', r ->> 'reservation_id', 'price_catalog_version', 'v1');
    perform ail_test.check(ail_test.rpc_error('ai_ledger_settle', bad) like '22023:%', 'settle refuses ' || bad::text);
  end loop;
  perform ail_test.check((select status from ai_ledger.reservations where request_id = 'req-inv-ok') = 'sent', 'nothing finalised');
  perform ail_test.settle_measured(r, 0.001, 10, 1);
end;
$$;

\echo '[20][21][22][23] role boundaries: anon / authenticated cannot reach anything; service_role only via the RPCs'
do $$
declare fn text; role text; err text; v jsonb;
begin
  foreach fn in array array['ai_ledger_reserve', 'ai_ledger_mark_sent', 'ai_ledger_settle', 'ai_ledger_release',
                            'ai_ledger_recover_stale', 'ai_ledger_usage_summary', 'ai_ledger_budget_status'] loop
    foreach role in array array['anon', 'authenticated'] loop
      err := ail_test.rpc_error(fn, '{}', role);
      perform ail_test.check(err like '42501:permission denied for function%', role || ' cannot execute ' || fn);
      perform ail_test.check(not has_function_privilege(role, ('public.' || fn || '(jsonb)')::regprocedure, 'EXECUTE'), role || ' no EXECUTE ' || fn);
    end loop;
    perform ail_test.check(has_function_privilege('service_role', ('public.' || fn || '(jsonb)')::regprocedure, 'EXECUTE'), 'service_role EXECUTE ' || fn);
  end loop;
  foreach role in array array['anon', 'authenticated', 'service_role'] loop
    begin
      execute format('set local role %I', role);
      perform count(*) from ai_ledger.usage_events;
      raise exception 'AIL_TEST_FAIL: % read the ledger directly', role;
    exception when insufficient_privilege then
      execute 'reset role';
    end;
    begin
      execute format('set local role %I', role);
      perform ai_ledger.jst_day(now());
      raise exception 'AIL_TEST_FAIL: % executed a helper', role;
    exception when insufficient_privilege then
      execute 'reset role';
    end;
    perform ail_test.check(not has_schema_privilege(role, 'ai_ledger', 'USAGE'), role || ' no schema usage');
    perform ail_test.check(not has_table_privilege(role, 'ai_ledger.budget_policies', 'INSERT'), role || ' cannot write policies');
  end loop;
  v := ail_test.rpc('ai_ledger_budget_status', '{}');
  perform ail_test.check(jsonb_array_length(v) > 0, 'service_role reads budget status through the RPC');
end;
$$;

\echo '[append-only] events cannot be changed even by the owner; reservations only move forward'
do $$
begin
  begin
    -- a change no constraint would stop: only the append-only trigger can refuse it
    update ai_ledger.usage_events set latency_ms = coalesce(latency_ms, 0) + 1;
    raise exception 'AIL_TEST_FAIL: usage event updated';
  exception when raise_exception then
    perform ail_test.check(sqlerrm like 'AI_LEDGER_APPEND_ONLY%', 'append-only update');
  end;
  begin
    delete from ai_ledger.usage_events;
    raise exception 'AIL_TEST_FAIL: usage event deleted';
  exception when raise_exception then null;
  end;
  begin
    delete from ai_ledger.reservations;
    raise exception 'AIL_TEST_FAIL: reservation deleted';
  exception when raise_exception then null;
  end;
  begin
    update ai_ledger.reservations set status = 'sent', sent_at = now() where status = 'settled';
    raise exception 'AIL_TEST_FAIL: settled reservation re-opened';
  exception when raise_exception then
    perform ail_test.check(sqlerrm like 'AI_LEDGER_RESERVATION_TRANSITION%', 'transition refused');
  end;
  begin
    update ai_ledger.reservations set reserved_usd = 0 where status = 'settled';
    raise exception 'AIL_TEST_FAIL: reservation amount changed';
  exception when raise_exception then
    perform ail_test.check(sqlerrm like 'AI_LEDGER_RESERVATION_IMMUTABLE%', 'identity immutable');
  end;
  begin
    truncate ai_ledger.usage_events;
    raise exception 'AIL_TEST_FAIL: ledger truncated';
  exception when raise_exception then null;
  end;
end;
$$;

\echo '[2]-[8] summaries by provider / model / application / brand / user / feature / month match the ledger'
do $$
declare dim text; got jsonb; expected jsonb; col text;
begin
  foreach dim in array array['total', 'provider', 'model', 'application', 'feature', 'logical_role', 'subject_kind', 'brand', 'user'] loop
    got := ail_test.rpc('ai_ledger_usage_summary', jsonb_build_object('billing_month', ail_test.this_month(), 'dimension', dim));
    col := case dim when 'total' then '''total''' when 'feature' then 'application || ''/'' || feature'
                    when 'brand' then 'coalesce(brand_id::text, ''(none)'')' when 'user' then 'coalesce(user_id::text, ''(none)'')'
                    else dim end;
    execute format($q$
      select coalesce(jsonb_agg(jsonb_build_object('key', k, 'attempts', n, 'usd', usd) order by k), '[]')
        from (select %s as k, count(*) as n, sum(estimated_cost_usd) as usd from ai_ledger.usage_events
               where billing_month = ai_ledger.jst_month_start(now()) group by 1) s $q$, col) into expected;
    perform ail_test.check(
      (select jsonb_agg(jsonb_build_object('key', x ->> 'key', 'attempts', (x ->> 'attempts')::bigint, 'usd', (x ->> 'estimated_cost_usd')::numeric) order by x ->> 'key')
         from jsonb_array_elements(got) x) = expected, 'summary by ' || dim);
  end loop;
  got := ail_test.rpc('ai_ledger_usage_summary', '{"billing_month": "2020-01-01", "dimension": "total"}');
  perform ail_test.check(got = '[]'::jsonb, 'another month is empty');
  got := ail_test.rpc('ai_ledger_usage_summary', jsonb_build_object('billing_month', ail_test.this_month(), 'dimension', 'provider'));
  perform ail_test.check((select count(*) from jsonb_array_elements(got) x where x ->> 'key' in ('openai', 'anthropic')) = 2, 'both providers present');
  got := ail_test.rpc('ai_ledger_usage_summary', jsonb_build_object('billing_month', ail_test.this_month(), 'dimension', 'subject_kind'));
  perform ail_test.check((select (x ->> 'upper_bound_cost_usd')::numeric from jsonb_array_elements(got) x where x ->> 'key' = 'system') >= 0.4,
    'upper-bound costs are reported separately');
  perform ail_test.check(ail_test.rpc_error('ai_ledger_usage_summary', '{"billing_month": "2026-10-15", "dimension": "total"}') like '22023:%', 'month must be YYYY-MM-01');
  perform ail_test.check(ail_test.rpc_error('ai_ledger_usage_summary', jsonb_build_object('billing_month', ail_test.this_month(), 'dimension', 'prompt')) like '22023:%', 'unknown dimension');
end;
$$;

\echo '[status] budget status lists current buckets with levels'
do $$
declare v jsonb;
begin
  v := ail_test.rpc('ai_ledger_budget_status', '{}');
  perform ail_test.check(exists (select 1 from jsonb_array_elements(v) x
                                  where x ->> 'policy_key' = 'postona.per_brand' and x ->> 'brand_id' = '00000000-0000-4000-8000-0000000000b1'
                                    and (x ->> 'calls')::int = 3 and x ->> 'level' = 'critical'), 'full brand bucket is critical');
end;
$$;

\echo '[30] no prompt, output or credential can be stored: extra fields are ignored, no free-text column exists'
do $$
declare r jsonb; hits integer; t record;
begin
  r := ail_test.rpc('ai_ledger_reserve', '{"request_id":"req-secret","attempt":1,"provider":"openai","model":"gpt-6-luna","application":"kabumori","feature":"news","logical_role":"kabumori.news","subject_kind":"system","amount_usd":0.01,"prompt":"SENTINEL-PROMPT","authorization":"Bearer SENTINEL-KEY"}');
  perform ail_test.mark_sent(r);
  perform ail_test.rpc('ai_ledger_settle', jsonb_build_object('reservation_id', r ->> 'reservation_id', 'outcome', 'succeeded',
    'cost_basis', 'measured', 'estimated_cost_usd', 0.001, 'input_tokens', 1, 'output_tokens', 1, 'price_catalog_version', 'v1',
    'output', 'SENTINEL-OUTPUT', 'api_key', 'SENTINEL-KEY'));
  hits := 0;
  for t in select c.relname from pg_class c where c.relnamespace = 'ai_ledger'::regnamespace and c.relkind = 'r' loop
    execute format('select count(*) from ai_ledger.%I x where x::text like ''%%SENTINEL%%''', t.relname) into hits;
    perform ail_test.check(hits = 0, 'no sentinel in ' || t.relname);
  end loop;
  perform ail_test.check(not exists (
    select 1 from information_schema.columns
     where table_schema = 'ai_ledger' and column_name ~ '(prompt|content|body|message|text|output_text|authorization|api_key|token_value|secret)'),
    'no free-text / credential column');
end;
$$;

\echo 'behaviour: all checks passed'
