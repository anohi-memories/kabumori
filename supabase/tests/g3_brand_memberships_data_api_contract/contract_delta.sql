-- G3 TASK 23/50 (Issue #318) TEST-ONLY CONTRACT MODEL. NOT a migration and NOT a source candidate: it exists so that
-- contract_run.sh can check the minimum-privilege contract proposed for public.brand_memberships (G3-20 / G3-21 T-1) on a
-- throw-away local PostgreSQL. Who writes the real migration, and whether service_role keeps any table privilege, are
-- undecided (G3-22 Q1, G3-21 U-1..U-6). Applied by the table owner, after the table's own DDL, in one transaction.
--
-- The contract: the ACL does not depend on the default privileges of the day (R-2 / R-3) -- revoke everything from the API
-- roles and PUBLIC, then grant only SELECT to authenticated (rows decided by the self-select policy). service_role gets NO
-- table privilege: no code path uses it (G3-21); writers are table-owner SECURITY DEFINER functions and FK cascades.
revoke all on table public.brand_memberships from public, anon, authenticated, service_role;
grant select on table public.brand_memberships to authenticated;
