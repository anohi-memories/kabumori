-- Behaviour of the AI consumer call store (disposable database, after the ledger migration, this migration, the
-- ledger fixture and this store's fixture). Any failed check raises ACS_TEST_FAIL and stops psql.
\set ON_ERROR_STOP 1
\set QUIET 1

-- A fully scoped POSTONA consult policy (the allowlist rule of the ledger's initial policies).
insert into ai_ledger.budget_policies
  (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls, max_estimated_usd, max_usd_per_call)
values
  ('anthropic.postona.consult.user.daily', 'anthropic', 'claude-haiku-5-5', 'postona', 'postona.consult', 'user', true, 'day', 1000, 10, 0.05),
  ('anthropic.postona.quota.user.daily', 'anthropic', 'claude-haiku-5-5', 'postona', 'postona.quota', 'user', true, 'day', 1, 10, 0.05);

\echo '[1] first claim acquires; a duplicate is busy, however old the claim is (no time-based takeover)'
do $$
declare c jsonb := acs_test.claim_p('op-1', 'tenant-a', 'content-1'); r jsonb; r2 jsonb; row ai_calls.consumer_calls;
begin
  r := acs_test.claim(c);
  perform acs_test.check(r ->> 'kind' = 'acquired' and (r ->> 'owner') ~ '^[0-9a-f-]{36}$', 'first claim acquired with an owner');
  perform acs_test.check((r ->> 'owner') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$', 'owner passes the bridge identifier check');
  row := acs_test.call_row(c);
  perform acs_test.check(row.state = 'acquired' and row.claim_token::text = r ->> 'owner' and row.result is null, 'row acquired');
  r2 := acs_test.claim(c);
  perform acs_test.check(r2 = '{"kind": "busy"}'::jsonb, 'duplicate claim busy');
  perform acs_test.backdate(c, interval '30 days');
  r2 := acs_test.claim(c);
  perform acs_test.check(r2 = '{"kind": "busy"}'::jsonb, 'a 30-day-old claim is still busy (never taken over)');
  perform acs_test.check((select count(*) from ai_calls.consumer_calls) = 1, 'one row');
  perform acs_test.check((acs_test.call_row(c)).claim_token = row.claim_token, 'owner unchanged');
end;
$$;

\echo '[2] content drift: the same key with another fingerprint / tenant / subject is a conflict; nothing changes'
do $$
declare c jsonb := acs_test.claim_p('op-1', 'tenant-a', 'content-1'); before ai_calls.consumer_calls; r jsonb;
begin
  before := acs_test.call_row(c);
  r := acs_test.claim(c || jsonb_build_object('fingerprint', acs_test.hex('content-2')));
  perform acs_test.check(r = '{"kind": "conflict"}'::jsonb, 'other fingerprint -> conflict');
  r := acs_test.claim(c || jsonb_build_object('tenant_tag', acs_test.hex('tenant-b')));
  perform acs_test.check(r = '{"kind": "conflict"}'::jsonb, 'other tenant -> conflict');
  r := acs_test.claim(c || jsonb_build_object('user_id', '00000000-0000-4000-8000-0000000000b2'));
  perform acs_test.check(r = '{"kind": "conflict"}'::jsonb, 'other user -> conflict');
  r := acs_test.claim(c || jsonb_build_object('feature', 'postona.preview'));
  perform acs_test.check(r = '{"kind": "conflict"}'::jsonb, 'other feature -> conflict');
  perform acs_test.check(acs_test.call_row(c) = before, 'row unchanged by conflicts');
end;
$$;

\echo '[3] two users, the same operationId: two separate calls; one user never sees or completes the other''s'
do $$
declare
  a jsonb := acs_test.claim_p('op-shared', 'tenant-a', 'content-a');
  b jsonb := acs_test.claim_p('op-shared', 'tenant-b', 'content-b', 'user', '00000000-0000-4000-8000-0000000000b2');
  ra jsonb; rb jsonb; e text;
begin
  perform acs_test.check(a ->> 'call_key' <> b ->> 'call_key', 'different keys for different tenants');
  ra := acs_test.claim(a);
  rb := acs_test.claim(b);
  perform acs_test.check(ra ->> 'kind' = 'acquired' and rb ->> 'kind' = 'acquired', 'both acquired independently');
  e := acs_test.rpc_error('ai_calls_complete', acs_test.complete_p(b, ra ->> 'owner', acs_test.ok_result(b, '{"reply": "x"}')));
  perform acs_test.check(e like 'P0001:AI_CALLS_FENCED%', 'user A''s owner cannot complete user B''s call: ' || coalesce(e, 'null'));
  e := acs_test.rpc_error('ai_calls_complete', acs_test.complete_p(b, rb ->> 'owner', acs_test.ok_result(a, '{"reply": "x"}')));
  perform acs_test.check(e like '22023:AI_CALLS_INVALID_INPUT: result%', 'a result carrying user A''s audit cannot complete B: ' || coalesce(e, 'null'));
  perform acs_test.check((acs_test.call_row(b)).state = 'acquired', 'B still acquired');
end;
$$;

\echo '[4] complete: owner only, identity checked, idempotent for the same result, then replayed'
do $$
declare
  c jsonb := acs_test.claim_p('op-4', 'tenant-a', 'content-4'); r jsonb; owner text; res jsonb; e text; row ai_calls.consumer_calls;
begin
  owner := acs_test.claim(c) ->> 'owner';
  res := acs_test.ok_result(c, '{"reply": "hello"}');
  e := acs_test.rpc_error('ai_calls_complete', acs_test.complete_p(c, gen_random_uuid()::text, res));
  perform acs_test.check(e like 'P0001:AI_CALLS_FENCED%', 'forged owner fenced: ' || coalesce(e, 'null'));
  e := acs_test.rpc_error('ai_calls_complete', acs_test.complete_p(c, owner, res) || jsonb_build_object('fingerprint', acs_test.hex('other')));
  perform acs_test.check(e like 'P0001:AI_CALLS_IDENTITY_MISMATCH%', 'identity mismatch refused: ' || coalesce(e, 'null'));
  e := acs_test.rpc_error('ai_calls_complete', acs_test.complete_p(acs_test.claim_p('op-none', 'tenant-a', 'x'), owner, res));
  perform acs_test.check(e like 'P0002:AI_CALLS_NOT_CLAIMED%', 'unknown key refused: ' || coalesce(e, 'null'));
  perform acs_test.check((acs_test.call_row(c)).state = 'acquired', 'still acquired after refusals');

  r := acs_test.rpc('ai_calls_complete', acs_test.complete_p(c, owner, res));
  perform acs_test.check(r = '{"state": "complete", "duplicate": false}'::jsonb, 'completed');
  row := acs_test.call_row(c);
  perform acs_test.check(row.state = 'complete' and row.result = res and row.audit = res -> 'audit' and row.completed_at is not null, 'row complete');
  r := acs_test.rpc('ai_calls_complete', acs_test.complete_p(c, owner, res));
  perform acs_test.check(r = '{"state": "complete", "duplicate": true}'::jsonb, 'same owner, same result -> duplicate (lost response retry)');
  e := acs_test.rpc_error('ai_calls_complete', acs_test.complete_p(c, owner, acs_test.ok_result(c, '{"reply": "other"}')));
  perform acs_test.check(e like 'P0001:AI_CALLS_RESULT_CONFLICT%', 'same owner, other result refused: ' || coalesce(e, 'null'));
  r := acs_test.claim(c);
  perform acs_test.check(r = jsonb_build_object('kind', 'complete', 'fingerprint', c ->> 'fingerprint', 'result', res), 'replay returns the stored result');
  perform acs_test.check(acs_test.call_row(c) = row, 'replay changed nothing');
end;
$$;

\echo '[5] only a well-formed final BridgeResult of THIS call is stored; oversized results are refused'
do $$
declare
  c jsonb := acs_test.claim_p('op-5', 'tenant-a', 'content-5'); owner text; good jsonb; bad jsonb; e text; label text;
  cases jsonb;
begin
  owner := acs_test.claim(c) ->> 'owner';
  good := acs_test.ok_result(c, '{"reply": "ok"}');
  cases := jsonb_build_array(
    jsonb_build_array('extra key', good || '{"note": 1}'),
    jsonb_build_array('no audit', good - 'audit'),
    jsonb_build_array('ok as string', good || '{"ok": "true"}'),
    jsonb_build_array('failure with data', acs_test.fail_result(c, 'UNKNOWN') || '{"data": {}}'),
    jsonb_build_array('code IN_PROGRESS', acs_test.fail_result(c, 'IN_PROGRESS')),
    jsonb_build_array('code CONTENT_DRIFT', acs_test.fail_result(c, 'CONTENT_DRIFT')),
    jsonb_build_array('code AUTHORITY_DENIED', acs_test.fail_result(c, 'AUTHORITY_DENIED')),
    jsonb_build_array('audit of another call', jsonb_set(good, '{audit,callId}', to_jsonb('h5m2_' || acs_test.hex('x')))),
    jsonb_build_array('audit of another tenant', jsonb_set(good, '{audit,tenantTag}', to_jsonb(acs_test.hex('tenant-b')))),
    jsonb_build_array('audit of another feature', jsonb_set(good, '{audit,feature}', '"postona.preview"')),
    jsonb_build_array('audit extra key', jsonb_set(good, '{audit,user}', '"u"')),
    jsonb_build_array('attempts 11', jsonb_set(good, '{audit,attempts}', '11')),
    jsonb_build_array('attempts 1.5', jsonb_set(good, '{audit,attempts}', '1.5')),
    jsonb_build_array('attempts as string', jsonb_set(good, '{audit,attempts}', '"1"')),
    jsonb_build_array('cost above 1 USD', jsonb_set(good, '{audit,estimatedCostUsd}', '1.5')),
    jsonb_build_array('negative cost', jsonb_set(good, '{audit,estimatedCostUsd}', '-0.1')),
    jsonb_build_array('cost basis', jsonb_set(good, '{audit,costBasis}', '"guess"')),
    jsonb_build_array('model not an identifier', jsonb_set(good, '{audit,model}', '"claude haiku"')),
    jsonb_build_array('audit null', jsonb_set(good, '{audit}', 'null')),
    jsonb_build_array('result is an array', '[1]'::jsonb),
    jsonb_build_array('oversized', jsonb_set(good, '{data,reply}', to_jsonb(repeat('x', 140000)))));
  for i in 0 .. jsonb_array_length(cases) - 1 loop
    label := cases -> i ->> 0;
    bad := cases -> i -> 1;
    e := acs_test.rpc_error('ai_calls_complete', acs_test.complete_p(c, owner, bad));
    perform acs_test.check(e like '22023:AI_CALLS_INVALID_INPUT%', 'refused: ' || label || ' -> ' || coalesce(e, 'stored'));
  end loop;
  e := acs_test.rpc_error('ai_calls_complete', acs_test.complete_p(c, owner, null));
  perform acs_test.check(e like '22023:AI_CALLS_INVALID_INPUT%', 'refused: missing result');
  perform acs_test.check((acs_test.call_row(c)).state = 'acquired', 'still acquired after every refusal');
  perform acs_test.rpc('ai_calls_complete', acs_test.complete_p(c, owner, acs_test.fail_result(c, 'BUDGET_DENIED')));
  perform acs_test.check((acs_test.call_row(c)).result ->> 'code' = 'BUDGET_DENIED', 'a valid failure result is stored');
end;
$$;

\echo '[6] input validation: key format, subject rules, brand slug; extra fields are ignored and never stored'
do $$
declare c jsonb := acs_test.claim_p('op-6', 'tenant-a', 'content-6'); e text;
begin
  e := acs_test.rpc_error('ai_calls_claim', c || '{"call_key": "h5m2_ABC"}');
  perform acs_test.check(e like '22023:AI_CALLS_INVALID_INPUT: call_key%', 'bad key: ' || coalesce(e, 'null'));
  e := acs_test.rpc_error('ai_calls_claim', c || '{"call_key": "req-1"}');
  perform acs_test.check(e like '22023:%', 'non-bridge key refused');
  e := acs_test.rpc_error('ai_calls_claim', c - 'user_id');
  perform acs_test.check(e like '22023:AI_CALLS_INVALID_INPUT: subject%', 'user subject without user_id: ' || coalesce(e, 'null'));
  e := acs_test.rpc_error('ai_calls_claim', c || '{"subject_kind": "system"}');
  perform acs_test.check(e like '22023:AI_CALLS_INVALID_INPUT: subject%', 'system subject with user_id: ' || coalesce(e, 'null'));
  e := acs_test.rpc_error('ai_calls_claim', acs_test.claim_p('op-6s', 'system', 'x', 'system', null, 'postona.ai_lab', null, 3));
  perform acs_test.check(e like '22023:AI_CALLS_INVALID_INPUT: subject%', 'system subject with lifecycle: ' || coalesce(e, 'null'));
  e := acs_test.rpc_error('ai_calls_claim', c || '{"subject_kind": "brand"}');
  perform acs_test.check(e like '22023:%', 'unknown subject kind refused');
  e := acs_test.rpc_error('ai_calls_claim', c || '{"brand_ref": "U_ABC"}');
  perform acs_test.check(e like '22023:AI_CALLS_INVALID_INPUT: brand_ref%', 'brand slug format: ' || coalesce(e, 'null'));
  e := acs_test.rpc_error('ai_calls_claim', c || '{"user_id": "u_0123456789abcdef01234567"}');
  perform acs_test.check(e like '22023:AI_CALLS_INVALID_INPUT: user_id%', 'a POSTONA slug is not a user id: ' || coalesce(e, 'null'));
  e := acs_test.rpc_error('ai_calls_claim', c || '{"lifecycle_version": -1}');
  perform acs_test.check(e like '22023:%', 'negative lifecycle refused');
  perform acs_test.check(not exists (select 1 from ai_calls.consumer_calls where call_key = c ->> 'call_key'), 'nothing written by refused claims');

  perform acs_test.claim(c || jsonb_build_object('brand_ref', 'u_0123456789abcdef01234567', 'lifecycle_version', 7,
                                                 'prompt', 'SENTINEL-PROMPT', 'api_key', 'SENTINEL-KEY', 'email', 'SENTINEL@example.com'));
  perform acs_test.check((acs_test.call_row(c)).brand_ref = 'u_0123456789abcdef01234567' and (acs_test.call_row(c)).lifecycle_version = 7, 'audit fields kept');
  perform acs_test.check(not exists (select 1 from ai_calls.consumer_calls x where x::text like '%SENTINEL%'), 'extra fields never stored');
  perform acs_test.check(acs_test.claim(acs_test.claim_p('op-6sys', 'system-postona', 'x', 'system', null, 'postona.ai_lab', 'ai_salaryman_lab')) ->> 'kind' = 'acquired',
    'system subject with an audit brand slug');
end;
$$;

\echo '[7] crash recovery: abandon only old claims whose ledger attempts are all final, with an audit that matches the ledger'
do $$
declare
  c jsonb := acs_test.claim_p('op-7', 'tenant-a', 'content-7'); owner text; res jsonb; r jsonb; e text; rid jsonb;
begin
  owner := acs_test.claim(c) ->> 'owner';
  r := acs_test.rpc('ai_calls_abandon', acs_test.abandon_p(c, acs_test.audit(c, 0, 0, 'no_request')));
  perform acs_test.check(r = '{"abandoned": false, "reason": "TOO_RECENT"}'::jsonb, 'fresh claim not abandoned: ' || r::text);
  e := acs_test.rpc_error('ai_calls_abandon', acs_test.abandon_p(c, acs_test.audit(c, 0, 0, 'no_request'), 60));
  perform acs_test.check(e like '22023:%', 'threshold below 300 s refused');
  perform acs_test.backdate(c, interval '31 minutes');

  -- the provider attempt was reserved and then sent; the worker crashed before settling
  rid := acs_test.reserve(c);
  perform acs_test.check(rid ->> 'allowed' = 'true', 'ledger reserved: ' || rid::text);
  r := acs_test.rpc('ai_calls_abandon', acs_test.abandon_p(c, acs_test.audit(c, 0, 0, 'no_request')));
  perform acs_test.check(r ->> 'reason' = 'LEDGER_NOT_FINAL', 'reserved attempt blocks abandon: ' || r::text);
  perform ail_test.mark_sent(rid);
  r := acs_test.rpc('ai_calls_abandon', acs_test.abandon_p(c, acs_test.audit(c, 1, 0.0044, 'includes_upper_bound')));
  perform acs_test.check(r ->> 'reason' = 'LEDGER_NOT_FINAL', 'sent attempt blocks abandon: ' || r::text);
  -- recovery: the ledger finalises the sent attempt at its upper bound (unknown)
  perform set_config('session_replication_role', 'replica', true);
  update ai_ledger.reservations set sent_at = now() - interval '1 hour' where id = (rid ->> 'reservation_id')::uuid;
  perform set_config('session_replication_role', 'origin', true);
  r := acs_test.rpc('ai_ledger_recover_stale', '{}');
  perform acs_test.check(r ->> 'marked_unknown' = '1', 'ledger marked the attempt unknown');

  -- the audit must agree with the ledger
  e := acs_test.rpc_error('ai_calls_abandon', acs_test.abandon_p(c, acs_test.audit(c, 0, 0, 'no_request')));
  perform acs_test.check(e like 'P0001:AI_CALLS_AUDIT_LEDGER_MISMATCH%', 'attempts 0 vs 1 sent: ' || coalesce(e, 'null'));
  e := acs_test.rpc_error('ai_calls_abandon', acs_test.abandon_p(c, acs_test.audit(c, 1, 0.0044, 'measured')));
  perform acs_test.check(e like 'P0001:AI_CALLS_AUDIT_LEDGER_MISMATCH%', 'upper bound must be shown: ' || coalesce(e, 'null'));
  e := acs_test.rpc_error('ai_calls_abandon', acs_test.abandon_p(c, acs_test.audit(c, 1, 0.001, 'includes_upper_bound')));
  perform acs_test.check(e like 'P0001:AI_CALLS_AUDIT_LEDGER_MISMATCH%', 'cost below the ledger charge: ' || coalesce(e, 'null'));
  e := acs_test.rpc_error('ai_calls_abandon', acs_test.abandon_p(c, jsonb_set(acs_test.audit(c, 1, 0.0044, 'includes_upper_bound'), '{tenantTag}', to_jsonb(acs_test.hex('tenant-b')))));
  perform acs_test.check(e like '22023:AI_CALLS_INVALID_INPUT: audit%', 'audit of another tenant: ' || coalesce(e, 'null'));
  perform acs_test.check((acs_test.call_row(c)).state = 'acquired', 'still acquired after refusals');

  r := acs_test.rpc('ai_calls_abandon', acs_test.abandon_p(c, acs_test.audit(c, 1, 0.0044, 'includes_upper_bound')));
  perform acs_test.check(r = '{"abandoned": true}'::jsonb, 'abandoned: ' || r::text);
  perform acs_test.check((acs_test.call_row(c)).state = 'abandoned'
    and (acs_test.call_row(c)).result = jsonb_build_object('ok', false, 'code', 'UNKNOWN', 'audit', acs_test.audit(c, 1, 0.0044, 'includes_upper_bound')),
    'tombstone with the ledger-consistent audit');
  -- the old owner is fenced, a duplicate replays UNKNOWN, nothing can be sent again for this call
  e := acs_test.rpc_error('ai_calls_complete', acs_test.complete_p(c, owner, acs_test.ok_result(c, '{"reply": "late"}')));
  perform acs_test.check(e like 'P0001:AI_CALLS_FENCED%', 'old owner fenced after abandon: ' || coalesce(e, 'null'));
  r := acs_test.claim(c);
  perform acs_test.check(r ->> 'kind' = 'complete' and r -> 'result' ->> 'code' = 'UNKNOWN', 'duplicate replays UNKNOWN');
  r := acs_test.reserve(c);
  perform acs_test.check(r ->> 'allowed' = 'false' and r ->> 'reason' = 'ATTEMPT_FINALIZED', 'the ledger refuses the attempt again: ' || r::text);
  r := acs_test.rpc('ai_calls_abandon', acs_test.abandon_p(c, acs_test.audit(c, 1, 0.0044, 'includes_upper_bound')));
  perform acs_test.check(r = '{"abandoned": false, "reason": "NOT_ACQUIRED", "state": "abandoned"}'::jsonb, 'abandon is not repeated');
  r := acs_test.rpc('ai_calls_abandon', acs_test.abandon_p(acs_test.claim_p('op-none', 'tenant-a', 'x'), acs_test.audit(c, 0, 0, 'no_request')));
  perform acs_test.check(r = '{"abandoned": false, "reason": "NOT_FOUND"}'::jsonb, 'unknown key');
end;
$$;

\echo '[8] crash before any send: no reservation, or a reservation released by recovery -> abandoned at zero cost'
do $$
declare
  c1 jsonb := acs_test.claim_p('op-8a', 'tenant-a', 'content-8a');
  c2 jsonb := acs_test.claim_p('op-8b', 'tenant-a', 'content-8b'); r jsonb; rid jsonb; e text;
begin
  perform acs_test.claim(c1);
  perform acs_test.claim(c2);
  perform acs_test.backdate(c1, interval '1 hour');
  perform acs_test.backdate(c2, interval '1 hour');
  r := acs_test.rpc('ai_calls_abandon', acs_test.abandon_p(c1, acs_test.audit(c1, 0, 0, 'no_request')));
  perform acs_test.check(r = '{"abandoned": true}'::jsonb, 'claimed, never reserved -> abandoned');
  rid := acs_test.reserve(c2);
  perform set_config('session_replication_role', 'replica', true);
  update ai_ledger.reservations set expires_at = now() - interval '1 minute' where id = (rid ->> 'reservation_id')::uuid;
  perform set_config('session_replication_role', 'origin', true);
  r := acs_test.rpc('ai_calls_abandon', acs_test.abandon_p(c2, acs_test.audit(c2, 0, 0, 'no_request')));
  perform acs_test.check(r ->> 'reason' = 'LEDGER_NOT_FINAL', 'an expired but unreleased hold still blocks');
  perform acs_test.rpc('ai_ledger_recover_stale', '{}');
  perform acs_test.check((select status from ai_ledger.reservations where id = (rid ->> 'reservation_id')::uuid) = 'released', 'hold released');
  e := acs_test.rpc_error('ai_calls_abandon', acs_test.abandon_p(c2, acs_test.audit(c2, 1, 0.0044, 'includes_upper_bound')));
  perform acs_test.check(e like 'P0001:AI_CALLS_AUDIT_LEDGER_MISMATCH%', 'an audit claiming a send that never happened: ' || coalesce(e, 'null'));
  r := acs_test.rpc('ai_calls_abandon', acs_test.abandon_p(c2, acs_test.audit(c2, 0, 0, 'no_request')));
  perform acs_test.check(r = '{"abandoned": true}'::jsonb, 'released hold -> abandoned at zero cost');
end;
$$;

\echo '[9] 504 / timeout: settled unknown at the upper bound, stored as UNKNOWN, replayed, never sent again'
do $$
declare
  c jsonb := acs_test.claim_p('op-9', 'tenant-a', 'content-9'); owner text; rid jsonb; r jsonb; res jsonb; b ai_ledger.budget_buckets;
begin
  owner := acs_test.claim(c) ->> 'owner';
  rid := acs_test.reserve(c);
  perform acs_test.check((ail_test.mark_sent(rid)) ->> 'may_send' = 'true', 'one send permit');
  r := ail_test.settle_unknown(rid, 0.001, 'TIMEOUT');
  perform acs_test.check(r ->> 'status' = 'unknown' and (r ->> 'estimated_cost_usd')::numeric = 0.0044, 'charged at the upper bound: ' || r::text);
  res := acs_test.fail_result(c, 'UNKNOWN', 1, 0.0044, 'includes_upper_bound');
  perform acs_test.rpc('ai_calls_complete', acs_test.complete_p(c, owner, res));
  r := acs_test.claim(c);
  perform acs_test.check(r -> 'result' = res, 'replay UNKNOWN');
  r := acs_test.reserve(c);
  perform acs_test.check(r ->> 'reason' = 'ATTEMPT_FINALIZED', 'no second send of attempt 1');
  b := ail_test.bucket('anthropic.postona.consult.user.daily', null, '00000000-0000-4000-8000-0000000000a1');
  perform acs_test.check(b.settled_usd >= 0.0044, 'bucket carries the upper bound');
  perform acs_test.check((select count(*) from ai_ledger.reservations where request_id = c ->> 'call_key') = 1, 'one reservation for the call');
end;
$$;

\echo '[10] quota: a denied reservation leaves no reservation and stores BUDGET_DENIED; no policy at all -> denied too'
do $$
declare
  c1 jsonb := acs_test.claim_p('op-10a', 'tenant-a', 'q1', 'user', '00000000-0000-4000-8000-0000000000a1', 'postona.quota');
  c2 jsonb := acs_test.claim_p('op-10b', 'tenant-a', 'q2', 'user', '00000000-0000-4000-8000-0000000000a1', 'postona.quota');
  c3 jsonb := acs_test.claim_p('op-10c', 'tenant-a', 'q3', 'user', '00000000-0000-4000-8000-0000000000a1', 'postona.unlisted');
  o text; r jsonb;
begin
  perform acs_test.claim(c1);
  o := acs_test.claim(c2) ->> 'owner';
  r := acs_test.reserve(c1);
  perform acs_test.check(r ->> 'allowed' = 'true', 'first call within the cap of 1');
  r := acs_test.reserve(c2);
  perform acs_test.check(r ->> 'allowed' = 'false' and r ->> 'reason' = 'CALL_LIMIT', 'second call denied: ' || r::text);
  perform acs_test.rpc('ai_calls_complete', acs_test.complete_p(c2, o, acs_test.fail_result(c2, 'BUDGET_DENIED')));
  perform acs_test.check((acs_test.claim(c2)) -> 'result' ->> 'code' = 'BUDGET_DENIED', 'replay BUDGET_DENIED');
  perform acs_test.check(not exists (select 1 from ai_ledger.reservations where request_id = c2 ->> 'call_key'), 'no reservation for the denied call');
  perform acs_test.claim(c3);
  r := acs_test.reserve(c3);
  perform acs_test.check(r ->> 'reason' = 'NO_MATCHING_POLICY', 'a feature without a policy is denied: ' || r::text);
end;
$$;

\echo '[11] content retention: successful outputs older than the window become UNKNOWN tombstones with the same audit'
do $$
declare
  old_ok jsonb := acs_test.claim_p('op-11a', 'tenant-a', 'c11a');
  new_ok jsonb := acs_test.claim_p('op-11b', 'tenant-a', 'c11b');
  old_fail jsonb := acs_test.claim_p('op-11c', 'tenant-a', 'c11c');
  oa text; ob text; oc text; res jsonb; r jsonb; row ai_calls.consumer_calls; e text;
begin
  oa := acs_test.claim(old_ok) ->> 'owner';
  ob := acs_test.claim(new_ok) ->> 'owner';
  oc := acs_test.claim(old_fail) ->> 'owner';
  res := acs_test.ok_result(old_ok, '{"reply": "SENTINEL-OUTPUT"}');
  perform acs_test.rpc('ai_calls_complete', acs_test.complete_p(old_ok, oa, res));
  perform acs_test.rpc('ai_calls_complete', acs_test.complete_p(new_ok, ob, acs_test.ok_result(new_ok, '{"reply": "SENTINEL-RECENT"}')));
  perform acs_test.rpc('ai_calls_complete', acs_test.complete_p(old_fail, oc, acs_test.fail_result(old_fail, 'PROVIDER_FAILED', 1, 0.0012, 'measured')));
  perform acs_test.backdate(old_ok, interval '25 hours');
  perform acs_test.backdate(old_fail, interval '25 hours');
  r := acs_test.rpc('ai_calls_purge_content', '{}');
  perform acs_test.check(r = '{"purged": 1}'::jsonb, 'one output purged: ' || r::text);
  row := acs_test.call_row(old_ok);
  perform acs_test.check(row.result = jsonb_build_object('ok', false, 'code', 'UNKNOWN', 'audit', res -> 'audit')
    and row.content_purged_at is not null and row.state = 'complete', 'tombstone with the original audit');
  perform acs_test.check(not exists (select 1 from ai_calls.consumer_calls x where x::text like '%SENTINEL-OUTPUT%'), 'the output is gone');
  perform acs_test.check(exists (select 1 from ai_calls.consumer_calls x where x::text like '%SENTINEL-RECENT%'), 'a recent output is kept');
  perform acs_test.check((acs_test.call_row(old_fail)).content_purged_at is null, 'a failure (no output) is left as is');
  r := acs_test.claim(old_ok);
  perform acs_test.check(r -> 'result' ->> 'code' = 'UNKNOWN' and r -> 'result' -> 'audit' = res -> 'audit', 'replay after purge: UNKNOWN, same audit');
  e := acs_test.rpc_error('ai_calls_complete', acs_test.complete_p(old_ok, oa, res));
  perform acs_test.check(e like 'P0001:AI_CALLS_RESULT_CONFLICT%', 'the old output cannot be written back: ' || coalesce(e, 'null'));
  r := acs_test.rpc('ai_calls_purge_content', '{}');
  perform acs_test.check(r = '{"purged": 0}'::jsonb, 'purge is idempotent');
  e := acs_test.rpc_error('ai_calls_purge_content', '{"older_than_hours": 0}');
  perform acs_test.check(e like '22023:%', 'a zero-hour window is refused');
end;
$$;

\echo '[12] forget_user: refused while a call is in flight; then removes only that user''s rows; the ledger is untouched'
do $$
declare
  u uuid := '00000000-0000-4000-8000-0000000000c3';
  v uuid := '00000000-0000-4000-8000-0000000000d4';
  c1 jsonb := acs_test.claim_p('op-12a', 'tenant-c', 'c12a', 'user', u);
  c2 jsonb := acs_test.claim_p('op-12b', 'tenant-c', 'c12b', 'user', u);
  c3 jsonb := acs_test.claim_p('op-12a', 'tenant-d', 'c12d', 'user', v);
  o1 text; o2 text; r jsonb; ledger_before text; rid jsonb;
begin
  o1 := acs_test.claim(c1) ->> 'owner';
  o2 := acs_test.claim(c2) ->> 'owner';
  perform acs_test.claim(c3);
  rid := acs_test.reserve(c1);
  perform ail_test.mark_sent(rid);
  perform ail_test.settle_measured(rid, 0.001, 100, 20);
  perform acs_test.rpc('ai_calls_complete', acs_test.complete_p(c1, o1, acs_test.ok_result(c1, '{"reply": "a"}')));
  ledger_before := (select string_agg(x::text, '|' order by x.id) from ai_ledger.reservations x)
                || (select string_agg(x::text, '|' order by x.id) from ai_ledger.usage_events x);
  r := acs_test.rpc('ai_calls_forget_user', jsonb_build_object('user_id', u));
  perform acs_test.check(r = '{"forgotten": false, "reason": "CALLS_IN_FLIGHT", "in_flight": 1}'::jsonb, 'in flight -> refused: ' || r::text);
  perform acs_test.rpc('ai_calls_complete', acs_test.complete_p(c2, o2, acs_test.fail_result(c2, 'PROVIDER_FAILED')));
  r := acs_test.rpc('ai_calls_forget_user', jsonb_build_object('user_id', u));
  perform acs_test.check(r = '{"forgotten": true, "deleted": 2, "ledger_reservations_retained": 1}'::jsonb, 'forgotten: ' || r::text);
  perform acs_test.check(not exists (select 1 from ai_calls.consumer_calls where user_id = u), 'no row of the user left');
  perform acs_test.check((acs_test.call_row(c3)).state = 'acquired', 'the other user''s call is untouched');
  perform acs_test.check(ledger_before = (select string_agg(x::text, '|' order by x.id) from ai_ledger.reservations x)
                                      || (select string_agg(x::text, '|' order by x.id) from ai_ledger.usage_events x), 'ledger rows unchanged');
  r := acs_test.rpc('ai_calls_forget_user', jsonb_build_object('user_id', u));
  perform acs_test.check(r = '{"forgotten": true, "deleted": 0, "ledger_reservations_retained": 1}'::jsonb, 'forget is idempotent');
end;
$$;

\echo '[13] the table changes only through the RPCs: identity immutable, state forward only, purge is the only rewrite'
do $$
declare c jsonb := acs_test.claim_p('op-4', 'tenant-a', 'content-4'); a jsonb := acs_test.claim_p('op-7', 'tenant-a', 'content-7'); e text;
begin
  begin
    update ai_calls.consumer_calls set fingerprint = acs_test.hex('z') where call_key = c ->> 'call_key';
    e := 'updated';
  exception when others then e := sqlerrm;
  end;
  perform acs_test.check(e like 'AI_CALLS_IDENTITY_IMMUTABLE%', 'fingerprint immutable: ' || e);
  begin
    update ai_calls.consumer_calls set state = 'acquired', result = null, audit = null, completed_at = null where call_key = c ->> 'call_key';
    e := 'updated';
  exception when others then e := sqlerrm;
  end;
  perform acs_test.check(e like 'AI_CALLS_TRANSITION%', 'complete -> acquired refused: ' || e);
  begin
    update ai_calls.consumer_calls set result = jsonb_set(result, '{data,reply}', '"edited"') where call_key = c ->> 'call_key';
    e := 'updated';
  exception when others then e := sqlerrm;
  end;
  perform acs_test.check(e like 'AI_CALLS_TRANSITION%', 'a stored result cannot be edited: ' || e);
  begin
    update ai_calls.consumer_calls set state = 'complete', completed_at = now(), abandoned_at = null where call_key = a ->> 'call_key';
    e := 'updated';
  exception when others then e := sqlerrm;
  end;
  perform acs_test.check(e like 'AI_CALLS_TRANSITION%', 'abandoned -> complete refused: ' || e);
end;
$$;

\echo '[14] roles: only service_role may call the RPCs; nobody but the owner reads or writes the table'
do $$
declare r text; fn text; c jsonb := acs_test.claim_p('op-14', 'tenant-a', 'content-14');
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach fn in array array['ai_calls_claim', 'ai_calls_complete', 'ai_calls_abandon', 'ai_calls_purge_content', 'ai_calls_forget_user'] loop
      perform acs_test.check(acs_test.rpc_error(fn, c, r) like '42501:%', r || ' cannot execute ' || fn);
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    perform acs_test.check(not has_schema_privilege(r, 'ai_calls', 'USAGE'), r || ' has no schema usage');
    perform acs_test.check(not has_table_privilege(r, 'ai_calls.consumer_calls', 'SELECT')
                           and not has_table_privilege(r, 'ai_calls.consumer_calls', 'INSERT')
                           and not has_table_privilege(r, 'ai_calls.consumer_calls', 'UPDATE')
                           and not has_table_privilege(r, 'ai_calls.consumer_calls', 'DELETE'), r || ' has no table privilege');
  end loop;
  perform acs_test.check(acs_test.rpc_error('ai_calls_claim', c, 'service_role') is null, 'service_role can claim');
end;
$$;

\echo 'call store behaviour: all checks passed'
