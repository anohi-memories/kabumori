-- オンデマンド個別AI分析 V1（2026-10-11、G2）— 未適用のソース候補。本番には別承認まで適用しない。
--
-- 何をするか
--   1. 機能のゲート（すべて既定で OFF）: アプリ向けの共通朝刊・大引け、オンデマンド分析の受付。
--   2. 利用者が押したときだけ作るジョブ（personalized_analysis_jobs）。1人に同時に1件まで。同じ依頼 ID の
--      再送は同じジョブを返す（二重タップ・2台の端末・再送）。
--   3. サーバーの worker だけが、期限付きの貸し出し（lease）でジョブを引き取る。完了・失敗の書き込みは、
--      貸し出しの token と版（lease_version）が一致し、期限内のときだけ効く（遅れて終わった worker の書き込みを拒む）。
--   4. 完成した結果（personalized_analysis_results）は本人だけが読める。完成後の通知は1件だけ予約する。
--   5. アプリが読める共通朝刊・大引け（get_app_market_report）は、公開してよい項目だけを返す。
-- 何をしないか
--   既存の表・関数・権限を変えない（通知の表に部分ユニーク索引を1つ足すだけ）。旧来の定時の個別レポート
--   （personalized_reports と personalized-reports の Cron）には触れない。課金・回数の引き落としは無い。

begin;

do $$
begin
  if to_regclass('public.personalized_analysis_jobs') is not null then
    raise exception 'PERSONALIZED_ONDEMAND_ALREADY_APPLIED';
  end if;
  if to_regclass('public.notifications') is null or to_regclass('public.tracked_stocks') is null
     or to_regclass('public.profiles') is null or to_regclass('public.alert_settings') is null
     or to_regclass('public.market_report_cycles') is null or to_regclass('public.market_report_packets') is null
     or to_regclass('public.market_data_packets') is null then
    raise exception 'PERSONALIZED_ONDEMAND_PREFLIGHT_FOUNDATION_MISSING';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. ゲートと上限（1行だけ）
-- ---------------------------------------------------------------------------

create table public.personalized_ondemand_settings (
  id boolean primary key default true check (id),
  public_market_feed_enabled boolean not null default false,
  ondemand_requests_enabled boolean not null default false,
  daily_request_limit integer not null default 5 check (daily_request_limit between 0 and 100),
  max_parallel_jobs integer not null default 4 check (max_parallel_jobs between 1 and 50),
  -- worker は、残りが 200 秒より短い貸し出しでは AI を呼ばない（MIN_LEASE_REMAINING_MS）。
  lease_seconds integer not null default 300 check (lease_seconds between 240 and 3600),
  max_attempts integer not null default 2 check (max_attempts between 1 and 5),
  updated_at timestamptz not null default now()
);
insert into public.personalized_ondemand_settings (id) values (true);

comment on table public.personalized_ondemand_settings is
  'オンデマンド個別AI分析とアプリ向け共通朝刊・大引けのゲート。既定はすべて OFF。変更は所有者の SQL だけ（API ロールに書き込み権限なし）。';

-- ---------------------------------------------------------------------------
-- 2. ジョブ
-- ---------------------------------------------------------------------------

create table public.personalized_analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  client_request_id uuid not null,
  scope text not null check (scope in ('morning', 'close', 'latest')),
  -- 依頼した日（東京時間）。1日の上限の数え方に使う。どの日の朝刊・大引けを基準にするかは worker が決め、結果に残す。
  request_date date not null,
  model_tier text not null default 'standard' check (model_tier in ('standard')),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null check (max_attempts between 1 and 5),
  lease_token uuid,
  lease_version bigint not null default 0,
  lease_expires_at timestamptz,
  available_at timestamptz not null default now(),
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  error_code text check (error_code is null or char_length(error_code) <= 120),
  reference_report_packet_id uuid,
  reference_data_packet_id uuid,
  notify_status text not null default 'not_required'
    check (notify_status in ('not_required', 'pending', 'queued', 'skipped', 'failed')),
  notify_attempt_count integer not null default 0 check (notify_attempt_count >= 0),
  updated_at timestamptz not null default now(),
  constraint personalized_analysis_jobs_request_once unique (user_id, client_request_id),
  constraint personalized_analysis_jobs_lease_shape check (
    (status = 'processing') = (lease_token is not null and lease_expires_at is not null)
  ),
  constraint personalized_analysis_jobs_attempts check (attempt_count <= max_attempts),
  constraint personalized_analysis_jobs_completed_shape check (
    status <> 'completed' or (completed_at is not null and reference_report_packet_id is not null)
  )
);

-- 1人に同時に1件まで（二重タップ・2台の端末）。
create unique index personalized_analysis_jobs_one_active
  on public.personalized_analysis_jobs (user_id) where status in ('queued', 'processing');
create index personalized_analysis_jobs_queue
  on public.personalized_analysis_jobs (available_at, requested_at, id) where status = 'queued';
create index personalized_analysis_jobs_leases
  on public.personalized_analysis_jobs (lease_expires_at) where status = 'processing';
create index personalized_analysis_jobs_user_recent
  on public.personalized_analysis_jobs (user_id, requested_at desc);
create index personalized_analysis_jobs_notify
  on public.personalized_analysis_jobs (completed_at) where status = 'completed' and notify_status in ('pending', 'failed');

-- ---------------------------------------------------------------------------
-- 3. 結果（本人だけが読める）
-- ---------------------------------------------------------------------------

create table public.personalized_analysis_results (
  job_id uuid primary key references public.personalized_analysis_jobs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  report_type text not null check (report_type in ('morning', 'close')),
  trading_date date not null,
  title_ja text not null check (char_length(btrim(title_ja)) > 0),
  summary_ja text not null,
  body jsonb not null,
  portfolio_snapshot jsonb not null,
  source_basis jsonb not null,
  fact_status text not null check (fact_status = 'passed'),
  model_used text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  api_cost_usd numeric(12, 6) not null default 0,
  generated_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index personalized_analysis_results_user on public.personalized_analysis_results (user_id, generated_at desc);

-- 通知は1つのジョブに1件まで（既存の通知の表に、部分ユニーク索引を足すだけ）。
create unique index notifications_personalized_analysis_once
  on public.notifications (user_id, source_type, source_id) where source_type = 'personalized_analysis';

-- ---------------------------------------------------------------------------
-- 4. 利用者の依頼（認証済みの本人だけ）
-- ---------------------------------------------------------------------------

create function public.request_personalized_analysis(
  p_scope text,
  p_client_request_id uuid,
  p_model_tier text default 'standard'
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_settings public.personalized_ondemand_settings%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_tokyo timestamp := v_now at time zone 'Asia/Tokyo';
  v_date date := v_tokyo::date;
  v_existing public.personalized_analysis_jobs%rowtype;
  v_today integer;
  v_job uuid;
begin
  if v_user is null then
    raise exception 'PERSONALIZED_ANALYSIS_NOT_AUTHENTICATED' using errcode = '28000';
  end if;
  if p_scope is null or p_scope not in ('morning', 'close', 'latest') or p_client_request_id is null then
    raise exception 'PERSONALIZED_ANALYSIS_INVALID_ARGUMENT' using errcode = '22023';
  end if;
  -- V1 で選べるのは通常分析だけ（上位分析は共通の AI 基盤での確認まで受け付けない）。
  if p_model_tier is distinct from 'standard' then
    raise exception 'PERSONALIZED_ANALYSIS_MODEL_TIER_UNAVAILABLE' using errcode = '22023';
  end if;

  select * into v_settings from public.personalized_ondemand_settings where id;
  if not found or not v_settings.ondemand_requests_enabled then
    return jsonb_build_object('status', 'disabled');
  end if;

  -- 同じ利用者の依頼は1つずつ処理する（同時の二重タップ・2台の端末）。
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personalized_analysis:' || v_user::text, 0));

  select * into v_existing from public.personalized_analysis_jobs
   where user_id = v_user and client_request_id = p_client_request_id;
  if found then
    return jsonb_build_object('status', 'replayed', 'job_id', v_existing.id, 'job_status', v_existing.status);
  end if;

  select * into v_existing from public.personalized_analysis_jobs
   where user_id = v_user and status in ('queued', 'processing');
  if found then
    return jsonb_build_object('status', 'already_active', 'job_id', v_existing.id, 'job_status', v_existing.status);
  end if;

  if not exists (select 1 from public.profiles where id = v_user) then
    return jsonb_build_object('status', 'profile_missing');
  end if;
  if not exists (select 1 from public.tracked_stocks where user_id = v_user and is_active) then
    return jsonb_build_object('status', 'no_tracked_stocks');
  end if;

  select count(*) into v_today from public.personalized_analysis_jobs
   where user_id = v_user and request_date = v_date;
  if v_today >= v_settings.daily_request_limit then
    return jsonb_build_object('status', 'daily_limit_reached', 'limit', v_settings.daily_request_limit);
  end if;

  insert into public.personalized_analysis_jobs
    (user_id, client_request_id, scope, request_date, model_tier, max_attempts, requested_at, available_at, updated_at)
  values
    (v_user, p_client_request_id, p_scope, v_date, 'standard', v_settings.max_attempts, v_now, v_now, v_now)
  returning id into v_job;

  return jsonb_build_object('status', 'queued', 'job_id', v_job, 'request_date', v_date);
end
$$;

-- アプリの表示用: 受付中か、アプリ向けの共通朝刊・大引けが公開中か、今日の残りの回数、処理中のジョブ
-- （本人の分だけ。書き込みはしない）。
create function public.get_personalized_analysis_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_settings public.personalized_ondemand_settings%rowtype;
  v_date date := (pg_catalog.clock_timestamp() at time zone 'Asia/Tokyo')::date;
  v_active public.personalized_analysis_jobs%rowtype;
  v_used integer;
begin
  if v_user is null then
    raise exception 'PERSONALIZED_ANALYSIS_NOT_AUTHENTICATED' using errcode = '28000';
  end if;
  select * into v_settings from public.personalized_ondemand_settings where id;
  if not found then
    return jsonb_build_object('enabled', false, 'market_feed_enabled', false);
  end if;
  if not v_settings.ondemand_requests_enabled then
    return jsonb_build_object('enabled', false, 'market_feed_enabled', v_settings.public_market_feed_enabled);
  end if;
  select count(*) into v_used from public.personalized_analysis_jobs where user_id = v_user and request_date = v_date;
  select * into v_active from public.personalized_analysis_jobs where user_id = v_user and status in ('queued', 'processing');
  return jsonb_build_object(
    'enabled', true,
    'market_feed_enabled', v_settings.public_market_feed_enabled,
    'daily_limit', v_settings.daily_request_limit,
    'used_today', v_used,
    'active_job_id', v_active.id,
    'active_status', v_active.status,
    'model_tiers', jsonb_build_array('standard')
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 5. アプリが読む共通朝刊・大引け（公開してよい項目だけ）
-- ---------------------------------------------------------------------------

create function public.get_app_market_report(p_report_type text, p_trading_date date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (pg_catalog.clock_timestamp() at time zone 'Asia/Tokyo')::date;
  v_cycle public.market_report_cycles%rowtype;
  v_report public.market_report_packets%rowtype;
  v_payload jsonb;
begin
  if auth.uid() is null then
    raise exception 'APP_MARKET_REPORT_NOT_AUTHENTICATED' using errcode = '28000';
  end if;
  if p_report_type is null or p_report_type not in ('morning', 'close')
     or p_trading_date > v_today or p_trading_date < v_today - 31 then
    raise exception 'APP_MARKET_REPORT_INVALID_ARGUMENT' using errcode = '22023';
  end if;
  if not coalesce((select public_market_feed_enabled from public.personalized_ondemand_settings where id), false) then
    return jsonb_build_object('status', 'disabled');
  end if;

  if p_trading_date is null then
    -- 日付の指定が無いときは、直近7日以内で最新の完成した回（週末・休日でも直近の回を見せる）。
    select * into v_cycle from public.market_report_cycles
     where report_type = p_report_type and trading_date between v_today - 7 and v_today
       and report_status = 'completed' and current_report_packet_id is not null
     order by trading_date desc limit 1;
    if not found then
      return jsonb_build_object('status', 'missing', 'report_type', p_report_type, 'today', v_today);
    end if;
  else
    select * into v_cycle from public.market_report_cycles where report_type = p_report_type and trading_date = p_trading_date;
    if not found then
      return jsonb_build_object('status', 'missing', 'report_type', p_report_type, 'trading_date', p_trading_date, 'today', v_today);
    end if;
    if v_cycle.report_status <> 'completed' or v_cycle.current_report_packet_id is null then
      return jsonb_build_object('status', 'not_ready', 'report_type', p_report_type, 'trading_date', p_trading_date, 'today', v_today);
    end if;
  end if;
  select * into v_report from public.market_report_packets where id = v_cycle.current_report_packet_id;
  v_payload := v_report.payload;

  -- 公開する項目だけを組み立てる（claims の根拠 ref、生成の記録、費用、モデル、元のデータパケットは返さない）。
  return jsonb_build_object(
    'status', 'completed',
    'report_type', p_report_type,
    'trading_date', v_cycle.trading_date,
    'today', v_today,
    'is_today', v_cycle.trading_date = v_today,
    'report_packet_id', v_report.id,
    'generated_at', v_payload -> 'generated_at',
    'claims', coalesce((
      select jsonb_agg(jsonb_build_object('text_ja', c -> 'text_ja', 'claim_type', c -> 'claim_type', 'scope', c -> 'scope'))
      from jsonb_array_elements(coalesce(v_payload -> 'claims', '[]'::jsonb)) as c), '[]'::jsonb),
    'headline_ja', v_payload -> 'headline_ja',
    'market_summary_ja', v_payload -> 'market_summary_ja',
    'market_direction', v_payload -> 'market_direction',
    'major_moves', coalesce((
      select jsonb_agg(jsonb_build_object(
        'label', m -> 'label', 'value_display', m -> 'value_display', 'change_pct_display', m -> 'change_pct_display',
        'session_date', m -> 'session_date', 'freshness', m -> 'freshness'))
      from jsonb_array_elements(coalesce(v_payload -> 'major_moves', '[]'::jsonb)) as m), '[]'::jsonb),
    'key_news', coalesce((
      select jsonb_agg(jsonb_build_object(
        'headline_ja', k -> 'headline_ja', 'why_it_matters_ja', k -> 'why_it_matters_ja', 'scope', k -> 'scope'))
      from jsonb_array_elements(coalesce(v_payload -> 'key_news', '[]'::jsonb)) as k), '[]'::jsonb),
    'strong_themes', coalesce((
      select jsonb_agg(t -> 'name_ja') from jsonb_array_elements(coalesce(v_payload -> 'strong_themes', '[]'::jsonb)) as t), '[]'::jsonb),
    'weak_themes', coalesce((
      select jsonb_agg(t -> 'name_ja') from jsonb_array_elements(coalesce(v_payload -> 'weak_themes', '[]'::jsonb)) as t), '[]'::jsonb),
    'next_watch_ja', coalesce(v_payload -> 'next_watch_ja', '[]'::jsonb),
    'risks_ja', coalesce(v_payload -> 'risks_ja', '[]'::jsonb),
    'data_gaps_ja', coalesce(v_payload -> 'data_gaps_ja', '[]'::jsonb),
    'points_ja', coalesce(v_payload #> '{x_post,points_ja}', '[]'::jsonb),
    'fact_status', coalesce(v_payload #>> '{fact,ai_status}', 'passed')
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 6. worker の操作（service_role だけ）
-- ---------------------------------------------------------------------------

create function public.claim_personalized_analysis_jobs(p_limit integer)
returns table (
  job_id uuid, user_id uuid, scope text, request_date date, model_tier text,
  attempt_count integer, max_attempts integer, lease_token uuid, lease_version bigint, lease_expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_settings public.personalized_ondemand_settings%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_running integer;
  v_slots integer;
begin
  select * into v_settings from public.personalized_ondemand_settings where id;
  if not found or not v_settings.ondemand_requests_enabled then
    return;
  end if;
  -- 引き取りは1つずつ（同時に呼ばれても、処理中の件数を数え違えて上限を超えない）。
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personalized_analysis:claim', 0));

  -- 期限切れの貸し出し: 版を進めて元の worker の書き込みを無効にし、回数が残っていれば待ち行列へ戻す。
  update public.personalized_analysis_jobs as j
     set status = case when j.attempt_count >= j.max_attempts then 'failed' else 'queued' end,
         failed_at = case when j.attempt_count >= j.max_attempts then v_now else null end,
         error_code = case when j.attempt_count >= j.max_attempts then 'LEASE_EXPIRED_ATTEMPTS_EXHAUSTED' else 'LEASE_EXPIRED' end,
         lease_token = null, lease_expires_at = null, lease_version = j.lease_version + 1,
         available_at = v_now, updated_at = v_now
   where j.status = 'processing' and j.lease_expires_at < v_now;

  select count(*) into v_running from public.personalized_analysis_jobs where status = 'processing';
  v_slots := least(greatest(coalesce(p_limit, 1), 0), 20, greatest(v_settings.max_parallel_jobs - v_running, 0));
  if v_slots = 0 then
    return;
  end if;

  -- 依頼の古い順（先着）。1人に同時に1件までなので、特定の利用者が枠を占めることはない。
  return query
  with candidates as materialized (
    select q.id
      from public.personalized_analysis_jobs as q
     where q.status = 'queued' and q.available_at <= v_now
     order by q.requested_at, q.id
     limit v_slots
     for update skip locked
  ), claimed as (
    update public.personalized_analysis_jobs as j
       set status = 'processing',
           attempt_count = j.attempt_count + 1,
           lease_token = pg_catalog.gen_random_uuid(),
           lease_version = j.lease_version + 1,
           lease_expires_at = v_now + pg_catalog.make_interval(secs => v_settings.lease_seconds),
           started_at = coalesce(j.started_at, v_now),
           error_code = null,
           updated_at = v_now
      from candidates as c
     where j.id = c.id and j.status = 'queued'
    returning j.id, j.user_id, j.scope, j.request_date, j.model_tier,
              j.attempt_count, j.max_attempts, j.lease_token, j.lease_version, j.lease_expires_at
  )
  select * from claimed;
end
$$;

create function public.complete_personalized_analysis_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_version bigint,
  p_result jsonb
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_job public.personalized_analysis_jobs%rowtype;
begin
  select * into v_job from public.personalized_analysis_jobs where id = p_job_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  -- 貸し出しの token・版・期限がすべて一致するときだけ（遅れて終わった worker の結果は捨てる）。
  if v_job.status <> 'processing' or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_version <> p_lease_version or v_job.lease_expires_at < v_now then
    return jsonb_build_object('status', 'lease_lost', 'job_status', v_job.status);
  end if;
  if p_result is null or nullif(btrim(p_result ->> 'title_ja'), '') is null or p_result ->> 'fact_status' is distinct from 'passed'
     or nullif(p_result ->> 'reference_report_packet_id', '') is null
     or coalesce(p_result ->> 'report_type', '') not in ('morning', 'close')
     or coalesce(p_result ->> 'trading_date', '') !~ '^\d{4}-\d{2}-\d{2}$'
     or (p_result ->> 'trading_date')::date > v_job.request_date then
    raise exception 'PERSONALIZED_ANALYSIS_RESULT_INVALID' using errcode = '22023';
  end if;

  insert into public.personalized_analysis_results
    (job_id, user_id, report_type, trading_date, title_ja, summary_ja, body, portfolio_snapshot, source_basis, fact_status,
     model_used, input_tokens, output_tokens, api_cost_usd, generated_at)
  values
    (v_job.id, v_job.user_id, p_result ->> 'report_type', (p_result ->> 'trading_date')::date, p_result ->> 'title_ja', coalesce(p_result ->> 'summary_ja', ''),
     coalesce(p_result -> 'body', '{}'::jsonb), coalesce(p_result -> 'portfolio_snapshot', '{}'::jsonb),
     coalesce(p_result -> 'source_basis', '{}'::jsonb), 'passed', coalesce(p_result ->> 'model_used', 'unknown'),
     coalesce((p_result ->> 'input_tokens')::integer, 0), coalesce((p_result ->> 'output_tokens')::integer, 0),
     coalesce((p_result ->> 'api_cost_usd')::numeric, 0), v_now);

  update public.personalized_analysis_jobs
     set status = 'completed', completed_at = v_now, lease_token = null, lease_expires_at = null,
         lease_version = lease_version + 1, error_code = null,
         reference_report_packet_id = (p_result ->> 'reference_report_packet_id')::uuid,
         reference_data_packet_id = nullif(p_result ->> 'reference_data_packet_id', '')::uuid,
         notify_status = 'pending', updated_at = v_now
   where id = v_job.id;
  return jsonb_build_object('status', 'completed', 'job_id', v_job.id);
end
$$;

create function public.fail_personalized_analysis_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_version bigint,
  p_error_code text,
  p_retryable boolean
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_job public.personalized_analysis_jobs%rowtype;
  v_final boolean;
begin
  select * into v_job from public.personalized_analysis_jobs where id = p_job_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_job.status <> 'processing' or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_version <> p_lease_version then
    return jsonb_build_object('status', 'lease_lost', 'job_status', v_job.status);
  end if;
  v_final := not coalesce(p_retryable, false) or v_job.attempt_count >= v_job.max_attempts;
  update public.personalized_analysis_jobs
     set status = case when v_final then 'failed' else 'queued' end,
         failed_at = case when v_final then v_now else null end,
         error_code = left(coalesce(nullif(p_error_code, ''), 'UNKNOWN'), 120),
         lease_token = null, lease_expires_at = null, lease_version = lease_version + 1,
         available_at = v_now + pg_catalog.make_interval(secs => 60 * v_job.attempt_count),
         updated_at = v_now
   where id = v_job.id;
  return jsonb_build_object('status', case when v_final then 'failed' else 'requeued' end);
end
$$;

-- 完成後の通知: 1つのジョブに1件まで（部分ユニーク索引）。プッシュ通知がオフ・設定が無い利用者は予約しない
-- （結果はアプリで読める）。送信は既存の送信の worker の仕事で、ここでは送らない。
create function public.enqueue_personalized_analysis_notification(p_job_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_job public.personalized_analysis_jobs%rowtype;
  v_title text;
  v_push boolean;
  v_inserted uuid;
begin
  select * into v_job from public.personalized_analysis_jobs where id = p_job_id for update;
  if not found or v_job.status <> 'completed' then
    return jsonb_build_object('status', 'not_completed');
  end if;
  if v_job.notify_status in ('queued', 'skipped') then
    return jsonb_build_object('status', v_job.notify_status);
  end if;
  select coalesce(s.push_enabled, false) into v_push from public.alert_settings as s where s.user_id = v_job.user_id;
  if not coalesce(v_push, false) then
    update public.personalized_analysis_jobs
       set notify_status = 'skipped', notify_attempt_count = notify_attempt_count + 1, updated_at = v_now
     where id = v_job.id;
    return jsonb_build_object('status', 'skipped');
  end if;
  select r.title_ja into v_title from public.personalized_analysis_results as r where r.job_id = v_job.id;

  insert into public.notifications as target
    (user_id, tracked_stock_id, source_type, source_id, title, summary, importance, push_status)
  values
    (v_job.user_id, null, 'personalized_analysis', v_job.id::text, '保有銘柄のAI分析ができました',
     case when char_length(v_title) > 140 then left(v_title, 139) || '…' else v_title end, 'normal', 'pending')
  on conflict (user_id, source_type, source_id) where source_type = 'personalized_analysis' do nothing
  returning target.id into v_inserted;

  update public.personalized_analysis_jobs
     set notify_status = 'queued', notify_attempt_count = notify_attempt_count + 1, updated_at = v_now
   where id = v_job.id;
  return jsonb_build_object('status', case when v_inserted is null then 'already_queued' else 'queued' end);
end
$$;

-- 予約が例外で失敗したときの記録（関数の中の変更は巻き戻るので、呼び出し側が別に記録する）。
create function public.mark_personalized_analysis_notification_failed(p_job_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.personalized_analysis_jobs
     set notify_status = 'failed', notify_attempt_count = notify_attempt_count + 1, updated_at = pg_catalog.clock_timestamp()
   where id = p_job_id and status = 'completed' and notify_status in ('pending', 'failed');
$$;

-- ---------------------------------------------------------------------------
-- 7. RLS と権限
-- ---------------------------------------------------------------------------

alter table public.personalized_ondemand_settings enable row level security;
alter table public.personalized_analysis_jobs enable row level security;
alter table public.personalized_analysis_results enable row level security;

revoke all on table public.personalized_ondemand_settings from public, anon, authenticated, service_role;
revoke all on table public.personalized_analysis_jobs from public, anon, authenticated, service_role;
revoke all on table public.personalized_analysis_results from public, anon, authenticated, service_role;

grant select on table public.personalized_ondemand_settings to service_role;
grant select on table public.personalized_analysis_jobs to service_role;
grant select on table public.personalized_analysis_results to service_role;

-- 本人は自分のジョブの状態と、完成した結果だけを読める（貸し出しの token や版は列ごと見せない）。
grant select (id, scope, request_date, model_tier, status, attempt_count, requested_at, started_at,
  completed_at, failed_at, error_code, notify_status)
  on table public.personalized_analysis_jobs to authenticated;
grant select (job_id, report_type, trading_date, title_ja, summary_ja, body, portfolio_snapshot, model_used, generated_at)
  on table public.personalized_analysis_results to authenticated;

create policy personalized_analysis_jobs_owner_select on public.personalized_analysis_jobs
  for select to authenticated using (auth.uid() = user_id);
create policy personalized_analysis_results_owner_select on public.personalized_analysis_results
  for select to authenticated using (auth.uid() = user_id);

revoke all on function public.request_personalized_analysis(text, uuid, text) from public, anon, service_role;
grant execute on function public.request_personalized_analysis(text, uuid, text) to authenticated;
revoke all on function public.get_personalized_analysis_status() from public, anon, service_role;
grant execute on function public.get_personalized_analysis_status() to authenticated;
revoke all on function public.get_app_market_report(text, date) from public, anon, service_role;
grant execute on function public.get_app_market_report(text, date) to authenticated;

revoke all on function public.claim_personalized_analysis_jobs(integer) from public, anon, authenticated;
revoke all on function public.complete_personalized_analysis_job(uuid, uuid, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.fail_personalized_analysis_job(uuid, uuid, bigint, text, boolean) from public, anon, authenticated;
revoke all on function public.enqueue_personalized_analysis_notification(uuid) from public, anon, authenticated;
revoke all on function public.mark_personalized_analysis_notification_failed(uuid) from public, anon, authenticated;
grant execute on function public.claim_personalized_analysis_jobs(integer) to service_role;
grant execute on function public.complete_personalized_analysis_job(uuid, uuid, bigint, jsonb) to service_role;
grant execute on function public.fail_personalized_analysis_job(uuid, uuid, bigint, text, boolean) to service_role;
grant execute on function public.enqueue_personalized_analysis_notification(uuid) to service_role;
grant execute on function public.mark_personalized_analysis_notification_failed(uuid) to service_role;

commit;
