-- G5 SOURCE CANDIDATE rollback (2026-10-21, Issue #320 G5-01 task 10): drops the session-only verdict of 003_session_verdict.sql ONLY.
-- R0 (002) and R1 / W1 / W2 / GC (001) stay. Never run against a managed or production database without the same approvals as the install.
begin;
drop function if exists private.account_lifecycle_session_verdict();
commit;
