-- Deterministic synthetic data for the differential (old vs rewritten same-event de-duplication) test.
-- :pool = number of distinct number-signatures; titles with equal signature + category + <=72h are "same event".
insert into auth.users(id, email)
select ('10000000-0000-0000-0000-' || lpad(u::text, 12, '0'))::uuid, 'e' || u || '@example.test' from generate_series(1, 6) u;
insert into public.profiles(id) select id from auth.users;
insert into public.stocks_master(id, ticker_code, company_name, sector) values
  ('00000000-0000-0000-0000-0000000000b1', '7203', 'テスト自動車', '輸送用機器'),
  ('00000000-0000-0000-0000-0000000000b2', '8306', 'テスト銀行', '銀行業'),
  ('00000000-0000-0000-0000-0000000000b3', '5020', 'テスト石油', '石油・石炭製品'),
  ('00000000-0000-0000-0000-0000000000b4', '9101', 'テスト海運', '海運業');
insert into public.tracked_stocks(user_id, stock_id, tracking_type) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', 'holding'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b2', 'holding'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000b3', 'watch'),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000b4', 'holding');
insert into public.alert_settings(user_id, notification_preset)
select ('10000000-0000-0000-0000-' || lpad(u::text, 12, '0'))::uuid, case when u = 5 then 'all_useful' else 'standard' end
from generate_series(1, 6) u on conflict (user_id) do update set notification_preset = excluded.notification_preset;
insert into public.important_news_candidates
  (source_type, source_priority, source_url, source_name, title, normalized_title, category, published_at, content_hash,
   status, importance, coverage_severity, japan_market_relevance, fact_check_status, generation_fact_status, generated_text)
select 'market_macro', 1, 'https://www.example.go.jp/e' || g, case when g % 5 = 0 then 'market_macro' else 'jp_official' end,
       '[E' || g || '] ' || (array['原油','為替介入','金融庁','地震','日銀','海運','半導体'])[1 + g % 7] || 'ニュース ' ||
         (100 + g % :pool) || '.5% ' || (1000 + (g * 7) % :pool) || ' 件' || case when g % 11 = 0 then '（続報）' else '' end,
       'ne' || g, (array['other_market_moving','fx','administrative_action','boj'])[1 + g % 4],
       timestamp with time zone '2026-10-01 00:00+09' + make_interval(hours => (g * 7919) % 160, secs => g),  -- unique timestamps: the feed's LIMIT has no tie-break
       md5('e' || g) || md5('f' || g),
       (array['rejected','published','ready_for_generation','generation_failed'])[1 + g % 4], 'no_post',
       (array['medium','high','critical','low','emergency'])[1 + g % 5], (array['medium','high','low'])[1 + g % 3],
       case when g % 9 = 0 then 'needs_review' else 'passed' end,
       case when g % 4 = 1 then 'passed' end, case when g % 4 = 1 then '本文' end
from generate_series(1, :n) as g;
