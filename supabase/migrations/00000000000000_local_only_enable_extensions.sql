-- LOCAL DEVELOPMENT ONLY. Never apply to production.
--
-- Production Supabase already has pg_cron/pg_net enabled via the platform's own extension
-- management (not through a repo migration), so no committed migration ever creates them. A
-- fresh local `supabase start` database does not have them enabled, and the existing
-- 20260908110000_add_important_news_publish_ready_cron.sql migration (and others that touch
-- cron.job / net.http_post) fails locally with "relation \"cron.job\" does not exist" without
-- this. This file exists solely so `supabase db reset` can replay the full existing migration
-- history unmodified in the kabumori-multibrand local/offline worktree
-- (see docs/multibrand/README.md and docs/multibrand/ARCHITECTURE.md, Phase 1). It must never be
-- copied into the production checkout's supabase/migrations/, pushed to production, or merged to
-- main outside of this local-only development setup.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
