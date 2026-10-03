-- 会社員AIラボ（ai_salaryman_lab）専用: 実際に投稿された「開発イベント／evergreen題材」の使用記録。
--
-- 目的: 同じ開発日記イベントを、切り口（changed / difficulty / decided / angle）だけ変えて短時間に
-- 何度も投稿しないよう、題材選定の前に「すでに投稿したイベント」を除外する。
--
-- 設計:
-- - 1 scheduled post = 1行（主キー）。x-test-post が X 投稿の成功を確認した後にだけ insert する
--   （生成失敗・内容ガード不合格・X 投稿失敗では記録しない）。重複 insert は無視される。
-- - 保存するのはイベントの安定キー（例 diary-2026-10-01-1 / evergreen-3）と切り口キー、X post id、時刻のみ。
--   投稿本文・日記本文・内部識別子は保存しない（CHECK で形を固定）。
-- - 既存の published_content_fingerprints / complete_ai_salaryman_lab_brand_post / scheduled_posts は
--   変更しない。scheduled_posts への外部キーも張らない（他ワークストリームの削除処理を巻き込まないため）。
-- - service_role（Edge Function）だけが読み書きできる。anon / authenticated からは見えない。
-- - 保持: 選定が読むのは直近14日分のみ。行は小さく、1日数行のため自動削除は設けない。

create table if not exists public.ai_lab_topic_event_usage (
  scheduled_post_id uuid primary key,
  brand_id text not null default 'ai_salaryman_lab'
    check (brand_id = 'ai_salaryman_lab'),
  event_key text not null
    check (event_key ~ '^(diary-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{1,2}|evergreen-[0-9]{1,2})$'),
  unit_key text
    check (unit_key is null or (char_length(unit_key) <= 64 and unit_key ~ '^[a-z0-9#-]+$')),
  x_post_id text not null
    check (char_length(x_post_id) between 1 and 64),
  published_at timestamptz not null default now()
);

create index if not exists ai_lab_topic_event_usage_recent_idx
  on public.ai_lab_topic_event_usage (brand_id, published_at desc);

alter table public.ai_lab_topic_event_usage enable row level security;

-- Supabase の既定権限（新規 public テーブルに全ロールへ ALL）を打ち消し、service_role も select/insert のみにする。
revoke all on table public.ai_lab_topic_event_usage from public, anon, authenticated, service_role;
grant select, insert on table public.ai_lab_topic_event_usage to service_role;

comment on table public.ai_lab_topic_event_usage is
  'AI Lab only: event keys of topics actually published to X (no post text). Read by x-test-post topic selection to avoid re-posting the same development event under a different angle.';
