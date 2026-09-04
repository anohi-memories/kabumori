-- Important news P0.5: allow the new breaking_market source_type (OpenAI web_search-based lane),
-- independent of tdnet/company_ir (corporate) and market_macro (official RSS). source_priority stays 1
-- for breaking_market, same as the other non-'secondary' source types under the existing consistency
-- check. No category migration needed: every category breaking_market candidates use (tariffs,
-- geopolitics, fx, us_government_policy, china_policy, other_market_moving) already exists from P0.
alter table public.important_news_candidates
  drop constraint if exists important_news_candidates_source_type_check;

alter table public.important_news_candidates
  add constraint important_news_candidates_source_type_check
  check (source_type in ('tdnet', 'company_ir', 'market_macro', 'breaking_market', 'primary', 'secondary'));
