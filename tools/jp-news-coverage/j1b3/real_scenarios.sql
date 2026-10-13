-- Synthetic data on the REAL schema (fictional events; market-wide rows have company_code null).
insert into auth.users(id, email) values
  ('10000000-0000-0000-0000-000000000001', 'u1@example.test'), ('10000000-0000-0000-0000-000000000002', 'u2@example.test'),
  ('10000000-0000-0000-0000-000000000003', 'u3@example.test'), ('10000000-0000-0000-0000-000000000004', 'u4@example.test'),
  ('10000000-0000-0000-0000-000000000005', 'u5@example.test');
insert into public.profiles(id) select id from auth.users;
insert into public.stocks_master(id, ticker_code, company_name, sector) values
  ('00000000-0000-0000-0000-0000000000a1', '7203', 'テスト自動車', '輸送用機器'),
  ('00000000-0000-0000-0000-0000000000a2', '8306', 'テスト銀行', '銀行業'),
  ('00000000-0000-0000-0000-0000000000a3', '9999', 'テスト食品', '食料品');
insert into public.tracked_stocks(user_id, stock_id, tracking_type) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'holding'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a2', 'holding'),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000a3', 'watch');
insert into public.alert_settings(user_id, notification_preset) values
  ('10000000-0000-0000-0000-000000000001', 'all_useful'),
  ('10000000-0000-0000-0000-000000000002', 'standard'),
  ('10000000-0000-0000-0000-000000000003', 'standard'),
  ('10000000-0000-0000-0000-000000000004', 'standard'),
  ('10000000-0000-0000-0000-000000000005', 'all_useful')
on conflict (user_id) do update set notification_preset = excluded.notification_preset;

insert into public.important_news_candidates
  (id, source_type, source_priority, source_url, source_name, title, normalized_title, category, published_at, content_hash,
   status, importance, coverage_severity, japan_market_relevance, fact_check_status, generation_fact_status, generated_text, company_code)
select ('20000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, stype, case when stype = 'secondary' then 2 else 1 end,
       'https://www.example.go.jp/' || n, sname, title, 'nt' || n, category, now() - make_interval(mins => mins),
       lpad(n::text, 64, 'a'), status, importance, severity, relevance, fact,
       case when status = 'published' then 'passed' end, case when status = 'published' then '本文' end, ccode
from (values
  (1,  'market_macro','jp_official',  'published',        'important',      'fx',                     '[C1] 財務省が為替介入の実施を公表',                      'high',      'high',   'passed',      30, null),
  (2,  'market_macro','market_macro', 'published',        'most_important','boj',                    '[C2] 日銀が政策金利の変更を決定',                        'critical',  'high',   'passed',      40, null),
  (3,  'market_macro','jp_official',  'rejected',         'no_post',        'administrative_action',  '[C3] 金融庁が地方銀行に業務改善命令',                    'medium',    'medium', 'passed',      50, null),
  (4,  'market_macro','jp_official',  'rejected',         'no_post',        'disaster',               '[C4] 気象庁が震度6強の地震を観測',                       'emergency', 'high',   'passed',      20, null),
  (5,  'market_macro','jp_official',  'rejected',         'no_post',        'other_market_moving',    '[C5] 大手工場で爆発事故 消防が発表',                     'high',      'medium', 'passed',      60, null),
  (6,  'market_macro','jp_official',  'rejected',         'no_post',        'other_market_moving',    '[C6] 省庁が啓発キャンペーンを開始',                      'low',       'none',   'passed',      70, null),
  (7,  'market_macro','jp_official',  'rejected',         'no_post',        'fx',                     '[C7] 為替市場の動向に関する財務官談話',                  'medium',    'medium', 'passed',      80, null),
  (8,  'market_macro','jp_official',  'rejected',         'no_post',        'administrative_action',  '[C8] 金融庁が地方銀行に業務改善命令（続報）',            'medium',    'medium', 'passed',      55, null),
  (9,  'market_macro','jp_official',  'pending_judgement','no_post',        'other_market_moving',    '[C9] 判定待ちの国内ニュース',                            'medium',    'medium', 'passed',      10, null),
  (10, 'market_macro','jp_official',  'published',        'important',      'major_security_incident','[C10] 大規模サイバー攻撃で国内の決済障害',               'high',      'high',   'passed',      90, null),
  (11, 'market_macro','jp_official',  'rejected',         'no_post',        'administrative_action',  '[C11] 金融庁が信用金庫に業務改善命令（事実確認未了）',    'medium',    'medium', 'needs_review',35, null),
  (12, 'breaking_market','breaking_market','rejected',    'no_post',        'major_security_incident','[C12] 大手通信会社で大規模障害との未確認情報',           'high',      'high',   'passed',      25, null),
  (13, 'market_macro','jp_official',  'rejected',         'no_post',        'other_market_moving',    '[C13] 大手工場で爆発事故 消防が発表（第2報）',           'high',      'high',   'passed',      58, null),
  (15, 'tdnet',       'tdnet',        'rejected',         'no_post',        'earnings',               '[C15] テスト自動車 決算短信（TDnet）',                   'medium',    'medium', 'passed',      45, '72030')
) as t(n, stype, sname, status, importance, category, title, severity, relevance, fact, mins, ccode);
