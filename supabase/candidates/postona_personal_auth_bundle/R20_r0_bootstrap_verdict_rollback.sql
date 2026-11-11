-- Rollback of 002_bootstrap_verdict.sql: drops R0 only. Nothing else was created; no data. A caller that needs it then fails, which G4 treats as
-- "G5 unreachable" (no begin, nothing exchanged).
begin;
set local lock_timeout = '5s';
drop function if exists public.common_account_bootstrap_verdict(text, text);
commit;
