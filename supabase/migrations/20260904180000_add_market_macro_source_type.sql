-- Important news P0: allow the new market_macro source_type (BOJ/Fed/USTR/UN/EIA lane), separate from
-- the existing corporate (tdnet/company_ir) lane. No other constraint changes: source_priority stays 1
-- for market_macro (identical to tdnet/company_ir under the existing consistency check), and every
-- category market_macro candidates use (boj, frb, interest_rates, fx, tariffs, china_policy,
-- us_government_policy, geopolitics, war_ceasefire, sanctions, other_market_moving) already exists.
alter table public.important_news_candidates
  drop constraint if exists important_news_candidates_source_type_check;

alter table public.important_news_candidates
  add constraint important_news_candidates_source_type_check
  check (source_type in ('tdnet', 'company_ir', 'market_macro', 'primary', 'secondary'));
