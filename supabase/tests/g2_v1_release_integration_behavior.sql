-- かぶモリ V1（オンデマンド個別分析 PR143 + 共通朝刊・大引けの一斉通知 PR149）を、同じデータベースに両方入れた
-- 状態での端から端までの確認（使い捨ての手元の PostgreSQL 専用。合成の利用者だけ）。
-- 各機能の細かい確認は、それぞれの検証（personalized_ondemand_analysis_* と market_report_broadcast_*）にある。
-- ここでは、2つを合わせたときの流れと、互いに干渉しないことを確かめる。最後に G2_V1_INTEGRATION_BEHAVIOR_PASS を出す。
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

-- 利用者。p_push: null なら通知設定の行なし。p_holding: 保有を1件登録するか。
create function fx.user(n integer, p_push boolean, p_morning boolean, p_holding boolean, p_devices integer) returns uuid
language plpgsql as $$
declare
  v uuid := fx.uid(n);
  v_stock uuid;
begin
  insert into auth.users (id) values (v);
  insert into public.profiles (id) values (v);
  if p_push is not null then
    insert into public.alert_settings (user_id, push_enabled, morning_report, close_report) values (v, p_push, p_morning, true);
  end if;
  if p_holding then
    insert into public.stocks_master (ticker_code, company_name) values ('T' || n, '会社' || n) on conflict (ticker_code, market) do nothing;
    select id into v_stock from public.stocks_master where ticker_code = 'T' || n;
    insert into public.tracked_stocks (user_id, stock_id, tracking_type, quantity, average_price) values (v, v_stock, 'holding', 100, 1000);
  end if;
  insert into public.device_push_tokens (user_id, expo_push_token, platform)
    select v, 'ExponentPushToken[u' || n || '-d' || d || ']', 'ios' from generate_series(1, p_devices) as d;
  return v;
end
$$;

-- 共通の回（完成済み）。
create function fx.market(p_type text, p_date date, p_completed_ago interval) returns uuid
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
        'data_quality', jsonb_build_object('status', 'ok'), 'metrics', '[]'::jsonb), repeat('a', 64), 'ok')
    returning id into v_data;
  update public.market_report_cycles set current_data_packet_id = v_data, cycle_status = 'completed', completed_at = now() where id = v_cycle;
  insert into public.market_report_packets (cycle_id, data_packet_id, attempt, schema_version, report_type, trading_date, payload,
      content_hash, fact_status, model, generation_calls, input_tokens, output_tokens, api_cost_usd)
    values (v_cycle, v_data, 1, 'market_report_packet.v1', p_type, p_date,
      jsonb_build_object('schema_version', 'market_report_packet.v1', 'report_type', p_type, 'trading_date', to_char(p_date, 'YYYY-MM-DD'),
        'data_packet_id', v_data::text, 'headline_ja', '日経平均は反発', 'market_summary_ja', '要約', 'market_direction', 'up',
        'model', 'secret-model-name',
        'claims', '[{"claim_id":"c1","text_ja":"上昇","claim_type":"observation","evidence_refs":["m:x"],"scope":"today"}]'::jsonb,
        'fact', jsonb_build_object('ai_status', 'passed', 'local_issues', '["internal"]'::jsonb)),
      repeat('b', 64), 'passed', 'secret-model-name', 1, 1, 1, 0.5)
    returning id into v_report;
  update public.market_report_cycles
     set current_report_packet_id = v_report, report_status = 'completed', report_completed_at = now() - p_completed_ago
   where id = v_cycle;
  return v_report;
end
$$;

select (now() at time zone 'Asia/Tokyo')::date as today \gset

-- ---------------------------------------------------------------------------
-- 0. 利用者
--   A: 保有あり・通知 ON・朝刊 ON・端末2台   B: 保有なし・通知 ON・朝刊 ON・端末1台
--   C: 保有あり・通知 OFF                    D: 保有あり・朝刊 OFF
--   E: 保有あり・通知設定の行なし
-- ---------------------------------------------------------------------------
select fx.user(1, true, true, true, 2) as a \gset
select fx.user(2, true, true, false, 1) as b \gset
select fx.user(3, false, true, true, 1) as c \gset
select fx.user(4, true, false, true, 1) as d \gset
select fx.user(5, null, null, true, 1) as e \gset
select fx.market('morning', :'today', interval '1 minute') as pkt \gset

-- ---------------------------------------------------------------------------
-- 1. 既定はすべて OFF。旧来の定時の個別レポートはそのまま（オンデマンドの受付が OFF = 定時の生成は止まらない）
-- ---------------------------------------------------------------------------
select fx.eq((select public_market_feed_enabled::text || ondemand_requests_enabled::text from public.personalized_ondemand_settings), 'falsefalse', 'ondemand gates off');
select fx.eq((select enabled::text || sending_enabled::text from public.market_report_broadcast_settings), 'falsefalse', 'broadcast gates off');
select fx.eq(fx.call_as(:'a', 'authenticated', $$select public.request_personalized_analysis('latest', gen_random_uuid())->>'status'$$), 'disabled', 'request disabled');
select fx.eq(fx.call_as(:'a', 'authenticated', $$select public.get_app_market_report('morning')->>'status'$$), 'disabled', 'feed disabled');
select fx.eq(fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()->>'status'$$), 'disabled', 'broadcast disabled');
-- 一斉通知だけ ON にしても、共通の市況が非公開・定時の個別レポートが動いている間は作らない（二重の通知を防ぐ）。
update public.market_report_broadcast_settings set enabled = true, sending_enabled = true, chunk_size = 50;
select fx.eq(fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()->>'status'$$), 'feed_disabled', 'broadcast waits for the feed');
update public.personalized_ondemand_settings set public_market_feed_enabled = true;
select fx.eq(fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()->>'status'$$), 'legacy_personalized_active', 'broadcast waits for the legacy cutover');
select fx.eq((select count(*)::text from public.market_report_broadcasts), '0', 'nothing created yet');

-- ---------------------------------------------------------------------------
-- 2. 共通の市況: 保有が無い人も読める。匿名は読めない。内部の項目は出ない
-- ---------------------------------------------------------------------------
select fx.eq(fx.call_as(:'b', 'authenticated', $$select public.get_app_market_report('morning')->>'headline_ja'$$), '日経平均は反発', 'B (no holdings) reads the shared report');
select fx.like(fx.call_as(null, 'anon', $$select public.get_app_market_report('morning')::text$$), 'ERR:permission denied%', 'anon cannot read');
select fx.eq(position('secret' in fx.call_as(:'a', 'authenticated', $$select public.get_app_market_report('morning')::text$$))::text, '0', 'no model name leaks');
select fx.eq(position('internal' in fx.call_as(:'a', 'authenticated', $$select public.get_app_market_report('morning')::text$$))::text, '0', 'no fact internals leak');

-- ---------------------------------------------------------------------------
-- 3. オンデマンドを ON（= 定時の個別レポートは ONDEMAND_MODE で止まる側）。一斉通知が作られる
-- ---------------------------------------------------------------------------
update public.personalized_ondemand_settings set ondemand_requests_enabled = true;
select fx.eq(fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()->>'created'$$), '1', 'broadcast created');
select fx.eq(fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()->>'created'$$), '0', 'one per report and day');
select id as bm from public.market_report_broadcasts \gset
select fx.call_as(null, 'service_role', format($$select public.plan_market_report_broadcast(%L)->>'status'$$, :'bm')) as ignored \gset
select fx.eq((select planned_users::text from public.market_report_broadcasts where id = :'bm'), '2', 'A and B planned; C (push off), D (morning off), E (no settings) are not');

-- ---------------------------------------------------------------------------
-- 4. 一斉通知を送る（区切りの引き取り → 送る直前 → 送ったあと）。重要ニュースの通知の表は使わない
-- ---------------------------------------------------------------------------
select count(*) as notifications_before from public.notifications \gset
create temp table claimed (chunk_id uuid, lease_token uuid, lease_version bigint);
grant all on claimed to service_role;
select fx.call_as(null, 'service_role', $$with c as (insert into claimed select chunk_id, lease_token, lease_version from public.claim_market_report_broadcast_chunks(4) returning 1) select count(*)::text from c$$) as n \gset
select fx.eq(:'n', '1', 'one chunk');
select chunk_id as ch, lease_token as tk, lease_version as vr from claimed \gset
select fx.eq(fx.call_as(null, 'service_role', format($$select string_agg(expo_push_token, ',' order by expo_push_token) from public.begin_market_report_broadcast_chunk(%L, %L, %s)$$, :'ch', :'tk', :'vr')),
  'ExponentPushToken[u1-d1],ExponentPushToken[u1-d2],ExponentPushToken[u2-d1]', 'A gets both devices, B one; nobody else');
select fx.eq(fx.call_as(null, 'service_role', format($$select public.finish_market_report_broadcast_chunk(%L, %L, %s, %L)->>'status'$$, :'ch', :'tk', :'vr',
  jsonb_build_array(jsonb_build_object('user_id', :'a', 'outcome', 'sent'), jsonb_build_object('user_id', :'b', 'outcome', 'sent')))), 'done', 'chunk done');
select fx.eq((select status from public.market_report_broadcasts where id = :'bm'), 'completed', 'broadcast completed');
select fx.eq((select count(*)::text from public.notifications), :'notifications_before', 'broadcast never writes the notifications table (important news lane untouched)');

-- ---------------------------------------------------------------------------
-- 5. 個別分析: 押した人だけ。アプリを閉じても（セッションが無くても）サーバーで進み、本人だけが読める
-- ---------------------------------------------------------------------------
select fx.call_as(:'a', 'authenticated', $$select public.request_personalized_analysis('latest', '00000000-0000-4000-9000-000000000001')::text$$)::jsonb as ra \gset
select fx.eq((:'ra'::jsonb)->>'status', 'queued', 'A request queued');
select ((:'ra'::jsonb)->>'job_id') as ja \gset
select fx.eq(fx.call_as(:'a', 'authenticated', $$select public.request_personalized_analysis('latest', '00000000-0000-4000-9000-000000000001')->>'status'$$), 'replayed', 'double tap is the same job');
select fx.eq(fx.call_as(:'b', 'authenticated', $$select public.request_personalized_analysis('latest', gen_random_uuid())->>'status'$$), 'no_tracked_stocks', 'B (0 holdings) cannot request');
select fx.call_as(:'c', 'authenticated', $$select public.request_personalized_analysis('latest', gen_random_uuid())->>'job_id'$$) as jc \gset
-- ここで「アプリを閉じた」: 以降、A・C のセッションは無い。worker（service_role）だけが進める。
create temp table jobs (job_id uuid, user_id uuid, lease_token uuid, lease_version bigint);
grant all on jobs to service_role;
select fx.call_as(null, 'service_role', $$with c as (insert into jobs select job_id, user_id, lease_token, lease_version from public.claim_personalized_analysis_jobs(10) returning 1) select count(*)::text from c$$) as n \gset
select fx.eq(:'n', '2', 'worker claims A and C');
select lease_token as ta, lease_version as va from jobs where job_id = :'ja' \gset
select lease_token as tc, lease_version as vc from jobs where job_id = :'jc' \gset
select jsonb_build_object('title_ja', '保有銘柄の見通し', 'summary_ja', '要約', 'body', '{}'::jsonb, 'portfolio_snapshot', '{}'::jsonb,
  'source_basis', '{}'::jsonb, 'fact_status', 'passed', 'model_used', 'm', 'reference_report_packet_id', :'pkt',
  'report_type', 'morning', 'trading_date', :'today')::text as result \gset
select fx.eq(fx.call_as(null, 'service_role', format($$select public.complete_personalized_analysis_job(%L, %L, %s, %L)->>'status'$$, :'ja', :'ta', :'va', :'result')), 'completed', 'A completed');
select fx.eq(fx.call_as(null, 'service_role', format($$select public.complete_personalized_analysis_job(%L, %L, %s, %L)->>'status'$$, :'jc', :'tc', :'vc', :'result')), 'completed', 'C completed');
select fx.eq(fx.call_as(null, 'service_role', format($$select public.enqueue_personalized_analysis_notification(%L)->>'status'$$, :'ja')), 'queued', 'A completion push queued');
select fx.eq(fx.call_as(null, 'service_role', format($$select public.enqueue_personalized_analysis_notification(%L)->>'status'$$, :'jc')), 'skipped', 'C (push off) no push, result still kept');
select fx.eq((select count(*)::text from public.notifications where source_type = 'personalized_analysis'), '1', 'exactly one completion push');
select fx.eq((select user_id::text from public.notifications where source_type = 'personalized_analysis'), :'a', 'to the owner only');
-- 「アプリを開き直した」: 本人は自分の結果を読める。他人は読めない。
select fx.eq(fx.call_as(:'a', 'authenticated', format($$select title_ja from public.personalized_analysis_results where job_id = %L$$, :'ja')), '保有銘柄の見通し', 'A reads own result after reopening');
select fx.eq(fx.call_as(:'c', 'authenticated', format($$select title_ja from public.personalized_analysis_results where job_id = %L$$, :'jc')), '保有銘柄の見通し', 'C reads own result without a push');
select fx.eq(fx.call_as(:'b', 'authenticated', $$select count(*)::text from public.personalized_analysis_results$$), '0', 'B reads nobody else''s result');
select fx.eq(fx.call_as(:'c', 'authenticated', format($$select count(*)::text from public.personalized_analysis_jobs where id = %L$$, :'ja')), '0', 'C cannot see A''s job');
-- 2つの通知の経路は混ざらない: 完成の通知は notifications（既存の送信の worker）、一斉通知は専用の記録。
select fx.eq((select count(*)::text from public.market_report_broadcast_deliveries where user_id = :'a'), '1', 'A has one broadcast delivery');
select fx.eq((select count(*)::text from public.notifications where user_id = :'a' and source_type <> 'personalized_analysis'), '0', 'no other notification rows for A');

-- ---------------------------------------------------------------------------
-- 6. 古い回は知らせない（作られた一斉通知も、古くなったら送らない）。共通の市況は直近の回を日付つきで返す
-- ---------------------------------------------------------------------------
delete from public.market_report_broadcasts;
update public.market_report_cycles set report_completed_at = now() - interval '3 hours' where report_type = 'morning' and trading_date = :'today'::date;
select fx.eq(fx.call_as(null, 'service_role', $$select public.enqueue_market_report_broadcasts()->>'created'$$), '0', 'stale report is not broadcast');
select fx.eq(fx.call_as(:'b', 'authenticated', $$select public.get_app_market_report('morning')->>'is_today'$$), 'true', 'the feed still shows today''s report (dated)');

-- ---------------------------------------------------------------------------
-- 7. 退会: 本人のジョブ・結果・一斉通知の記録・完成の通知が消える。他人の分は残る
-- ---------------------------------------------------------------------------
select count(*) as others_before from public.personalized_analysis_results where user_id <> :'a' \gset
delete from public.profiles where id = :'a';
select fx.eq((select count(*)::text from public.personalized_analysis_jobs where user_id = :'a'), '0', 'A jobs removed');
select fx.eq((select count(*)::text from public.personalized_analysis_results where user_id = :'a'), '0', 'A results removed');
select fx.eq((select count(*)::text from public.notifications where user_id = :'a'), '0', 'A notifications removed');
select fx.eq((select count(*)::text from public.personalized_analysis_results where user_id <> :'a'), :'others_before', 'others kept');

select 'G2_V1_INTEGRATION_BEHAVIOR_PASS';
