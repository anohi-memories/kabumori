-- Behaviour of the Phase 1d test-phase budget policies (ai_provider_budget_ledger_initial_policies.sql) on a
-- disposable database: after the migration, the fixture and that policy file. Any failed check raises
-- AIL_TEST_FAIL and stops psql. Run by ai_provider_budget_ledger_run.sh (part "phase1d").
\set ON_ERROR_STOP 1
\set QUIET 1

\echo '[P1] exactly the two allowlist policies'
do $$
begin
  perform ail_test.check((select count(*) from ai_ledger.budget_policies where enabled) = 2, 'two enabled policies');
  perform ail_test.check((select array_agg(policy_key order by policy_key) from ai_ledger.budget_policies)
                         = array['anthropic.opus.kabumori.market_report.daily', 'anthropic.opus.kabumori.market_report.monthly'],
                         'policy keys');
end;
$$;

\echo '[P2] the shared market report (system, Anthropic, Opus 5.5) reserves, sends and settles'
do $$
declare r jsonb; s jsonb;
begin
  r := ail_test.reserve('p-ok-1', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system', null, null, 0.70);
  perform ail_test.check(r ->> 'allowed' = 'true', 'market report allowed');
  perform ail_test.check(ail_test.mark_sent(r) ->> 'may_send' = 'true', 'send permitted');
  s := ail_test.settle_measured(r, 0.27, 20000, 9500);
  perform ail_test.check(s ->> 'status' = 'settled', 'settled');
  perform ail_test.check((ail_test.bucket('anthropic.opus.kabumori.market_report.daily')).settled_usd = 0.27
                         and (ail_test.bucket('anthropic.opus.kabumori.market_report.monthly')).settled_usd = 0.27,
                         'both buckets carry the measured cost');
end;
$$;

\echo '[P3] every other use is refused before anything is written (allowlist)'
do $$
declare
  v_before bigint := (select count(*) from ai_ledger.reservations);
  r jsonb;
begin
  -- a user subject on the same feature (personal data must never reach Anthropic through this ledger)
  r := ail_test.reserve('p-no-user', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'user',
                        '00000000-0000-4000-8000-0000000000d1', null, 0.10);
  perform ail_test.check(r ->> 'reason' = 'NO_MATCHING_POLICY', 'user subject refused');
  r := ail_test.reserve('p-no-brand', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'user',
                        '00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000b1', 0.10);
  perform ail_test.check(r ->> 'reason' = 'NO_MATCHING_POLICY', 'user + brand refused');
  -- other features and applications
  r := ail_test.reserve('p-no-personal', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'personalized_report', 'system', null, null, 0.10);
  perform ail_test.check(r ->> 'reason' = 'NO_MATCHING_POLICY', 'personalized report refused');
  r := ail_test.reserve('p-no-news', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'important_news', 'system', null, null, 0.10);
  perform ail_test.check(r ->> 'reason' = 'NO_MATCHING_POLICY', 'news refused');
  r := ail_test.reserve('p-no-postona', 1, 'anthropic', 'claude-opus-5-5', 'postona', 'consult', 'system', null, null, 0.10);
  perform ail_test.check(r ->> 'reason' = 'NO_MATCHING_POLICY', 'POSTONA refused');
  r := ail_test.reserve('p-no-postona-mr', 1, 'anthropic', 'claude-opus-5-5', 'postona', 'market_report', 'system', null, null, 0.10);
  perform ail_test.check(r ->> 'reason' = 'NO_MATCHING_POLICY', 'another application with the same feature name refused');
  -- other models and the other provider
  r := ail_test.reserve('p-no-sonnet', 1, 'anthropic', 'claude-sonnet-5-5', 'kabumori', 'market_report', 'system', null, null, 0.10);
  perform ail_test.check(r ->> 'reason' = 'NO_MATCHING_POLICY', 'Sonnet refused');
  r := ail_test.reserve('p-no-haiku', 1, 'anthropic', 'claude-haiku-5-5', 'kabumori', 'market_report', 'system', null, null, 0.10);
  perform ail_test.check(r ->> 'reason' = 'NO_MATCHING_POLICY', 'Haiku refused');
  r := ail_test.reserve('p-no-openai', 1, 'openai', 'gpt-6.1-sol', 'kabumori', 'market_report', 'system', null, null, 0.10);
  perform ail_test.check(r ->> 'reason' = 'NO_MATCHING_POLICY', 'OpenAI refused');
  perform ail_test.check((select count(*) from ai_ledger.reservations) = v_before, 'no reservation written for refused uses');
end;
$$;

\echo '[P4] one attempt may hold at most $1.00'
do $$
declare r jsonb; v_calls integer := (ail_test.bucket('anthropic.opus.kabumori.market_report.daily')).calls;
begin
  r := ail_test.reserve('p-percall-over', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system', null, null, 1.00000001);
  perform ail_test.check(r ->> 'reason' = 'PER_CALL_LIMIT', 'over $1.00 refused');
  perform ail_test.check((ail_test.bucket('anthropic.opus.kabumori.market_report.daily')).calls = v_calls, 'refusal counts no call');
  r := ail_test.reserve('p-percall-exact', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system', null, null, 1.00);
  perform ail_test.check(r ->> 'allowed' = 'true', 'exactly $1.00 allowed');
  perform ail_test.check(ail_test.rpc('ai_ledger_release', jsonb_build_object('reservation_id', r ->> 'reservation_id')) ->> 'status' = 'released',
                         'unsent hold released');
end;
$$;

\echo '[P5] the day stops at $2.00 (held + settled)'
do $$
declare r1 jsonb; r2 jsonb;
begin
  -- settled 0.27 so far today
  r1 := ail_test.reserve('p-day-usd-1', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system', null, null, 1.00);
  perform ail_test.check(r1 ->> 'allowed' = 'true', '0.27 + 1.00 allowed');
  r2 := ail_test.reserve('p-day-usd-2', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system', null, null, 0.80);
  perform ail_test.check(r2 ->> 'reason' = 'COST_LIMIT' and r2 ->> 'policy_key' = 'anthropic.opus.kabumori.market_report.daily',
                         '0.27 + 1.00 + 0.80 > $2.00 refused by the daily policy');
  perform ail_test.rpc('ai_ledger_release', jsonb_build_object('reservation_id', r1 ->> 'reservation_id'));
end;
$$;

\echo '[P6] the day stops at 6 attempts'
do $$
declare r jsonb; i integer := 0;
begin
  loop
    i := i + 1;
    r := ail_test.reserve('p-day-calls-' || i, 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system', null, null, 0.01);
    exit when r ->> 'allowed' <> 'true' or i > 10;
  end loop;
  perform ail_test.check(r ->> 'reason' = 'CALL_LIMIT' and r ->> 'policy_key' = 'anthropic.opus.kabumori.market_report.daily',
                         'refused by the daily call cap');
  perform ail_test.check((ail_test.bucket('anthropic.opus.kabumori.market_report.daily')).calls = 6, 'exactly 6 attempts today');
  -- release the open holds again (they were never sent)
  perform ail_test.rpc('ai_ledger_release', jsonb_build_object('reservation_id', x.id))
     from ai_ledger.reservations x where x.status = 'reserved';
end;
$$;

\echo '[P7] the month stops at 40 attempts and at $5.00'
do $$
declare r jsonb;
begin
  -- Simulate the rest of the month on the counters (test fixture only): today is clear, the month nearly full.
  update ai_ledger.budget_buckets b set calls = 0, held_usd = 0, settled_usd = 0
    from ai_ledger.budget_policies p where p.id = b.policy_id and p.period = 'day';
  update ai_ledger.budget_buckets b set calls = 39, held_usd = 0, settled_usd = 4.50
    from ai_ledger.budget_policies p where p.id = b.policy_id and p.period = 'month';
  r := ail_test.reserve('p-month-40', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system', null, null, 0.40);
  perform ail_test.check(r ->> 'allowed' = 'true', '40th attempt within $5.00 allowed');
  r := ail_test.reserve('p-month-41', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system', null, null, 0.01);
  perform ail_test.check(r ->> 'reason' = 'CALL_LIMIT' and r ->> 'policy_key' = 'anthropic.opus.kabumori.market_report.monthly',
                         '41st attempt refused by the monthly call cap');
  update ai_ledger.budget_buckets b set calls = 10
    from ai_ledger.budget_policies p where p.id = b.policy_id and p.period = 'month';
  r := ail_test.reserve('p-month-usd', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system', null, null, 0.20);
  perform ail_test.check(r ->> 'reason' = 'COST_LIMIT' and r ->> 'policy_key' = 'anthropic.opus.kabumori.market_report.monthly',
                         '4.50 + 0.40 + 0.20 > $5.00 refused by the monthly policy');
end;
$$;

\echo '[P8] the stop switch: disabled policies refuse everything; enabling restores'
do $$
declare r jsonb;
begin
  update ai_ledger.budget_buckets b set calls = 0, held_usd = 0, settled_usd = 0;
  update ai_ledger.budget_policies set enabled = false;
  r := ail_test.reserve('p-stop', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system', null, null, 0.10);
  perform ail_test.check(r ->> 'reason' = 'NO_MATCHING_POLICY', 'stopped');
  update ai_ledger.budget_policies set enabled = true;
  r := ail_test.reserve('p-restart', 1, 'anthropic', 'claude-opus-5-5', 'kabumori', 'market_report', 'system', null, null, 0.10);
  perform ail_test.check(r ->> 'allowed' = 'true', 'restarted');
end;
$$;
\echo 'PASS policies behaviour'
