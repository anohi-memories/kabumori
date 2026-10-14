-- 20261014100000_app_market_report_story_v2 の動作の検証（使い捨ての手元の PostgreSQL 専用）。
-- テーブルの所有者として実行する。利用者の操作は fx.call_as で、実際のロールと request.jwt.claim.sub に切り替えて呼ぶ。
-- 最後に APP_MARKET_REPORT_STORY_V2_BEHAVIOR_PASS を出す。
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create schema fx;

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

create function fx.jeq(p_actual jsonb, p_expected jsonb, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL %: expected [%] got [%]', p_label, p_expected, p_actual;
  end if;
end
$$;

create function fx.keys(p jsonb) returns text language sql immutable as
$$ select coalesce(string_agg(k, ',' order by k), '') from jsonb_object_keys(p) as k $$;

-- 完成した共通の回を1つ作る。p_extra は V1 の形の payload に足す（上書きする）項目。
create function fx.market(p_type text, p_date date, p_extra jsonb, p_data_generated timestamptz) returns uuid
language plpgsql as $$
declare
  v_cycle uuid;
  v_data uuid;
  v_report uuid;
begin
  insert into public.market_report_cycles (report_type, trading_date) values (p_type, p_date) returning id into v_cycle;
  insert into public.market_data_packets (cycle_id, attempt, schema_version, report_type, trading_date, as_of, generated_at,
      payload, content_hash, data_quality_status)
    values (v_cycle, 1, 'market_data_packet.v1', p_type, p_date, p_data_generated, p_data_generated,
      jsonb_build_object('schema_version', 'market_data_packet.v1', 'report_type', p_type, 'trading_date', to_char(p_date, 'YYYY-MM-DD'),
        'generated_at', 'LEAK-data-payload', 'data_quality', jsonb_build_object('status', 'ok'), 'metrics', '[]'::jsonb),
      repeat('a', 64), 'ok')
    returning id into v_data;
  update public.market_report_cycles set current_data_packet_id = v_data, cycle_status = 'completed', completed_at = now() where id = v_cycle;
  insert into public.market_report_packets (cycle_id, data_packet_id, attempt, schema_version, report_type, trading_date, payload,
      content_hash, fact_status, model, generation_calls, input_tokens, output_tokens, api_cost_usd)
    values (v_cycle, v_data, 1, 'market_report_packet.v1', p_type, p_date,
      jsonb_build_object('schema_version', 'market_report_packet.v1', 'report_type', p_type, 'trading_date', to_char(p_date, 'YYYY-MM-DD'),
        'data_packet_id', v_data::text, 'data_content_hash', repeat('a', 64), 'generated_at', '2026-10-09T23:05:00Z',
        'model', 'LEAK-model-name', 'market_direction', 'up', 'direction_basis', '["LEAK-direction-basis"]'::jsonb,
        'headline_ja', '見出し', 'market_summary_ja', '要約',
        'major_moves', '[{"metric_key":"nikkei225","label":"日経平均","session_date":"2026-10-09","value_display":"40,000","change_pct_display":"+1.0%","freshness":"fresh"},{"metric_key":"usdjpy","label":"ドル円","session_date":"2026-10-08","value_display":"150.00円","change_pct_display":null,"freshness":"stale"}]'::jsonb,
        'claims', '[{"claim_id":"LEAK-claim","text_ja":"上昇","claim_type":"observation","evidence_refs":["LEAK-ref"],"scope":"today"}]'::jsonb,
        'key_news', '[{"ref_id":"LEAK-news-ref","headline_ja":"ニュース","why_it_matters_ja":"理由","scope":"broad"}]'::jsonb,
        'strong_themes', '[{"name_ja":"半導体","claim_ids":["LEAK-claim"]}]'::jsonb, 'weak_themes', '[]'::jsonb,
        'next_watch_ja', '["注目"]'::jsonb, 'risks_ja', '["リスク"]'::jsonb, 'data_gaps_ja', '[]'::jsonb,
        'x_post', '{"lead_ja":"x","points_ja":["p1"],"closing_ja":"c"}'::jsonb,
        'fact', '{"local_issues":["LEAK-local"],"ai_status":"passed","generation_attempts":1,"quality_warnings":["LEAK-warning"],"removed_units":["LEAK-removed"]}'::jsonb)
        || p_extra,
      repeat('b', 64), 'passed', 'LEAK-model-name', 1, 100, 200, 0.5)
    returning id into v_report;
  update public.market_report_cycles set current_report_packet_id = v_report, report_status = 'completed', report_completed_at = now()
   where id = v_cycle;
  return v_report;
end
$$;

select ('00000000-0000-4000-8000-' || lpad('41', 12, '0'))::uuid as a \gset
insert into auth.users (id) values (:'a');
insert into public.profiles (id) values (:'a');
select (now() at time zone 'Asia/Tokyo')::date as today \gset
update public.personalized_ondemand_settings set public_market_feed_enabled = true;

-- V2 の項目を持つ回（presentation v2 の朝刊。ゆめちゃんの見立ては新しい scenario_ja つき）。
select fx.market('morning', :'today', jsonb_build_object(
  'presentation_version', 'market_presentation.v2',
  'app_story', jsonb_build_object('summary_ja', '要約のお話', 'overseas_ja', '米国の話', 'japan_ja', '日本の話', 'cross_asset_ja', '為替の話',
    'news_ja', 'ニュースの話', 'strong_ja', '強いテーマの話', 'caution_ja', '注意の話', 'watch_ja', '注目の話', 'extra_internal', 'LEAK-story-extra'),
  'session_views', '[{"market":"us","session_date":"2026-10-08","direction":"up","basis":["LEAK-session-basis"]},{"market":"tokyo","session_date":"2026-10-09","direction":"down","basis":[]},"LEAK-not-an-object"]'::jsonb,
  'yume', jsonb_build_object('version', 'yume.v1', 'target', 'nikkei225', 'horizon', 'this_session', 'horizon_date', :'today',
    'flat_band_pct', 0.3, 'stance', 'up', 'headline_ja', '上がるとみます', 'reasons_ja', '米国株高のため', 'scenario_ja', '前場は高く始まりそう',
    'counter_ja', '円高', 'invalidation_ja', '9時台に下げたら', 'claim_ids', '["LEAK-yume-claim"]'::jsonb)),
  '2026-10-13T22:40:00Z') as v2_morning \gset

-- V2 の大引け（前日）: 答え合わせつき。朝刊のパケットの ID・帯・実際の前日比の数値は返さない。
select fx.market('close', (:'today'::date - 1), jsonb_build_object(
  'presentation_version', 'market_presentation.v2',
  'app_story', jsonb_build_object('summary_ja', 'まとめ', 'japan_ja', '東京の話'),
  'yume', jsonb_build_object('version', 'yume.v1', 'target', 'nikkei225', 'horizon', 'next_session', 'horizon_date', null,
    'flat_band_pct', 0.3, 'stance', 'flat', 'headline_ja', '様子見', 'reasons_ja', '材料待ち',
    'counter_ja', '', 'invalidation_ja', '',
    'review', jsonb_build_object('verdict', 'hit', 'reason_code', 'COMPARED', 'morning_report_packet_id', 'LEAK-morning-packet',
      'morning_stance', 'up', 'morning_headline_ja', '上がるとみます', 'flat_band_pct', 0.3, 'actual_change_pct', 1.0,
      'actual_change_display', '+1.00%', 'actual_session_date', '2026-10-09', 'text_ja', '当たりました'))),
  '2026-10-09T06:40:00Z') as v2_close \gset

-- V1 の形の回（前日の朝刊）: 足した項目は無い。
select fx.market('morning', (:'today'::date - 1), '{}'::jsonb, '2026-10-08T22:40:00Z') as v1_morning \gset
-- 形の違う回（2日前の朝刊）: yume が文字列、app_story が配列、session_views がオブジェクト、帯が文字列。
select fx.market('morning', (:'today'::date - 2), jsonb_build_object(
  'app_story', '["LEAK-story-array"]'::jsonb, 'session_views', '{"market":"LEAK-session-object"}'::jsonb,
  'yume', 'LEAK-yume-string'), '2026-10-07T22:40:00Z') as odd_morning \gset
-- yume はあるが答え合わせ・scenario_ja が無い、帯が文字列（3日前の大引け）。
select fx.market('close', (:'today'::date - 3), jsonb_build_object(
  'yume', jsonb_build_object('horizon', 'next_session', 'stance', 'down', 'flat_band_pct', '0.3', 'headline_ja', 'h', 'reasons_ja', 'r',
    'counter_ja', 'c', 'invalidation_ja', 'i', 'review', 'LEAK-review-string')), '2026-10-06T06:40:00Z') as partial_close \gset

-- ---------------------------------------------------------------------------
-- 1. V2 の朝刊: 足した項目を、公開してよい形で返す
-- ---------------------------------------------------------------------------
select fx.call_as(:'a', 'authenticated', $$select public.get_app_market_report('morning')::text$$)::jsonb as feed \gset
select fx.eq((:'feed'::jsonb) ->> 'status', 'completed', 'v2 morning completed');
select fx.eq(fx.keys(:'feed'::jsonb),
  'app_story,claims,data_gaps_ja,data_generated_at,fact_status,generated_at,headline_ja,is_today,key_news,major_moves,market_direction,market_summary_ja,next_watch_ja,points_ja,presentation_version,report_packet_id,report_type,risks_ja,session_views,status,strong_themes,today,trading_date,weak_themes,yume',
  'v2 top-level keys (V1 keys unchanged + additive keys only)');
select fx.eq((:'feed'::jsonb) ->> 'presentation_version', 'market_presentation.v2', 'presentation_version');
select fx.jeq((:'feed'::jsonb) -> 'app_story', jsonb_build_object('summary_ja', '要約のお話', 'overseas_ja', '米国の話', 'japan_ja', '日本の話',
  'cross_asset_ja', '為替の話', 'news_ja', 'ニュースの話', 'strong_ja', '強いテーマの話', 'caution_ja', '注意の話', 'watch_ja', '注目の話'), 'app_story projected');
select fx.jeq((:'feed'::jsonb) -> 'session_views',
  '[{"market":"us","session_date":"2026-10-08","direction":"up"},{"market":"tokyo","session_date":"2026-10-09","direction":"down"}]'::jsonb,
  'session_views without basis, non-objects dropped');
select fx.jeq((:'feed'::jsonb) -> 'major_moves',
  '[{"metric_key":"nikkei225","label":"日経平均","session_date":"2026-10-09","value_display":"40,000","change_pct_display":"+1.0%","freshness":"fresh"},{"metric_key":"usdjpy","label":"ドル円","session_date":"2026-10-08","value_display":"150.00円","change_pct_display":null,"freshness":"stale"}]'::jsonb,
  'major_moves keep V1 keys and add metric_key');
select fx.jeq((:'feed'::jsonb) -> 'yume', jsonb_build_object('stance', 'up', 'horizon', 'this_session', 'horizon_date', :'today', 'flat_band_pct', 0.3,
  'headline_ja', '上がるとみます', 'reasons_ja', '米国株高のため', 'scenario_ja', '前場は高く始まりそう', 'counter_ja', '円高',
  'invalidation_ja', '9時台に下げたら', 'review', null), 'yume projected (morning)');
select fx.eq((:'feed'::jsonb) ->> 'data_generated_at', '2026-10-13T22:40:00Z', 'data_generated_at from market_data_packets.generated_at (UTC)');
-- V1 の項目は変わらない。
select fx.eq((:'feed'::jsonb) ->> 'headline_ja', '見出し', 'v1 headline');
select fx.eq((:'feed'::jsonb) ->> 'generated_at', '2026-10-09T23:05:00Z', 'v1 generated_at');
select fx.jeq((:'feed'::jsonb) -> 'claims', '[{"text_ja":"上昇","claim_type":"observation","scope":"today"}]'::jsonb, 'v1 claims');
select fx.jeq((:'feed'::jsonb) -> 'key_news', '[{"headline_ja":"ニュース","why_it_matters_ja":"理由","scope":"broad"}]'::jsonb, 'v1 key_news');
select fx.jeq((:'feed'::jsonb) -> 'points_ja', '["p1"]'::jsonb, 'v1 points');
select fx.eq((:'feed'::jsonb) ->> 'report_packet_id', :'v2_morning', 'v1 report_packet_id');

-- ---------------------------------------------------------------------------
-- 2. V2 の大引け: 答え合わせは公開してよい項目だけ
-- ---------------------------------------------------------------------------
select fx.call_as(:'a', 'authenticated', $$select public.get_app_market_report('close')::text$$)::jsonb as close_feed \gset
select fx.eq((:'close_feed'::jsonb) ->> 'trading_date', (:'today'::date - 1)::text, 'latest close is yesterday');
select fx.jeq((:'close_feed'::jsonb) -> 'yume', jsonb_build_object('stance', 'flat', 'horizon', 'next_session', 'horizon_date', null, 'flat_band_pct', 0.3,
  'headline_ja', '様子見', 'reasons_ja', '材料待ち', 'scenario_ja', '', 'counter_ja', '', 'invalidation_ja', '',
  'review', jsonb_build_object('verdict', 'hit', 'reason_code', 'COMPARED', 'morning_stance', 'up', 'morning_headline_ja', '上がるとみます',
    'actual_change_display', '+1.00%', 'actual_session_date', '2026-10-09', 'text_ja', '当たりました')), 'yume with review (close)');
select fx.jeq((:'close_feed'::jsonb) -> 'app_story', jsonb_build_object('summary_ja', 'まとめ', 'overseas_ja', '', 'japan_ja', '東京の話',
  'cross_asset_ja', '', 'news_ja', '', 'strong_ja', '', 'caution_ja', '', 'watch_ja', ''), 'missing story fields are empty strings');
select fx.jeq((:'close_feed'::jsonb) -> 'session_views', '[]'::jsonb, 'no session_views -> []');
select fx.eq((:'close_feed'::jsonb) ->> 'data_generated_at', '2026-10-09T06:40:00Z', 'close data_generated_at');

-- ---------------------------------------------------------------------------
-- 3. V1 の形の回・形の違う回は、足した項目が null / [] で、従来の項目はそのまま
-- ---------------------------------------------------------------------------
select fx.call_as(:'a', 'authenticated', format($$select public.get_app_market_report('morning', %L)::text$$, (:'today'::date - 1)))::jsonb as old_feed \gset
select fx.eq((:'old_feed'::jsonb) ->> 'status', 'completed', 'old packet completed');
select fx.eq(jsonb_typeof((:'old_feed'::jsonb) -> 'yume'), 'null', 'old packet: yume null');
select fx.eq(jsonb_typeof((:'old_feed'::jsonb) -> 'app_story'), 'null', 'old packet: app_story null');
select fx.eq(jsonb_typeof((:'old_feed'::jsonb) -> 'presentation_version'), 'null', 'old packet: presentation_version null');
select fx.jeq((:'old_feed'::jsonb) -> 'session_views', '[]'::jsonb, 'old packet: session_views []');
select fx.eq((:'old_feed'::jsonb) ->> 'data_generated_at', '2026-10-08T22:40:00Z', 'old packet: data_generated_at');
select fx.eq((:'old_feed'::jsonb) #>> '{major_moves,0,metric_key}', 'nikkei225', 'old packet: metric_key');
select fx.eq((:'old_feed'::jsonb) ->> 'headline_ja', '見出し', 'old packet: headline unchanged');

select fx.call_as(:'a', 'authenticated', format($$select public.get_app_market_report('morning', %L)::text$$, (:'today'::date - 2)))::jsonb as odd_feed \gset
select fx.eq((:'odd_feed'::jsonb) ->> 'status', 'completed', 'malformed v2 fields do not break the report');
select fx.eq(jsonb_typeof((:'odd_feed'::jsonb) -> 'yume'), 'null', 'yume string -> null');
select fx.eq(jsonb_typeof((:'odd_feed'::jsonb) -> 'app_story'), 'null', 'app_story array -> null');
select fx.jeq((:'odd_feed'::jsonb) -> 'session_views', '[]'::jsonb, 'session_views object -> []');

select fx.call_as(:'a', 'authenticated', format($$select public.get_app_market_report('close', %L)::text$$, (:'today'::date - 3)))::jsonb as partial_feed \gset
select fx.eq(jsonb_typeof((:'partial_feed'::jsonb) #> '{yume,review}'), 'null', 'review string -> null');
select fx.eq((:'partial_feed'::jsonb) #>> '{yume,scenario_ja}', '', 'missing scenario_ja -> empty string');
select fx.eq(jsonb_typeof((:'partial_feed'::jsonb) #> '{yume,flat_band_pct}'), 'null', 'non-number band -> null');
select fx.eq(jsonb_typeof((:'partial_feed'::jsonb) #> '{yume,horizon_date}'), 'null', 'absent horizon_date -> null');

-- ---------------------------------------------------------------------------
-- 4. 内部の項目は返さない（どの回でも）
-- ---------------------------------------------------------------------------
select fx.eq(position('LEAK' in (:'feed' || :'close_feed' || :'old_feed' || :'odd_feed' || :'partial_feed'))::text, '0', 'no internal value leaks');
select fx.eq(position(w in (:'feed' || :'close_feed' || :'old_feed' || :'odd_feed' || :'partial_feed'))::text, '0', 'no internal key: ' || w)
  from unnest(array['evidence_refs', 'ref_id', 'morning_report_packet_id', 'model', 'removed_units', 'quality_warnings', 'claim_id',
    'basis', 'local_issues', 'api_cost', 'content_hash', 'data_packet_id', 'actual_change_pct', 'yume.v1', 'target', 'x_post', 'claim_ids', 'extra_internal']) as w;

-- ---------------------------------------------------------------------------
-- 5. 認証・権限・ゲートは V1 のまま
-- ---------------------------------------------------------------------------
select fx.like(fx.call_as(null, 'anon', $$select public.get_app_market_report('morning')::text$$), 'ERR:permission denied%', 'anon cannot execute');
select fx.like(fx.call_as(null, 'service_role', $$select public.get_app_market_report('morning')::text$$), 'ERR:permission denied%', 'service_role cannot execute');
select fx.like(fx.call_as(null, 'authenticated', $$select public.get_app_market_report('morning')::text$$), 'ERR:APP_MARKET_REPORT_NOT_AUTHENTICATED%', 'needs a user');
select fx.like(fx.call_as(:'a', 'authenticated', $$select public.get_app_market_report('weekly')::text$$), 'ERR:APP_MARKET_REPORT_INVALID_ARGUMENT%', 'bad type refused');
select fx.like(fx.call_as(:'a', 'authenticated', format($$select public.get_app_market_report('close', %L)::text$$, (:'today'::date + 1))), 'ERR:APP_MARKET_REPORT_INVALID_ARGUMENT%', 'future date refused');
select fx.eq(fx.call_as(:'a', 'authenticated', format($$select public.get_app_market_report('close', %L)::text$$, (:'today'::date - 5)))::jsonb ->> 'status', 'missing', 'missing date');
select fx.like(fx.call_as(:'a', 'authenticated', $$select count(*)::text from public.market_report_packets$$), 'ERR:permission denied%', 'packets not directly readable');
select fx.like(fx.call_as(:'a', 'authenticated', $$select count(*)::text from public.market_data_packets$$), 'ERR:permission denied%', 'data packets not directly readable');
update public.personalized_ondemand_settings set public_market_feed_enabled = false;
select fx.eq(fx.call_as(:'a', 'authenticated', $$select public.get_app_market_report('morning')::text$$), '{"status": "disabled"}', 'feed gate off');
update public.personalized_ondemand_settings set public_market_feed_enabled = true;
select fx.eq((select p.prosecdef::text || '/' || p.provolatile::text || '/' || array_to_string(p.proconfig, ',')
  from pg_proc p where p.oid = 'public.get_app_market_report(text,date)'::regprocedure), 'true/s/search_path=""', 'security definer, stable, empty search_path');

select 'APP_MARKET_REPORT_STORY_V2_BEHAVIOR_PASS';
