-- Market Intelligence Core (MIC) Macro Indicators Phase 1B: Japan CPI /
-- Core CPI via e-Stat (政府統計の総合窓口).
--
-- Pure data seed -- no schema change (no ALTER anywhere in this file).
-- category='macro' and domain='macro' were already valid CHECK values from
-- Phase 1A. This migration only registers a new source_key ('estat') and
-- 4 new mic_metric_domain_map rows for it, exactly like every prior MIC
-- source addition (FRED/MOF/EIA/Frankfurter, then FRED Equity Index Phase
-- 1, then FRED Macro Phase 1A). No Cron job is added or changed by this
-- migration -- 'estat' is registered with is_active=false, the same safe
-- default every other source used before its own explicit activation
-- step.
--
-- ---------------------------------------------------------------------------
-- Source: e-Stat getStatsData API, statsDataId=0004052037 ("消費者物価指数
-- （2025年基準）", 2025-base CPI -- confirmed live via e-Stat's own news
-- announcement that this table's statsDataId changed with the 2026-08-21
-- base-year revision; the pre-revision 2020-base table has a DIFFERENT
-- statsDataId and is out of scope). Region cdArea=00000 (全国), item
-- codes cdCat01=0001 (総合) and 0161 (生鮮食品を除く総合) -- both
-- confirmed live via e-Stat's own dbview region/item picker for this
-- exact table, not guessed. requires_auth=true: e-Stat's appId is
-- mandatory for every call including metadata-only calls (confirmed live:
-- an unauthenticated getMetaInfo call returns
-- STATUS=100/"認証に失敗しました。アプリケーションIDを確認してください。").
--
-- ---------------------------------------------------------------------------
-- Material-change policy: same minimal-noise design as Macro Indicators
-- Phase 1A (US CPI/PCE/etc.) -- only the derived YoY metric of each
-- level+derived pair gets always_material=true (the figure media/investors
-- react to), while its level companion gets a conservative
-- pct_change_threshold instead. No blanket always_material across both
-- members of a pair, and no risk of a "duplicate AI dispatch" since a
-- domain-level State evaluation already collapses all of a domain's new
-- observations into one evaluation regardless of how many are
-- individually flagged material (confirmed by reading
-- mic_state_decision_logic.ts during Phase 1A).
--
-- ---------------------------------------------------------------------------
-- Freshness: Japan's national CPI is monthly, same cadence class as the
-- Phase 1A US monthly metrics (CPI/Core CPI/PCE/etc.) -- reuses the exact
-- same, already-derived values (see 20260922090000's header comment for
-- the full 2*Q+R derivation): expected_observation_lag_minutes=115200
-- (80 days), observation_stale_after_minutes=158400 (110 days). Japan's
-- national CPI publish lag (reference month -> release) is on the same
-- order as the US figures this formula was derived from (confirmed live:
-- 2026-08 data released 2026-09-17, a ~48-day lag from month start),
-- so no re-derivation is needed for this cadence class.
insert into public.mic_source_registry
  (source_key, category, display_name, provider, endpoint_url, source_kind, requires_auth,
   cost_tier, update_frequency_minutes, expected_delay_minutes, quality_tier, is_official, is_primary,
   is_active, reliability_notes)
values
  ('estat', 'macro', 'e-Stat (政府統計の総合窓口) -- 消費者物価指数(2025年基準)', 'e-Stat',
   'https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData', 'structured_api', true,
   'free', 1440, 1440, 'official', true, true,
   false, 'statsDataId=0004052037 (2025年基準消費者物価指数)。全国(cdArea=00000)の総合(0001)/生鮮食品を除く総合(0161)のみ実装。appId必須(ESTAT_APP_ID)、appIdなしではgetMetaInfo等メタ情報取得すら不可。月次公表のため低頻度Cronを想定。')
on conflict (source_key) do nothing;

insert into public.mic_metric_domain_map (
  metric_key, domain, display_name, pct_change_threshold, abs_change_threshold,
  always_material, expected_observation_lag_minutes, observation_stale_after_minutes
) values
  ('JP_CPI', 'macro', '日本CPI(全国・総合)', 0.3, null, false, 115200, 158400),
  ('JP_CPI_YOY', 'macro', '日本CPI前年比(全国・総合)', null, null, true, 115200, 158400),
  ('JP_CORE_CPI', 'macro', '日本コアCPI(全国・生鮮食品を除く総合)', 0.3, null, false, 115200, 158400),
  ('JP_CORE_CPI_YOY', 'macro', '日本コアCPI前年比(全国・生鮮食品を除く総合)', null, null, true, 115200, 158400)
on conflict (metric_key) do nothing;
