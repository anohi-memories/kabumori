alter table public.posting_windows
  add column if not exists daily_probability numeric not null default 1
  check (daily_probability > 0 and daily_probability <= 1);

create table if not exists public.interaction_topics (
  id uuid primary key default gen_random_uuid(),
  title text not null unique,
  question_format text not null check (question_format in (
    'choice', 'experience', 'beginner_question',
    'market_sentiment', 'watchlist', 'how_do_you_see'
  )),
  prompt_hint text not null,
  is_active boolean not null default true,
  last_used_at timestamptz,
  use_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.market_contexts (
  id bigint generated always as identity primary key,
  context_date date not null,
  summary text not null,
  source_label text,
  valid_until timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.interaction_post_metrics (
  id bigint generated always as identity primary key,
  scheduled_post_id uuid not null references public.scheduled_posts(id),
  interaction_topic_id uuid not null references public.interaction_topics(id),
  x_post_id text not null,
  impressions integer,
  likes integer,
  replies integer,
  reposts integer,
  measured_at timestamptz,
  created_at timestamptz not null default now(),
  unique (x_post_id)
);

alter table public.interaction_topics enable row level security;
alter table public.market_contexts enable row level security;
alter table public.interaction_post_metrics enable row level security;
grant select on public.interaction_topics to service_role;
grant select on public.market_contexts to service_role;
grant select on public.interaction_post_metrics to service_role;

insert into public.interaction_topics (title, question_format, prompt_hint) values
('指値派？成行派？', 'choice', '普段よく使う注文方法を2択で聞き、使い分けの例も添える'),
('決算は発表前に持つ？発表後に見る？', 'choice', 'A・B・場合による、の3択にして理由も一言募集する'),
('配当と成長性、先に見るのはどっち？', 'choice', '配当・成長性・両方の3択で答えやすくする'),
('投資を始めた頃の失敗談', 'experience', '初心者時代の失敗と、あとから学んだことを募集する'),
('損切りで迷った経験', 'experience', '判断が難しかった場面を責めない雰囲気で募集する'),
('決算を読み違えた経験', 'experience', '見落とした項目や次から確認する点を募集する'),
('最初に分からなかった株用語', 'beginner_question', '初心者の頃につまずいた用語を具体例付きで募集する'),
('今いちばん知りたい投資用語', 'beginner_question', '候補を2〜3個挙げつつ自由回答も歓迎する'),
('証券アプリで最初に困ったこと', 'beginner_question', '注文、チャート、入金などの例を示して募集する'),
('今日の相場は強気？弱気？様子見？', 'market_sentiment', '3択と判断材料を一言で答えてもらう'),
('今日の値動き、想定内？想定外？', 'market_sentiment', '2択にして印象に残った動きも募集する'),
('今の相場で気になるリスクは？', 'market_sentiment', '金利、為替、決算など選択肢の例を出す'),
('いま注目している投資テーマ', 'watchlist', '半導体、AI、防衛、高配当など例を示して募集する'),
('決算で注目している銘柄や業種', 'watchlist', '直接的な売買推奨にならないよう、見る理由を募集する'),
('ウォッチリストに入れる基準', 'watchlist', '業績、チャート、配当など何を入口にするか聞く'),
('好決算後の下落、みなさんならどう見る？', 'how_do_you_see', '織り込み、材料出尽くし、見通しなど観点を示す'),
('出来高を伴う急騰、どこを確認する？', 'how_do_you_see', '材料、需給、継続性など確認点を募集する'),
('高配当だけど減益、みなさんなら何を見る？', 'how_do_you_see', '配当方針、利益、キャッシュフローなど観点を示す')
on conflict (title) do update
set question_format = excluded.question_format,
    prompt_hint = excluded.prompt_hint,
    is_active = true;

insert into public.posting_windows
  (post_type, slot_no, start_time, end_time, timezone, daily_probability, is_active)
values
  ('interaction', 1, '14:00', '16:30', 'Asia/Tokyo', 1, false),
  ('interaction', 2, '20:00', '22:00', 'Asia/Tokyo', 0.45, false)
on conflict (post_type, slot_no) do update
set start_time = excluded.start_time,
    end_time = excluded.end_time,
    timezone = excluded.timezone,
    daily_probability = excluded.daily_probability,
    is_active = false;

create or replace function public.plan_daily_posts(
  p_date date default ((now() at time zone 'Asia/Tokyo')::date)
)
returns setof public.scheduled_posts
language plpgsql
security definer
set search_path = public
as $$
declare
  window_row public.posting_windows%rowtype;
  random_seconds integer;
  local_now timestamp;
  effective_start time;
  probability_bucket integer;
begin
  for window_row in
    select * from public.posting_windows where is_active order by post_type, slot_no
  loop
    probability_bucket := mod(
      abs(hashtextextended(p_date::text || ':' || window_row.post_type || ':' || window_row.slot_no, 0)),
      10000
    )::integer;
    if probability_bucket >= floor(window_row.daily_probability * 10000)::integer then
      continue;
    end if;

    local_now := now() at time zone window_row.timezone;
    effective_start := window_row.start_time;
    if p_date = local_now::date then
      if local_now::time >= window_row.end_time then continue; end if;
      if local_now::time > window_row.start_time then
        effective_start := (local_now + interval '1 minute')::time;
      end if;
    end if;

    random_seconds := floor(
      random() * (extract(epoch from (window_row.end_time - effective_start)) + 1)
    )::integer;
    insert into public.scheduled_posts (schedule_date, post_type, slot_no, scheduled_for)
    values (
      p_date, window_row.post_type, window_row.slot_no,
      ((p_date + effective_start + random_seconds * interval '1 second') at time zone window_row.timezone)
    ) on conflict (schedule_date, post_type, slot_no) do nothing;
  end loop;

  return query select * from public.scheduled_posts
  where schedule_date = p_date order by scheduled_for;
end;
$$;

create or replace function public.complete_interaction_post(
  p_scheduled_post_id uuid,
  p_interaction_topic_id uuid,
  p_x_post_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.interaction_topics
  set last_used_at = now(), use_count = use_count + 1
  where id = p_interaction_topic_id;

  update public.scheduled_posts
  set status = 'succeeded', finished_at = now()
  where id = p_scheduled_post_id and status = 'running';

  insert into public.post_execution_logs
    (scheduled_post_id, post_type, status, x_post_id, message)
  values
    (p_scheduled_post_id, 'interaction', 'succeeded', p_x_post_id,
     'Interaction X post created; topic=' || p_interaction_topic_id::text);

  insert into public.interaction_post_metrics
    (scheduled_post_id, interaction_topic_id, x_post_id)
  values (p_scheduled_post_id, p_interaction_topic_id, p_x_post_id);
end;
$$;

revoke all on function public.complete_interaction_post(uuid, uuid, text) from public;
grant execute on function public.complete_interaction_post(uuid, uuid, text) to service_role;
