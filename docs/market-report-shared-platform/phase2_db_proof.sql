-- Disposable-database proof for 20260920100000_market_report_packets_phase2.sql.
-- Run only against a throwaway PostgreSQL with the Phase 1 and Phase 2
-- migrations applied. Every check raises on failure; the script ends with
-- ROLLBACK. Never run against production.
\set ON_ERROR_STOP 1
begin;

create function pg_temp.expect_error(p_sql text, p_fragment text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_fragment in sqlerrm) = 0 then
      raise exception 'expected error containing %, got: %', p_fragment, sqlerrm;
    end if;
    return;
  end;
  raise exception 'expected error containing %, but statement succeeded', p_fragment;
end;
$$;
grant execute on function pg_temp.expect_error(text, text) to anon, authenticated, service_role;

-- 1. Catalog and grants ------------------------------------------------------
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.market_report_packets'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.market_report_consumer_settings'::regclass) then
    raise exception 'RLS must be enabled';
  end if;
  if (select count(*) from pg_proc where proname in ('claim_market_report_analysis', 'complete_market_report_analysis', 'fail_market_report_analysis', 'get_shared_market_report')
      and prosecdef and proconfig @> array['search_path=""']) <> 4 then
    raise exception 'RPCs must be SECURITY DEFINER with empty search_path';
  end if;
  if has_table_privilege('anon', 'public.market_report_packets', 'select')
     or has_table_privilege('authenticated', 'public.market_report_consumer_settings', 'select')
     or has_table_privilege('service_role', 'public.market_report_packets', 'insert')
     or has_table_privilege('service_role', 'public.market_report_consumer_settings', 'update')
     or not has_table_privilege('service_role', 'public.market_report_packets', 'select') then
    raise exception 'grants wrong';
  end if;
  if has_function_privilege('authenticated', 'public.get_shared_market_report(text, text, date)', 'execute')
     or has_function_privilege('anon', 'public.claim_market_report_analysis(text, date, integer, integer)', 'execute')
     or not has_function_privilege('service_role', 'public.get_shared_market_report(text, text, date)', 'execute') then
    raise exception 'function grants wrong';
  end if;
  if (select x_enabled or app_enabled from public.market_report_consumer_settings) then
    raise exception 'consumer gate must default to OFF';
  end if;
  raise notice 'PASS 1 catalog, grants, gate default OFF';
end $$;

set local role service_role;

-- 2. Analysis before the data packet is completed -----------------------------
do $$
declare c record;
begin
  select * into c from public.claim_market_report_analysis('close', '2026-09-17');
  if c.outcome <> 'data_not_ready' then raise exception 'no cycle must be data_not_ready, got %', c.outcome; end if;
  perform public.claim_market_report_cycle('close', '2026-09-17');
  select * into c from public.claim_market_report_analysis('close', '2026-09-17');
  if c.outcome <> 'data_not_ready' then raise exception 'running data cycle must be data_not_ready, got %', c.outcome; end if;
  raise notice 'PASS 2 analysis refuses without a completed data packet';
end $$;

-- 3. Complete data → claim analysis → complete analysis → idempotent ----------
create temp table proof_ids (label text primary key, id uuid, token uuid);
do $$
declare d record; a record; v_report uuid; v_data uuid;
begin
  select c.id as cycle_id, c.claim_token into d from public.market_report_cycles c
    where c.report_type = 'close' and c.trading_date = '2026-09-17';
  select r.packet_id into v_data from public.complete_market_report_cycle(d.cycle_id, d.claim_token,
    '{"schema_version":"market_data_packet.v1","report_type":"close","trading_date":"2026-09-17","data_quality":{"status":"partial"}}',
    repeat('a', 64), now(), now()) r;

  select * into a from public.claim_market_report_analysis('close', '2026-09-17');
  if a.outcome <> 'claimed' or a.attempt <> 1 or a.data_packet_id <> v_data then
    raise exception 'analysis claim failed: %', a.outcome;
  end if;
  v_report := public.complete_market_report_analysis(a.cycle_id, a.claim_token,
    jsonb_build_object('schema_version', 'market_report_packet.v1', 'report_type', 'close', 'trading_date', '2026-09-17',
                       'data_packet_id', v_data::text, 'market_direction', 'up', 'headline_ja', '見出し'),
    repeat('b', 64), 'gpt-5.6-luna', 2, 1800, 600, 0.00108, '{"calls":"2"}');
  insert into proof_ids values ('cycle', a.cycle_id, a.claim_token), ('report', v_report, null), ('data', v_data, null);

  select * into a from public.claim_market_report_analysis('close', '2026-09-17');
  if a.outcome <> 'already_completed' then raise exception 'completed analysis must not be re-claimed'; end if;
  if (select count(*) from public.market_report_packets) <> 1 then raise exception 'exactly one report packet'; end if;
  if (select report_status from public.market_report_cycles where id = a.cycle_id) <> 'completed' then raise exception 'report_status'; end if;
  raise notice 'PASS 3 data → analysis → completed; re-claim idempotent; one report packet';
end $$;

-- 4. Stale token / second packet for the same cycle rejected ------------------
select pg_temp.expect_error(format(
  $q$select public.complete_market_report_analysis(%L, %L, '{"schema_version":"market_report_packet.v1"}', %L, 'm', 1, 0, 0, 0)$q$,
  (select id from proof_ids where label = 'cycle'), (select token from proof_ids where label = 'cycle'), repeat('c', 64)
), 'MARKET_REPORT_ANALYSIS_CLAIM_LOST');
do $$ begin raise notice 'PASS 4 stale analysis token rejected'; end $$;
reset role;

-- 5. Immutability (even for the owner) ----------------------------------------
select pg_temp.expect_error($q$update public.market_report_packets set model = 'x'$q$, 'MARKET_DATA_PACKET_IMMUTABLE');
select pg_temp.expect_error($q$delete from public.market_report_packets$q$, 'MARKET_DATA_PACKET_IMMUTABLE');
select pg_temp.expect_error($q$update public.market_report_cycles set current_report_packet_id = null where report_type = 'close' and trading_date = '2026-09-17'$q$, 'MARKET_REPORT_CYCLE_REPORT_IMMUTABLE');
select pg_temp.expect_error($q$update public.market_report_cycles set report_status = 'failed' where report_type = 'close' and trading_date = '2026-09-17'$q$, 'MARKET_REPORT_CYCLE_REPORT_COMPLETED_IMMUTABLE');
select pg_temp.expect_error($q$update public.market_report_cycles set current_data_packet_id = null where report_type = 'close' and trading_date = '2026-09-17'$q$, 'MARKET_REPORT_CYCLE_PACKET_IMMUTABLE');
select pg_temp.expect_error(format(
  $q$insert into public.market_report_packets (cycle_id, data_packet_id, attempt, schema_version, report_type, trading_date, payload, content_hash, fact_status, model, generation_calls, input_tokens, output_tokens, api_cost_usd)
     values (%L, %L, 2, 'market_report_packet.v1', 'close', '2026-09-17', jsonb_build_object('schema_version','market_report_packet.v1','report_type','close','trading_date','2026-09-17','data_packet_id',%L), %L, 'passed', 'm', 1, 0, 0, 0)$q$,
  (select id from proof_ids where label = 'cycle'), (select id from proof_ids where label = 'data'), (select id from proof_ids where label = 'data'), repeat('d', 64)
), 'market_report_packets_cycle_key');
do $$ begin raise notice 'PASS 5 report packet update/delete, pointer/status changes and a second packet per cycle rejected'; end $$;

-- 6. Consumer gate ------------------------------------------------------------
set local role service_role;
do $$
declare v jsonb;
begin
  v := public.get_shared_market_report('x', 'close', '2026-09-17');
  if v->>'status' <> 'disabled' or (v->>'enabled')::boolean then raise exception 'gate OFF must return disabled: %', v; end if;
end $$;
reset role;
update public.market_report_consumer_settings set x_enabled = true;
set local role service_role;
do $$
declare v jsonb;
begin
  v := public.get_shared_market_report('x', 'close', '2026-09-17');
  if v->>'status' <> 'completed' or v->>'report_packet_id' <> (select id::text from proof_ids where label = 'report')
     or v #>> '{report,headline_ja}' <> '見出し' or v #>> '{data,data_quality,status}' <> 'partial' then
    raise exception 'gate ON must return the completed packets: %', v;
  end if;
  v := public.get_shared_market_report('app', 'close', '2026-09-17');
  if v->>'status' <> 'disabled' then raise exception 'app gate is independent: %', v; end if;
  v := public.get_shared_market_report('x', 'morning', '2026-09-17');
  if v->>'status' <> 'missing' then raise exception 'no morning cycle must be missing: %', v; end if;
  raise notice 'PASS 6 gate OFF → disabled; x ON → same completed packets; app stays OFF; missing cycle reported';
end $$;

-- 7. Analysis failure, retry, not_ready surface, budget -----------------------
do $$
declare d record; a record; v jsonb;
begin
  select * into d from public.claim_market_report_cycle('morning', '2026-09-18');
  perform public.complete_market_report_cycle(d.cycle_id, d.claim_token,
    '{"schema_version":"market_data_packet.v1","report_type":"morning","trading_date":"2026-09-18","data_quality":{"status":"ok"}}',
    repeat('e', 64), now(), now());
  for i in 1..3 loop
    select * into a from public.claim_market_report_analysis('morning', '2026-09-18');
    if a.outcome <> 'claimed' or a.attempt <> i then raise exception 'attempt % should claim', i; end if;
    if public.fail_market_report_analysis(a.cycle_id, a.claim_token, 'ANALYSIS_FACT_FAILED', '{}') <> 'failed' then
      raise exception 'fail must record';
    end if;
  end loop;
  select * into a from public.claim_market_report_analysis('morning', '2026-09-18');
  if a.outcome <> 'attempts_exhausted' then raise exception 'expected attempts_exhausted, got %', a.outcome; end if;
  v := public.get_shared_market_report('x', 'morning', '2026-09-18');
  if v->>'status' <> 'not_ready' or v->>'report_last_error' <> 'ANALYSIS_FACT_FAILED' then
    raise exception 'failed analysis must surface as not_ready: %', v;
  end if;
  raise notice 'PASS 7 failed analysis retries up to budget and consumers see not_ready (fail closed)';
end $$;

-- 8. Phase 1 invariants still hold with the replaced guard --------------------
reset role;
select pg_temp.expect_error($q$update public.market_data_packets set content_hash = repeat('f', 64)$q$, 'MARKET_DATA_PACKET_IMMUTABLE');
select pg_temp.expect_error($q$update public.market_report_cycles set cycle_status = 'failed' where report_type = 'close' and trading_date = '2026-09-17'$q$, 'MARKET_REPORT_CYCLE_COMPLETED_IMMUTABLE');
do $$ begin raise notice 'PASS 8 Phase 1 immutability unchanged'; end $$;

rollback;
