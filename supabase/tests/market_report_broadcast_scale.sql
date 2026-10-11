-- 一斉通知の SQL 側の規模の確認（使い捨ての手元の PostgreSQL 専用。合成の利用者だけ。本番・サービスの DB には絶対に当てない）。
-- psql -v n=<人数> で実行する。対象の全員に1回ずつ「送信済み」が付くまで、分割・引き取り・送る直前・送ったあとを
-- worker と同じ順に回し、それぞれにかかった時間（手元の PostgreSQL での実測）を出す。Expo への送信はしない。
\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- 合成の利用者: n 人（5人に1人は端末2台）。さらに対象外を n/10 人（通知 OFF）。
insert into auth.users (id)
  select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid from generate_series(1, :n + :n / 10) as g;
insert into public.profiles (id) select id from auth.users where id::text like '00000000-0000-4000-9000-%';
insert into public.alert_settings (user_id, push_enabled, morning_report, close_report)
  select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, g <= :n, true, true from generate_series(1, :n + :n / 10) as g;
insert into public.device_push_tokens (user_id, expo_push_token, platform)
  select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, 'ExponentPushToken[s' || g || '-' || d || ']', 'ios'
    from generate_series(1, :n + :n / 10) as g, generate_series(1, 2) as d
   where d = 1 or g % 5 = 0;
analyze;

-- 今日の朝刊の回（完成済み）
do $$
declare
  v_cycle uuid;
  v_data uuid;
  v_report uuid;
  v_date date := (now() at time zone 'Asia/Tokyo')::date;
begin
  insert into public.market_report_cycles (report_type, trading_date) values ('morning', v_date) returning id into v_cycle;
  insert into public.market_data_packets (cycle_id, attempt, schema_version, report_type, trading_date, as_of, generated_at, payload, content_hash, data_quality_status)
    values (v_cycle, 1, 'market_data_packet.v1', 'morning', v_date, now(), now(),
      jsonb_build_object('schema_version', 'market_data_packet.v1', 'report_type', 'morning', 'trading_date', to_char(v_date, 'YYYY-MM-DD'),
        'data_quality', jsonb_build_object('status', 'ok')), repeat('a', 64), 'ok') returning id into v_data;
  update public.market_report_cycles set current_data_packet_id = v_data, cycle_status = 'completed' where id = v_cycle;
  insert into public.market_report_packets (cycle_id, data_packet_id, attempt, schema_version, report_type, trading_date, payload,
      content_hash, fact_status, model, generation_calls, input_tokens, output_tokens, api_cost_usd)
    values (v_cycle, v_data, 1, 'market_report_packet.v1', 'morning', v_date,
      jsonb_build_object('schema_version', 'market_report_packet.v1', 'report_type', 'morning', 'trading_date', to_char(v_date, 'YYYY-MM-DD'),
        'data_packet_id', v_data::text, 'headline_ja', '見出し', 'fact', jsonb_build_object('ai_status', 'passed')),
      repeat('b', 64), 'passed', 'm', 1, 1, 1, 0) returning id into v_report;
  update public.market_report_cycles set current_report_packet_id = v_report, report_status = 'completed', report_completed_at = now() where id = v_cycle;
end
$$;
update public.personalized_ondemand_settings set public_market_feed_enabled = true, ondemand_requests_enabled = true;
update public.market_report_broadcast_settings set enabled = true, sending_enabled = true, max_parallel_chunks = 4;

select set_config('scale.n', :'n', false);
create temp table timing (phase text, calls integer, ms numeric);
grant all on timing to service_role;

-- worker と同じ順に、service_role として回す。
begin;
set local role service_role;
do $$
declare
  t0 timestamptz;
  v_b uuid;
  v_status text;
  v_calls integer := 0;
  v_chunk record;
  v_claims integer := 0;
  v_begins integer := 0;
  v_finishes integer := 0;
  ms_claim numeric := 0;
  ms_begin numeric := 0;
  ms_finish numeric := 0;
  v_results jsonb;
  v_got integer;
begin
  t0 := clock_timestamp();
  perform public.enqueue_market_report_broadcasts();
  insert into timing values ('enqueue', 1, extract(epoch from clock_timestamp() - t0) * 1000);
  select id into v_b from public.market_report_broadcasts limit 1;
  t0 := clock_timestamp();
  loop
    v_calls := v_calls + 1;
    v_status := public.plan_market_report_broadcast(v_b) ->> 'status';
    exit when v_status <> 'planning' or v_calls > 1000;
  end loop;
  insert into timing values ('plan', v_calls, extract(epoch from clock_timestamp() - t0) * 1000);
  loop
    t0 := clock_timestamp();
    v_got := 0;
    for v_chunk in select * from public.claim_market_report_broadcast_chunks(4) loop
      v_got := v_got + 1;
      ms_claim := ms_claim + extract(epoch from clock_timestamp() - t0) * 1000;
      v_claims := v_claims + 1;
      t0 := clock_timestamp();
      select coalesce(jsonb_agg(jsonb_build_object('user_id', x.user_id, 'outcome', 'sent')), '[]'::jsonb) into v_results
        from (select distinct b.user_id from public.begin_market_report_broadcast_chunk(v_chunk.chunk_id, v_chunk.lease_token, v_chunk.lease_version) as b) as x;
      ms_begin := ms_begin + extract(epoch from clock_timestamp() - t0) * 1000;
      v_begins := v_begins + 1;
      t0 := clock_timestamp();
      perform public.finish_market_report_broadcast_chunk(v_chunk.chunk_id, v_chunk.lease_token, v_chunk.lease_version, v_results);
      ms_finish := ms_finish + extract(epoch from clock_timestamp() - t0) * 1000;
      v_finishes := v_finishes + 1;
      t0 := clock_timestamp();
    end loop;
    exit when v_got = 0 or v_claims > 100000;
  end loop;
  insert into timing values ('claim', v_claims, ms_claim), ('begin', v_begins, ms_begin), ('finish', v_finishes, ms_finish);
end
$$;
reset role;
commit;

select 'TIMING ' || phase || ' calls=' || calls || ' total_ms=' || round(ms) || ' per_call_ms=' || round(ms / greatest(calls, 1), 1) from timing order by phase;

-- 全員にちょうど1回「送信済み」。対象外（通知 OFF）には記録なし。一斉通知は完了。
do $$
declare
  v_n integer := current_setting('scale.n')::integer;
begin
  if (select count(*) from public.market_report_broadcast_deliveries where status = 'sent') <> v_n then
    raise exception 'FAIL scale: sent % expected %', (select count(*) from public.market_report_broadcast_deliveries where status = 'sent'), v_n;
  end if;
  if (select count(*) from public.market_report_broadcast_deliveries) <> v_n then
    raise exception 'FAIL scale: extra deliveries';
  end if;
  if (select status from public.market_report_broadcasts limit 1) <> 'completed' then
    raise exception 'FAIL scale: broadcast not completed';
  end if;
  if (select planned_chunks from public.market_report_broadcasts limit 1) <> ceil(v_n / 500.0) then
    raise exception 'FAIL scale: chunks';
  end if;
end
$$;
select 'MARKET_REPORT_BROADCAST_SCALE_PASS';
