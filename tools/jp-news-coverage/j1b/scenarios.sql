-- Synthetic scenarios: fictional events, market-wide (company_code null). `case_id` is carried in the title prefix [Cx].
insert into public.stocks_master(id, ticker_code, company_name, sector) values
  ('00000000-0000-0000-0000-0000000000a1', '7203', 'テスト自動車', '輸送用機器'),
  ('00000000-0000-0000-0000-0000000000a2', '8306', 'テスト銀行', '銀行業'),
  ('00000000-0000-0000-0000-0000000000a3', '9999', 'テスト食品', '食料品');
insert into public.tracked_stocks(user_id, stock_id, tracking_type) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'holding'),   -- u_all  : auto holder
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a2', 'holding'),   -- u_std  : bank holder
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000a3', 'watch');     -- u_food : food watcher
insert into public.alert_settings(user_id, notification_preset) values
  ('10000000-0000-0000-0000-000000000001', 'all_useful'),
  ('10000000-0000-0000-0000-000000000002', 'standard'),
  ('10000000-0000-0000-0000-000000000003', 'standard'),    -- u_none : tracks nothing
  ('10000000-0000-0000-0000-000000000004', 'standard');

-- columns: id suffix, status, importance, category, title, source_type, source_name, severity(stored), relevance, fact, minutes_ago
insert into public.important_news_candidates
  (id, status, importance, category, title, source_type, source_name, source_url, published_at, coverage_severity,
   japan_market_relevance, fact_check_status, generation_fact_status, generated_text)
select ('20000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, status, importance, category, title, 'market_macro', source_name,
       'https://www.example.go.jp/' || n, now() - make_interval(mins => mins), severity, relevance, fact,
       case when status = 'published' then 'passed' end, case when status = 'published' then '本文' end
from (values
  (1,  'published', 'important',  'fx',                    '[C1] 財務省が為替介入の実施を公表',                  'jp_official', 'high',      'high',   'passed', 30),
  (2,  'published', 'most_important','boj',                '[C2] 日銀が政策金利の変更を決定',                    'market_macro','critical',  'high',   'passed', 40),
  (3,  'rejected',  'no_post',    'administrative_action', '[C3] 金融庁が地方銀行に業務改善命令',                'jp_official', 'medium',    'medium', 'passed', 50),
  (4,  'rejected',  'no_post',    'other_market_moving',   '[C4] 気象庁が震度6強の地震を観測',                   'jp_official', 'emergency', 'high',   'passed', 20),
  (5,  'rejected',  'no_post',    'other_market_moving',   '[C5] 大手工場で爆発事故、消防が発表',                'jp_official', 'high',      'medium', 'passed', 60),
  (6,  'rejected',  'no_post',    'other_market_moving',   '[C6] 省庁が啓発キャンペーンを開始',                  'jp_official', 'low',       'none',   'passed', 70),
  (7,  'rejected',  'no_post',    'fx',                    '[C7] 為替市場の動向に関する財務官談話',              'jp_official', 'medium',    'medium', 'passed', 80),
  (8,  'rejected',  'no_post',    'administrative_action', '[C8] 金融庁が証券会社に行政処分（続報）',            'jp_official', 'medium',    'medium', 'passed', 55),
  (9,  'pending_judgement','no_post','other_market_moving','[C9] 判定待ちの国内ニュース',                        'jp_official', 'medium',    'medium', 'passed', 10),
  (10, 'published', 'important',  'major_security_incident','[C10] 大規模サイバー攻撃で国内の決済障害',          'jp_official', 'high',      'high',   'passed', 90)
) as t(n, status, importance, category, title, source_name, severity, relevance, fact, mins);
-- C3/C8 are the same event (duplicate pair for the dedupe check)
update public.important_news_candidates set title = '[C8] 金融庁が地方銀行に業務改善命令（続報）' where id = '20000000-0000-0000-0000-000000000008';

-- ---- J1-b2 additions: Fact failures, rumours, follow-ups, non-official source, company news, no-tracking all_useful user
insert into public.alert_settings(user_id, notification_preset) values ('10000000-0000-0000-0000-000000000005', 'all_useful'); -- u5: all_useful, tracks nothing
insert into public.important_news_candidates
  (id, status, importance, category, title, source_type, source_name, source_url, published_at, coverage_severity,
   japan_market_relevance, fact_check_status, company_code)
values
  ('20000000-0000-0000-0000-000000000011', 'rejected', 'no_post', 'administrative_action', '[C11] 金融庁が信用金庫に業務改善命令（事実確認未了）', 'market_macro', 'jp_official', 'https://www.example.go.jp/11', now() - interval '35 minutes', 'medium', 'medium', 'needs_review', null),
  ('20000000-0000-0000-0000-000000000012', 'rejected', 'no_post', 'major_security_incident', '[C12] 大手通信会社で大規模障害との未確認情報', 'market_macro', 'breaking_market', 'https://example.test/12', now() - interval '25 minutes', 'high', 'high', 'passed', null),
  ('20000000-0000-0000-0000-000000000013', 'rejected', 'no_post', 'other_market_moving', '[C13] 大手工場で爆発事故 消防が発表（第2報）', 'market_macro', 'jp_official', 'https://www.example.go.jp/13', now() - interval '58 minutes', 'high', 'high', 'passed', null),
  ('20000000-0000-0000-0000-000000000015', 'rejected', 'no_post', 'earnings', '[C15] テスト自動車 決算短信（TDnet）', 'tdnet', 'tdnet', 'https://www.release.tdnet.info/15', now() - interval '45 minutes', 'medium', 'medium', 'passed', '72030');
-- C13 is the same event as C5 (title differs only by a follow-up marker)
update public.important_news_candidates set title = '[C5] 大手工場で爆発事故 消防が発表' where id = '20000000-0000-0000-0000-000000000005';
