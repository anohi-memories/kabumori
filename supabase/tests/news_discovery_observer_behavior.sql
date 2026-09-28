-- Disposable-only behavior proof for 20260928120000_news_discovery_observer.sql.
-- Run by news_discovery_observer_run.sh as the (non-superuser) owner, switching roles to prove
-- the privilege model. Every check raises on failure (ON_ERROR_STOP).
\set ON_ERROR_STOP 1

-- helper: a signal payload (built as the owner, used under service_role)
create function pg_temp.sig(p_id text, p_source text, p_title text, p_url text, p_extra jsonb default '{}')
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'id', p_id, 'source_id', p_source, 'source_type', 'rss', 'policy', 'DIRECT_SOURCE', 'discovery_only', false,
    'discovered_via', 'feed:' || p_source, 'source_url', p_url, 'canonical_url', p_url,
    'url_key', regexp_replace(p_url, '^https?://(www\.)?', ''), 'external_id', null, 'title', p_title,
    'title_fingerprint', left(md5(p_title) || md5(p_title), 32), 'title_display_allowed', true, 'summary_hint', null,
    'published_at', '2026-09-28T03:00:00Z', 'published_at_precision', 'datetime', 'updated_at', null,
    'detected_at', null, 'fetched_at', '2026-09-28T06:00:00Z', 'language', 'ja', 'country', 'JP', 'publisher', 'fixture',
    'topics', '["war"]'::jsonb, 'needs_verification', '[]'::jsonb, 'same_event_group', null, 'image_url', null,
    'image_usage_allowed', false, 'raw_reference', '{"feed_url":"x","item_index":0}'::jsonb,
    'tickers', '[]'::jsonb, 'entities', '[]'::jsonb) || p_extra
$$;
grant execute on function pg_temp.sig(text, text, text, text, jsonb) to service_role;

\echo '--- T1 privileges: anon / authenticated get nothing'
set role anon;
do $$ begin
  begin perform 1 from public.news_discovery_signals; raise exception 'FAIL anon select'; exception when insufficient_privilege then null; end;
  begin perform public.news_discovery_begin_run('{}'); raise exception 'FAIL anon execute'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role authenticated;
do $$ begin
  begin perform 1 from public.news_discovery_runs; raise exception 'FAIL authenticated select'; exception when insufficient_privilege then null; end;
  begin perform public.news_discovery_reserve_search('{}'); raise exception 'FAIL authenticated execute'; exception when insufficient_privilege then null; end;
end $$;
reset role;

\echo '--- T1b service_role: SELECT + EXECUTE only, no direct writes'
set role service_role;
do $$ begin
  perform 1 from public.news_discovery_signals;
  begin
    insert into public.news_discovery_runs (trigger_type) values ('manual');
    raise exception 'FAIL service_role direct insert';
  exception when insufficient_privilege then null; end;
  begin
    update public.news_discovery_search_config set daily_hard_limit = 500;
    raise exception 'FAIL service_role config update';
  exception when insufficient_privilege then null; end;
end $$;

\echo '--- T1c catalog read-back: all 7 tables/functions, RLS, owner, empty path, ACL'
reset role;
do $$ declare r record; n integer := 0; begin
  for r in select c.oid, c.relname, c.relrowsecurity from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relkind = 'r' and c.relname like 'news_discovery%' loop
    n := n + 1;
    if not r.relrowsecurity or has_table_privilege('anon', r.oid, 'SELECT,INSERT,UPDATE,DELETE')
      or has_table_privilege('authenticated', r.oid, 'SELECT,INSERT,UPDATE,DELETE')
      or not has_table_privilege('service_role', r.oid, 'SELECT')
      or has_table_privilege('service_role', r.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'FAIL table ACL/RLS %', r.relname;
    end if;
  end loop;
  if n <> 7 then raise exception 'FAIL table count %', n; end if;
  n := 0;
  for r in select p.*, owner.rolname, owner.rolsuper from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    join pg_roles owner on owner.oid = p.proowner where ns.nspname = 'public' and p.proname like 'news_discovery%' loop
    n := n + 1;
    if not r.prosecdef or not coalesce('search_path=""' = any(r.proconfig), false) or r.rolsuper
      or r.rolname <> current_user
      or has_function_privilege('anon', r.oid, 'EXECUTE') or has_function_privilege('authenticated', r.oid, 'EXECUTE')
      or not has_function_privilege('service_role', r.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(coalesce(r.proacl, acldefault('f', r.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception 'FAIL function owner/path/ACL %', r.proname;
    end if;
  end loop;
  if n <> 7 then raise exception 'FAIL function count %', n; end if;
end $$;
set role service_role;

\echo '--- T2 begin run + insert (tickers/entities separate; same-source same-title docs both kept)'
select (public.news_discovery_begin_run('{"trigger_type":"local_validation","requested_sources":["jp_kantei_news"],"code_version":"t"}') ->> 'run_id') as run_id \gset
select set_config('app.run', :'run_id', false);
do $$
declare
  v_run text := current_setting('app.run');
  r jsonb;
begin
  r := public.news_discovery_insert_signals(jsonb_build_object('run_id', v_run, 'alias_dictionary_version', 'alias-v0', 'signals', jsonb_build_array(
    pg_temp.sig(repeat('a', 64), 'jp_kantei_news', '北朝鮮弾道ミサイル発射に関する総理指示', 'https://www.kantei.go.jp/jp/105/discourse/20260920shiji2.html',
      jsonb_build_object(
        'tickers', jsonb_build_array(jsonb_build_object('ticker', '7203', 'status', 'confirmed', 'confirmation_basis', 'strong_match',
          'match_types', jsonb_build_array('EXACT_COMPANY_NAME'), 'matched_aliases', jsonb_build_array('トヨタ自動車'), 'in_title', true, 'score', 1)),
        'entities', jsonb_build_array(jsonb_build_object('kind', 'country_or_region', 'value', 'North Korea')))),
    pg_temp.sig(repeat('b', 64), 'jp_kantei_news', '北朝鮮弾道ミサイル発射に関する総理指示', 'https://www.kantei.go.jp/jp/105/discourse/20260928shiji.html'),
    pg_temp.sig(repeat('c', 64), 'gdelt_doc', 'Tanker hit near Hormuz', 'https://news.example/tanker',
      jsonb_build_object('policy', 'DISCOVERY_ONLY', 'discovery_only', true, 'source_type', 'gdelt_doc_json', 'title_display_allowed', false,
        'published_at', null, 'published_at_precision', null, 'detected_at', '2026-09-28T05:00:00Z'))
  )));
  if jsonb_array_length(r -> 'inserted') <> 3 or jsonb_array_length(r -> 'conflicted') <> 0 then raise exception 'FAIL T2 %', r; end if;
  if (select count(*) from public.news_discovery_signal_tickers) <> 1 then raise exception 'FAIL T2 tickers'; end if;
  if (select count(*) from public.news_discovery_signal_entities) <> 1 then raise exception 'FAIL T2 entities'; end if;
  if (select count(*) from public.news_discovery_signals where title = '北朝鮮弾道ミサイル発射に関する総理指示') <> 2 then raise exception 'FAIL T2 same-title docs'; end if;
end $$;

\echo '--- T3 retry safety: the same batch again inserts nothing and duplicates no relation'
do $$
declare r jsonb;
begin
  r := public.news_discovery_insert_signals(jsonb_build_object('run_id', current_setting('app.run'), 'signals', jsonb_build_array(
    pg_temp.sig(repeat('a', 64), 'jp_kantei_news', '北朝鮮弾道ミサイル発射に関する総理指示', 'https://www.kantei.go.jp/jp/105/discourse/20260920shiji2.html',
      jsonb_build_object('tickers', jsonb_build_array(jsonb_build_object('ticker', '7203', 'status', 'confirmed', 'confirmation_basis', 'strong_match',
        'match_types', jsonb_build_array('EXACT_COMPANY_NAME'), 'matched_aliases', '[]'::jsonb, 'in_title', true, 'score', 1)))),
    pg_temp.sig(repeat('b', 64), 'jp_kantei_news', '北朝鮮弾道ミサイル発射に関する総理指示', 'https://www.kantei.go.jp/jp/105/discourse/20260928shiji.html'))));
  if jsonb_array_length(r -> 'inserted') <> 0 or jsonb_array_length(r -> 'conflicted') <> 2 then raise exception 'FAIL T3 %', r; end if;
  if (select count(*) from public.news_discovery_signal_tickers) <> 1 then raise exception 'FAIL T3 tickers'; end if;
end $$;

\echo '--- T4 find_duplicates mirrors the TypeScript rules'
do $$
declare r jsonb; fp text := left(md5('北朝鮮弾道ミサイル発射に関する総理指示') || md5('北朝鮮弾道ミサイル発射に関する総理指示'), 32);
begin
  r := public.news_discovery_find_duplicates(jsonb_build_object('lookups', jsonb_build_array(
    -- 0: other source, same canonical URL -> canonical_url
    jsonb_build_object('i', 0, 'source_id', 'web_search', 'external_id', null, 'canonical_url', 'https://news.example/tanker',
      'url_key', 'news.example/tanker', 'title_fingerprint', null, 'title_fingerprint_any', repeat('0', 32), 'since', '2026-09-25T00:00:00Z'),
    -- 1: SAME source, same URL, different title (URL reused for a new item) -> no hit
    jsonb_build_object('i', 1, 'source_id', 'gdelt_doc', 'external_id', null, 'canonical_url', 'https://news.example/tanker',
      'url_key', 'news.example/tanker', 'title_fingerprint', null, 'title_fingerprint_any', repeat('0', 32), 'since', '2026-09-25T00:00:00Z'),
    -- 2: same title from ANOTHER source -> title_fingerprint
    jsonb_build_object('i', 2, 'source_id', 'web_search', 'external_id', null, 'canonical_url', 'https://other.example/x',
      'url_key', 'other.example/x', 'title_fingerprint', fp, 'title_fingerprint_any', fp, 'since', '2026-09-25T00:00:00Z'),
    -- 3: same title from the SAME source, new URL (a new missile instruction) -> no hit
    jsonb_build_object('i', 3, 'source_id', 'jp_kantei_news', 'external_id', null, 'canonical_url', 'https://www.kantei.go.jp/jp/105/discourse/20261001shiji.html',
      'url_key', 'kantei.go.jp/jp/105/discourse/20261001shiji.html', 'title_fingerprint', fp, 'title_fingerprint_any', fp, 'since', '2026-09-25T00:00:00Z'),
    -- 4: other source, same title but outside the window -> no hit
    jsonb_build_object('i', 4, 'source_id', 'web_search', 'external_id', null, 'canonical_url', 'https://other.example/y',
      'url_key', 'other.example/y', 'title_fingerprint', fp, 'title_fingerprint_any', fp, 'since', '2026-09-29T00:00:00Z')
  )));
  if r <> jsonb_build_array(
      jsonb_build_object('i', 0, 'reason', 'canonical_url', 'signal_id', repeat('c', 64)),
      jsonb_build_object('i', 2, 'reason', 'title_fingerprint', 'signal_id', repeat('a', 64))) then
    raise exception 'FAIL T4 %', r;
  end if;
end $$;

\echo '--- T5 transaction failure: one invalid row rolls back the whole batch'
do $$
declare failed boolean := false;
begin
  begin
    perform public.news_discovery_insert_signals(jsonb_build_object('run_id', current_setting('app.run'), 'signals', jsonb_build_array(
      pg_temp.sig(repeat('d', 64), 'jp_mof_news', 'valid row that must be rolled back', 'https://www.mof.go.jp/d.html'),
      -- discovery-only row carrying a summary: rejected by the policy constraint
      pg_temp.sig(repeat('e', 64), 'gdelt_doc', 'discovery with summary', 'https://news.example/e',
        jsonb_build_object('policy', 'DISCOVERY_ONLY', 'discovery_only', true, 'source_type', 'gdelt_doc_json',
          'title_display_allowed', false, 'summary_hint', 'publisher text must not be stored')))));
  exception when check_violation then failed := true; end;
  if not failed then raise exception 'FAIL T5 not rejected'; end if;
  if exists (select 1 from public.news_discovery_signals where id = repeat('d', 64)) then raise exception 'FAIL T5 partial write'; end if;
end $$;

\echo '--- T6 constraints: weak-only confirmation, missing basis, AI calls beyond searches'
do $$
declare failed integer := 0;
begin
  begin
    perform public.news_discovery_insert_signals(jsonb_build_object('run_id', current_setting('app.run'), 'signals', jsonb_build_array(
      pg_temp.sig(repeat('f', 64), 'jp_mof_news', 'weak only claimed strong', 'https://www.mof.go.jp/f.html',
        jsonb_build_object('tickers', jsonb_build_array(jsonb_build_object('ticker', '4477', 'status', 'confirmed', 'confirmation_basis', 'strong_match',
          'match_types', jsonb_build_array('WEAK_ALIAS'), 'matched_aliases', '[]'::jsonb, 'in_title', true, 'score', 0.4)))))));
  exception when check_violation then failed := failed + 1; end;
  begin
    perform public.news_discovery_insert_signals(jsonb_build_object('run_id', current_setting('app.run'), 'signals', jsonb_build_array(
      pg_temp.sig(repeat('9', 64), 'jp_mof_news', 'confirmed without basis', 'https://www.mof.go.jp/g.html',
        jsonb_build_object('tickers', jsonb_build_array(jsonb_build_object('ticker', '7203', 'status', 'confirmed', 'confirmation_basis', null,
          'match_types', jsonb_build_array('STRONG_ALIAS'), 'matched_aliases', '[]'::jsonb, 'in_title', true, 'score', 0.9)))))));
  exception when check_violation then failed := failed + 1; end;
  if failed <> 2 then raise exception 'FAIL T6 ticker constraints (%)', failed; end if;
end $$;
select set_config('app.bad_run', public.news_discovery_begin_run('{"trigger_type":"local_validation"}') ->> 'run_id', false);
do $$
declare failed boolean := false;
begin
  begin
    perform public.news_discovery_finish_run(jsonb_build_object('run_id', current_setting('app.bad_run'), 'status', 'completed',
      'totals', jsonb_build_object('ai_calls', 1, 'search_count', 0)));
  exception when check_violation then failed := true; end;
  if not failed then raise exception 'FAIL T6 ai_calls <= search_count'; end if;
end $$;

\echo '--- T7 search budget (config authority is the table; values set by the owner)'
reset role;
update public.news_discovery_search_config set daily_soft_budget = 2, daily_hard_limit = 3;
set role service_role;
do $$
declare r jsonb; v_parent text;
  req jsonb := jsonb_build_object('run_id', current_setting('app.run'), 'provider', 'mock', 'model', 'm', 'query', 'q', 'triggered_by', null);
begin
  r := public.news_discovery_reserve_search(req || '{"lane":"WORLD","reason":"scheduled_rotation","search_key":"rotation:WORLD"}');
  if not (r ->> 'allowed')::boolean then raise exception 'FAIL T7 first %', r; end if;
  r := public.news_discovery_reserve_search(req || '{"lane":"WORLD","reason":"scheduled_rotation","search_key":"rotation:WORLD"}');
  if r ->> 'reason' <> 'duplicate_search_key' then raise exception 'FAIL T7 cooldown %', r; end if;
  r := public.news_discovery_reserve_search(req || '{"lane":"MARKET","reason":"scheduled_rotation","search_key":"rotation:MARKET"}');
  if not (r ->> 'allowed')::boolean then raise exception 'FAIL T7 second %', r; end if;
  r := public.news_discovery_reserve_search(req || '{"lane":"ENERGY","reason":"scheduled_rotation","search_key":"rotation:ENERGY"}');
  if r ->> 'reason' <> 'soft_budget' then raise exception 'FAIL T7 soft %', r; end if;
  r := public.news_discovery_reserve_search(req || '{"lane":"ENERGY","reason":"trigger_market_anomaly","search_key":"anomaly:WTI"}');
  if not (r ->> 'allowed')::boolean then raise exception 'FAIL T7 trigger past soft %', r; end if;
  v_parent := r ->> 'search_id';
  r := public.news_discovery_reserve_search(req || jsonb_build_object('lane', 'ENERGY', 'reason', 'escalation', 'search_key', 'anomaly:WTI', 'parent_search_id', v_parent));
  if r ->> 'reason' <> 'hard_cap' then raise exception 'FAIL T7 hard cap first %', r; end if;
  -- complete: recorded once; a second completion is a no-op
  r := public.news_discovery_complete_search(jsonb_build_object('search_id', v_parent, 'status', 'succeeded', 'result_count', 5,
    'new_signal_count', 3, 'useful_signal_count', 2, 'duplicate_count', 2, 'model_calls', 1, 'web_search_calls', 1));
  if not (r ->> 'completed')::boolean then raise exception 'FAIL T7 complete %', r; end if;
  r := public.news_discovery_complete_search(jsonb_build_object('search_id', v_parent, 'status', 'failed'));
  if (r ->> 'completed')::boolean then raise exception 'FAIL T7 double complete %', r; end if;
  if (select count(*) from public.news_discovery_searches where status = 'denied') <> 3 then raise exception 'FAIL T7 denials recorded'; end if;
end $$;
reset role;
update public.news_discovery_search_config set daily_soft_budget = 30, daily_hard_limit = 48;
set role service_role;
do $$
declare r jsonb; v_parent text;
  req jsonb := jsonb_build_object('run_id', current_setting('app.run'), 'provider', 'mock', 'model', 'm', 'query', 'q', 'triggered_by', null);
begin
  v_parent := (select id::text from public.news_discovery_searches where search_key = 'anomaly:WTI' and status <> 'denied');
  r := public.news_discovery_reserve_search(req || jsonb_build_object('lane', 'ENERGY', 'reason', 'escalation', 'search_key', 'anomaly:WTI', 'parent_search_id', v_parent));
  if not (r ->> 'allowed')::boolean then raise exception 'FAIL T7 escalation %', r; end if;
  r := public.news_discovery_reserve_search(req || jsonb_build_object('lane', 'ENERGY', 'reason', 'escalation', 'search_key', 'anomaly:WTI', 'parent_search_id', v_parent));
  if r ->> 'reason' <> 'escalation_limit' then raise exception 'FAIL T7 escalation limit %', r; end if;
  r := public.news_discovery_reserve_search(req || jsonb_build_object('lane', 'ENERGY', 'reason', 'escalation', 'search_key', 'anomaly:OTHER', 'parent_search_id', v_parent));
  if r ->> 'reason' <> 'bad_parent' then raise exception 'FAIL T7 bad parent %', r; end if;
end $$;

\echo '--- T8 search-discovery signal with restricted publisher flag'
do $$
declare r jsonb; v_search text := (select id::text from public.news_discovery_searches where search_key = 'anomaly:WTI' and reason = 'trigger_market_anomaly');
begin
  r := public.news_discovery_insert_signals(jsonb_build_object('run_id', current_setting('app.run'), 'signals', jsonb_build_array(
    pg_temp.sig(repeat('1', 64), 'web_search', 'トヨタ 工場火災で生産停止', 'https://www3.nhk.or.jp/news/html/x.html',
      jsonb_build_object('policy', 'SEARCH_DISCOVERY', 'discovery_only', true, 'source_type', 'web_search', 'title_display_allowed', false,
        'restricted_publisher', true, 'search_id', v_search, 'published_at', null, 'published_at_precision', null,
        'detected_at', '2026-09-28T06:00:00Z', 'needs_verification', '["no_published_at","discovery_only_needs_primary","restricted_publisher_needs_primary"]'::jsonb)))));
  if jsonb_array_length(r -> 'inserted') <> 1 then raise exception 'FAIL T8 %', r; end if;
  begin
    -- restricted flag on a DIRECT signal is impossible
    perform public.news_discovery_insert_signals(jsonb_build_object('run_id', current_setting('app.run'), 'signals', jsonb_build_array(
      pg_temp.sig(repeat('2', 64), 'jp_mof_news', 'direct flagged restricted', 'https://www.mof.go.jp/r.html', '{"restricted_publisher":true}'))));
    raise exception 'FAIL T8 restricted direct accepted';
  exception when check_violation then null; end;
end $$;

\echo '--- T8b review: cross-run search references/escalation, weak-only claims, raw body rejected'
do $$
declare
  v_other text := public.news_discovery_begin_run('{"trigger_type":"local_validation"}') ->> 'run_id';
  v_search text := (select id::text from public.news_discovery_searches where search_key = 'anomaly:WTI' and reason = 'trigger_market_anomaly');
  r jsonb;
  rejected integer := 0;
begin
  begin
    perform public.news_discovery_insert_signals(jsonb_build_object('run_id', v_other, 'signals', jsonb_build_array(
      pg_temp.sig(repeat('3', 64), 'web_search', 'cross run reference', 'https://news.example/cross-run',
        jsonb_build_object('search_id', v_search)))));
  exception when raise_exception then
    if sqlerrm <> 'NEWS_DISCOVERY_SEARCH_RUN_MISMATCH' then raise; end if;
    rejected := rejected + 1;
  end;
  r := public.news_discovery_reserve_search(jsonb_build_object('run_id', v_other, 'lane', 'ENERGY', 'reason', 'escalation',
    'search_key', 'anomaly:WTI', 'parent_search_id', v_search, 'query', 'q', 'provider', 'mock', 'model', 'm'));
  if r ->> 'reason' <> 'bad_parent' then raise exception 'FAIL cross-run parent %', r; end if;
  begin
    perform public.news_discovery_insert_signals(jsonb_build_object('run_id', v_other, 'signals', jsonb_build_array(
      pg_temp.sig(repeat('4', 64), 'jp_mof_news', 'single weak alias claiming multiple', 'https://news.example/weak',
        jsonb_build_object('tickers', jsonb_build_array(jsonb_build_object('ticker', '4477', 'status', 'confirmed',
          'confirmation_basis', 'multiple_weak', 'match_types', jsonb_build_array('WEAK_ALIAS'),
          'matched_aliases', jsonb_build_array('BASE'), 'in_title', true, 'score', 0.4)))))));
  exception when check_violation then rejected := rejected + 1; end;
  begin
    perform public.news_discovery_insert_signals(jsonb_build_object('run_id', v_other, 'signals', jsonb_build_array(
      pg_temp.sig(repeat('6', 64), 'jp_mof_news', 'same weak alias duplicated', 'https://news.example/duplicate-weak',
        jsonb_build_object('tickers', jsonb_build_array(jsonb_build_object('ticker', '4477', 'status', 'confirmed',
          'confirmation_basis', 'multiple_weak', 'match_types', jsonb_build_array('WEAK_ALIAS'),
          'matched_aliases', jsonb_build_array('BASE', 'BASE'), 'in_title', true, 'score', 0.4)))))));
  exception when check_violation then rejected := rejected + 1; end;
  begin
    perform public.news_discovery_insert_signals(jsonb_build_object('run_id', v_other, 'signals', jsonb_build_array(
      pg_temp.sig(repeat('5', 64), 'gdelt_doc', 'hidden body', 'https://news.example/body',
        jsonb_build_object('policy', 'DISCOVERY_ONLY', 'discovery_only', true, 'source_type', 'gdelt_doc_json',
          'title_display_allowed', false, 'raw_reference', jsonb_build_object('body', 'must not persist'))))));
  exception when check_violation then rejected := rejected + 1; end;
  if rejected <> 4 then raise exception 'FAIL T8b rejected %/4', rejected; end if;
  if exists (select 1 from public.news_discovery_signals where first_run_id = v_other::uuid) then
    raise exception 'FAIL T8b partial write';
  end if;
end $$;

\echo '--- T9 finish_run records totals + sources once'
do $$
declare r jsonb;
begin
  r := public.news_discovery_finish_run(jsonb_build_object('run_id', current_setting('app.run'), 'status', 'completed_with_errors',
    'totals', jsonb_build_object('source_count', 2, 'successful_sources', 1, 'failed_sources', 1, 'inserted_count', 4,
      'search_count', 2, 'ai_calls', 2, 'web_search_calls', 2),
    'sources', jsonb_build_array(
      jsonb_build_object('source_id', 'jp_kantei_news', 'policy', 'DIRECT_SOURCE', 'outcome', 'ok', 'requests', '[{"via":"feed:jp_kantei_news","outcome":"ok","http_status":200}]'::jsonb),
      jsonb_build_object('source_id', 'us_state_press', 'policy', 'DIRECT_SOURCE', 'outcome', 'failed', 'requests', '[{"via":"feed:us_state_press","outcome":"HTTP_ERROR","http_status":403}]'::jsonb)),
    'error_summary', 'us_state_press:HTTP_ERROR:403'));
  if not (r ->> 'finished')::boolean then raise exception 'FAIL T9 %', r; end if;
  r := public.news_discovery_finish_run(jsonb_build_object('run_id', current_setting('app.run'), 'status', 'failed'));
  if (r ->> 'finished')::boolean then raise exception 'FAIL T9 finished twice'; end if;
  if (select count(*) from public.news_discovery_run_sources where run_id = current_setting('app.run')::uuid) <> 2 then raise exception 'FAIL T9 sources'; end if;
  begin
    perform public.news_discovery_insert_signals(jsonb_build_object('run_id', current_setting('app.run'), 'signals', '[]'::jsonb));
    raise exception 'FAIL T9 insert into finished run';
  exception when raise_exception then
    if sqlerrm <> 'NEWS_DISCOVERY_RUN_NOT_RUNNING' then raise; end if;
  end;
end $$;
\echo '--- T10 M1: persisted counts come from the DB; a failed run keeps the real search usage'
do $$
declare v_run text; v_search text; r jsonb;
  row_s public.news_discovery_searches; row_r public.news_discovery_runs;
begin
  v_run := public.news_discovery_begin_run('{"trigger_type":"local_validation"}') ->> 'run_id';
  r := public.news_discovery_reserve_search(jsonb_build_object('run_id', v_run, 'lane', 'TECH', 'reason', 'manual',
    'search_key', 'm1-proof', 'query', 'q', 'provider', 'mock', 'model', 'm'));
  if not (r ->> 'allowed')::boolean then raise exception 'FAIL T10 reserve %', r; end if;
  v_search := r ->> 'search_id';
  -- signals of the search are persisted BEFORE its row is completed
  r := public.news_discovery_insert_signals(jsonb_build_object('run_id', v_run, 'signals', jsonb_build_array(
    pg_temp.sig(repeat('7', 64), 'web_search', 'Chipmaker halts output after fire', 'https://m1.example/a',
      jsonb_build_object('policy', 'SEARCH_DISCOVERY', 'discovery_only', true, 'source_type', 'web_search',
        'title_display_allowed', false, 'search_id', v_search, 'topics', '["supply_chain"]'::jsonb,
        'published_at', null, 'published_at_precision', null, 'detected_at', '2026-09-28T06:00:00Z')),
    pg_temp.sig(repeat('8', 64), 'web_search', 'Unclassified result', 'https://m1.example/b',
      jsonb_build_object('policy', 'SEARCH_DISCOVERY', 'discovery_only', true, 'source_type', 'web_search',
        'title_display_allowed', false, 'search_id', v_search, 'topics', '[]'::jsonb,
        'published_at', null, 'published_at_precision', null, 'detected_at', '2026-09-28T06:00:00Z')))));
  -- client claims 5 discovered / 4 useful; the DB counts what is really stored: 2 / 1
  perform public.news_discovery_complete_search(jsonb_build_object('search_id', v_search, 'status', 'succeeded',
    'result_count', 6, 'new_signal_count', 5, 'useful_signal_count', 4, 'model_calls', 1, 'web_search_calls', 1,
    'input_tokens', 9000, 'output_tokens', 400));
  select * into row_s from public.news_discovery_searches where id = v_search::uuid;
  if row_s.persisted_signal_count <> 2 or row_s.persisted_useful_signal_count <> 1 or row_s.input_tokens <> 9000 then
    raise exception 'FAIL T10 persisted counts % %', row_s.persisted_signal_count, row_s.persisted_useful_signal_count;
  end if;
  -- the run then fails and finishes with EMPTY client totals: usage must still show
  perform public.news_discovery_finish_run(jsonb_build_object('run_id', v_run, 'status', 'failed', 'totals', '{}'::jsonb,
    'error_summary', 'RUN_FAILED:fixture', 'execution', jsonb_build_object('deadline_reached', true, 'searches_skipped', 1)));
  select * into row_r from public.news_discovery_runs where id = v_run::uuid;
  if row_r.search_count <> 1 or row_r.ai_calls <> 1 or row_r.web_search_calls <> 1 or row_r.search_result_count <> 6
     or row_r.search_useful_signal_count <> 1 or row_r.inserted_count <> 2 then
    raise exception 'FAIL T10 run usage % % % % % %', row_r.search_count, row_r.ai_calls, row_r.web_search_calls,
      row_r.search_result_count, row_r.search_useful_signal_count, row_r.inserted_count;
  end if;
  if (row_r.execution ->> 'deadline_reached')::boolean is not true or (row_r.execution ->> 'signals_persisted')::int <> 2 then
    raise exception 'FAIL T10 execution %', row_r.execution;
  end if;
end $$;

\echo '--- T11 M2 (sequential): same URL from another source is a DB duplicate; same source + same URL + new title is kept'
do $$
declare v_run text; r jsonb;
begin
  v_run := public.news_discovery_begin_run('{"trigger_type":"local_validation"}') ->> 'run_id';
  r := public.news_discovery_insert_signals(jsonb_build_object('run_id', v_run, 'signals', jsonb_build_array(
    pg_temp.sig(repeat('5', 64), 'jp_esri', '景気動向指数（7月分速報）', 'https://www.esri.cao.go.jp/jp/stat/di/di.html'),
    pg_temp.sig(repeat('6', 64), 'jp_esri', '景気動向指数（6月分改訂）', 'https://www.esri.cao.go.jp/jp/stat/di/di.html'),
    pg_temp.sig(repeat('4', 64), 'web_search', 'ESRI index page', 'https://www.esri.cao.go.jp/jp/stat/di/di.html',
      jsonb_build_object('policy', 'SEARCH_DISCOVERY', 'discovery_only', true, 'source_type', 'web_search', 'title_display_allowed', false,
        'published_at', null, 'published_at_precision', null)))));
  if jsonb_array_length(r -> 'inserted') <> 2 or jsonb_array_length(r -> 'duplicates') <> 1
     or r -> 'duplicates' -> 0 ->> 'duplicate_of' <> repeat('5', 64) then
    raise exception 'FAIL T11 %', r;
  end if;
end $$;
reset role;
\echo 'BEHAVIOR_PROOF_PASSED'
