-- Disposable-database proof for 20260919100000_market_report_data_packets_phase1.sql.
-- Run only against a throwaway PostgreSQL that already has the migration
-- applied. Every check raises on failure; the script ends with ROLLBACK, so it
-- leaves no rows behind. Never run against production.
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
  raise exception 'expected error containing %, but statement succeeded: %', p_fragment, p_sql;
end;
$$;
grant execute on function pg_temp.expect_error(text, text) to anon, authenticated, service_role;

create temp table proof_ids (label text primary key, id uuid, token uuid);
grant all on proof_ids to anon, authenticated, service_role;

-- 1. Catalog: RLS, SECURITY DEFINER, empty search_path, grants ---------------
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.market_report_cycles'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.market_data_packets'::regclass) then
    raise exception 'RLS must be enabled on both tables';
  end if;
  if exists (select 1 from pg_policies where tablename in ('market_report_cycles', 'market_data_packets')) then
    raise exception 'no RLS policies expected in Phase 1';
  end if;
  if (select count(*) from pg_proc p
      where p.proname in ('claim_market_report_cycle', 'complete_market_report_cycle', 'fail_market_report_cycle')
        and p.prosecdef and p.proconfig @> array['search_path=""']) <> 3 then
    raise exception 'all three RPCs must be SECURITY DEFINER with an empty search_path';
  end if;
  if has_table_privilege('anon', 'public.market_data_packets', 'select')
     or has_table_privilege('authenticated', 'public.market_data_packets', 'select')
     or has_table_privilege('anon', 'public.market_report_cycles', 'select')
     or has_table_privilege('authenticated', 'public.market_report_cycles', 'select') then
    raise exception 'anon/authenticated must not read the tables';
  end if;
  if not has_table_privilege('service_role', 'public.market_data_packets', 'select')
     or has_table_privilege('service_role', 'public.market_data_packets', 'insert')
     or has_table_privilege('service_role', 'public.market_data_packets', 'update')
     or has_table_privilege('service_role', 'public.market_data_packets', 'delete')
     or has_table_privilege('service_role', 'public.market_report_cycles', 'update') then
    raise exception 'service_role must be select-only on the tables';
  end if;
  if has_function_privilege('anon', 'public.claim_market_report_cycle(text, date, timestamptz, integer, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.complete_market_report_cycle(uuid, uuid, jsonb, text, timestamptz, timestamptz, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.fail_market_report_cycle(uuid, uuid, text, jsonb)', 'execute') then
    raise exception 'anon/authenticated must not execute the RPCs';
  end if;
  if not has_function_privilege('service_role', 'public.claim_market_report_cycle(text, date, timestamptz, integer, integer)', 'execute') then
    raise exception 'service_role must execute the RPCs';
  end if;
  raise notice 'PASS 1 catalog: RLS, definer, search_path, grants';
end $$;

-- 2. anon / authenticated are denied at runtime ------------------------------
set local role anon;
select pg_temp.expect_error($q$select * from public.claim_market_report_cycle('close', '2026-09-16')$q$, 'permission denied');
select pg_temp.expect_error($q$select * from public.market_data_packets$q$, 'permission denied');
reset role;
set local role authenticated;
select pg_temp.expect_error($q$select * from public.market_report_cycles$q$, 'permission denied');
reset role;
do $$ begin raise notice 'PASS 2 runtime denial for anon/authenticated'; end $$;

-- 3. Claim → complete (ok) → idempotent re-claim ------------------------------
set local role service_role;
insert into proof_ids select 'close1', c.cycle_id, c.claim_token
from public.claim_market_report_cycle('close', '2026-09-16', '2026-09-16T07:15:00Z') as c
where c.outcome = 'claimed' and c.attempt = 1;
do $$ begin
  if (select count(*) from proof_ids where label = 'close1') <> 1 then raise exception 'first claim must succeed'; end if;
end $$;

insert into proof_ids select 'packet1', r.packet_id, null
from proof_ids p,
  public.complete_market_report_cycle(
    p.id, p.token,
    '{"schema_version":"market_data_packet.v1","report_type":"close","trading_date":"2026-09-16","data_quality":{"status":"ok"}}',
    repeat('a', 64), '2026-09-16T07:15:00Z', '2026-09-16T07:15:05Z', '{"source":"proof"}'
  ) as r
where p.label = 'close1' and r.cycle_status = 'completed';

do $$
declare v record;
begin
  if (select count(*) from proof_ids where label = 'packet1') <> 1 then raise exception 'ok packet must complete the cycle'; end if;
  select * into v from public.claim_market_report_cycle('close', '2026-09-16');
  if v.outcome <> 'already_completed' or v.claim_token is not null then
    raise exception 'completed cycle must not be re-claimed, got %', v.outcome;
  end if;
  if (select count(*) from public.market_report_cycles where report_type = 'close' and trading_date = '2026-09-16') <> 1 then
    raise exception 'duplicate cycle rows';
  end if;
  if (select count(*) from public.market_data_packets) <> 1 then raise exception 'idempotent re-claim must not add packets'; end if;
  raise notice 'PASS 3 claim/complete/idempotent re-claim, single cycle row';
end $$;

-- 4. Completed-cycle token is gone: a late writer cannot add a packet ---------
select pg_temp.expect_error(format(
  $q$select * from public.complete_market_report_cycle(%L, %L, '{"schema_version":"market_data_packet.v1","report_type":"close","trading_date":"2026-09-16","data_quality":{"status":"ok"}}', %L, now(), now())$q$,
  (select id from proof_ids where label = 'close1'), (select token from proof_ids where label = 'close1'), repeat('b', 64)
), 'MARKET_REPORT_CYCLE_CLAIM_LOST');
do $$ begin raise notice 'PASS 4 stale token rejected after completion'; end $$;
reset role;

-- 5. Immutability even for the table owner -----------------------------------
select pg_temp.expect_error($q$update public.market_data_packets set content_hash = repeat('c', 64)$q$, 'MARKET_DATA_PACKET_IMMUTABLE');
select pg_temp.expect_error($q$delete from public.market_data_packets$q$, 'MARKET_DATA_PACKET_IMMUTABLE');
select pg_temp.expect_error($q$truncate public.market_data_packets cascade$q$, 'MARKET_DATA_PACKET_IMMUTABLE');
select pg_temp.expect_error($q$update public.market_report_cycles set current_data_packet_id = null where report_type = 'close'$q$, 'MARKET_REPORT_CYCLE_PACKET_IMMUTABLE');
select pg_temp.expect_error($q$update public.market_report_cycles set cycle_status = 'failed' where report_type = 'close'$q$, 'MARKET_REPORT_CYCLE_COMPLETED_IMMUTABLE');
select pg_temp.expect_error($q$update public.market_report_cycles set trading_date = '2026-09-15' where report_type = 'close'$q$, 'MARKET_REPORT_CYCLE_IDENTITY_IMMUTABLE');
select pg_temp.expect_error($q$insert into public.market_report_cycles (report_type, trading_date) values ('close', '2026-09-16')$q$, 'market_report_cycles_type_date_key');
do $$ begin raise notice 'PASS 5 packet update/delete/truncate, pointer, status, identity and duplicate cycle all rejected'; end $$;

-- 6. Payload / cycle identity checks ------------------------------------------
select pg_temp.expect_error(format(
  $q$insert into public.market_data_packets (cycle_id, attempt, schema_version, report_type, trading_date, as_of, generated_at, payload, content_hash, data_quality_status)
     values (%L, 9, 'market_data_packet.v1', 'close', '2026-09-16', now(), now(),
             '{"schema_version":"market_data_packet.v1","report_type":"close","trading_date":"2026-09-15","data_quality":{"status":"ok"}}', %L, 'ok')$q$,
  (select id from proof_ids where label = 'close1'), repeat('d', 64)
), 'market_data_packets_payload_identity');
select pg_temp.expect_error(format(
  $q$insert into public.market_data_packets (cycle_id, attempt, schema_version, report_type, trading_date, as_of, generated_at, payload, content_hash, data_quality_status)
     values (%L, 9, 'market_data_packet.v1', 'morning', '2026-09-16', now(), now(),
             '{"schema_version":"market_data_packet.v1","report_type":"morning","trading_date":"2026-09-16","data_quality":{"status":"ok"}}', %L, 'ok')$q$,
  (select id from proof_ids where label = 'close1'), repeat('d', 64)
), 'MARKET_DATA_PACKET_CYCLE_MISMATCH');
do $$ begin raise notice 'PASS 6 payload identity and cycle mismatch rejected'; end $$;

-- 7. Blocked packet keeps the cycle retryable; retry completes; budget ---------
set local role service_role;
do $$
declare c record; r record; v_blocked uuid;
begin
  select * into c from public.claim_market_report_cycle('morning', '2026-09-17');
  if c.outcome <> 'claimed' or c.attempt <> 1 then raise exception 'morning claim 1 failed'; end if;
  select * into r from public.complete_market_report_cycle(c.cycle_id, c.claim_token,
    '{"schema_version":"market_data_packet.v1","report_type":"morning","trading_date":"2026-09-17","data_quality":{"status":"blocked"}}',
    repeat('e', 64), now(), now());
  if r.cycle_status <> 'blocked' then raise exception 'blocked packet must leave cycle blocked'; end if;
  v_blocked := r.packet_id;
  if (select current_data_packet_id from public.market_report_cycles where id = c.cycle_id) is not null then
    raise exception 'blocked packet must not become current';
  end if;

  select * into c from public.claim_market_report_cycle('morning', '2026-09-17');
  if c.outcome <> 'claimed' or c.attempt <> 2 then raise exception 'blocked cycle must be retryable as attempt 2'; end if;
  if public.fail_market_report_cycle(c.cycle_id, c.claim_token, 'YAHOO_FETCH_FAILED', '{"n225":"http_503"}') <> 'failed' then
    raise exception 'fail must record';
  end if;
  if public.fail_market_report_cycle(c.cycle_id, c.claim_token, 'LATE', '{}') <> 'claim_lost' then
    raise exception 'second fail with stale token must be claim_lost';
  end if;

  select * into c from public.claim_market_report_cycle('morning', '2026-09-17');
  if c.outcome <> 'claimed' or c.attempt <> 3 then raise exception 'failed cycle must be retryable as attempt 3'; end if;
  select * into r from public.complete_market_report_cycle(c.cycle_id, c.claim_token,
    '{"schema_version":"market_data_packet.v1","report_type":"morning","trading_date":"2026-09-17","data_quality":{"status":"partial"}}',
    repeat('f', 64), now(), now());
  if r.cycle_status <> 'completed' then raise exception 'partial packet must complete'; end if;
  if (select current_data_packet_id from public.market_report_cycles where id = c.cycle_id) <> r.packet_id then
    raise exception 'partial packet must be current';
  end if;
  if (select count(*) from public.market_data_packets where cycle_id = c.cycle_id) <> 2 then
    raise exception 'blocked and completed packets must both be kept (insert-only history)';
  end if;
  if not exists (select 1 from public.market_data_packets where id = v_blocked) then
    raise exception 'blocked packet must remain';
  end if;
  raise notice 'PASS 7 blocked → retry → failed → retry → partial completes; history kept';
end $$;

do $$
declare c record;
begin
  -- exhaust the budget on a fresh cycle
  for i in 1..3 loop
    select * into c from public.claim_market_report_cycle('close', '2026-09-17', null, 900, 3);
    if c.outcome <> 'claimed' then raise exception 'attempt % should claim, got %', i, c.outcome; end if;
    perform public.fail_market_report_cycle(c.cycle_id, c.claim_token, 'X', '{}');
  end loop;
  select * into c from public.claim_market_report_cycle('close', '2026-09-17', null, 900, 3);
  if c.outcome <> 'attempts_exhausted' then raise exception 'expected attempts_exhausted, got %', c.outcome; end if;
  raise notice 'PASS 8 retry budget enforced';
end $$;

-- 9. Concurrent-style guard: running attempt blocks a second claim until stale -
do $$
declare c1 record; c2 record;
begin
  select * into c1 from public.claim_market_report_cycle('morning', '2026-09-18');
  select * into c2 from public.claim_market_report_cycle('morning', '2026-09-18');
  if c1.outcome <> 'claimed' or c2.outcome <> 'in_progress' or c2.claim_token is not null then
    raise exception 'second claim during a fresh running attempt must be in_progress';
  end if;
  raise notice 'PASS 9 running attempt blocks a second claim';
end $$;
reset role;

-- stale running attempt: owner backdates started_at, then the next claim takes over
update public.market_report_cycles set started_at = now() - interval '2 hours'
where report_type = 'morning' and trading_date = '2026-09-18';
set local role service_role;
do $$
declare old_token uuid; c record;
begin
  select claim_token into old_token from public.market_report_cycles where report_type = 'morning' and trading_date = '2026-09-18';
  select * into c from public.claim_market_report_cycle('morning', '2026-09-18');
  if c.outcome <> 'claimed' or c.attempt <> 2 then raise exception 'stale running attempt must be reclaimable'; end if;
  begin
    perform * from public.complete_market_report_cycle(c.cycle_id, old_token,
      '{"schema_version":"market_data_packet.v1","report_type":"morning","trading_date":"2026-09-18","data_quality":{"status":"ok"}}',
      repeat('0', 64), now(), now());
    raise exception 'old token must not complete';
  exception when others then
    if position('MARKET_REPORT_CYCLE_CLAIM_LOST' in sqlerrm) = 0 then raise; end if;
  end;
  raise notice 'PASS 10 stale attempt reclaimed; superseded token cannot write';
end $$;
reset role;

rollback;
