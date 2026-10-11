-- 20261012100000_market_report_broadcast_push_v1 の動作の検証（使い捨ての手元の PostgreSQL 専用）。
-- テーブルの所有者として実行する。worker・利用者の操作は fx.call_as で実際のロールに切り替えて呼ぶ。
-- 最後に MARKET_REPORT_BROADCAST_BEHAVIOR_PASS を出す。
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create schema fx;

create function fx.call_as(p_sub uuid, p_role text, p_sql text) returns text
language plpgsql as $$
declare
  v text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    execute format('set local role %I', p_role);
    execute p_sql into v;
    reset role;
    perform set_config('request.jwt.claim.sub', '', true);
    return coalesce(v, '<null>');
  exception when others then
    return 'ERR:' || sqlerrm;
  end;
end
$$;

create function fx.eq(p_actual text, p_expected text, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL %: expected [%] got [%]', p_label, p_expected, p_actual;
  end if;
end
$$;

create function fx.like(p_actual text, p_pattern text, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is null or p_actual not like p_pattern then
    raise exception 'FAIL %: expected like [%] got [%]', p_label, p_pattern, p_actual;
  end if;
end
$$;

create function fx.uid(n integer) returns uuid language sql immutable as
$$ select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;

-- 利用者（auth.users + profiles）。p_settings: null なら通知設定の行なし。p_devices: 端末の数。
create function fx.user(n integer, p_push boolean, p_morning boolean, p_close boolean, p_devices integer) returns uuid
language plpgsql as $$
declare
  v uuid := fx.uid(n);
begin
  insert into auth.users (id) values (v);
  insert into public.profiles (id) values (v);
  if p_push is not null then
    insert into public.alert_settings (user_id, push_enabled, morning_report, close_report) values (v, p_push, p_morning, p_close);
  end if;
  insert into public.device_push_tokens (user_id, expo_push_token, platform)
    select v, 'ExponentPushToken[u' || n || '-d' || d || ']', 'ios' from generate_series(1, p_devices) as d;
  return v;
end
$$;

-- 共通の回を1つ作る。p_fact: payload の fact.ai_status。p_completed_ago: 完成からの経過時間。
create function fx.market(p_type text, p_date date, p_completed boolean, p_fact text default 'passed',
  p_completed_ago interval default interval '1 minute') returns uuid
language plpgsql as $$
declare
  v_cycle uuid;
  v_data uuid;
  v_report uuid;
begin
  insert into public.market_report_cycles (report_type, trading_date) values (p_type, p_date) returning id into v_cycle;
  insert into public.market_data_packets (cycle_id, attempt, schema_version, report_type, trading_date, as_of, generated_at,
      payload, content_hash, data_quality_status)
    values (v_cycle, 1, 'market_data_packet.v1', p_type, p_date, now(), now(),
      jsonb_build_object('schema_version', 'market_data_packet.v1', 'report_type', p_type, 'trading_date', to_char(p_date, 'YYYY-MM-DD'),
        'data_quality', jsonb_build_object('status', 'ok'), 'metrics', '[]'::jsonb),
      repeat('a', 64), 'ok')
    returning id into v_data;
  update public.market_report_cycles set current_data_packet_id = v_data, cycle_status = 'completed', completed_at = now() where id = v_cycle;
  if not p_completed then
    update public.market_report_cycles set report_status = 'running', report_claim_token = gen_random_uuid() where id = v_cycle;
    return null;
  end if;
  insert into public.market_report_packets (cycle_id, data_packet_id, attempt, schema_version, report_type, trading_date, payload,
      content_hash, fact_status, model, generation_calls, input_tokens, output_tokens, api_cost_usd)
    values (v_cycle, v_data, 1, 'market_report_packet.v1', p_type, p_date,
      jsonb_build_object('schema_version', 'market_report_packet.v1', 'report_type', p_type, 'trading_date', to_char(p_date, 'YYYY-MM-DD'),
        'data_packet_id', v_data::text, 'headline_ja', '日経平均は反発、半導体株が支え',
        'fact', jsonb_build_object('ai_status', p_fact, 'local_issues', '[]'::jsonb, 'generation_attempts', 1)),
      repeat('b', 64), 'passed', 'm', 1, 1, 1, 0)
    returning id into v_report;
  update public.market_report_cycles
     set current_report_packet_id = v_report, report_status = 'completed', report_completed_at = now() - p_completed_ago
   where id = v_cycle;
  return v_report;
end
$$;

create temp table claimed (chunk_id uuid, broadcast_id uuid, attempt_count integer, lease_token uuid, lease_version bigint);
grant all on claimed to service_role;

create function fx.claim(p_limit integer) returns integer language plpgsql as $$
declare v integer;
begin
  truncate claimed;
  v := fx.call_as(null, 'service_role', format($q$with c as (insert into claimed select chunk_id, broadcast_id, attempt_count, lease_token, lease_version
    from public.claim_market_report_broadcast_chunks(%s) returning 1) select count(*)::text from c$q$, p_limit))::integer;
  return v;
end
$$;

-- 区切りの送る直前の呼び出しの結果（user:token の並び）。
create function fx.begin(p_chunk uuid, p_token uuid, p_version bigint) returns text language sql as $$
  select fx.call_as(null, 'service_role', format($q$select coalesce(string_agg(right(user_id::text, 4) || ':' || expo_push_token, ',' order by user_id, expo_push_token), '')
    from public.begin_market_report_broadcast_chunk(%L, %L, %s)$q$, p_chunk, p_token, p_version))
$$;

create function fx.finish(p_chunk uuid, p_token uuid, p_version bigint, p_results jsonb) returns text language sql as $$
  select fx.call_as(null, 'service_role', format($q$select (public.finish_market_report_broadcast_chunk(%L, %L, %s, %L) ->> 'status')$q$,
    p_chunk, p_token, p_version, p_results))
$$;

-- 区切りの「送信中」の人を、全員 outcome にする結果。
create function fx.all_as(p_chunk uuid, p_outcome text) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', d.user_id, 'outcome', p_outcome)), '[]'::jsonb)
    from public.market_report_broadcast_deliveries as d where d.chunk_id = p_chunk and d.status = 'sending'
$$;

select (now() at time zone 'Asia/Tokyo')::date as today \gset

-- ---------------------------------------------------------------------------
-- 0. 利用者
--   A: 通知 ON・朝刊 ON・大引け ON・端末2台    F: 通知 ON・朝刊 ON・端末1台
--   B: 通知 OFF   C: 朝刊 OFF（大引けだけ ON）   D: 設定の行なし（端末あり）   E: 端末なし
-- ---------------------------------------------------------------------------
select fx.user(1, true, true, true, 2) as a \gset
select fx.user(2, false, true, true, 1) as b \gset
select fx.user(3, true, false, true, 1) as c \gset
select fx.user(4, null, null, null, 1) as d \gset
select fx.user(5, true, true, true, 0) as e \gset
select fx.user(6, true, true, false, 1) as f \gset

-- ---------------------------------------------------------------------------
-- 1. 既定はすべて OFF。権限
-- ---------------------------------------------------------------------------
select fx.eq((select enabled::text || sending_enabled::text || allow_with_legacy_personalized_reports::text || (pilot_user_ids is null)::text
                from public.market_report_broadcast_settings), 'falsefalsefalsetrue', 'defaults off');
select fx.eq(fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()::text$$), '{"status": "disabled"}', 'enqueue disabled');
select fx.eq(fx.claim(5)::text, '0', 'claim nothing while disabled');
select fx.like(fx.call_as(:'a', 'authenticated', $$select public.enqueue_market_report_broadcasts()::text$$), 'ERR:permission denied%', 'user cannot enqueue');
select fx.like(fx.call_as(:'a', 'authenticated', $$select count(*)::text from public.claim_market_report_broadcast_chunks(1)$$), 'ERR:permission denied%', 'user cannot claim');
select fx.like(fx.call_as(:'a', 'authenticated', $$select count(*)::text from public.begin_market_report_broadcast_chunk(gen_random_uuid(), gen_random_uuid(), 1)$$), 'ERR:permission denied%', 'user cannot begin');
select fx.like(fx.call_as(:'a', 'authenticated', $$select public.finish_market_report_broadcast_chunk(gen_random_uuid(), gen_random_uuid(), 1, '[]')::text$$), 'ERR:permission denied%', 'user cannot finish');
select fx.like(fx.call_as(:'a', 'authenticated', $$select public.plan_market_report_broadcast(gen_random_uuid())::text$$), 'ERR:permission denied%', 'user cannot plan');
select fx.like(fx.call_as(:'a', 'authenticated', $$select public.purge_market_report_broadcasts(1)::text$$), 'ERR:permission denied%', 'user cannot purge');
select fx.like(fx.call_as(null, 'anon', $$select public.enqueue_market_report_broadcasts()::text$$), 'ERR:permission denied%', 'anon cannot enqueue');
select fx.like(fx.call_as(:'a', 'authenticated', $$select count(*)::text from public.market_report_broadcasts$$), 'ERR:permission denied%', 'user cannot read broadcasts');
select fx.like(fx.call_as(:'a', 'authenticated', $$select count(*)::text from public.market_report_broadcast_deliveries$$), 'ERR:permission denied%', 'user cannot read deliveries');
select fx.like(fx.call_as(null, 'service_role', $$select count(*)::text from public.market_report_broadcast_deliveries$$), 'ERR:permission denied%', 'service_role reads deliveries only via RPC');
select fx.like(fx.call_as(null, 'service_role', $$update public.market_report_broadcast_settings set enabled = true returning 'x'$$), 'ERR:permission denied%', 'service_role cannot flip gate');
select fx.like(fx.call_as(null, 'service_role', $$insert into public.market_report_broadcasts (report_type) values ('morning') returning 'x'$$), 'ERR:permission denied%', 'service_role cannot insert broadcasts');
select fx.like(fx.call_as(null, 'service_role', $$select public.market_report_broadcast_eligible(gen_random_uuid(), 'morning')::text$$), 'ERR:permission denied%', 'eligibility helper is internal');

-- ---------------------------------------------------------------------------
-- 2. ゲートの順序: 一斉通知 ON → 共通の市況の公開 → 旧来の定時の個別レポートとの二重を防ぐ
-- ---------------------------------------------------------------------------
select fx.market('morning', :'today', true) as pkt_m \gset
update public.market_report_broadcast_settings set enabled = true, chunk_size = 50, plan_chunks_per_call = 1;
select fx.eq(fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()::text$$), '{"status": "feed_disabled"}', 'feed gate off');
update public.personalized_ondemand_settings set public_market_feed_enabled = true;
select fx.eq(fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()::text$$), '{"status": "legacy_personalized_active"}', 'legacy personalized reports still active');
select fx.eq((select count(*)::text from public.market_report_broadcasts), '0', 'nothing created behind gates');
update public.personalized_ondemand_settings set ondemand_requests_enabled = true;

-- ---------------------------------------------------------------------------
-- 3. 作る側: 1つの回に1つ。作成中・古い・前日・Fact 未確認の回は作らない
-- ---------------------------------------------------------------------------
select fx.market('close', :'today', false) as ignored \gset
select fx.market('morning', (:'today'::date - 1), true) as ignored \gset
select fx.eq(fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()::text$$)::jsonb ->> 'created', '1', 'one broadcast for today morning');
select fx.eq(fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()::text$$)::jsonb ->> 'created', '0', 'enqueue is idempotent');
select id as bm, title, body from public.market_report_broadcasts where report_type = 'morning' \gset
select fx.eq(:'title', to_char(:'today'::date, 'FMMM"月"FMDD"日"') || 'の朝刊ができました', 'title has the market date');
select fx.eq(:'body', '日経平均は反発、半導体株が支え', 'body is the Fact-checked headline');
select fx.eq((select count(*)::text from public.market_report_broadcasts where trading_date <> :'today'::date), '0', 'yesterday not broadcast');

-- ---------------------------------------------------------------------------
-- 4. 分割: 1回の呼び出しで1区切り（plan_chunks_per_call=1）、続きの位置から再開、隙間なくつながる
-- ---------------------------------------------------------------------------
-- 対象（朝刊）: A と F と、追加の120人（10000〜10119、半分は端末2台）。B（OFF）・C（朝刊 OFF）・D（行なし）・E（端末なし）は対象外。
select count(fx.user(n, true, true, true, 1 + (n % 2))) as ignored from generate_series(10000, 10119) as n \gset
select fx.eq(fx.call_as(null, 'service_role', format($$select public.plan_market_report_broadcast(%L) ->> 'status'$$, :'bm')), 'planning', 'plan call 1 makes one chunk');
select fx.eq((select planned_chunks || '/' || planned_users from public.market_report_broadcasts where id = :'bm'), '1/50', 'checkpoint after call 1');
select fx.eq(fx.call_as(null, 'service_role', format($$select public.plan_market_report_broadcast(%L) ->> 'status'$$, :'bm')), 'planning', 'plan call 2');
select fx.eq(fx.call_as(null, 'service_role', format($$select public.plan_market_report_broadcast(%L) ->> 'status'$$, :'bm')), 'planning', 'plan call 3');
select fx.eq(fx.call_as(null, 'service_role', format($$select public.plan_market_report_broadcast(%L) ->> 'status'$$, :'bm')), 'planned', 'plan call 4 finds no more users');
select fx.eq((select status || '/' || planned_chunks || '/' || planned_users from public.market_report_broadcasts where id = :'bm'), 'sending/3/122', '122 eligible users in 3 chunks');
select fx.eq((select string_agg(planned_users::text, ',' order by chunk_no) from public.market_report_broadcast_chunks where broadcast_id = :'bm'), '50,50,22', 'chunk sizes');
select fx.eq((select count(*)::text from public.market_report_broadcast_chunks as c
               join public.market_report_broadcast_chunks as p on p.broadcast_id = c.broadcast_id and p.chunk_no = c.chunk_no - 1
              where c.broadcast_id = :'bm' and c.user_after is distinct from p.user_to), '0', 'chunks are contiguous');
select fx.eq((select (user_after is null)::text from public.market_report_broadcast_chunks where broadcast_id = :'bm' and chunk_no = 1), 'true', 'first chunk starts at the beginning');
select fx.eq(fx.call_as(null, 'service_role', format($$select public.plan_market_report_broadcast(%L) ->> 'status'$$, :'bm')), 'sending', 'replanning a planned broadcast is a no-op');

-- ---------------------------------------------------------------------------
-- 5. 送る: 上限まで引き取り、送る直前に確かめ直し、1人1回
-- ---------------------------------------------------------------------------
-- 送信のゲートが OFF の間は、作成と分割だけ（試し実行）。引き取らない。
select fx.eq(fx.claim(10)::text, '0', 'sending gate off: planned but nothing claimed');
update public.market_report_broadcast_settings set sending_enabled = true, max_parallel_chunks = 2;
select fx.eq(fx.claim(10)::text, '2', 'capacity 2');
select fx.eq(fx.claim(10)::text, '0', 'no slot while 2 running');
-- 区切り1（A・F を含む先頭の50人）を進める。送る直前に F が通知を OFF にし、A は端末を入れ替えた。
select id as c1, lease_token as t1, lease_version as v1 from public.market_report_broadcast_chunks where broadcast_id = :'bm' and chunk_no = 1 \gset
update public.alert_settings set push_enabled = false where user_id = :'f';
delete from public.device_push_tokens where user_id = :'a' and expo_push_token = 'ExponentPushToken[u1-d1]';
insert into public.device_push_tokens (user_id, expo_push_token, platform) values (:'a', 'ExponentPushToken[u1-new]', 'ios');
select fx.like(fx.begin(:'c1', gen_random_uuid(), :'v1'), 'ERR:MARKET_REPORT_BROADCAST_LEASE_LOST%', 'begin needs the lease token');
select fx.like(fx.begin(:'c1', :'t1', :'v1'::bigint + 1), 'ERR:MARKET_REPORT_BROADCAST_LEASE_LOST%', 'begin needs the lease version');
select fx.begin(:'c1', :'t1', :'v1') as sent1 \gset
select fx.like(:'sent1', '0001:ExponentPushToken[u1-d2],0001:ExponentPushToken[u1-new],%', 'A gets both current devices, not the removed one');
select fx.eq((position('u6-' in :'sent1') = 0)::text, 'true', 'F switched off before send: not sent');
select fx.eq((position('u2-' in :'sent1') + position('u3-' in :'sent1') + position('u4-' in :'sent1') + position('u5-' in :'sent1'))::text, '0', 'B/C/D/E never sent');
select fx.eq((select count(*)::text from public.market_report_broadcast_deliveries where chunk_id = :'c1' and status = 'sending'), '49', 'one sending row per user (A once, 2 devices)');
select fx.eq((select device_count::text from public.market_report_broadcast_deliveries where user_id = :'a' and broadcast_id = :'bm'), '2', 'A device count');
-- 同じ区切りを二度呼んでも、もう送らない（送信中の人は対象外）。
select fx.eq(fx.begin(:'c1', :'t1', :'v1'), '', 'second begin returns nobody');
-- 結果: A は送信、ほかは送っていないことが確かな失敗（retry）を1人、結果なし（unknown）を1人、残りは送信。
select user_id as r_user from public.market_report_broadcast_deliveries where chunk_id = :'c1' and status = 'sending' and user_id <> :'a' order by user_id limit 1 \gset
select user_id as u_user from public.market_report_broadcast_deliveries where chunk_id = :'c1' and status = 'sending' and user_id <> :'a' order by user_id desc limit 1 \gset
select fx.eq(fx.finish(:'c1', gen_random_uuid(), :'v1', '[]'), 'lease_lost', 'finish needs the lease token');
select fx.eq(fx.finish(:'c1', :'t1', :'v1',
  (select jsonb_agg(jsonb_build_object('user_id', d.user_id, 'outcome', case when d.user_id = :'r_user'::uuid then 'retry' else 'sent' end))
     from public.market_report_broadcast_deliveries as d where d.chunk_id = :'c1' and d.status = 'sending' and d.user_id <> :'u_user'::uuid)),
  'requeued', 'chunk with a retry user is requeued');
select fx.eq((select status from public.market_report_broadcast_deliveries where user_id = :'u_user' and broadcast_id = :'bm'), 'unknown', 'missing result is unknown');
select fx.eq((select status from public.market_report_broadcast_deliveries where user_id = :'r_user' and broadcast_id = :'bm'), 'retry', 'explicit not-accepted is retry');
select fx.eq((select status || '/' || sent_users || '/' || unknown_users || '/' || (available_at > clock_timestamp())::text
                from public.market_report_broadcast_chunks where id = :'c1'), 'queued/47/1/true', 'chunk counts and backoff');
-- 再試行: 送り直すのは retry の人だけ（unknown・送信済みの人には送らない）。
update public.market_report_broadcast_chunks set available_at = clock_timestamp() where id = :'c1';
select fx.eq(fx.finish(:'c1', :'t1', :'v1', '[]'), 'lease_lost', 'old lease cannot finish after requeue');
select count(*) as ignored from (select fx.claim(1)) as x \gset
select lease_token as t1b, lease_version as v1b, attempt_count as a1b from public.market_report_broadcast_chunks where id = :'c1' \gset
select fx.eq(:'a1b', '2', 'second attempt');
select fx.eq(fx.begin(:'c1', :'t1b', :'v1b'), right(:'r_user', 4) || ':ExponentPushToken[u' || ltrim(right(:'r_user', 12), '0') || '-d1]'
  || case when ltrim(right(:'r_user', 12), '0')::integer % 2 = 1 then ',' || right(:'r_user', 4) || ':ExponentPushToken[u' || ltrim(right(:'r_user', 12), '0') || '-d2]' else '' end,
  'only the retry user is resent');
select fx.eq(fx.finish(:'c1', :'t1b', :'v1b', fx.all_as(:'c1', 'sent')), 'done', 'chunk done');
select fx.eq((select attempt_count::text from public.market_report_broadcast_deliveries where user_id = :'r_user' and broadcast_id = :'bm'), '2', 'retry user attempt 2');

-- ---------------------------------------------------------------------------
-- 6. 期限切れ: 送る直前だった人は unknown（二度と送らない）。区切りは引き取り直し、まだの人だけに送る
-- ---------------------------------------------------------------------------
select id as c2, lease_token as t2, lease_version as v2 from public.market_report_broadcast_chunks where broadcast_id = :'bm' and chunk_no = 2 \gset
select length(fx.begin(:'c2', :'t2', :'v2')) > 0 as began \gset
-- 半分だけ記録が残っている状態を作る: 先頭の10人だけ送信済みにして、残りは送信中のまま期限切れ。
update public.market_report_broadcast_deliveries set status = 'sent'
 where chunk_id = :'c2' and user_id in (select user_id from public.market_report_broadcast_deliveries where chunk_id = :'c2' order by user_id limit 10);
update public.market_report_broadcast_chunks set lease_expires_at = clock_timestamp() - interval '1 second' where id = :'c2';
select fx.eq(fx.finish(:'c2', :'t2', :'v2', fx.all_as(:'c2', 'sent')), 'lease_lost', 'expired lease cannot finish');
select fx.like(fx.begin(:'c2', :'t2', :'v2'), 'ERR:MARKET_REPORT_BROADCAST_LEASE_LOST%', 'expired lease cannot begin');
select count(*) as ignored from (select fx.claim(4)) as x \gset
select fx.eq((select count(*)::text from public.market_report_broadcast_deliveries where chunk_id = :'c2' and status = 'unknown'), '40', 'in-flight users become unknown');
select lease_token as t2b, lease_version as v2b from public.market_report_broadcast_chunks where id = :'c2' \gset
select fx.eq((select (lease_version = :'v2'::bigint + 2)::text from public.market_report_broadcast_chunks where id = :'c2'), 'true', 'version bumped by expiry and reclaim');
select fx.eq(fx.begin(:'c2', :'t2b', :'v2b'), '', 'reclaim sends to nobody already sent or unknown');
select fx.eq(fx.finish(:'c2', :'t2b', :'v2b', '[]'), 'done', 'reclaimed chunk done');

-- ---------------------------------------------------------------------------
-- 7. 回数を使い切る: retry の人は failed。開いている区切りが無くなれば一斉通知は完了
-- ---------------------------------------------------------------------------
update public.market_report_broadcast_settings set max_parallel_chunks = 4;
select x.id as c3, x.lease_token as t3, x.lease_version as v3, x.status as s3 from public.market_report_broadcast_chunks as x where broadcast_id = :'bm' and chunk_no = 3 \gset
select fx.eq(:'s3', 'processing', 'chunk 3 was claimed earlier');
select length(fx.begin(:'c3', :'t3', :'v3')) > 0 as began \gset
select fx.eq(fx.finish(:'c3', :'t3', :'v3', fx.all_as(:'c3', 'retry')), 'requeued', 'all retry');
update public.market_report_broadcast_chunks set available_at = clock_timestamp() where id = :'c3';
select count(*) as ignored from (select fx.claim(4)) as x \gset
select lease_token as t3, lease_version as v3 from public.market_report_broadcast_chunks where id = :'c3' \gset
select length(fx.begin(:'c3', :'t3', :'v3')) > 0 as began \gset
select fx.eq(fx.finish(:'c3', :'t3', :'v3', fx.all_as(:'c3', 'retry')), 'requeued', 'retry again');
update public.market_report_broadcast_chunks set available_at = clock_timestamp() where id = :'c3';
select count(*) as ignored from (select fx.claim(4)) as x \gset
select lease_token as t3, lease_version as v3, attempt_count as a3 from public.market_report_broadcast_chunks where id = :'c3' \gset
select fx.eq(:'a3', '3', 'final attempt');
select length(fx.begin(:'c3', :'t3', :'v3')) > 0 as began \gset
select fx.eq(fx.finish(:'c3', :'t3', :'v3', fx.all_as(:'c3', 'retry')), 'done', 'final attempt ends the chunk');
select fx.eq((select count(*)::text from public.market_report_broadcast_deliveries where chunk_id = :'c3' and status = 'failed'), '22', 'retry on final attempt is failed');
select fx.eq((select status from public.market_report_broadcasts where id = :'bm'), 'completed', 'broadcast completed');
select fx.eq((select count(*)::text from public.market_report_broadcast_deliveries where broadcast_id = :'bm'),
             (select count(distinct user_id)::text from public.market_report_broadcast_deliveries where broadcast_id = :'bm'), 'one row per user');
select fx.eq(fx.claim(4)::text, '0', 'nothing left');

-- ---------------------------------------------------------------------------
-- 8. 期限切れで回数を使い切った区切り（finish が呼ばれない）でも、一斉通知は完了する
-- ---------------------------------------------------------------------------
update public.market_report_broadcast_settings set max_chunk_attempts = 1;
-- 手で1つ作る（今日の大引けの回は作成中で、同じ日に二つ目は作れないため、前日の朝刊の回を使う）。
insert into public.market_report_broadcasts (report_type, trading_date, cycle_id, report_packet_id, title, body)
  select 'close', :'today'::date - 1, c.id, c.current_report_packet_id, 't', 'b'
    from public.market_report_cycles as c where c.report_type = 'morning' and c.trading_date = :'today'::date - 1;
select id as bx from public.market_report_broadcasts where report_type = 'close' and trading_date = :'today'::date - 1 \gset
update public.market_report_broadcast_settings set plan_chunks_per_call = 10;
select fx.call_as(null, 'service_role', format($$select public.plan_market_report_broadcast(%L) ->> 'status'$$, :'bx')) as ignored \gset
select count(*) as ignored from (select fx.claim(4)) as x \gset
update public.market_report_broadcast_chunks set lease_expires_at = clock_timestamp() - interval '1 second' where broadcast_id = :'bx';
select count(*) as ignored from (select fx.claim(4)) as x \gset
select fx.eq((select string_agg(distinct status, ',') from public.market_report_broadcast_chunks where broadcast_id = :'bx'), 'failed', 'expired single-attempt chunks fail');
select fx.eq((select status from public.market_report_broadcasts where id = :'bx'), 'completed', 'broadcast completes without finish');
update public.market_report_broadcast_settings set max_chunk_attempts = 3;

-- ---------------------------------------------------------------------------
-- 9. 対象者0人の一斉通知はすぐ完了。退会で記録も消える。古い記録の削除
-- ---------------------------------------------------------------------------
update public.alert_settings set morning_report = false;
update public.market_report_broadcast_settings set plan_chunks_per_call = 1;
select fx.market('morning', (:'today'::date - 3), true) as pkt_old \gset
insert into public.market_report_broadcasts (report_type, trading_date, cycle_id, report_packet_id, title, body)
  values ('morning', :'today'::date - 3, (select cycle_id from public.market_report_packets where id = :'pkt_old'), :'pkt_old', 't', 'b');
select id as bz from public.market_report_broadcasts where trading_date = :'today'::date - 3 \gset
select fx.eq(fx.call_as(null, 'service_role', format($$select public.plan_market_report_broadcast(%L) ->> 'status'$$, :'bz')), 'planned', 'zero users');
select fx.eq((select status from public.market_report_broadcasts where id = :'bz'), 'completed', 'zero-user broadcast completes');
update public.alert_settings set morning_report = true;
select count(*) as before_a from public.market_report_broadcast_deliveries where user_id = :'a' \gset
delete from public.profiles where id = :'a';
select fx.eq((select count(*)::text from public.market_report_broadcast_deliveries where user_id = :'a'), '0', 'withdrawal removes the user rows');
update public.market_report_broadcast_settings set keep_days = 3;
update public.market_report_broadcasts set trading_date = trading_date - 30 where id = :'bm';
select fx.call_as(null, 'service_role', $$select public.purge_market_report_broadcasts(50)::text$$)::jsonb as pg1 \gset
select fx.eq((:'pg1'::jsonb) ->> 'deliveries_deleted', '50', 'purge is bounded');
select fx.call_as(null, 'service_role', $$select public.purge_market_report_broadcasts(1000)::text$$)::jsonb as pg2 \gset
select fx.eq((select count(*)::text from public.market_report_broadcasts where id = :'bm'), '0', 'old broadcast purged');
select fx.eq((select count(*)::text from public.market_report_broadcasts where id = :'bx'), '1', 'recent broadcast kept');

-- ---------------------------------------------------------------------------
-- 10. Fact: advisory は知らせる、not_run は知らせない。古すぎる回も知らせない
-- ---------------------------------------------------------------------------
delete from public.market_report_broadcasts;
update public.market_report_broadcast_settings set max_report_age_minutes = 30;
-- 今日の朝刊（1分前に完成）は作られる。上で消したので作り直される。
select fx.eq(fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()::text$$)::jsonb ->> 'created', '1', 'recreated after delete (fresh)');
update public.market_report_cycles set report_completed_at = now() - interval '2 hours' where report_type = 'morning' and trading_date = :'today'::date;
delete from public.market_report_broadcasts;
select fx.eq(fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()::text$$)::jsonb ->> 'created', '0', 'too old is not broadcast');
-- Fact の状態（パケットは書き換え禁止なので、検証のためだけに所有者がトリガーを止めて書き換える）。
update public.market_report_cycles set report_completed_at = now() where report_type = 'morning' and trading_date = :'today'::date;
alter table public.market_report_packets disable trigger market_report_packets_no_update;
update public.market_report_packets set payload = jsonb_set(payload, '{fact,ai_status}', '"not_run"') where id = :'pkt_m';
select fx.eq(fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()::text$$), '{"status": "ok", "blocked": 1, "created": 0}', 'not_run is not broadcast');
update public.market_report_packets set payload = jsonb_set(payload, '{headline_ja}', '"  "') || jsonb_build_object('fact', jsonb_build_object('ai_status', 'passed')) where id = :'pkt_m';
select fx.eq(fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()::text$$)::jsonb ->> 'blocked', '1', 'empty headline is not broadcast');
update public.market_report_packets set payload = jsonb_set(jsonb_set(payload, '{headline_ja}', '"見出し"'), '{fact,ai_status}', '"advisory"') where id = :'pkt_m';
select fx.eq(fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()::text$$)::jsonb ->> 'created', '1', 'advisory is broadcast (Fact V2 delivered)');
alter table public.market_report_packets enable trigger market_report_packets_no_update;

-- ---------------------------------------------------------------------------
-- 11. 少数で試す（試す人の一覧）。古くなった一斉通知は送らずに終える
-- ---------------------------------------------------------------------------
delete from public.market_report_broadcasts;
update public.market_report_broadcast_settings set max_report_age_minutes = 120, plan_chunks_per_call = 10, max_parallel_chunks = 4,
  pilot_user_ids = array[fx.uid(10000), fx.uid(10001)];
update public.market_report_cycles set report_completed_at = now() where report_type = 'morning' and trading_date = :'today'::date;
select fx.eq(fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()::text$$)::jsonb ->> 'created', '1', 'pilot broadcast created');
select id as bp from public.market_report_broadcasts \gset
select fx.call_as(null, 'service_role', format($$select public.plan_market_report_broadcast(%L) ->> 'status'$$, :'bp')) as ignored \gset
select fx.eq((select planned_users::text from public.market_report_broadcasts where id = :'bp'), '2', 'only pilot users planned');
select count(*) as ignored from (select fx.claim(4)) as x \gset
select id as cp, lease_token as tp, lease_version as vp from public.market_report_broadcast_chunks where broadcast_id = :'bp' \gset
-- 分割のあとで一覧から1人外すと、送る直前に外れる。
update public.market_report_broadcast_settings set pilot_user_ids = array[fx.uid(10000)];
select fx.eq(fx.begin(:'cp', :'tp', :'vp'), '0000:ExponentPushToken[u10000-d1]', 'only the remaining pilot user is sent');
select fx.eq(fx.finish(:'cp', :'tp', :'vp', fx.all_as(:'cp', 'sent')), 'done', 'pilot chunk done');
update public.market_report_broadcast_settings set pilot_user_ids = null;
-- 古くなった一斉通知: 分割済みで、まだ送っていない区切りは送らずに failed、一斉通知は完了。
delete from public.market_report_broadcasts;
update public.market_report_cycles set report_completed_at = now() where report_type = 'morning' and trading_date = :'today'::date;
select fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()::text$$) as ignored \gset
select id as bs from public.market_report_broadcasts \gset
select fx.call_as(null, 'service_role', format($$select public.plan_market_report_broadcast(%L) ->> 'status'$$, :'bs')) as ignored \gset
update public.market_report_broadcasts set created_at = now() - interval '3 hours' where id = :'bs';
select fx.eq(fx.claim(4)::text, '0', 'stale broadcast is not sent');
select fx.eq((select string_agg(distinct status || ':' || last_error_code, ',') from public.market_report_broadcast_chunks where broadcast_id = :'bs'), 'failed:BROADCAST_STALE', 'stale chunks fail');
select fx.eq((select status from public.market_report_broadcasts where id = :'bs'), 'completed', 'stale broadcast completes');
select fx.eq((select count(*)::text from public.market_report_broadcast_deliveries where broadcast_id = :'bs'), '0', 'nobody was sent');

select 'MARKET_REPORT_BROADCAST_BEHAVIOR_PASS';
