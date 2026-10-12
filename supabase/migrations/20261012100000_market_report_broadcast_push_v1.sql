-- 共通の朝刊・大引けの一斉プッシュ通知 V1（2026-10-12、G2）— 未適用のソース候補。本番には別承認まで適用しない。
-- 前提: 20261011150000_personalized_ondemand_analysis_v1（PR143、未マージ・未適用）の後に適用する。
--
-- 何をするか
--   1. 共通の回（market_report_cycles + market_report_packets）が完成したら、朝刊・大引けごとに「一斉通知」を1つ作る
--      （キーは report_type + trading_date。回のパケットは一度決まると変わらないので、1つの回に1つ）。
--   2. 対象者（通知 ON・朝刊／大引けの通知 ON・端末あり）を利用者 ID の順に区切り（チャンク）へ分ける。分割は1回の
--      呼び出しで上限まで、続きは次の呼び出しで（全員を一度に読み込んだり書き込んだりしない）。
--   3. 専用の worker が区切りを期限付きの貸し出し（token・版・期限）で引き取り、送る直前に対象を確かめ直して送る。
--      利用者ごとの記録（deliveries）で、1つの一斉通知に1人1回。送ったかどうか分からない人には、二度と送らない。
-- 何をしないか
--   既存の表・関数・権限を変えない。重要ニュース・個別レポート・オンデマンド分析の通知の経路（notifications と
--   send-push-notifications）には一切触れない（専用の表と専用の worker に分ける）。端末のトークンも削除しない。

begin;

do $$
begin
  if to_regclass('public.market_report_broadcasts') is not null then
    raise exception 'MARKET_REPORT_BROADCAST_ALREADY_APPLIED';
  end if;
  if to_regclass('public.market_report_cycles') is null or to_regclass('public.market_report_packets') is null
     or to_regclass('public.alert_settings') is null or to_regclass('public.device_push_tokens') is null
     or to_regclass('public.profiles') is null then
    raise exception 'MARKET_REPORT_BROADCAST_PREFLIGHT_FOUNDATION_MISSING';
  end if;
  -- 通知をタップした先（アプリ向けの共通朝刊・大引け）と、そのゲートは PR143 の migration が作る。
  if to_regclass('public.personalized_ondemand_settings') is null
     or to_regprocedure('public.get_app_market_report(text,date)') is null then
    raise exception 'MARKET_REPORT_BROADCAST_PREFLIGHT_ONDEMAND_V1_MISSING';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. ゲートと上限（1行だけ。既定はすべて OFF）
-- ---------------------------------------------------------------------------

create table public.market_report_broadcast_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  -- 送信のゲート。enabled だけ ON（これは OFF）の間は、一斉通知の作成と分割だけを行い、送らない
  -- （本番で対象者の数・区切りの数を確かめる試し実行）。
  sending_enabled boolean not null default false,
  -- 試す人の一覧。null なら対象の全員。指定すると、その人たちだけを対象にする（少数で試す段階）。
  pilot_user_ids uuid[],
  -- 旧来の定時の個別レポート（朝刊・大引けの完成の通知）が動いている間は、一斉通知を作らない（二重の通知を防ぐ）。
  -- オンデマンドが ON（定時の個別レポートが止まる）なら作る。どうしても並べて送るときだけ true にする。
  allow_with_legacy_personalized_reports boolean not null default false,
  chunk_size integer not null default 500 check (chunk_size between 50 and 2000),
  plan_chunks_per_call integer not null default 40 check (plan_chunks_per_call between 1 and 200),
  -- 同時に送る区切りの数。Expo が勧める同時の接続（6本程度）を超えない。
  max_parallel_chunks integer not null default 4 check (max_parallel_chunks between 1 and 6),
  lease_seconds integer not null default 180 check (lease_seconds between 60 and 900),
  max_chunk_attempts integer not null default 3 check (max_chunk_attempts between 1 and 5),
  -- 回の完成からこれより時間がたったら、一斉通知を作らない。作った一斉通知も、これより古くなったら残りを送らない
  -- （古い朝刊・大引けを今さら知らせない。試し実行で作った一斉通知が、あとで送信を ON にしたときに届くこともない）。
  max_report_age_minutes integer not null default 120 check (max_report_age_minutes between 10 and 720),
  -- 一斉通知の全体の送信の速さの上限（通知の数／秒）。worker は区切りごとに「上限 ÷ 同時の区切りの数」を、
  -- 直近1秒の送信数で守る（平均ではなく、どの1秒の窓でも超えない）。Expo の上限（1プロジェクト600通/秒）から、
  -- 重要ニュースなどの分として少なくとも200通/秒を残す。
  messages_per_second integer not null default 300 check (messages_per_second between 10 and 400),
  -- 1人あたりの端末の上限。これより多い端末を登録している人には送らず、failed（DEVICE_LIMIT_EXCEEDED）と記録する
  -- （端末を黙って切り捨てて「送信済み」にしない）。1人の端末は1つのリクエスト（90通まで）に入れる。
  max_devices_per_user integer not null default 20 check (max_devices_per_user between 1 and 90),
  -- 記録を残す日数（それより古い一斉通知の記録は少しずつ消す）。
  keep_days integer not null default 14 check (keep_days between 3 and 90),
  updated_at timestamptz not null default now(),
  -- 区切りごとの1秒あたりの送信数（上限 ÷ 同時の区切りの数）で、1人の端末をすべて1つのリクエストに入れられること。
  constraint market_report_broadcast_settings_rate_fits_devices
    check (messages_per_second / max_parallel_chunks >= max_devices_per_user)
);
insert into public.market_report_broadcast_settings (id) values (true);

comment on table public.market_report_broadcast_settings is
  '共通の朝刊・大引けの一斉通知のゲートと上限。既定は OFF。変更は所有者の SQL だけ（API ロールに書き込み権限なし）。';

-- ---------------------------------------------------------------------------
-- 2. 一斉通知・区切り・利用者ごとの記録
-- ---------------------------------------------------------------------------

create table public.market_report_broadcasts (
  id uuid primary key default gen_random_uuid(),
  report_type text not null check (report_type in ('morning', 'close')),
  trading_date date not null,
  cycle_id uuid not null references public.market_report_cycles (id),
  report_packet_id uuid not null references public.market_report_packets (id),
  -- 回の完成時刻（新しさの基準。作成・引き取り・送る直前のすべてで、これから max_report_age_minutes 以内）。
  source_completed_at timestamptz not null,
  title text not null check (char_length(title) between 1 and 60),
  body text not null check (char_length(body) between 1 and 160),
  status text not null default 'planning' check (status in ('planning', 'sending', 'completed')),
  -- 分割の続きの位置（ここまでの利用者 ID は区切りに入った）。null は先頭から。
  plan_cursor uuid,
  planned_chunks integer not null default 0 check (planned_chunks >= 0),
  planned_users integer not null default 0 check (planned_users >= 0),
  created_at timestamptz not null default now(),
  plan_completed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint market_report_broadcasts_once unique (report_type, trading_date),
  constraint market_report_broadcasts_packet_once unique (report_packet_id)
);

create table public.market_report_broadcast_chunks (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references public.market_report_broadcasts (id) on delete cascade,
  chunk_no integer not null check (chunk_no >= 1),
  -- 利用者 ID の範囲（user_after < user_id <= user_to）。区切りどうしは隙間なくつながる。
  user_after uuid,
  user_to uuid not null,
  planned_users integer not null check (planned_users >= 1),
  status text not null default 'queued' check (status in ('queued', 'processing', 'done', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null check (max_attempts between 1 and 5),
  lease_token uuid,
  lease_version bigint not null default 0,
  lease_expires_at timestamptz,
  available_at timestamptz not null default now(),
  sent_users integer not null default 0,
  skipped_users integer not null default 0,
  failed_users integer not null default 0,
  unknown_users integer not null default 0,
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_report_broadcast_chunks_no unique (broadcast_id, chunk_no),
  constraint market_report_broadcast_chunks_range check (user_after is null or user_after < user_to),
  constraint market_report_broadcast_chunks_lease_shape check (
    (status = 'processing') = (lease_token is not null and lease_expires_at is not null)
  ),
  constraint market_report_broadcast_chunks_attempts check (attempt_count <= max_attempts)
);
create index market_report_broadcast_chunks_queue
  on public.market_report_broadcast_chunks (available_at, created_at, chunk_no) where status = 'queued';
create index market_report_broadcast_chunks_leases
  on public.market_report_broadcast_chunks (lease_expires_at) where status = 'processing';
create index market_report_broadcast_chunks_open
  on public.market_report_broadcast_chunks (broadcast_id) where status in ('queued', 'processing');

-- 利用者ごとの記録。1つの一斉通知に1人1行（主キー）。
--   planned: 分割のときに、その区切りの対象者として固定した（区切りの人数は chunk_size まで）。送る直前には、
--            この人たちだけを確かめ直す（分割のあとに通知を ON にした人は、次の朝刊・大引けから）。
--   sending: 送る直前に付ける。このまま止まったら unknown（送ったかもしれないので二度と送らない）。
--   retry:   送っていないことが確かな失敗（Expo が受け付けを明示的に断った）。区切りの次の試行で送り直す。
--   sent / failed / unknown / skipped: 終わり。
create table public.market_report_broadcast_deliveries (
  broadcast_id uuid not null references public.market_report_broadcasts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  chunk_id uuid not null references public.market_report_broadcast_chunks (id) on delete cascade,
  status text not null check (status in ('planned', 'sending', 'retry', 'sent', 'failed', 'unknown', 'skipped')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  device_count integer not null default 0 check (device_count >= 0),
  error_code text check (error_code is null or char_length(error_code) <= 120),
  updated_at timestamptz not null default now(),
  primary key (broadcast_id, user_id)
);
create index market_report_broadcast_deliveries_chunk
  on public.market_report_broadcast_deliveries (chunk_id, status);

-- ---------------------------------------------------------------------------
-- 3. 対象者の条件（送る直前にも同じ条件で確かめ直す）
-- ---------------------------------------------------------------------------

create function public.market_report_broadcast_eligible(p_user_id uuid, p_report_type text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.alert_settings as s
     where s.user_id = p_user_id
       and s.push_enabled
       and case p_report_type when 'morning' then s.morning_report when 'close' then s.close_report else false end
  ) and exists (select 1 from public.device_push_tokens as t where t.user_id = p_user_id)
    and coalesce((select g.pilot_user_ids is null or p_user_id = any(g.pilot_user_ids)
                     from public.market_report_broadcast_settings as g where g.id), false);
$$;

-- 今この一斉通知を送ってよいか（引き取りと送る直前の両方で確かめる）:
--   一斉通知・送信のゲートが ON、共通の市況の公開（PR143）が ON（タップした先が見られる）、
--   回の完成から max_report_age_minutes 以内、回の現在のパケットが一斉通知のパケットと同じで完成のまま。
create function public.market_report_broadcast_send_allowed(p_broadcast_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select g.enabled and g.sending_enabled
       and coalesce((select o.public_market_feed_enabled from public.personalized_ondemand_settings as o where o.id), false)
       and b.source_completed_at >= pg_catalog.clock_timestamp() - pg_catalog.make_interval(mins => g.max_report_age_minutes)
       and c.report_status = 'completed' and c.current_report_packet_id = b.report_packet_id
      from public.market_report_broadcasts as b
      join public.market_report_cycles as c on c.id = b.cycle_id
      cross join public.market_report_broadcast_settings as g
     where b.id = p_broadcast_id and g.id
  ), false);
$$;

-- ---------------------------------------------------------------------------
-- 4. 作る側: 完成した共通の回から一斉通知を作る（worker が毎回最初に呼ぶ。何度呼んでも1つの回に1つ）
-- ---------------------------------------------------------------------------

create function public.enqueue_market_report_broadcasts()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_settings public.market_report_broadcast_settings%rowtype;
  v_ondemand public.personalized_ondemand_settings%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := (pg_catalog.clock_timestamp() at time zone 'Asia/Tokyo')::date;
  v_cycle public.market_report_cycles%rowtype;
  v_packet public.market_report_packets%rowtype;
  v_fact text;
  v_headline text;
  v_title text;
  v_created integer := 0;
  v_blocked integer := 0;
  v_id uuid;
begin
  select * into v_settings from public.market_report_broadcast_settings where id;
  if not found or not v_settings.enabled then
    return jsonb_build_object('status', 'disabled');
  end if;
  select * into v_ondemand from public.personalized_ondemand_settings where id;
  -- タップした先（アプリ向けの共通朝刊・大引け）が見られないなら、知らせない。
  if not found or not v_ondemand.public_market_feed_enabled then
    return jsonb_build_object('status', 'feed_disabled');
  end if;
  -- 旧来の定時の個別レポートが動いている間は作らない（同じ朝・夕に2通の通知が届くのを防ぐ）。
  if not v_ondemand.ondemand_requests_enabled and not v_settings.allow_with_legacy_personalized_reports then
    return jsonb_build_object('status', 'legacy_personalized_active');
  end if;

  for v_cycle in
    select c.* from public.market_report_cycles as c
     where c.trading_date = v_today
       and c.report_status = 'completed'
       and c.current_report_packet_id is not null
       and c.report_completed_at >= v_now - pg_catalog.make_interval(mins => v_settings.max_report_age_minutes)
       and not exists (
         select 1 from public.market_report_broadcasts as b
          where b.report_type = c.report_type and b.trading_date = c.trading_date
       )
     order by c.report_completed_at
  loop
    select * into v_packet from public.market_report_packets where id = v_cycle.current_report_packet_id;
    v_fact := coalesce(v_packet.payload #>> '{fact,ai_status}', 'passed');
    v_headline := pg_catalog.btrim(coalesce(v_packet.payload ->> 'headline_ja', ''));
    -- 欠けた・食い違う・Fact 未確認のパケットは知らせない。
    if v_packet.id is null or v_packet.cycle_id <> v_cycle.id or v_packet.report_type <> v_cycle.report_type
       or v_packet.trading_date <> v_cycle.trading_date or v_packet.fact_status <> 'passed'
       or v_fact not in ('passed', 'advisory') or v_headline = '' then
      v_blocked := v_blocked + 1;
      continue;
    end if;
    v_title := pg_catalog.to_char(v_cycle.trading_date, 'FMMM"月"FMDD"日"')
      || case v_cycle.report_type when 'morning' then 'の朝刊ができました' else 'の大引けレポートができました' end;
    insert into public.market_report_broadcasts (report_type, trading_date, cycle_id, report_packet_id, source_completed_at, title, body)
    values (v_cycle.report_type, v_cycle.trading_date, v_cycle.id, v_packet.id, v_cycle.report_completed_at, v_title,
            case when char_length(v_headline) > 160 then left(v_headline, 159) || '…' else v_headline end)
    on conflict do nothing
    returning id into v_id;
    if v_id is not null then
      v_created := v_created + 1;
    end if;
    v_id := null;
  end loop;
  return jsonb_build_object('status', 'ok', 'created', v_created, 'blocked', v_blocked);
end
$$;

-- ---------------------------------------------------------------------------
-- 5. 分割: 対象者を利用者 ID の順に区切る（1回の呼び出しで最大 plan_chunks_per_call 個。続きは次の呼び出しで）
-- ---------------------------------------------------------------------------

create function public.plan_market_report_broadcast(p_broadcast_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_settings public.market_report_broadcast_settings%rowtype;
  v_b public.market_report_broadcasts%rowtype;
  v_users uuid[];
  v_n integer;
  v_made integer := 0;
  v_chunk uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select * into v_settings from public.market_report_broadcast_settings where id;
  if not found or not v_settings.enabled then
    return jsonb_build_object('status', 'disabled');
  end if;
  -- 同じ一斉通知の分割は1つずつ（行のロック）。続きの位置と区切りの追加は同じ取引で進む。
  select * into v_b from public.market_report_broadcasts where id = p_broadcast_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_b.status <> 'planning' then
    return jsonb_build_object('status', v_b.status);
  end if;

  while v_made < v_settings.plan_chunks_per_call loop
    select array_agg(x.user_id order by x.user_id) into v_users
      from (
        select s.user_id
          from public.alert_settings as s
         where (v_b.plan_cursor is null or s.user_id > v_b.plan_cursor)
           and s.push_enabled
           and case v_b.report_type when 'morning' then s.morning_report else s.close_report end
           and exists (select 1 from public.device_push_tokens as t where t.user_id = s.user_id)
           and (v_settings.pilot_user_ids is null or s.user_id = any(v_settings.pilot_user_ids))
         order by s.user_id
         limit v_settings.chunk_size
      ) as x;
    v_n := coalesce(array_length(v_users, 1), 0);
    if v_n = 0 then
      -- 分割の終わり。開いている区切りが無ければ（対象者0人、または全部送り終えた）そのまま完了。
      update public.market_report_broadcasts as b
         set status = case when exists (
               select 1 from public.market_report_broadcast_chunks as c
                where c.broadcast_id = b.id and c.status in ('queued', 'processing')) then 'sending' else 'completed' end,
             plan_completed_at = v_now, updated_at = v_now,
             completed_at = case when exists (
               select 1 from public.market_report_broadcast_chunks as c
                where c.broadcast_id = b.id and c.status in ('queued', 'processing')) then null else v_now end
       where b.id = v_b.id;
      return jsonb_build_object('status', 'planned', 'chunks', v_b.planned_chunks, 'users', v_b.planned_users, 'made', v_made);
    end if;
    insert into public.market_report_broadcast_chunks
      (broadcast_id, chunk_no, user_after, user_to, planned_users, max_attempts, available_at)
    values
      (v_b.id, v_b.planned_chunks + 1, v_b.plan_cursor, v_users[v_n], v_n, v_settings.max_chunk_attempts, v_now)
    returning id into v_chunk;
    -- この区切りの対象者を固定する（送る直前には、この人たちだけを確かめ直す）。
    insert into public.market_report_broadcast_deliveries (broadcast_id, user_id, chunk_id, status, attempt_count, updated_at)
    select v_b.id, u, v_chunk, 'planned', 0, v_now from pg_catalog.unnest(v_users) as u;
    v_b.plan_cursor := v_users[v_n];
    v_b.planned_chunks := v_b.planned_chunks + 1;
    v_b.planned_users := v_b.planned_users + v_n;
    v_made := v_made + 1;
    update public.market_report_broadcasts
       set plan_cursor = v_b.plan_cursor, planned_chunks = v_b.planned_chunks, planned_users = v_b.planned_users,
           updated_at = v_now
     where id = v_b.id;
  end loop;
  return jsonb_build_object('status', 'planning', 'chunks', v_b.planned_chunks, 'users', v_b.planned_users, 'made', v_made);
end
$$;

-- ---------------------------------------------------------------------------
-- 6. 送る側: 区切りの引き取り（先着順・同時に動かせる数の上限・期限付きの貸し出し）
-- ---------------------------------------------------------------------------

create function public.claim_market_report_broadcast_chunks(p_limit integer)
returns table (
  chunk_id uuid, broadcast_id uuid, report_type text, trading_date date, title text, body text,
  attempt_count integer, max_attempts integer, lease_token uuid, lease_version bigint, lease_expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_settings public.market_report_broadcast_settings%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_running integer;
  v_slots integer;
  v_expired uuid[];
begin
  select * into v_settings from public.market_report_broadcast_settings where id;
  if not found or not v_settings.enabled or not v_settings.sending_enabled then
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('market_report_broadcast:claim', 0));

  -- 期限切れの区切り: 先に区切りを更新する（送る直前の処理が区切りの行をつかんでいれば、その確定を待つ）。
  -- 版を進めて、回数が残っていれば待ち行列へ戻す（まだ送っていない人だけが、次の試行の対象になる）。
  with expired as (
    update public.market_report_broadcast_chunks as c
       set status = case when c.attempt_count >= c.max_attempts then 'failed' else 'queued' end,
           last_error_code = 'LEASE_EXPIRED',
           lease_token = null, lease_expires_at = null, lease_version = c.lease_version + 1,
           available_at = v_now, updated_at = v_now
     where c.status = 'processing' and c.lease_expires_at < v_now
    returning c.id
  )
  select coalesce(array_agg(id), '{}') into v_expired from expired;
  -- そのあとで（確定した「送信中」も見える新しい文で）、送る直前だった人を unknown にする
  -- （送ったかもしれないので二度と送らない）。
  update public.market_report_broadcast_deliveries as d
     set status = 'unknown', error_code = 'LEASE_EXPIRED_OUTCOME_UNKNOWN', updated_at = v_now
   where d.chunk_id = any(v_expired) and d.status = 'sending';
  -- 古くなった一斉通知の、まだ送っていない区切りは送らずに終える（再試行待ちの人は failed）。
  with stale as (
    update public.market_report_broadcast_chunks as c
       set status = 'failed', last_error_code = 'BROADCAST_STALE', available_at = v_now, updated_at = v_now
      from public.market_report_broadcasts as b
     where b.id = c.broadcast_id and c.status = 'queued'
       and b.source_completed_at < v_now - pg_catalog.make_interval(mins => v_settings.max_report_age_minutes)
    returning c.id
  )
  select v_expired || coalesce(array_agg(id), '{}') into v_expired from stale;
  -- 終わった区切り（回数を使い切った・古くなった）に残った、固定した人・再試行待ちの人は failed（もう送らない）。
  update public.market_report_broadcast_deliveries as d
     set status = 'failed', error_code = coalesce(c.last_error_code, 'CHUNK_ATTEMPTS_EXHAUSTED'), updated_at = v_now
    from public.market_report_broadcast_chunks as c
   where d.chunk_id = c.id and c.id = any(v_expired) and d.status in ('planned', 'retry') and c.status = 'failed';
  -- 分割が終わり、開いている区切りが無い一斉通知は完了（期限切れで区切りが終わった場合も含む）。
  update public.market_report_broadcasts as b
     set status = 'completed', completed_at = v_now, updated_at = v_now
   where b.status = 'sending'
     and not exists (
       select 1 from public.market_report_broadcast_chunks as c
        where c.broadcast_id = b.id and c.status in ('queued', 'processing'));

  select count(*) into v_running from public.market_report_broadcast_chunks where status = 'processing';
  v_slots := least(greatest(coalesce(p_limit, 1), 0), 16, greatest(v_settings.max_parallel_chunks - v_running, 0));
  if v_slots = 0 then
    return;
  end if;

  return query
  with candidates as materialized (
    select q.id
      from public.market_report_broadcast_chunks as q
      join public.market_report_broadcasts as b on b.id = q.broadcast_id
     where q.status = 'queued' and q.available_at <= v_now and b.status in ('planning', 'sending')
       and public.market_report_broadcast_send_allowed(b.id)
     order by b.created_at, q.chunk_no
     limit v_slots
     for update of q skip locked
  ), claimed as (
    update public.market_report_broadcast_chunks as c
       set status = 'processing',
           attempt_count = c.attempt_count + 1,
           lease_token = pg_catalog.gen_random_uuid(),
           lease_version = c.lease_version + 1,
           lease_expires_at = v_now + pg_catalog.make_interval(secs => v_settings.lease_seconds),
           updated_at = v_now
      from candidates as k
     where c.id = k.id and c.status = 'queued'
    returning c.id, c.broadcast_id, c.attempt_count, c.max_attempts, c.lease_token, c.lease_version, c.lease_expires_at
  )
  select k.id, k.broadcast_id, b.report_type, b.trading_date, b.title, b.body,
         k.attempt_count, k.max_attempts, k.lease_token, k.lease_version, k.lease_expires_at
    from claimed as k join public.market_report_broadcasts as b on b.id = k.broadcast_id;
end
$$;

-- 送る直前: 分割のときに固定した対象者（planned）と、送っていないことが確かな人（retry）だけを、今の設定で確かめ直し、
-- 送る人に「送信中」を付けて、その人の端末を返す。送信済み・不明の人は返さない。返す人数は区切りの人数まで。
-- 今送ってよくない（ゲート OFF・共通の市況が非公開・古い・パケットが変わった）なら、誰にも印を付けずに区切りを
-- 順番待ちへ戻し（試行の回数は消費しない）、空を返す。送ってよくない間は引き取られないので、くり返さない。
create function public.begin_market_report_broadcast_chunk(p_chunk_id uuid, p_lease_token uuid, p_lease_version bigint)
returns table (user_id uuid, token_id uuid, expo_push_token text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_c public.market_report_broadcast_chunks%rowtype;
  v_type text;
  v_max_devices integer;
begin
  select * into v_c from public.market_report_broadcast_chunks where id = p_chunk_id for update;
  if not found or v_c.status <> 'processing' or v_c.lease_token is distinct from p_lease_token
     or v_c.lease_version <> p_lease_version or v_c.lease_expires_at < v_now then
    raise exception 'MARKET_REPORT_BROADCAST_LEASE_LOST' using errcode = 'P0001';
  end if;
  if not public.market_report_broadcast_send_allowed(v_c.broadcast_id) then
    update public.market_report_broadcast_chunks as c
       set status = 'queued', attempt_count = greatest(c.attempt_count - 1, 0), last_error_code = 'SEND_NOT_ALLOWED',
           lease_token = null, lease_expires_at = null, lease_version = c.lease_version + 1,
           available_at = v_now + interval '60 seconds', updated_at = v_now
     where c.id = v_c.id;
    return;
  end if;
  select b.report_type into v_type from public.market_report_broadcasts as b where b.id = v_c.broadcast_id;
  select g.max_devices_per_user into v_max_devices from public.market_report_broadcast_settings as g where g.id;

  -- 今は対象でなくなった人（通知 OFF・端末なし・退会・試す人の一覧から外れた）は skipped。
  update public.market_report_broadcast_deliveries as d
     set status = 'skipped', error_code = 'NOT_ELIGIBLE_AT_SEND', updated_at = v_now
   where d.chunk_id = v_c.id and d.status in ('planned', 'retry')
     and not public.market_report_broadcast_eligible(d.user_id, v_type);
  -- 端末が上限より多い人には送らず failed（黙って一部の端末だけに送り「送信済み」にしない）。
  update public.market_report_broadcast_deliveries as d
     set status = 'failed', error_code = 'DEVICE_LIMIT_EXCEEDED', updated_at = v_now,
         device_count = (select count(*) from public.device_push_tokens as k where k.user_id = d.user_id)
   where d.chunk_id = v_c.id and d.status in ('planned', 'retry')
     and (select count(*) from public.device_push_tokens as k where k.user_id = d.user_id) > v_max_devices;

  return query
  with marked as (
    update public.market_report_broadcast_deliveries as d
       set status = 'sending', attempt_count = d.attempt_count + 1, error_code = null, updated_at = v_now,
           device_count = (select count(*) from public.device_push_tokens as k where k.user_id = d.user_id)
     where d.chunk_id = v_c.id and d.status in ('planned', 'retry')
    returning d.user_id
  )
  select m.user_id, k.id, k.expo_push_token
    from marked as m join public.device_push_tokens as k on k.user_id = m.user_id
   order by m.user_id, k.id;
end
$$;

-- 送ったあと: 利用者ごとの結果を記録し、区切りを終える（送っていないことが確かな人が残れば、回数の範囲で再試行）。
-- p_results: [{"user_id": "...", "outcome": "sent" | "retry" | "failed" | "unknown"}]
-- 結果が届かなかった「送信中」の人は unknown（送ったかもしれないので二度と送らない）。
create function public.finish_market_report_broadcast_chunk(
  p_chunk_id uuid,
  p_lease_token uuid,
  p_lease_version bigint,
  p_results jsonb,
  p_error_code text default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_c public.market_report_broadcast_chunks%rowtype;
  v_final_attempt boolean;
  v_retry integer;
  v_open integer;
  v_b public.market_report_broadcasts%rowtype;
begin
  select * into v_c from public.market_report_broadcast_chunks where id = p_chunk_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_c.status <> 'processing' or v_c.lease_token is distinct from p_lease_token
     or v_c.lease_version <> p_lease_version or v_c.lease_expires_at < v_now then
    return jsonb_build_object('status', 'lease_lost', 'chunk_status', v_c.status);
  end if;
  if p_results is null or jsonb_typeof(p_results) <> 'array' then
    raise exception 'MARKET_REPORT_BROADCAST_RESULTS_INVALID' using errcode = '22023';
  end if;
  v_final_attempt := v_c.attempt_count >= v_c.max_attempts;

  update public.market_report_broadcast_deliveries as d
     set status = case
                    when r.outcome = 'sent' then 'sent'
                    when r.outcome = 'retry' and not v_final_attempt then 'retry'
                    when r.outcome in ('retry', 'failed') then 'failed'
                    else 'unknown'
                  end,
         error_code = case when r.outcome = 'sent' then null else left(coalesce(r.error_code, upper(r.outcome)), 120) end,
         updated_at = v_now
    from (
      select (e ->> 'user_id')::uuid as user_id, e ->> 'outcome' as outcome, e ->> 'error_code' as error_code
        from jsonb_array_elements(p_results) as e
    ) as r
   where d.chunk_id = v_c.id and d.status = 'sending' and d.user_id = r.user_id;
  -- 結果の無い「送信中」は unknown。
  update public.market_report_broadcast_deliveries as d
     set status = 'unknown', error_code = 'RESULT_MISSING', updated_at = v_now
   where d.chunk_id = v_c.id and d.status = 'sending';

  select count(*) into v_retry from public.market_report_broadcast_deliveries as d
   where d.chunk_id = v_c.id and d.status = 'retry';

  update public.market_report_broadcast_chunks as c
     set status = case when v_retry > 0 then 'queued' else 'done' end,
         available_at = case when v_retry > 0 then v_now + pg_catalog.make_interval(secs => 30 * v_c.attempt_count) else c.available_at end,
         lease_token = null, lease_expires_at = null, lease_version = c.lease_version + 1,
         last_error_code = left(p_error_code, 120),
         sent_users = (select count(*) from public.market_report_broadcast_deliveries as d where d.chunk_id = c.id and d.status = 'sent'),
         skipped_users = (select count(*) from public.market_report_broadcast_deliveries as d where d.chunk_id = c.id and d.status = 'skipped'),
         failed_users = (select count(*) from public.market_report_broadcast_deliveries as d where d.chunk_id = c.id and d.status = 'failed'),
         unknown_users = (select count(*) from public.market_report_broadcast_deliveries as d where d.chunk_id = c.id and d.status = 'unknown'),
         updated_at = v_now
   where c.id = v_c.id;

  -- 分割が終わり、開いている区切りが無くなったら、一斉通知は完了。
  select * into v_b from public.market_report_broadcasts where id = v_c.broadcast_id for update;
  select count(*) into v_open from public.market_report_broadcast_chunks as c
   where c.broadcast_id = v_c.broadcast_id and c.status in ('queued', 'processing');
  if v_b.status = 'sending' and v_open = 0 then
    update public.market_report_broadcasts set status = 'completed', completed_at = v_now, updated_at = v_now
     where id = v_b.id;
  end if;
  return jsonb_build_object('status', case when v_retry > 0 then 'requeued' else 'done' end, 'retry_users', v_retry);
end
$$;

-- 古い一斉通知の記録を少しずつ消す（1回の呼び出しで最大 p_limit 行）。
create function public.purge_market_report_broadcasts(p_limit integer default 20000)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_keep integer;
  v_cut date;
  v_deleted integer;
  v_broadcasts integer;
begin
  select keep_days into v_keep from public.market_report_broadcast_settings where id;
  v_cut := (pg_catalog.clock_timestamp() at time zone 'Asia/Tokyo')::date - coalesce(v_keep, 14);
  delete from public.market_report_broadcast_deliveries as d
   where d.ctid in (
     select d2.ctid from public.market_report_broadcast_deliveries as d2
       join public.market_report_broadcasts as b on b.id = d2.broadcast_id
      where b.trading_date < v_cut and b.status = 'completed'
      limit least(greatest(coalesce(p_limit, 20000), 1), 50000)
   );
  get diagnostics v_deleted = row_count;
  delete from public.market_report_broadcasts as b
   where b.trading_date < v_cut and b.status = 'completed'
     and not exists (select 1 from public.market_report_broadcast_deliveries as d where d.broadcast_id = b.id);
  get diagnostics v_broadcasts = row_count;
  return jsonb_build_object('deliveries_deleted', v_deleted, 'broadcasts_deleted', v_broadcasts);
end
$$;

-- ---------------------------------------------------------------------------
-- 7. RLS と権限（利用者・匿名は何も読めず書けない。worker は service_role の RPC だけ）
-- ---------------------------------------------------------------------------

alter table public.market_report_broadcast_settings enable row level security;
alter table public.market_report_broadcasts enable row level security;
alter table public.market_report_broadcast_chunks enable row level security;
alter table public.market_report_broadcast_deliveries enable row level security;

revoke all on table public.market_report_broadcast_settings from public, anon, authenticated, service_role;
revoke all on table public.market_report_broadcasts from public, anon, authenticated, service_role;
revoke all on table public.market_report_broadcast_chunks from public, anon, authenticated, service_role;
revoke all on table public.market_report_broadcast_deliveries from public, anon, authenticated, service_role;
grant select on table public.market_report_broadcast_settings to service_role;
grant select on table public.market_report_broadcasts to service_role;
grant select on table public.market_report_broadcast_chunks to service_role;

revoke all on function public.market_report_broadcast_eligible(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.market_report_broadcast_send_allowed(uuid) from public, anon, authenticated, service_role;
revoke all on function public.enqueue_market_report_broadcasts() from public, anon, authenticated;
revoke all on function public.plan_market_report_broadcast(uuid) from public, anon, authenticated;
revoke all on function public.claim_market_report_broadcast_chunks(integer) from public, anon, authenticated;
revoke all on function public.begin_market_report_broadcast_chunk(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.finish_market_report_broadcast_chunk(uuid, uuid, bigint, jsonb, text) from public, anon, authenticated;
revoke all on function public.purge_market_report_broadcasts(integer) from public, anon, authenticated;
grant execute on function public.enqueue_market_report_broadcasts() to service_role;
grant execute on function public.plan_market_report_broadcast(uuid) to service_role;
grant execute on function public.claim_market_report_broadcast_chunks(integer) to service_role;
grant execute on function public.begin_market_report_broadcast_chunk(uuid, uuid, bigint) to service_role;
grant execute on function public.finish_market_report_broadcast_chunk(uuid, uuid, bigint, jsonb, text) to service_role;
grant execute on function public.purge_market_report_broadcasts(integer) to service_role;

commit;
