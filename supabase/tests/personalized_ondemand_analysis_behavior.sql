-- 20261011150000_personalized_ondemand_analysis_v1 の動作の検証（使い捨ての手元の PostgreSQL 専用）。
-- テーブルの所有者として実行する。利用者・worker の操作は fx.call_as で、実際のロール（authenticated /
-- service_role / anon）と request.jwt.claim.sub に切り替えて呼ぶ。最後に PERSONALIZED_ONDEMAND_BEHAVIOR_PASS を出す。
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create schema fx;

-- 指定したロールと利用者で SQL を1つ実行し、結果の1つ目の値を文字列で返す。例外は 'ERR:<メッセージ>'。
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

-- 利用者（auth.users + profiles）と、任意で保有銘柄1件・通知設定。
create function fx.user(n integer, p_tracked boolean, p_push boolean) returns uuid
language plpgsql as $$
declare
  v uuid := fx.uid(n);
  v_stock uuid;
begin
  insert into auth.users (id) values (v);
  insert into public.profiles (id) values (v);
  if p_tracked then
    insert into public.stocks_master (ticker_code, company_name) values ('T' || n, '会社' || n)
      on conflict (ticker_code, market) do nothing;
    select id into v_stock from public.stocks_master where ticker_code = 'T' || n;
    insert into public.tracked_stocks (user_id, stock_id, tracking_type, quantity, average_price)
      values (v, v_stock, 'holding', 100, 1000);
  end if;
  if p_push is not null then
    insert into public.alert_settings (user_id, push_enabled) values (v, p_push);
  end if;
  return v;
end
$$;

create function fx.request(p_user uuid, p_scope text, p_client uuid, p_tier text default 'standard') returns text
language sql as $$
  select fx.call_as(p_user, 'authenticated',
    format('select public.request_personalized_analysis(%L, %L::uuid, %L)::text', p_scope, p_client, p_tier))
$$;

create function fx.result_ok(p_packet uuid, p_type text, p_date date) returns jsonb language sql as $$
  select jsonb_build_object('title_ja', '保有銘柄の見通し', 'summary_ja', '要約', 'body', '{"overview_ja":"本文"}'::jsonb,
    'portfolio_snapshot', '{"holdings":[]}'::jsonb, 'source_basis', '{"lane":"ondemand"}'::jsonb, 'fact_status', 'passed',
    'model_used', 'test-model', 'input_tokens', 10, 'output_tokens', 20, 'api_cost_usd', 0.001,
    'reference_report_packet_id', p_packet, 'reference_data_packet_id', null, 'report_type', p_type, 'trading_date', p_date)
$$;

-- 共通の朝刊・大引けの回を1つ作る（完成まで、または分析の途中まで）。
create function fx.market(p_type text, p_date date, p_completed boolean) returns uuid
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
        'data_packet_id', v_data::text, 'data_content_hash', repeat('a', 64), 'generated_at', '2026-10-09T23:05:00Z',
        'model', 'secret-model-name', 'market_direction', 'up', 'direction_basis', '["n225"]'::jsonb,
        'headline_ja', '見出し', 'market_summary_ja', '要約',
        'major_moves', '[{"metric_key":"nikkei225","label":"日経平均","session_date":"2026-10-09","value_display":"40,000","change_pct_display":"+1.0%","freshness":"fresh"}]'::jsonb,
        'claims', '[{"claim_id":"c1","text_ja":"上昇","claim_type":"observation","evidence_refs":["m:nikkei225"],"scope":"today"}]'::jsonb,
        'key_news', '[{"ref_id":"n:secret","headline_ja":"ニュース","why_it_matters_ja":"理由","scope":"japan"}]'::jsonb,
        'strong_themes', '[{"name_ja":"半導体","claim_ids":["c1"]}]'::jsonb, 'weak_themes', '[]'::jsonb,
        'next_watch_ja', '["注目"]'::jsonb, 'risks_ja', '["リスク"]'::jsonb, 'data_gaps_ja', '[]'::jsonb,
        'x_post', '{"lead_ja":"x","points_ja":["p1"],"closing_ja":"c"}'::jsonb,
        'fact', '{"local_issues":["internal"],"ai_status":"passed","generation_attempts":1}'::jsonb),
      repeat('b', 64), 'passed', 'secret-model-name', 1, 100, 200, 0.5)
    returning id into v_report;
  update public.market_report_cycles set current_report_packet_id = v_report, report_status = 'completed', report_completed_at = now()
   where id = v_cycle;
  return v_report;
end
$$;

-- ---------------------------------------------------------------------------
-- 0. 準備: 利用者 A（保有あり・通知 ON）、B（保有あり・通知 OFF）、C（保有なし）、E（設定の行なし）
-- ---------------------------------------------------------------------------
select fx.user(1, true, true) as a \gset
select fx.user(2, true, false) as b \gset
select fx.user(3, false, true) as c \gset
select fx.user(5, true, null) as e \gset
select (now() at time zone 'Asia/Tokyo')::date as today \gset

-- ---------------------------------------------------------------------------
-- 1. 既定はすべて OFF
-- ---------------------------------------------------------------------------
select fx.eq((select public_market_feed_enabled::text || ondemand_requests_enabled::text from public.personalized_ondemand_settings), 'falsefalse', 'defaults off');
select fx.eq(fx.request(:'a', 'latest', fx.uid(9001)), '{"status": "disabled"}', 'request disabled by default');
select fx.eq((select count(*)::text from public.personalized_analysis_jobs), '0', 'no job while disabled');
select fx.eq(fx.call_as(:'a', 'authenticated', $$select public.get_app_market_report('morning')::text$$), '{"status": "disabled"}', 'feed disabled by default');
select fx.eq(fx.call_as(null, 'service_role', $$select count(*)::text from public.claim_personalized_analysis_jobs(5)$$), '0', 'claim nothing while disabled');
select fx.eq(fx.call_as(:'a', 'authenticated', $$select public.get_personalized_analysis_status()::text$$), '{"enabled": false, "market_feed_enabled": false}', 'status disabled by default');

-- ---------------------------------------------------------------------------
-- 2. 権限: 匿名・他のロールからの呼び出しと、表への直接の書き込みを拒む
-- ---------------------------------------------------------------------------
select fx.like(fx.call_as(null, 'anon', $$select public.request_personalized_analysis('latest', gen_random_uuid())::text$$), 'ERR:permission denied%', 'anon request');
select fx.like(fx.call_as(null, 'anon', $$select public.get_app_market_report('morning')::text$$), 'ERR:permission denied%', 'anon feed');
select fx.like(fx.call_as(null, 'anon', $$select public.get_personalized_analysis_status()::text$$), 'ERR:permission denied%', 'anon status');
select fx.like(fx.call_as(null, 'service_role', $$select public.get_personalized_analysis_status()::text$$), 'ERR:permission denied%', 'service_role status');
select fx.like(fx.call_as(null, 'service_role', $$select public.request_personalized_analysis('latest', gen_random_uuid())::text$$), 'ERR:permission denied%', 'service_role cannot impersonate a user request');
select fx.like(fx.call_as(:'a', 'authenticated', $$select count(*)::text from public.claim_personalized_analysis_jobs(1)$$), 'ERR:permission denied%', 'user claim');
select fx.like(fx.call_as(:'a', 'authenticated', $$select public.complete_personalized_analysis_job(gen_random_uuid(), gen_random_uuid(), 1, '{}')::text$$), 'ERR:permission denied%', 'user complete');
select fx.like(fx.call_as(:'a', 'authenticated', $$select public.fail_personalized_analysis_job(gen_random_uuid(), gen_random_uuid(), 1, 'X', true)::text$$), 'ERR:permission denied%', 'user fail');
select fx.like(fx.call_as(:'a', 'authenticated', $$select public.enqueue_personalized_analysis_notification(gen_random_uuid())::text$$), 'ERR:permission denied%', 'user enqueue');
select fx.like(fx.call_as(:'a', 'authenticated', $$select public.mark_personalized_analysis_notification_failed(gen_random_uuid())::text$$), 'ERR:permission denied%', 'user mark failed');
select fx.like(fx.call_as(:'a', 'authenticated', $$select count(*)::text from public.personalized_ondemand_settings$$), 'ERR:permission denied%', 'user reads settings');
select fx.like(fx.call_as(:'a', 'authenticated', format($$insert into public.personalized_analysis_jobs (user_id, client_request_id, scope, request_date, max_attempts) values (%L, gen_random_uuid(), 'latest', current_date, 2) returning id::text$$, :'a')), 'ERR:permission denied%', 'user inserts job');
select fx.like(fx.call_as(:'a', 'authenticated', $$update public.personalized_analysis_jobs set status = 'completed' returning id::text$$), 'ERR:permission denied%', 'user updates job');
select fx.like(fx.call_as(:'a', 'authenticated', $$delete from public.personalized_analysis_results returning job_id::text$$), 'ERR:permission denied%', 'user deletes result');
select fx.like(fx.call_as(null, 'service_role', $$update public.personalized_ondemand_settings set ondemand_requests_enabled = true returning 'x'$$), 'ERR:permission denied%', 'service_role cannot flip gates');
select fx.like(fx.call_as(null, 'service_role', $$insert into public.personalized_analysis_results (job_id) values (gen_random_uuid()) returning 'x'$$), 'ERR:permission denied%', 'service_role writes results only via RPC');

-- ---------------------------------------------------------------------------
-- 3. 受付（ゲート ON）
-- ---------------------------------------------------------------------------
update public.personalized_ondemand_settings set ondemand_requests_enabled = true, public_market_feed_enabled = true;

select fx.like(fx.call_as(null, 'authenticated', $$select public.request_personalized_analysis('latest', gen_random_uuid())::text$$), 'ERR:PERSONALIZED_ANALYSIS_NOT_AUTHENTICATED%', 'no sub');
select fx.like(fx.request(:'a', 'weekly', fx.uid(9002)), 'ERR:PERSONALIZED_ANALYSIS_INVALID_ARGUMENT%', 'bad scope');
select fx.like(fx.call_as(:'a', 'authenticated', $$select public.request_personalized_analysis('latest', null)::text$$), 'ERR:PERSONALIZED_ANALYSIS_INVALID_ARGUMENT%', 'null client id');
select fx.like(fx.request(:'a', 'latest', fx.uid(9003), 'premium'), 'ERR:PERSONALIZED_ANALYSIS_MODEL_TIER_UNAVAILABLE%', 'premium tier refused');
select fx.like(fx.request(:'a', 'latest', fx.uid(9004), null), 'ERR:PERSONALIZED_ANALYSIS_MODEL_TIER_UNAVAILABLE%', 'null tier refused');
select fx.eq(fx.request(:'c', 'latest', fx.uid(9005)), '{"status": "no_tracked_stocks"}', 'no tracked stocks');
select fx.eq(fx.request(fx.uid(4), 'latest', fx.uid(9006)), '{"status": "profile_missing"}', 'no profile');
select fx.eq((select count(*)::text from public.personalized_analysis_jobs), '0', 'refusals create nothing');

select fx.request(:'a', 'morning', fx.uid(9100))::jsonb as a_req \gset
select fx.eq((:'a_req'::jsonb) ->> 'status', 'queued', 'a queued');
select ((:'a_req'::jsonb) ->> 'job_id') as a_job \gset
select fx.eq((:'a_req'::jsonb) ->> 'request_date', :'today', 'request_date is today in Tokyo');
-- 同じ依頼 ID の再送は同じジョブ。別の依頼 ID は「処理中のものがある」。
select fx.eq(fx.request(:'a', 'morning', fx.uid(9100))::jsonb ->> 'job_id', :'a_job', 'replay returns same job');
select fx.eq(fx.request(:'a', 'morning', fx.uid(9100))::jsonb ->> 'status', 'replayed', 'replay status');
select fx.eq(fx.request(:'a', 'close', fx.uid(9101))::jsonb ->> 'status', 'already_active', 'one active per user');
select fx.eq(fx.request(:'a', 'close', fx.uid(9101))::jsonb ->> 'job_id', :'a_job', 'already_active points to the active job');
select fx.eq((select count(*)::text from public.personalized_analysis_jobs where user_id = :'a'), '1', 'a has one job');
-- 他人の依頼 ID を使っても、他人のジョブは見えない（依頼 ID は利用者ごと）。
select fx.eq(fx.request(:'b', 'morning', fx.uid(9100))::jsonb ->> 'status', 'queued', 'same client id for another user is a new job');
select ((fx.request(:'b', 'morning', fx.uid(9100))::jsonb) ->> 'job_id') as b_job \gset
select fx.eq((:'b_job' <> :'a_job')::text, 'true', 'b job differs from a job');

-- ---------------------------------------------------------------------------
-- 4. RLS: 本人だけが自分のジョブを見る。貸し出しの token と版は見えない。
-- ---------------------------------------------------------------------------
select fx.eq(fx.call_as(:'a', 'authenticated', $$select string_agg(id::text, ',') from public.personalized_analysis_jobs$$), :'a_job', 'a sees only own job');
select fx.eq(fx.call_as(:'b', 'authenticated', format($$select count(*)::text from public.personalized_analysis_jobs where id = %L$$, :'a_job')), '0', 'b cannot see a job');
select fx.like(fx.call_as(:'a', 'authenticated', $$select lease_token::text from public.personalized_analysis_jobs limit 1$$), 'ERR:permission denied%', 'lease token hidden');
select fx.like(fx.call_as(:'a', 'authenticated', $$select user_id::text from public.personalized_analysis_jobs limit 1$$), 'ERR:permission denied%', 'user_id column hidden');
select fx.eq(fx.call_as(null, 'anon', $$select count(*)::text from public.personalized_analysis_jobs$$), 'ERR:permission denied for table personalized_analysis_jobs', 'anon cannot read jobs');

-- ---------------------------------------------------------------------------
-- 5. 引き取りと、貸し出しの token・版による排除
-- ---------------------------------------------------------------------------
create temp table claimed (job_id uuid, user_id uuid, attempt_count integer, lease_token uuid, lease_version bigint);
grant all on claimed to service_role;
select fx.call_as(null, 'service_role', $$with c as (insert into claimed select job_id, user_id, attempt_count, lease_token, lease_version from public.claim_personalized_analysis_jobs(10) returning 1) select count(*)::text from c$$) as n \gset
select fx.eq(:'n', '2', 'two queued jobs claimed');
select fx.eq((select string_agg(user_id::text, ',' order by user_id) from claimed), :'a' || ',' || :'b', 'FIFO: a then b');
select fx.eq(fx.call_as(null, 'service_role', $$select count(*)::text from public.claim_personalized_analysis_jobs(10)$$), '0', 'nothing left to claim');
select lease_token as a_tok, lease_version as a_ver from claimed where job_id = :'a_job' \gset
select fx.eq(:'a_ver', '1', 'first claim version 1');
select fx.eq(fx.call_as(:'a', 'authenticated', $$select status from public.personalized_analysis_jobs$$), 'processing', 'a sees processing');
-- 1人に1件の制約: 処理中でも新しい依頼は「処理中のものがある」。
select fx.eq(fx.request(:'a', 'latest', fx.uid(9102))::jsonb ->> 'status', 'already_active', 'active while processing');
select fx.call_as(:'a', 'authenticated', $$select public.get_personalized_analysis_status()::text$$)::jsonb as st \gset
select fx.eq((:'st'::jsonb) ->> 'enabled', 'true', 'status enabled');
select fx.eq((:'st'::jsonb) ->> 'market_feed_enabled', 'true', 'status shows feed gate');
select fx.eq((:'st'::jsonb) ->> 'active_job_id', :'a_job', 'status shows own active job');
select fx.eq((:'st'::jsonb) ->> 'active_status', 'processing', 'status shows processing');
select fx.eq((:'st'::jsonb) ->> 'used_today', '1', 'status counts own requests only');
select fx.eq(fx.call_as(:'c', 'authenticated', $$select (public.get_personalized_analysis_status() ->> 'active_job_id') is null$$), 'true', 'c sees no active job of others');
select fx.like(fx.call_as(null, 'authenticated', $$select public.get_personalized_analysis_status()::text$$), 'ERR:PERSONALIZED_ANALYSIS_NOT_AUTHENTICATED%', 'status needs a user');

select fx.market('morning', :'today', true) as pkt \gset
select fx.eq(fx.call_as(null, 'service_role', format($$select public.complete_personalized_analysis_job(%L, gen_random_uuid(), %s, %L)::text$$, :'a_job', :'a_ver', fx.result_ok(:'pkt', 'morning', :'today'))), '{"status": "lease_lost", "job_status": "processing"}', 'wrong token rejected');
select fx.eq(fx.call_as(null, 'service_role', format($$select public.complete_personalized_analysis_job(%L, %L, %s, %L)::text$$, :'a_job', :'a_tok', :'a_ver'::bigint + 1, fx.result_ok(:'pkt', 'morning', :'today'))), '{"status": "lease_lost", "job_status": "processing"}', 'wrong version rejected');
select fx.like(fx.call_as(null, 'service_role', format($$select public.complete_personalized_analysis_job(%L, %L, %s, %L)::text$$, :'a_job', :'a_tok', :'a_ver', fx.result_ok(:'pkt', 'morning', :'today') || '{"fact_status":"failed"}')), 'ERR:PERSONALIZED_ANALYSIS_RESULT_INVALID%', 'non-passed result refused');
select fx.like(fx.call_as(null, 'service_role', format($$select public.complete_personalized_analysis_job(%L, %L, %s, %L)::text$$, :'a_job', :'a_tok', :'a_ver', fx.result_ok(:'pkt', 'morning', (:'today'::date + 1)))), 'ERR:PERSONALIZED_ANALYSIS_RESULT_INVALID%', 'future basis date refused');
select fx.eq((select count(*)::text from public.personalized_analysis_results), '0', 'no result written by rejected completions');
select fx.eq((fx.call_as(null, 'service_role', format($$select public.complete_personalized_analysis_job(%L, %L, %s, %L)::text$$, :'a_job', :'a_tok', :'a_ver', fx.result_ok(:'pkt', 'morning', :'today')))::jsonb)::text, jsonb_build_object('status', 'completed', 'job_id', :'a_job')::text, 'correct lease completes');
select fx.eq(fx.call_as(null, 'service_role', format($$select public.complete_personalized_analysis_job(%L, %L, %s, %L)::text$$, :'a_job', :'a_tok', :'a_ver', fx.result_ok(:'pkt', 'morning', :'today'))), '{"status": "lease_lost", "job_status": "completed"}', 'second completion rejected');
select fx.eq(fx.call_as(null, 'service_role', format($$select public.fail_personalized_analysis_job(%L, %L, %s, 'LATE', true)::text$$, :'a_job', :'a_tok', :'a_ver')), '{"status": "lease_lost", "job_status": "completed"}', 'late failure cannot overwrite completed');
select fx.eq((select status || '/' || notify_status || '/' || (lease_token is null)::text from public.personalized_analysis_jobs where id = :'a_job'), 'completed/pending/true', 'a completed, notify pending, lease cleared');
select fx.eq((select count(*)::text from public.personalized_analysis_results where job_id = :'a_job'), '1', 'one result');

-- 結果は本人だけ。内部の列（出典の記録・費用）は見えない。
select fx.eq(fx.call_as(:'a', 'authenticated', $$select title_ja || '/' || report_type || '/' || trading_date from public.personalized_analysis_results$$), '保有銘柄の見通し/morning/' || :'today', 'a reads own result');
select fx.eq(fx.call_as(:'b', 'authenticated', $$select count(*)::text from public.personalized_analysis_results$$), '0', 'b cannot read a result');
select fx.like(fx.call_as(:'a', 'authenticated', $$select source_basis::text from public.personalized_analysis_results$$), 'ERR:permission denied%', 'source_basis hidden');
select fx.like(fx.call_as(:'a', 'authenticated', $$select api_cost_usd::text from public.personalized_analysis_results$$), 'ERR:permission denied%', 'cost hidden');

-- ---------------------------------------------------------------------------
-- 6. 期限切れの貸し出し: 引き取り直しで版が進み、元の worker の書き込みは効かない
-- ---------------------------------------------------------------------------
select lease_token as b_tok, lease_version as b_ver from claimed where job_id = :'b_job' \gset
update public.personalized_analysis_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = :'b_job';
-- 期限切れのあと、引き取り直す前でも、元の worker の完了は拒む。
select fx.eq(fx.call_as(null, 'service_role', format($$select public.complete_personalized_analysis_job(%L, %L, %s, %L)::text$$, :'b_job', :'b_tok', :'b_ver', fx.result_ok(:'pkt', 'morning', :'today'))), '{"status": "lease_lost", "job_status": "processing"}', 'expired lease cannot complete');
truncate claimed;
select fx.call_as(null, 'service_role', $$with c as (insert into claimed select job_id, user_id, attempt_count, lease_token, lease_version from public.claim_personalized_analysis_jobs(10) returning 1) select count(*)::text from c$$) as n \gset
select fx.eq(:'n', '1', 'expired job reclaimed');
select fx.eq((select attempt_count || '/' || lease_version from claimed), '2/3', 'attempt 2, version bumped twice (expire + claim)');
select fx.eq(fx.call_as(null, 'service_role', format($$select public.complete_personalized_analysis_job(%L, %L, %s, %L)::text$$, :'b_job', :'b_tok', :'b_ver', fx.result_ok(:'pkt', 'morning', :'today'))), '{"status": "lease_lost", "job_status": "processing"}', 'stale worker rejected after reclaim');
select fx.eq(fx.call_as(null, 'service_role', format($$select public.fail_personalized_analysis_job(%L, %L, %s, 'STALE', false)::text$$, :'b_job', :'b_tok', :'b_ver')), '{"status": "lease_lost", "job_status": "processing"}', 'stale worker failure rejected');
select lease_token as b_tok2, lease_version as b_ver2 from claimed \gset
-- 2回目も期限切れ → 回数を使い切って failed（もう引き取らない）。
update public.personalized_analysis_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = :'b_job';
select fx.eq(fx.call_as(null, 'service_role', $$select count(*)::text from public.claim_personalized_analysis_jobs(10)$$), '0', 'exhausted job not reclaimed');
select fx.eq((select status || '/' || error_code from public.personalized_analysis_jobs where id = :'b_job'), 'failed/LEASE_EXPIRED_ATTEMPTS_EXHAUSTED', 'exhausted lease fails');
select fx.eq(fx.call_as(null, 'service_role', format($$select public.complete_personalized_analysis_job(%L, %L, %s, %L)::text$$, :'b_job', :'b_tok2', :'b_ver2', fx.result_ok(:'pkt', 'morning', :'today'))), '{"status": "lease_lost", "job_status": "failed"}', 'late worker cannot resurrect failed job');
-- 失敗のあとは新しい依頼を受け付ける。
select fx.eq(fx.request(:'b', 'latest', fx.uid(9200))::jsonb ->> 'status', 'queued', 'b can request again after failure');
select ((fx.request(:'b', 'latest', fx.uid(9200))::jsonb) ->> 'job_id') as b_job2 \gset

-- ---------------------------------------------------------------------------
-- 7. 失敗の記録: 再試行できる失敗は待ち時間つきで待ち行列へ戻し、回数を使い切ると failed
-- ---------------------------------------------------------------------------
truncate claimed;
select fx.call_as(null, 'service_role', $$with c as (insert into claimed select job_id, user_id, attempt_count, lease_token, lease_version from public.claim_personalized_analysis_jobs(10) returning 1) select count(*)::text from c$$) as n \gset
select lease_token as t, lease_version as v from claimed where job_id = :'b_job2' \gset
select fx.eq(fx.call_as(null, 'service_role', format($$select public.fail_personalized_analysis_job(%L, %L, %s, 'MARKET_REPORT_NOT_READY', true)::text$$, :'b_job2', :'t', :'v')), '{"status": "requeued"}', 'retryable failure requeued');
select fx.eq((select status || '/' || (available_at > clock_timestamp())::text from public.personalized_analysis_jobs where id = :'b_job2'), 'queued/true', 'requeued with backoff');
select fx.eq(fx.call_as(null, 'service_role', $$select count(*)::text from public.claim_personalized_analysis_jobs(10)$$), '0', 'backoff respected');
update public.personalized_analysis_jobs set available_at = clock_timestamp() where id = :'b_job2';
truncate claimed;
select fx.call_as(null, 'service_role', $$with c as (insert into claimed select job_id, user_id, attempt_count, lease_token, lease_version from public.claim_personalized_analysis_jobs(10) returning 1) select count(*)::text from c$$) as n \gset
select lease_token as t, lease_version as v from claimed where job_id = :'b_job2' \gset
select fx.eq(fx.call_as(null, 'service_role', format($$select public.fail_personalized_analysis_job(%L, %L, %s, 'MARKET_REPORT_NOT_READY', true)::text$$, :'b_job2', :'t', :'v')), '{"status": "failed"}', 'retryable failure at max attempts fails');
select fx.eq(fx.call_as(:'b', 'authenticated', format($$select status || '/' || error_code from public.personalized_analysis_jobs where id = %L$$, :'b_job2')), 'failed/MARKET_REPORT_NOT_READY', 'b sees failure code');
select fx.eq((select count(*)::text from public.notifications where user_id = :'b'), '0', 'failure sends no notification');

-- 再試行しない失敗は1回目でも failed。
select ((fx.request(:'e', 'latest', fx.uid(9300))::jsonb) ->> 'job_id') as e_job \gset
truncate claimed;
select fx.call_as(null, 'service_role', $$with c as (insert into claimed select job_id, user_id, attempt_count, lease_token, lease_version from public.claim_personalized_analysis_jobs(10) returning 1) select count(*)::text from c$$) as n \gset
select lease_token as t, lease_version as v from claimed where job_id = :'e_job' \gset
select fx.eq(fx.call_as(null, 'service_role', format($$select public.fail_personalized_analysis_job(%L, %L, %s, 'REPORT_FACT_FAILED', false)::text$$, :'e_job', :'t', :'v')), '{"status": "failed"}', 'non-retryable fails at once');

-- ---------------------------------------------------------------------------
-- 8. 1日の上限（依頼した日で数える。失敗した分も数える）
-- ---------------------------------------------------------------------------
update public.personalized_ondemand_settings set daily_request_limit = 2;
select fx.eq(fx.request(:'b', 'latest', fx.uid(9400))::jsonb ->> 'status', 'daily_limit_reached', 'b reached 2 today');
select fx.eq(fx.request(:'b', 'latest', fx.uid(9200))::jsonb ->> 'status', 'replayed', 'replay still answers after the limit');
update public.personalized_ondemand_settings set daily_request_limit = 5;

-- ---------------------------------------------------------------------------
-- 9. 完成の通知: 1つのジョブに1件まで。通知 OFF・設定なしは予約しない。
-- ---------------------------------------------------------------------------
select fx.eq(fx.call_as(null, 'service_role', format($$select public.enqueue_personalized_analysis_notification(%L)::text$$, :'a_job')), '{"status": "queued"}', 'a notification queued');
select fx.eq(fx.call_as(null, 'service_role', format($$select public.enqueue_personalized_analysis_notification(%L)::text$$, :'a_job')), '{"status": "queued"}', 'second enqueue is a no-op');
select fx.eq((select count(*)::text from public.notifications where source_type = 'personalized_analysis' and source_id = :'a_job'), '1', 'exactly one notification');
select fx.eq((select user_id::text || '/' || push_status || '/' || title from public.notifications where source_id = :'a_job'), :'a' || '/pending/保有銘柄のAI分析ができました', 'notification to the owner only');
-- 印が消えたあとに再度呼ばれても（予約の記録の失敗を想定）、索引で重複しない。
update public.personalized_analysis_jobs set notify_status = 'failed' where id = :'a_job';
select fx.eq(fx.call_as(null, 'service_role', format($$select public.enqueue_personalized_analysis_notification(%L)::text$$, :'a_job')), '{"status": "already_queued"}', 'retry after lost bookkeeping does not duplicate');
select fx.eq((select count(*)::text from public.notifications where source_id = :'a_job'), '1', 'still one notification');
select fx.eq(fx.call_as(null, 'service_role', format($$select public.enqueue_personalized_analysis_notification(%L)::text$$, :'b_job2')), '{"status": "not_completed"}', 'failed job never notifies');
-- 通知 OFF の B と、設定の行が無い E は skipped。
select ((fx.request(:'e', 'latest', fx.uid(9500))::jsonb) ->> 'job_id') as e_job2 \gset
truncate claimed;
select fx.call_as(null, 'service_role', $$with c as (insert into claimed select job_id, user_id, attempt_count, lease_token, lease_version from public.claim_personalized_analysis_jobs(10) returning 1) select count(*)::text from c$$) as n \gset
select lease_token as t, lease_version as v from claimed where job_id = :'e_job2' \gset
select fx.call_as(null, 'service_role', format($$select public.complete_personalized_analysis_job(%L, %L, %s, %L)::text$$, :'e_job2', :'t', :'v', fx.result_ok(:'pkt', 'morning', :'today'))) as ignored \gset
select fx.eq(fx.call_as(null, 'service_role', format($$select public.enqueue_personalized_analysis_notification(%L)::text$$, :'e_job2')), '{"status": "skipped"}', 'no settings row: skipped');
select fx.eq((select count(*)::text from public.notifications where user_id = :'e'), '0', 'no notification for e');
select fx.call_as(null, 'service_role', format($$select public.mark_personalized_analysis_notification_failed(%L)::text$$, :'e_job2')) as ignored \gset
select fx.eq((select notify_status from public.personalized_analysis_jobs where id = :'e_job2'), 'skipped', 'mark failed does not touch skipped');

-- ---------------------------------------------------------------------------
-- 10. アプリ向けの共通朝刊・大引け（公開してよい項目だけ）
-- ---------------------------------------------------------------------------
select fx.call_as(:'a', 'authenticated', $$select public.get_app_market_report('morning')::text$$)::jsonb as feed \gset
select fx.eq((:'feed'::jsonb) ->> 'status', 'completed', 'feed completed');
select fx.eq((:'feed'::jsonb) ->> 'is_today', 'true', 'feed is today');
select fx.eq((:'feed'::jsonb) ->> 'headline_ja', '見出し', 'feed headline');
select fx.eq((:'feed'::jsonb) #>> '{claims,0,text_ja}', '上昇', 'feed claim text');
select fx.eq((:'feed'::jsonb) #>> '{strong_themes,0}', '半導体', 'feed theme');
-- 内部の項目は返さない（モデル名・根拠の ref・Fact の内部の指摘・費用）。
select fx.eq(position('secret' in :'feed')::text, '0', 'no model name or ref ids leak');
select fx.eq(position('evidence_refs' in :'feed')::text, '0', 'no evidence refs');
select fx.eq(position('internal' in :'feed')::text, '0', 'no fact internals');
select fx.eq(position('api_cost' in :'feed')::text, '0', 'no cost');
select fx.eq(fx.call_as(:'a', 'authenticated', $$select public.get_app_market_report('close')::text$$)::jsonb ->> 'status', 'missing', 'close missing');
select fx.market('close', :'today', false) as ignored \gset
select fx.eq(fx.call_as(:'a', 'authenticated', format($$select public.get_app_market_report('close', %L)::text$$, :'today'))::jsonb ->> 'status', 'not_ready', 'close not ready');
-- 日付の指定が無いときは、直近の完成した回（前日）を返し、今日ではないことを示す。
select fx.market('close', (:'today'::date - 1), true) as ignored \gset
select fx.eq(fx.call_as(:'a', 'authenticated', $$select (r ->> 'trading_date') || '/' || (r ->> 'is_today') from public.get_app_market_report('close') as r$$), ((:'today'::date - 1)::text) || '/false', 'latest completed close is yesterday');
select fx.like(fx.call_as(:'a', 'authenticated', format($$select public.get_app_market_report('close', %L)::text$$, (:'today'::date + 1))), 'ERR:APP_MARKET_REPORT_INVALID_ARGUMENT%', 'future date refused');
select fx.like(fx.call_as(:'a', 'authenticated', $$select public.get_app_market_report('weekly')::text$$), 'ERR:APP_MARKET_REPORT_INVALID_ARGUMENT%', 'bad type refused');
select fx.like(fx.call_as(null, 'authenticated', $$select public.get_app_market_report('morning')::text$$), 'ERR:APP_MARKET_REPORT_NOT_AUTHENTICATED%', 'feed needs a user');
-- 利用者は共通の表を直接は読めない（既存の権限のまま）。
select fx.like(fx.call_as(:'a', 'authenticated', $$select count(*)::text from public.market_report_packets$$), 'ERR:permission denied%', 'packets not directly readable');
update public.personalized_ondemand_settings set public_market_feed_enabled = false;
select fx.eq(fx.call_as(:'a', 'authenticated', $$select public.get_app_market_report('morning')::text$$), '{"status": "disabled"}', 'feed gate off again');
update public.personalized_ondemand_settings set public_market_feed_enabled = true;

-- ---------------------------------------------------------------------------
-- 11. 同時に動かせる数の上限
-- ---------------------------------------------------------------------------
update public.personalized_ondemand_settings set max_parallel_jobs = 2;
select count(fx.user(n, true, true)) as ignored from generate_series(11, 14) as n \gset
select count(fx.request(fx.uid(n), 'latest', fx.uid(9600 + n))) as ignored from generate_series(11, 14) as n \gset
select fx.eq(fx.call_as(null, 'service_role', $$select count(*)::text from public.claim_personalized_analysis_jobs(10)$$), '2', 'capacity 2');
select fx.eq(fx.call_as(null, 'service_role', $$select count(*)::text from public.claim_personalized_analysis_jobs(10)$$), '0', 'no slot while 2 running');
select fx.eq(fx.call_as(null, 'service_role', $$select count(*)::text from public.claim_personalized_analysis_jobs(0)$$), '0', 'limit 0 claims nothing');
update public.personalized_ondemand_settings set ondemand_requests_enabled = false;
select fx.eq(fx.call_as(null, 'service_role', $$select count(*)::text from public.claim_personalized_analysis_jobs(10)$$), '0', 'gate off stops claims');
update public.personalized_ondemand_settings set ondemand_requests_enabled = true, max_parallel_jobs = 4;
-- 後片付け（この節のジョブを終わらせる）
update public.personalized_analysis_jobs set status = 'failed', failed_at = now(), lease_token = null, lease_expires_at = null
 where status in ('queued', 'processing');

-- ---------------------------------------------------------------------------
-- 12. 公平さ: 100人・1000人が1件ずつ依頼 → 先着順に、全員がちょうど1回ずつ完成する
-- ---------------------------------------------------------------------------
create function fx.fairness(p_from integer, p_count integer) returns text
language plpgsql as $$
declare
  v_job record;
  v_rounds integer := 0;
  v_order uuid[] := '{}';
  v_expected uuid[];
  v_got integer;
  v_client uuid;
  v_result jsonb := fx.result_ok((select id from public.market_report_packets order by created_at limit 1), 'morning',
    (now() at time zone 'Asia/Tokyo')::date);
begin
  for i in p_from .. p_from + p_count - 1 loop
    perform fx.user(i, true, i % 3 <> 0);
    perform set_config('request.jwt.claim.sub', fx.uid(i)::text, true);
    v_client := fx.uid(500000 + i);
    set local role authenticated;
    perform public.request_personalized_analysis('latest', v_client, 'standard');
    reset role;
  end loop;
  perform set_config('request.jwt.claim.sub', '', true);
  select array_agg(id order by requested_at, id) into v_expected
    from public.personalized_analysis_jobs where user_id between fx.uid(p_from) and fx.uid(p_from + p_count - 1) and status = 'queued';
  if coalesce(array_length(v_expected, 1), 0) <> p_count then
    raise exception 'FAIL fairness: % queued, expected %', array_length(v_expected, 1), p_count;
  end if;
  loop
    v_rounds := v_rounds + 1;
    v_got := 0;
    set local role service_role;
    for v_job in select * from public.claim_personalized_analysis_jobs(4) loop
      v_got := v_got + 1;
      v_order := v_order || v_job.job_id;
      perform public.complete_personalized_analysis_job(v_job.job_id, v_job.lease_token, v_job.lease_version, v_result);
      perform public.enqueue_personalized_analysis_notification(v_job.job_id);
    end loop;
    reset role;
    exit when v_got = 0;
    if v_rounds > p_count then raise exception 'FAIL fairness: too many rounds'; end if;
  end loop;
  if v_order <> v_expected then
    raise exception 'FAIL fairness: claim order differs from request order';
  end if;
  if (select count(*) from public.personalized_analysis_results r join public.personalized_analysis_jobs j on j.id = r.job_id
       where j.user_id between fx.uid(p_from) and fx.uid(p_from + p_count - 1)) <> p_count then
    raise exception 'FAIL fairness: results';
  end if;
  if (select count(distinct user_id) from public.personalized_analysis_results
       where user_id between fx.uid(p_from) and fx.uid(p_from + p_count - 1)) <> p_count then
    raise exception 'FAIL fairness: a user got two results';
  end if;
  -- 通知は通知 ON の人にだけ、1人1件。
  if (select count(*) from public.notifications where source_type = 'personalized_analysis'
       and user_id between fx.uid(p_from) and fx.uid(p_from + p_count - 1))
     <> (select count(*) from generate_series(p_from, p_from + p_count - 1) as i where i % 3 <> 0) then
    raise exception 'FAIL fairness: notifications';
  end if;
  return p_count || ' users, ' || (v_rounds - 1) || ' rounds';
end
$$;
select fx.eq(fx.fairness(100000, 100), '100 users, 25 rounds', 'fairness 100');
select fx.eq(fx.fairness(200000, 1000), '1000 users, 250 rounds', 'fairness 1000');

-- ---------------------------------------------------------------------------
-- 13. 利用者の削除で、本人のジョブ・結果も消える（他人の行は残る）
-- ---------------------------------------------------------------------------
select count(*) as before_other from public.personalized_analysis_jobs where user_id <> :'a' \gset
delete from public.profiles where id = :'a';
select fx.eq((select count(*)::text from public.personalized_analysis_jobs where user_id = :'a'), '0', 'a jobs cascade');
select fx.eq((select count(*)::text from public.personalized_analysis_results where user_id = :'a'), '0', 'a results cascade');
select fx.eq((select count(*)::text from public.personalized_analysis_jobs where user_id <> :'a'), :'before_other', 'others untouched');

select 'PERSONALIZED_ONDEMAND_BEHAVIOR_PASS';
