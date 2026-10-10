-- Rollback of 20261010050613_ai_provider_budget_ledger.sql (operator use only; never a migration).
-- Removes exactly what the migration created. It DESTROYS the ledger: export usage_events and
-- billing_observations first if they hold anything worth keeping. The proof runner checks that the catalog digest
-- after this script equals the digest before the migration.
set client_min_messages = warning;
begin;
drop function public.ai_ledger_reserve(jsonb);
drop function public.ai_ledger_mark_sent(jsonb);
drop function public.ai_ledger_settle(jsonb);
drop function public.ai_ledger_release(jsonb);
drop function public.ai_ledger_recover_stale(jsonb);
drop function public.ai_ledger_usage_summary(jsonb);
drop function public.ai_ledger_budget_status(jsonb);
drop schema ai_ledger cascade;
commit;
