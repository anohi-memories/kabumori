-- Rollback for 20260928120000_news_discovery_observer.sql (observation-only objects).
-- Drops ONLY news_discovery_* objects; nothing else is touched. Observation data is lost.
begin;
drop function if exists public.news_discovery_begin_run(jsonb);
drop function if exists public.news_discovery_find_duplicates(jsonb);
drop function if exists public.news_discovery_insert_signals(jsonb);
drop function if exists public.news_discovery_recent_for_grouping(jsonb);
drop function if exists public.news_discovery_finish_run(jsonb);
drop function if exists public.news_discovery_reserve_search(jsonb);
drop function if exists public.news_discovery_complete_search(jsonb);
drop table if exists public.news_discovery_signal_entities;
drop table if exists public.news_discovery_signal_tickers;
drop table if exists public.news_discovery_signals;
drop table if exists public.news_discovery_searches;
drop table if exists public.news_discovery_search_config;
drop table if exists public.news_discovery_run_sources;
drop table if exists public.news_discovery_runs;
commit;
