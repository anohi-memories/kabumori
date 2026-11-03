-- Behaviour of the ledger user erasure and the call-store deletion helpers (disposable database, after the ledger,
-- call-store and erasure migrations and the three fixtures). Any failed check raises AUE_TEST_FAIL and stops psql.
\set ON_ERROR_STOP 1
\set QUIET 1

insert into ai_ledger.budget_policies
  (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls, max_estimated_usd)
values
  ('anthropic.postona.consult.user.daily', 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', true, 'day', 1000, 10),
  ('anthropic.postona.consult.user.monthly', 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', true, 'month', 1000, 10);
insert into ai_ledger.budget_policies (policy_key, scope_application, scope_subject_kind, scope_user_id, period, max_calls)
values ('override.user.a1', 'postona', 'user', '00000000-0000-4000-8000-0000000000a1', 'month', 500),
       ('override.user.b2', 'postona', 'user', '00000000-0000-4000-8000-0000000000b2', 'month', 500);
do $$ begin perform aue_test.seed_user('00000000-0000-4000-8000-0000000000a1', 'user-a'); perform aue_test.seed_user('00000000-0000-4000-8000-0000000000b2', 'user-b'); end $$;

\echo '[1] refused while the call store still holds the user, or an attempt of the user is in flight; nothing changes'
do $$
declare
  u uuid := '00000000-0000-4000-8000-0000000000a1';
  c jsonb := acs_test.claim_p('op-erase-1', 'tenant-a', 'content', 'user', '00000000-0000-4000-8000-0000000000a1');
  before text; r jsonb; owner text; rid jsonb;
begin
  owner := acs_test.claim(c) ->> 'owner';
  perform acs_test.rpc('ai_calls_complete', acs_test.complete_p(c, owner, acs_test.fail_result(c, 'PROVIDER_FAILED')));
  before := aue_test.rows_of(u) || aue_test.totals();
  r := aue_test.erase(u);
  perform aue_test.check(r = '{"erased": false, "reason": "CALL_STORE_NOT_FORGOTTEN", "call_rows": 1}'::jsonb, 'call store first: ' || r::text);
  perform aue_test.check(aue_test.rows_of(u) || aue_test.totals() = before, 'nothing changed');
  perform acs_test.rpc('ai_calls_forget_user', jsonb_build_object('user_id', u));

  rid := ail_test.reserve(aue_test.request('user-a-inflight'), 1, 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', u, null, 0.0044);
  r := aue_test.erase(u);
  perform aue_test.check(r = '{"erased": false, "reason": "LEDGER_IN_FLIGHT", "in_flight": 1}'::jsonb, 'reserved attempt: ' || r::text);
  perform ail_test.mark_sent(rid);
  r := aue_test.erase(u);
  perform aue_test.check(r ->> 'reason' = 'LEDGER_IN_FLIGHT', 'sent attempt: ' || r::text);
  perform ail_test.settle_measured(rid, 0.0011, 900, 150);
end;
$$;

\echo '[2] erasure: every ledger reference to the user becomes ONE erased subject; nothing else changes'
do $$
declare
  u uuid := '00000000-0000-4000-8000-0000000000a1';
  v uuid := '00000000-0000-4000-8000-0000000000b2';
  totals_before text; mine_before text; other_before text; summary_before jsonb; status_before jsonb;
  r jsonb; erased uuid; fp jsonb; policy_a1 uuid;
begin
  policy_a1 := (select id from ai_ledger.budget_policies where policy_key = 'override.user.a1');
  totals_before := aue_test.totals();
  mine_before := aue_test.rows_sans_user(u);
  other_before := aue_test.rows_of(v);
  summary_before := (select jsonb_agg(aue_test.rpc('ai_ledger_usage_summary', jsonb_build_object('billing_month', ail_test.this_month(), 'dimension', d)) order by d)
                       from unnest(array['total', 'provider', 'model', 'application', 'feature', 'logical_role', 'subject_kind']) d);
  status_before := aue_test.rpc('ai_ledger_budget_status', '{}');

  r := aue_test.erase(u);
  perform aue_test.check(r = '{"erased": true, "reservations": 5, "usage_events": 4, "budget_buckets": 2, "budget_policies": 1}'::jsonb,
    'erased: ' || r::text);
  perform aue_test.check(not (r::text ~ '[0-9a-f]{8}-[0-9a-f]{4}-'), 'the result carries no id');

  erased := aue_test.subject_of('user-a');
  perform aue_test.check(ai_ledger.is_erased_subject(erased) and erased <> u, 'reserved shape, not the user');
  perform aue_test.check((select count(*) from ai_ledger.reservations r2 where r2.user_id = erased) = 5
                         and (select count(*) from ai_ledger.usage_events e2 where e2.user_id = erased) = 4
                         and (select count(*) from ai_ledger.budget_buckets b2 where b2.user_id = erased) = 2,
    'one erased subject for all the user''s rows');
  perform aue_test.check(aue_test.rows_sans_user(erased) = mine_before, 'every other column of every row is unchanged');
  perform aue_test.check(aue_test.rows_of(v) = other_before, 'the other user''s rows are byte-for-byte unchanged');
  perform aue_test.check(aue_test.totals() = totals_before, 'bill and budget totals unchanged');
  perform aue_test.check((select jsonb_agg(aue_test.rpc('ai_ledger_usage_summary', jsonb_build_object('billing_month', ail_test.this_month(), 'dimension', d)) order by d)
                           from unnest(array['total', 'provider', 'model', 'application', 'feature', 'logical_role', 'subject_kind']) d) = summary_before,
    'usage summaries unchanged');
  perform aue_test.check(jsonb_array_length(aue_test.rpc('ai_ledger_budget_status', '{}')) = jsonb_array_length(status_before), 'same budget rows');
  perform aue_test.check((select not enabled and scope_user_id = erased and policy_key = 'erased.' || id::text and note is null
                            from ai_ledger.budget_policies where id = policy_a1),
    'the user''s own policy: erased subject, disabled, renamed erased.<id>, no note');
  perform aue_test.check((select enabled and scope_user_id = v from ai_ledger.budget_policies where policy_key = 'override.user.b2'),
    'the other user''s policy untouched');

  fp := aue_test.footprint(u);
  perform aue_test.check(fp = '{"call_rows": 0, "reservations": 0, "usage_events": 0, "budget_buckets": 0, "budget_policies": 0, "policy_mentions": 0}'::jsonb,
    'footprint is zero: ' || fp::text);
  perform aue_test.check(aue_test.mentions(u::text) = 0, 'the user id appears nowhere in ai_ledger / ai_calls');
  perform aue_test.check(coalesce(current_setting('ai_ledger.erasure', true), '') = '', 'no erasure setting is left in the transaction');
end;
$$;

\echo '[3] irreversible and unlinkable to the user: not derived, not stored, a new erased subject per erasure'
do $$
declare
  u uuid := '00000000-0000-4000-8000-0000000000a1';
  v uuid := '00000000-0000-4000-8000-0000000000b2';
  pu uuid; pv uuid; t record; n bigint; total bigint := 0;
begin
  perform aue_test.check(coalesce(current_setting('ai_ledger.erasure', true), '') = '', 'no setting survives the erasing transaction');
  perform aue_test.erase(v);
  pu := aue_test.subject_of('user-a');
  pv := aue_test.subject_of('user-b');
  perform aue_test.check(pu <> pv and ai_ledger.is_erased_subject(pv), 'another erasure, another erased subject');
  perform aue_test.check(pu::text <> ('00000000-0000-0000-' || substr(md5(u::text), 1, 4) || '-' || substr(md5(u::text), 5, 12)), 'not a hash of the user id');
  -- No table in any schema holds the pair (or the user id at all): the mapping exists nowhere.
  for t in select ns.nspname, c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
            where c.relkind = 'r' and ns.nspname not in ('pg_catalog', 'information_schema') and ns.nspname !~ '^pg_' loop
    execute format('select count(*) from %I.%I x where x::text like $1 or x::text like $2', t.nspname, t.relname)
      into strict n using '%' || u::text || '%', '%' || v::text || '%';
    total := total + n;
  end loop;
  perform aue_test.check(total = 0, 'neither user id remains in any table of the database');
end;
$$;

\echo '[4] idempotent and strict input'
do $$
declare r jsonb; e text;
begin
  r := aue_test.erase('00000000-0000-4000-8000-0000000000a1');
  perform aue_test.check(r = '{"erased": true, "reservations": 0, "usage_events": 0, "budget_buckets": 0, "budget_policies": 0}'::jsonb, 'second erasure finds nothing');
  r := aue_test.erase('00000000-0000-4000-8000-0000000000f9');
  perform aue_test.check(r ->> 'erased' = 'true' and r ->> 'reservations' = '0', 'a never-seen user: nothing to do');
  e := aue_test.rpc_error('ai_ledger_erase_user', jsonb_build_object('user_id', aue_test.subject_of('user-a')));
  perform aue_test.check(e like '22023:AI_LEDGER_INVALID_INPUT: user_id is an erased subject%', 'an erased subject cannot be erased again: ' || coalesce(e, 'null'));
  e := aue_test.rpc_error('ai_ledger_erase_user', '{}');
  perform aue_test.check(e like '22023:%', 'user_id required');
  e := aue_test.rpc_error('ai_ledger_erase_user', '{"user_id": "u_0123456789abcdef01234567"}');
  perform aue_test.check(e like '22023:%', 'a POSTONA slug is not a user id');
  e := aue_test.rpc_error('ai_ledger_user_footprint', '{"user_id": "00000000-0000-4000-8000-0000000000a1", "brand_ref": "Bad Slug"}');
  perform aue_test.check(e like '22023:%', 'footprint brand slug checked');
end;
$$;

\echo '[5] the immutability exception is exactly: user_id, real -> erased, of the announced user, inside the announcement'
do $$ begin perform aue_test.seed_user('00000000-0000-4000-8000-0000000000e5', 'user-e'); perform aue_test.seed_user('00000000-0000-4000-8000-0000000000e6', 'user-e6'); end $$;
do $$
declare
  u uuid := '00000000-0000-4000-8000-0000000000e5';
  other uuid := '00000000-0000-4000-8000-0000000000e6';
  p uuid := '00000000-0000-0000-8123-456789abcdef';
  e text;
begin
  -- no announcement: refused as before
  begin
    update ai_ledger.reservations set user_id = p where user_id = u;
    e := 'updated';
  exception when others then e := sqlerrm;
  end;
  perform aue_test.check(e = 'AI_LEDGER_RESERVATION_IMMUTABLE', 'reservation, no announcement: ' || e);
  begin
    update ai_ledger.usage_events set user_id = p where user_id = u;
    e := 'updated';
  exception when others then e := sqlerrm;
  end;
  perform aue_test.check(e = 'AI_LEDGER_APPEND_ONLY: UPDATE on usage_events', 'usage event, no announcement: ' || e);

  -- announced, but another column changes too
  begin
    perform set_config('ai_ledger.erasure', u::text || '>' || p::text, true);
    update ai_ledger.reservations set user_id = p, reserved_usd = reserved_usd + 1 where user_id = u;
    e := 'updated';
  exception when others then e := sqlerrm;
  end;
  perform aue_test.check(e = 'AI_LEDGER_RESERVATION_IMMUTABLE', 'user_id plus amount: ' || e);
  begin
    perform set_config('ai_ledger.erasure', u::text || '>' || p::text, true);
    update ai_ledger.reservations set user_id = p, status = 'settled' where user_id = u and status = 'released';
    e := 'updated';
  exception when others then e := sqlerrm;
  end;
  perform aue_test.check(e = 'AI_LEDGER_RESERVATION_IMMUTABLE', 'user_id plus status: ' || e);
  begin
    perform set_config('ai_ledger.erasure', u::text || '>' || p::text, true);
    update ai_ledger.usage_events set user_id = p, latency_ms = coalesce(latency_ms, 0) + 1 where user_id = u;
    e := 'updated';
  exception when others then e := sqlerrm;
  end;
  perform aue_test.check(e like 'AI_LEDGER_APPEND_ONLY%', 'event user_id plus latency: ' || e);

  -- announced for another user, to a non-erased shape, or backwards
  begin
    perform set_config('ai_ledger.erasure', u::text || '>' || p::text, true);
    update ai_ledger.reservations set user_id = p where user_id = other;
    e := 'updated';
  exception when others then e := sqlerrm;
  end;
  perform aue_test.check(e = 'AI_LEDGER_RESERVATION_IMMUTABLE', 'another user''s rows: ' || e);
  begin
    perform set_config('ai_ledger.erasure', u::text || '>' || other::text, true);
    update ai_ledger.reservations set user_id = other where user_id = u;
    e := 'updated';
  exception when others then e := sqlerrm;
  end;
  perform aue_test.check(e = 'AI_LEDGER_RESERVATION_IMMUTABLE', 'to a real-user shape (re-attribution): ' || e);
  begin
    perform set_config('ai_ledger.erasure', p::text || '>' || u::text, true);
    update ai_ledger.reservations set user_id = u where user_id = aue_test.subject_of('user-a');
    e := 'updated';
  exception when others then e := sqlerrm;
  end;
  perform aue_test.check(e = 'AI_LEDGER_RESERVATION_IMMUTABLE', 'erased -> real (re-identification): ' || e);
  begin
    perform set_config('ai_ledger.erasure', aue_test.subject_of('user-a')::text || '>' || p::text, true);
    update ai_ledger.reservations set user_id = p where user_id = aue_test.subject_of('user-a');
    e := 'updated';
  exception when others then e := sqlerrm;
  end;
  perform aue_test.check(e = 'AI_LEDGER_RESERVATION_IMMUTABLE', 'an erased subject is never renamed: ' || e);
  begin
    perform set_config('ai_ledger.erasure', u::text || '>' || p::text, true);
    delete from ai_ledger.usage_events where user_id = u;
    e := 'deleted';
  exception when others then e := sqlerrm;
  end;
  perform aue_test.check(e = 'AI_LEDGER_APPEND_ONLY: DELETE on usage_events', 'delete still refused: ' || e);
  begin
    perform set_config('ai_ledger.erasure', u::text || '>' || p::text, true);
    delete from ai_ledger.reservations where user_id = u;
    e := 'deleted';
  exception when others then e := sqlerrm;
  end;
  perform aue_test.check(e like 'AI_LEDGER_APPEND_ONLY%', 'reservation delete still refused: ' || e);

  -- the exact change, announced: admitted (then rolled back by the error below)
  begin
    perform set_config('ai_ledger.erasure', u::text || '>' || p::text, true);
    update ai_ledger.reservations set user_id = p where user_id = u;
    update ai_ledger.usage_events set user_id = p where user_id = u;
    perform aue_test.check((select count(*) from ai_ledger.reservations where user_id = p) = 4, 'admitted');
    raise exception 'ROLLBACK_PROBE';
  exception when others then e := sqlerrm;
  end;
  perform aue_test.check(e = 'ROLLBACK_PROBE', 'the announced change is admitted: ' || e);
  perform aue_test.check((select count(*) from ai_ledger.reservations where user_id = u) = 4, 'probe rolled back');
end;
$$;

\echo '[6] roles: only service_role calls the four RPCs; announcing an erasure gives no table access'
do $$
declare r text; fn text; e text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach fn in array array['ai_ledger_erase_user', 'ai_ledger_user_footprint', 'ai_calls_forget_system_brand', 'ai_calls_recovery_candidates'] loop
      perform aue_test.check(aue_test.rpc_error(fn, '{"user_id": "00000000-0000-4000-8000-0000000000e5", "brand_ref": "u_0123456789abcdef01234567"}', r) like '42501:%',
        r || ' cannot execute ' || fn);
    end loop;
  end loop;
  perform aue_test.check(aue_test.rpc_error('ai_ledger_user_footprint', '{"user_id": "00000000-0000-4000-8000-0000000000e5"}') is null, 'service_role reads the footprint');
  begin
    set local role service_role;
    perform set_config('ai_ledger.erasure', '00000000-0000-4000-8000-0000000000e5>00000000-0000-0000-8123-456789abcdef', true);
    update ai_ledger.reservations set user_id = '00000000-0000-0000-8123-456789abcdef' where user_id = '00000000-0000-4000-8000-0000000000e5';
    e := 'updated';
  exception when others then e := sqlstate;
  end;
  reset role;
  perform aue_test.check(e = '42501', 'service_role cannot touch the ledger tables even with the setting: ' || e);
end;
$$;

\echo '[7] forget_system_brand: only user workspace slugs, only system rows, not while in flight'
do $$
declare
  slug text := 'u_0123456789abcdef01234567';
  sys jsonb := acs_test.claim_p('op-sys-1', 'system-postona', 'x', 'system', null, 'postona.ai_lab', 'u_0123456789abcdef01234567');
  usr jsonb := acs_test.claim_p('op-usr-1', 'tenant-g', 'x', 'user', '00000000-0000-4000-8000-0000000000a7', 'postona.consult', 'u_0123456789abcdef01234567');
  lab jsonb := acs_test.claim_p('op-lab-1', 'system-postona', 'x', 'system', null, 'postona.ai_lab', 'ai_salaryman_lab');
  o text; ou text; r jsonb; e text;
begin
  o := acs_test.claim(sys) ->> 'owner';
  ou := acs_test.claim(usr) ->> 'owner';
  perform acs_test.rpc('ai_calls_complete', acs_test.complete_p(usr, ou, acs_test.fail_result(usr, 'PROVIDER_FAILED')));
  perform acs_test.claim(lab);
  perform aue_test.check(aue_test.footprint('00000000-0000-4000-8000-0000000000a7', slug) ->> 'brand_call_rows' = '2', 'footprint by brand');
  r := aue_test.rpc('ai_calls_forget_system_brand', jsonb_build_object('brand_ref', slug));
  perform aue_test.check(r = '{"forgotten": false, "reason": "CALLS_IN_FLIGHT", "in_flight": 1}'::jsonb, 'in flight: ' || r::text);
  perform acs_test.rpc('ai_calls_complete', acs_test.complete_p(sys, o, acs_test.fail_result(sys, 'PROVIDER_FAILED')));
  r := aue_test.rpc('ai_calls_forget_system_brand', jsonb_build_object('brand_ref', slug));
  perform aue_test.check(r = '{"forgotten": true, "deleted": 1}'::jsonb, 'system row forgotten: ' || r::text);
  perform aue_test.check((acs_test.call_row(usr)).state = 'complete', 'the (finished) user-subject row is left to forget_user');
  perform aue_test.check((acs_test.call_row(lab)).state = 'acquired', 'the operator brand row is untouched');
  e := aue_test.rpc_error('ai_calls_forget_system_brand', '{"brand_ref": "ai_salaryman_lab"}');
  perform aue_test.check(e like '22023:%', 'an operator brand is refused: ' || coalesce(e, 'null'));
end;
$$;

\echo '[8] recovery candidates: old in-flight claims with their ledger summary, no user id, brand or result'
do $$
declare
  stuck jsonb := acs_test.claim_p('op-stuck', 'tenant-h', 'x', 'user', '00000000-0000-4000-8000-0000000000a8');
  young jsonb := acs_test.claim_p('op-young', 'tenant-h', 'y', 'user', '00000000-0000-4000-8000-0000000000a8');
  rid jsonb; list jsonb; row jsonb;
begin
  perform acs_test.claim(stuck);
  perform acs_test.claim(young);
  rid := ail_test.reserve(stuck ->> 'call_key', 1, 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', '00000000-0000-4000-8000-0000000000a8', null, 0.0044);
  perform ail_test.mark_sent(rid);
  perform acs_test.backdate(stuck, interval '2 hours');
  list := aue_test.rpc('ai_calls_recovery_candidates', '{}');
  perform aue_test.check(jsonb_array_length(list) >= 1 and not (list::text like '%' || (young ->> 'call_key') || '%'), 'only old claims');
  select x into row from jsonb_array_elements(list) x where x ->> 'call_key' = stuck ->> 'call_key';
  perform aue_test.check(row is not null and row ->> 'open_attempts' = '1' and row ->> 'sent_attempts' = '0'
                         and row -> 'models' = '["claude-haiku-5-5"]'::jsonb and row ->> 'tenant_tag' = stuck ->> 'tenant_tag', 'ledger summary: ' || coalesce(row::text, 'missing'));
  perform aue_test.check(not (list::text like '%user_id%') and not (list::text like '%brand_ref%') and not (list::text like '%0000000000a8%'), 'no user id or brand');
  perform aue_test.check(jsonb_array_length(aue_test.rpc('ai_calls_recovery_candidates', '{"limit": 1}')) = 1, 'limit');
end;
$$;

\echo '[9] the deletion sequence end to end, including a late claim caught by the final sweep'
do $$
declare
  z uuid := '00000000-0000-4000-8000-0000000000d4';
  stuck jsonb := acs_test.claim_p('op-z-stuck', 'tenant-z', 'x', 'user', '00000000-0000-4000-8000-0000000000d4');
  done jsonb := acs_test.claim_p('op-z-done', 'tenant-z', 'y', 'user', '00000000-0000-4000-8000-0000000000d4');
  late jsonb := acs_test.claim_p('op-z-late', 'tenant-z', 'z', 'user', '00000000-0000-4000-8000-0000000000d4');
  o text; rid jsonb; r jsonb; cand jsonb; audit jsonb;
begin
  perform aue_test.seed_user(z, 'user-z');
  -- a finished call and a call whose worker died after sending
  o := acs_test.claim(done) ->> 'owner';
  perform acs_test.rpc('ai_calls_complete', acs_test.complete_p(done, o, acs_test.ok_result(done, '{"reply": "x"}')));
  perform acs_test.claim(stuck);
  rid := ail_test.reserve(stuck ->> 'call_key', 1, 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', z, null, 0.0044);
  perform ail_test.mark_sent(rid);
  -- (1) entitlement stopped (outside the database): no new claim from here on. (2) wait: deadline passed and the
  -- worker is gone. forget / erase refuse until the in-flight work is closed.
  perform aue_test.check(acs_test.rpc('ai_calls_forget_user', jsonb_build_object('user_id', z)) ->> 'reason' = 'CALLS_IN_FLIGHT', 'forget waits');
  -- (3) recovery: the ledger finalises the sent attempt at its upper bound, the claim is abandoned with that audit
  perform acs_test.backdate(stuck, interval '1 hour');
  perform set_config('session_replication_role', 'replica', true);
  update ai_ledger.reservations set sent_at = now() - interval '1 hour' where id = (rid ->> 'reservation_id')::uuid;
  perform set_config('session_replication_role', 'origin', true);
  perform aue_test.rpc('ai_ledger_recover_stale', '{}');
  select x into cand from jsonb_array_elements(aue_test.rpc('ai_calls_recovery_candidates', '{}')) x where x ->> 'call_key' = stuck ->> 'call_key';
  perform aue_test.check(cand ->> 'open_attempts' = '0' and cand ->> 'sent_attempts' = '1' and cand ->> 'includes_upper_bound' = 'true', 'candidate: ' || cand::text);
  audit := acs_test.audit(stuck, 1, (cand ->> 'estimated_cost_usd')::numeric, 'includes_upper_bound');
  perform aue_test.check(acs_test.rpc('ai_calls_abandon', acs_test.abandon_p(stuck, audit)) = '{"abandoned": true}'::jsonb, 'abandoned');
  -- (4) forget, (5) erase, (6) read back
  r := acs_test.rpc('ai_calls_forget_user', jsonb_build_object('user_id', z));
  perform aue_test.check(r ->> 'forgotten' = 'true' and r ->> 'deleted' = '2' and r ->> 'ledger_reservations_retained' = '5', 'forgotten: ' || r::text);
  r := aue_test.erase(z);
  perform aue_test.check(r ->> 'erased' = 'true' and r ->> 'reservations' = '5', 'erased: ' || r::text);
  perform aue_test.check(aue_test.footprint(z) = '{"call_rows": 0, "reservations": 0, "usage_events": 0, "budget_buckets": 0, "budget_policies": 0, "policy_mentions": 0}'::jsonb, 'footprint zero');
  -- a late claim (an authoriser that did not stop): the read-back sees it, the erasure refuses, the sweep repeats
  o := acs_test.claim(late) ->> 'owner';
  perform aue_test.check(aue_test.footprint(z) ->> 'call_rows' = '1', 'the read-back sees the late claim');
  perform aue_test.check(aue_test.erase(z) ->> 'reason' = 'CALL_STORE_NOT_FORGOTTEN', 'erase refuses');
  perform acs_test.rpc('ai_calls_complete', acs_test.complete_p(late, o, acs_test.fail_result(late, 'BUDGET_DENIED')));
  perform acs_test.rpc('ai_calls_forget_user', jsonb_build_object('user_id', z));
  perform aue_test.check(aue_test.erase(z) ->> 'erased' = 'true', 'sweep again');
  perform aue_test.check(aue_test.footprint(z) = '{"call_rows": 0, "reservations": 0, "usage_events": 0, "budget_buckets": 0, "budget_policies": 0, "policy_mentions": 0}'::jsonb, 'footprint zero after the sweep');
  perform aue_test.check(aue_test.mentions(z::text) = 0, 'no trace of the user');
end;
$$;

\echo '[10] budgets keep working: the erased subject keeps its counters; new users get their own buckets'
do $$
declare r jsonb;
begin
  perform aue_test.check((select sum(b.calls) from ai_ledger.budget_buckets b where b.user_id = aue_test.subject_of('user-a')) > 0, 'erased counters kept');
  r := ail_test.reserve(aue_test.request('new-user-1'), 1, 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', '00000000-0000-4000-8000-0000000000aa', null, 0.0044);
  perform aue_test.check(r ->> 'allowed' = 'true', 'a new user reserves normally');
  perform aue_test.check((select count(*) from ai_ledger.budget_buckets where user_id = '00000000-0000-4000-8000-0000000000aa') = 2, 'its own buckets');
end;
$$;

\echo '[11] policies: no identifier survives in the user''s own key or note; other policies untouched; a stray mention blocks'
do $$
declare
  u uuid := '00000000-0000-4000-8000-00000000c0de';
  v uuid := '00000000-0000-4000-8000-00000000beef';
  w uuid := '00000000-0000-4000-8000-00000000f00d';
  pol1 uuid; pol2 uuid; polw uuid; conflict uuid;
  stamps_before text; others_before text; all_before text; totals_before text; r jsonb; fp jsonb; erased uuid; e text;
begin
  -- the user's two policies: full id in a key, an e-mail in a note; the id without dashes in a key and in upper case
  -- without dashes in a note (only those forms: a mention check that misses a form would count one policy less)
  insert into ai_ledger.budget_policies (policy_key, scope_application, scope_subject_kind, scope_user_id, period, max_calls, note)
  values ('override.user.' || u::text, 'postona', 'user', u, 'month', 500, 'support ticket: jane@example.com')
  returning id into pol1;
  insert into ai_ledger.budget_policies (policy_key, scope_application, scope_subject_kind, scope_user_id, period, max_calls, note)
  values ('cap.' || replace(u::text, '-', ''), 'postona', 'user', u, 'day', 50, 'raised for ' || upper(replace(u::text, '-', '')))
  returning id into pol2;
  -- another user's policy (with its own contact), a system policy, and a system policy whose note names u by mistake
  insert into ai_ledger.budget_policies (policy_key, scope_application, scope_subject_kind, scope_user_id, period, max_calls, note)
  values ('override.user.' || v::text, 'postona', 'user', v, 'month', 500, 'ticket: bob@example.com');
  insert into ai_ledger.budget_policies (policy_key, scope_provider, period, max_estimated_usd, note)
  values ('system.anthropic.monthly', 'anthropic', 'month', 100, 'ops: keep under budget'),
         ('system.slip', 'openai', 'month', 1, 'debug for ' || upper(u::text));
  perform aue_test.seed_user(u, 'pol-u');
  stamps_before := (select string_agg(concat_ws('|', id, created_at, updated_at, period, max_calls), ';' order by id)
                      from ai_ledger.budget_policies where id in (pol1, pol2));

  fp := aue_test.footprint(u);
  perform aue_test.check(fp ->> 'budget_policies' = '2' and fp ->> 'policy_mentions' = '3', 'footprint counts both policies and all three mentions: ' || fp::text);

  -- a policy that is not the user's names the user: refused, nothing changes
  all_before := (select string_agg(pol::text, '|' order by pol.id) from ai_ledger.budget_policies pol);
  totals_before := aue_test.totals();
  r := aue_test.erase(u);
  perform aue_test.check(r = '{"erased": false, "reason": "POLICY_TEXT_MENTIONS_USER", "policies": 1}'::jsonb, 'stray mention blocks: ' || r::text);
  perform aue_test.check((select string_agg(pol::text, '|' order by pol.id) from ai_ledger.budget_policies pol) = all_before
                         and aue_test.totals() = totals_before and aue_test.footprint(u) ->> 'reservations' = '4', 'nothing changed');

  -- the operator corrects that note; the erasure then goes through
  update ai_ledger.budget_policies set note = 'debug note removed' where policy_key = 'system.slip';
  others_before := (select string_agg(pol::text, '|' order by pol.id) from ai_ledger.budget_policies pol where pol.id not in (pol1, pol2));
  totals_before := aue_test.totals();
  r := aue_test.erase(u);
  perform aue_test.check(r ->> 'erased' = 'true' and r ->> 'budget_policies' = '2' and r ->> 'reservations' = '4', 'erased: ' || r::text);
  erased := aue_test.subject_of('pol-u');
  perform aue_test.check((select bool_and(policy_key = 'erased.' || id::text and note is null and not enabled and scope_user_id = erased)
                            from ai_ledger.budget_policies where id in (pol1, pol2)), 'both policies: erased.<id>, no note, disabled, erased subject');
  perform aue_test.check((select string_agg(concat_ws('|', id, created_at, updated_at, period, max_calls), ';' order by id)
                            from ai_ledger.budget_policies where id in (pol1, pol2)) = stamps_before, 'timestamps, period and caps unchanged');
  perform aue_test.check((select string_agg(pol::text, '|' order by pol.id) from ai_ledger.budget_policies pol where pol.id not in (pol1, pol2)) = others_before,
    'every other policy (another user''s, system ones) is byte-for-byte unchanged');
  perform aue_test.check(aue_test.totals() = totals_before, 'bill and budget totals unchanged');
  perform aue_test.check(aue_test.mentions(u::text) = 0 and aue_test.mentions(replace(u::text, '-', '')) = 0
                         and aue_test.mentions(upper(u::text)) = 0 and aue_test.mentions(upper(replace(u::text, '-', ''))) = 0
                         and aue_test.mentions('jane@example.com') = 0,
    'no form of the user id and no e-mail of the user remains in ai_ledger / ai_calls');
  perform aue_test.check(aue_test.mentions('bob@example.com') = 1, 'the other user''s policy keeps its own note');
  fp := aue_test.footprint(u);
  perform aue_test.check(fp = '{"call_rows": 0, "reservations": 0, "usage_events": 0, "budget_buckets": 0, "budget_policies": 0, "policy_mentions": 0}'::jsonb,
    'footprint zero: ' || fp::text);
  r := aue_test.erase(u);
  perform aue_test.check(r = '{"erased": true, "reservations": 0, "usage_events": 0, "budget_buckets": 0, "budget_policies": 0}'::jsonb, 'retry finds nothing');

  -- another policy already holds the key erasure would give: refused, nothing changes; resolved -> erased
  insert into ai_ledger.budget_policies (policy_key, scope_application, scope_subject_kind, scope_user_id, period, max_calls)
  values ('override.user.' || w::text, 'postona', 'user', w, 'month', 500) returning id into polw;
  insert into ai_ledger.budget_policies (policy_key, scope_provider, period, max_calls)
  values ('erased.' || polw::text, 'openai', 'month', 1) returning id into conflict;
  r := aue_test.erase(w);
  perform aue_test.check(r = '{"erased": false, "reason": "POLICY_KEY_CONFLICT"}'::jsonb, 'key conflict refused: ' || r::text);
  perform aue_test.check((select scope_user_id = w and enabled from ai_ledger.budget_policies where id = polw), 'w''s policy untouched');
  delete from ai_ledger.budget_policies where id = conflict;
  perform aue_test.check(aue_test.erase(w) ->> 'budget_policies' = '1', 'erased once the conflict is resolved');

  -- the service role still cannot read or change any policy directly
  begin
    set local role service_role;
    update ai_ledger.budget_policies set note = 'x' where id = pol1;
    e := 'updated';
  exception when others then e := sqlstate;
  end;
  reset role;
  perform aue_test.check(e = '42501', 'service_role cannot touch budget_policies: ' || e);
end;
$$;

\echo 'erasure behaviour: all checks passed'
