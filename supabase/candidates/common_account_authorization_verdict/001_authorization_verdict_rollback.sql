-- Rollback of 001_authorization_verdict.sql: drops the three read-only functions. Nothing else was created; no data to keep. A caller that needs
-- them then fails, which the consumers treat as "G5 unreachable" (send 0).
begin;
set local lock_timeout = '5s';
drop function if exists public.common_account_worker_brand_verdict(text, text, bigint, timestamptz);
drop function if exists private.account_lifecycle_worker_brand_verdict(text, text, bigint, timestamptz);
drop function if exists public.common_account_authorization_verdict(text, text, text);
commit;
