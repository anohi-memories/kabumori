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
-- Edge cases for the same-event rewrite (explicit ids so tie-breaks are identical in every database).
insert into public.important_news_candidates
  (id, source_type, source_priority, source_url, source_name, title, normalized_title, category, published_at, content_hash,
   status, importance, coverage_severity, japan_market_relevance, fact_check_status, generation_fact_status, generated_text, company_code)
values
  -- exactly 72h apart (<= 72h: same event) and 72h + 1s (different events)
  ('30000000-0000-0000-0000-000000000001','market_macro',1,'https://e.test/1','jp_official','[E01] 為替 ドル円 150.5円 1000件','n1','fx', timestamptz '2026-10-01 00:00+09','1000000000000000000000000000000000000000000000000000000000000001','published','important','high','high','passed',null,null,null),
  ('30000000-0000-0000-0000-000000000002','market_macro',1,'https://e.test/2','jp_official','[E02] 為替 ドル円 150.5円 1000件','n2','fx', timestamptz '2026-10-04 00:00+09','1000000000000000000000000000000000000000000000000000000000000002','published','important','high','high','passed',null,null,null),
  ('30000000-0000-0000-0000-000000000003','market_macro',1,'https://e.test/3','jp_official','[E03] 為替 ユーロ円 160.5円 2000件','n3','fx', timestamptz '2026-10-01 00:00+09','1000000000000000000000000000000000000000000000000000000000000003','published','important','high','high','passed',null,null,null),
  ('30000000-0000-0000-0000-000000000004','market_macro',1,'https://e.test/4','jp_official','[E04] 為替 ユーロ円 160.5円 2000件','n4','fx', timestamptz '2026-10-04 00:00:01+09','1000000000000000000000000000000000000000000000000000000000000004','published','important','high','high','passed',null,null,null),
  -- identical timestamps: tie broken by id
  ('30000000-0000-0000-0000-000000000005','market_macro',1,'https://e.test/5','jp_official','[E05] 為替 豪ドル円 99.5円 3000件','n5','fx', timestamptz '2026-10-02 12:00+09','1000000000000000000000000000000000000000000000000000000000000005','published','important','high','high','passed',null,null,null),
  ('30000000-0000-0000-0000-000000000006','market_macro',1,'https://e.test/6','jp_official','[E06] 為替 豪ドル円 99.5円 3000件','n6','fx', timestamptz '2026-10-02 12:00+09','1000000000000000000000000000000000000000000000000000000000000006','published','important','high','high','passed',null,null,null),
  -- same signature, different category (not the same event)
  ('30000000-0000-0000-0000-000000000007','market_macro',1,'https://e.test/7','jp_official','[E07] 為替 関税 25.5% 4000件','n7','fx', timestamptz '2026-10-02 06:00+09','1000000000000000000000000000000000000000000000000000000000000007','published','important','high','high','passed',null,null,null),
  ('30000000-0000-0000-0000-000000000008','market_macro',1,'https://e.test/8','jp_official','[E08] 為替 関税 25.5% 4000件','n8','tariffs', timestamptz '2026-10-02 06:00+09','1000000000000000000000000000000000000000000000000000000000000008','published','important','high','high','passed',null,null,null),
  -- one number only: signature is null, so identical titles are not deduplicated
  ('30000000-0000-0000-0000-000000000009','market_macro',1,'https://e.test/9','jp_official','[E09] 為替 介入 150円','n9','fx', timestamptz '2026-10-02 08:00+09','1000000000000000000000000000000000000000000000000000000000000009','published','important','high','high','passed',null,null,null),
  ('30000000-0000-0000-0000-000000000010','market_macro',1,'https://e.test/10','jp_official','[E10] 為替 介入 150円','n10','fx', timestamptz '2026-10-02 08:30+09','1000000000000000000000000000000000000000000000000000000000000010','published','important','high','high','passed',null,null,null),
  -- years only: signature null
  ('30000000-0000-0000-0000-000000000011','market_macro',1,'https://e.test/11','jp_official','[E11] 為替 2026年 2025年 比較','n11','fx', timestamptz '2026-10-02 09:00+09','1000000000000000000000000000000000000000000000000000000000000011','published','important','high','high','passed',null,null,null),
  ('30000000-0000-0000-0000-000000000012','market_macro',1,'https://e.test/12','jp_official','[E12] 為替 2026年 2025年 比較','n12','fx', timestamptz '2026-10-02 09:30+09','1000000000000000000000000000000000000000000000000000000000000012','published','important','high','high','passed',null,null,null),
  -- company row and market row with the same numbers: the company row never enters the market feed
  ('30000000-0000-0000-0000-000000000013','tdnet',1,'https://e.test/13','tdnet','[E13] 為替 テスト自動車 業績 5000百万円 3.5%','n13','fx', timestamptz '2026-10-02 10:00+09','1000000000000000000000000000000000000000000000000000000000000013','published','important','high','high','passed',null,null,'72030'),
  ('30000000-0000-0000-0000-000000000014','market_macro',1,'https://e.test/14','jp_official','[E14] 為替 テスト自動車 業績 5000百万円 3.5%','n14','fx', timestamptz '2026-10-02 10:30+09','1000000000000000000000000000000000000000000000000000000000000014','published','important','high','high','passed',null,null,null),
  -- verified text decides which duplicate survives (priority tuple before time)
  ('30000000-0000-0000-0000-000000000015','market_macro',1,'https://e.test/15','jp_official','[E15] 為替 ポンド円 190.5円 5000件','n15','fx', timestamptz '2026-10-03 01:00+09','1000000000000000000000000000000000000000000000000000000000000015','published','important','high','high','passed','passed','本文あり',null),
  ('30000000-0000-0000-0000-000000000016','market_macro',1,'https://e.test/16','jp_official','[E16] 為替 ポンド円 190.5円 5000件','n16','fx', timestamptz '2026-10-03 00:00+09','1000000000000000000000000000000000000000000000000000000000000016','published','important','high','high','passed','failed',null,null),
  -- domestic path: equal event key after stripping follow-up markers; short key (< 8 chars) is never merged
  ('30000000-0000-0000-0000-000000000017','market_macro',1,'https://e.test/17','jp_official','[E17] 金融庁が地方銀行に業務改善命令','n17','administrative_action', timestamptz '2026-10-03 03:00+09','1000000000000000000000000000000000000000000000000000000000000017','rejected','no_post','medium','medium','passed',null,null,null),
  ('30000000-0000-0000-0000-000000000018','market_macro',1,'https://e.test/18','jp_official','[E18] 金融庁が地方銀行に業務改善命令（第2報）','n18','administrative_action', timestamptz '2026-10-03 04:00+09','1000000000000000000000000000000000000000000000000000000000000018','rejected','no_post','medium','medium','passed',null,null,null),
  ('30000000-0000-0000-0000-000000000019','market_macro',1,'https://e.test/19','jp_official','[E19] 銀行障害','n19','major_security_incident', timestamptz '2026-10-03 05:00+09','1000000000000000000000000000000000000000000000000000000000000019','rejected','no_post','high','high','passed',null,null,null),
  ('30000000-0000-0000-0000-000000000020','market_macro',1,'https://e.test/20','jp_official','[E20] 銀行障害','n20','major_security_incident', timestamptz '2026-10-03 05:30+09','1000000000000000000000000000000000000000000000000000000000000020','rejected','no_post','high','high','passed',null,null,null);
