-- Rollback of 20261017120000_ai_consumer_call_store.sql (operator use only; never a migration).
-- Removes exactly what the migration created and DESTROYS the call store: every in-flight claim and stored result
-- is lost, so a retried operationId would be sent again. Stop every bridge caller first. The ledger is untouched.
-- Run it BEFORE any rollback of the ledger (20261010050613): the call-store RPCs read ai_ledger tables.
-- The proof runner checks that the catalog digest after this script equals the digest before the migration.
set client_min_messages = warning;
begin;
drop function public.ai_calls_claim(jsonb);
drop function public.ai_calls_complete(jsonb);
drop function public.ai_calls_abandon(jsonb);
drop function public.ai_calls_purge_content(jsonb);
drop function public.ai_calls_forget_user(jsonb);
drop schema ai_calls cascade;
commit;
