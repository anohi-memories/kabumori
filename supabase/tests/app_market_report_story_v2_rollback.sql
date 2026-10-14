-- 20261014100000_app_market_report_story_v2 の取り消し（別承認待ち・未実行）。
-- get_app_market_report を V1（20261011150000_personalized_ondemand_analysis_v1）と1文字も違わない本文に戻す。
-- 表・データには触れない。手元の検証（app_market_report_story_v2_run.sh）で、取り消したあとの定義と権限が
-- V2 の適用前と完全に一致することを確かめている。
begin;

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
        'session_date', m -> 'session_date', 'freshness', m -> 'freshness'))
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
    'fact_status', coalesce(v_payload #>> '{fact,ai_status}', 'passed')
  );
end
$$;

revoke all on function public.get_app_market_report(text, date) from public, anon, service_role;
grant execute on function public.get_app_market_report(text, date) to authenticated;
commit;
