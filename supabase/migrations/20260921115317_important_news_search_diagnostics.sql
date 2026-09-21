-- Additive, privacy-minimal diagnostics for targeted Responses API searches.
-- Existing rows remain NULL (not retroactively treated as observed zeroes).
-- RLS and grants are intentionally unchanged; no prompt/query/response data is stored.

alter table public.important_news_shadow_runs
  add column targeted_search_attempt_count integer check (targeted_search_attempt_count >= 0),
  add column targeted_search_success_count integer check (targeted_search_success_count >= 0),
  add column targeted_search_failure_count integer check (targeted_search_failure_count >= 0),
  add column web_search_output_item_count integer check (web_search_output_item_count >= 0),
  add column web_search_action_search_count integer check (web_search_action_search_count >= 0),
  add column web_search_action_open_page_count integer check (web_search_action_open_page_count >= 0),
  add column web_search_action_find_in_page_count integer check (web_search_action_find_in_page_count >= 0),
  add column web_search_action_unknown_count integer check (web_search_action_unknown_count >= 0);

alter table public.ai_usage_events
  add column targeted_search_attempt_count integer check (targeted_search_attempt_count >= 0),
  add column targeted_search_success_count integer check (targeted_search_success_count >= 0),
  add column targeted_search_failure_count integer check (targeted_search_failure_count >= 0),
  add column web_search_output_item_count integer check (web_search_output_item_count >= 0),
  add column web_search_action_search_count integer check (web_search_action_search_count >= 0),
  add column web_search_action_open_page_count integer check (web_search_action_open_page_count >= 0),
  add column web_search_action_find_in_page_count integer check (web_search_action_find_in_page_count >= 0),
  add column web_search_action_unknown_count integer check (web_search_action_unknown_count >= 0);

comment on column public.important_news_shadow_runs.targeted_search_attempt_count is
  'Number of targeted Responses API POST attempts initiated during the run; not a billable-unit count.';
comment on column public.important_news_shadow_runs.targeted_search_success_count is
  'Number of targeted Responses API attempts yielding a successful HTTP response and parseable JSON.';
comment on column public.important_news_shadow_runs.targeted_search_failure_count is
  'Number of targeted Responses API attempts that failed by HTTP status, transport, timeout, or response parsing.';
comment on column public.important_news_shadow_runs.web_search_output_item_count is
  'Count of web_search_call output items across successful targeted responses; not provider billing units.';
comment on column public.ai_usage_events.targeted_search_attempt_count is
  'Per-run targeted Responses API POST attempt aggregate; one ai_usage_events row remains one run aggregate.';
comment on column public.ai_usage_events.web_search_output_item_count is
  'Per-run count of web_search_call output items; not provider billing units.';
