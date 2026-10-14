-- アプリ向けの共通朝刊・大引け: お話（app_story）とゆめちゃんの見立て（yume）を返す V2（2026-10-14）
-- — 未適用のソース候補。本番には別承認まで適用しない。
-- 前提: 20261011150000_personalized_ondemand_analysis_v1 の後に適用する（同じ関数を置き換えるだけ）。
--
-- 何をするか
--   get_app_market_report(text, date) を、同じ引数・同じ返り値の型・同じ権限（security definer、search_path = ''）・
--   同じ認証／引数／ゲート／回の選び方のまま置き換え、完成した回の返り値に「公開してよい項目」だけを足す。
--     presentation_version … 共通の分析の表示の版（無い回は null）
--     app_story            … AI が書いた市況のお話（8つの文章だけ。無い回は null）
--     session_views        … 市場ごとの方向（market・session_date・direction だけ。根拠の basis は返さない。無い回は []）
--     major_moves[].metric_key … 指標の種類（東京・米国・その他に分けて表示するため）
--     yume                 … ゆめちゃん（AI）の見立て（意見。事実の項目とは分けて返す。無い回は null）
--                            答え合わせ（review）は、判定・理由のコード・朝の見立て・実際の前日比・その日・ことばだけ。
--     data_generated_at    … 元の市場データを取得した時刻（market_data_packets.generated_at、UTC の ISO 8601）
--   既存の項目は1つも変えない。
-- 何をしないか
--   表・権限・方針・他の関数は変えない。根拠の ref（evidence_refs・ref_id・claim_id）、Fact の内部の指摘
--   （removed_units・quality_warnings・local_issues）、モデル名、費用、ハッシュ、朝刊のパケットの ID は返さない。

begin;

do $$
begin
  if to_regclass('public.personalized_ondemand_settings') is null
     or to_regclass('public.market_report_cycles') is null or to_regclass('public.market_report_packets') is null
     or to_regclass('public.market_data_packets') is null
     or to_regprocedure('public.get_app_market_report(text,date)') is null then
    raise exception 'APP_MARKET_REPORT_STORY_V2_PREFLIGHT_V1_MISSING';
  end if;
end
$$;

create or replace function public.get_app_market_report(p_report_type text, p_trading_date date default null)
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
  v_story jsonb;
  v_yume jsonb;
  v_review jsonb;
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

  -- V2 で足す項目は、形が想定どおりのときだけ読む（古い回・形の違う回は null / [] にして、画面は従来どおり描く）。
  if pg_catalog.jsonb_typeof(v_payload -> 'app_story') = 'object' then
    v_story := v_payload -> 'app_story';
  end if;
  if pg_catalog.jsonb_typeof(v_payload -> 'yume') = 'object' then
    v_yume := v_payload -> 'yume';
    if pg_catalog.jsonb_typeof(v_yume -> 'review') = 'object' then
      v_review := v_yume -> 'review';
    end if;
  end if;

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
        'session_date', m -> 'session_date', 'freshness', m -> 'freshness', 'metric_key', m -> 'metric_key'))
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
    'fact_status', coalesce(v_payload #>> '{fact,ai_status}', 'passed'),
    -- ここから V2 の追加（公開してよい項目だけ）。
    'presentation_version', v_payload ->> 'presentation_version',
    'app_story', case when v_story is not null then jsonb_build_object(
      'summary_ja', coalesce(v_story ->> 'summary_ja', ''),
      'overseas_ja', coalesce(v_story ->> 'overseas_ja', ''),
      'japan_ja', coalesce(v_story ->> 'japan_ja', ''),
      'cross_asset_ja', coalesce(v_story ->> 'cross_asset_ja', ''),
      'news_ja', coalesce(v_story ->> 'news_ja', ''),
      'strong_ja', coalesce(v_story ->> 'strong_ja', ''),
      'caution_ja', coalesce(v_story ->> 'caution_ja', ''),
      'watch_ja', coalesce(v_story ->> 'watch_ja', '')) end,
    'session_views', coalesce((
      select jsonb_agg(jsonb_build_object('market', s -> 'market', 'session_date', s -> 'session_date', 'direction', s -> 'direction'))
      from jsonb_array_elements(case when pg_catalog.jsonb_typeof(v_payload -> 'session_views') = 'array'
                                     then v_payload -> 'session_views' else '[]'::jsonb end) as s
      where pg_catalog.jsonb_typeof(s) = 'object'), '[]'::jsonb),
    'yume', case when v_yume is not null then jsonb_build_object(
      'stance', v_yume ->> 'stance',
      'horizon', v_yume ->> 'horizon',
      'horizon_date', v_yume ->> 'horizon_date',
      'flat_band_pct', case when pg_catalog.jsonb_typeof(v_yume -> 'flat_band_pct') = 'number' then v_yume -> 'flat_band_pct' end,
      'headline_ja', v_yume ->> 'headline_ja',
      'reasons_ja', v_yume ->> 'reasons_ja',
      'scenario_ja', coalesce(v_yume ->> 'scenario_ja', ''),
      'counter_ja', v_yume ->> 'counter_ja',
      'invalidation_ja', v_yume ->> 'invalidation_ja',
      'review', case when v_review is not null then jsonb_build_object(
        'verdict', v_review ->> 'verdict',
        'reason_code', v_review ->> 'reason_code',
        'morning_stance', v_review ->> 'morning_stance',
        'morning_headline_ja', v_review ->> 'morning_headline_ja',
        'actual_change_display', v_review ->> 'actual_change_display',
        'actual_session_date', v_review ->> 'actual_session_date',
        'text_ja', v_review ->> 'text_ja') end) end,
    'data_generated_at', (
      select pg_catalog.to_char(d.generated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        from public.market_data_packets d where d.id = v_report.data_packet_id)
  );
end
$$;

-- 権限は V1 と同じ（create or replace は権限を保つが、明示して読み手に分かるようにする）。
revoke all on function public.get_app_market_report(text, date) from public, anon, service_role;
grant execute on function public.get_app_market_report(text, date) to authenticated;

commit;
