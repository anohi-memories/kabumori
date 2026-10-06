-- Common-account Phase 1 backfill: the ONE production write transaction (NOT run without explicit approval).
-- Calls only the reviewed private.account_lifecycle_backfill(true), inside one transaction that refuses to
-- commit unless the state before and after matches the approved dry-run exactly. Any mismatch, lock
-- timeout or error raises; with ON_ERROR_STOP psql exits 3 and the transaction is rolled back.
-- Output: "label=<json>" lines with aggregate counts only.
--
-- Required psql variables (the approved dry-run, frozen in the approval package):
--   exp_auth_users exp_accounts_to_create exp_kab_to_create exp_kab_activity exp_kab_profile_only
--   exp_x_to_create exp_x_verified exp_x_pending exp_x_excluded_admin exp_auth_only
-- Precondition asserted here: no common account, entitlement or lifecycle operation exists yet.
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
begin isolation level read committed;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
set local search_path = pg_catalog, public;

-- 1. Precondition: foundation state and an empty population, exactly as approved.
select (select count(*) = 1 from private.account_lifecycle_settings
         where auth_delete_guard = 'shadow' and integration_state = 'not_started')
   and (select count(*) = 0 from public.common_accounts)
   and (select count(*) = 0 from public.service_entitlements)
   and (select count(*) = 0 from private.account_lifecycle_operations) as pre_state_ok \gset
\if :pre_state_ok
\else
  select 'STOP=' || '{"reason":"BACKFILL_PRECONDITION_STATE"}';
  do $$ begin raise exception 'BACKFILL_PRECONDITION_STATE'; end $$;
\endif

-- 2. A fresh plan inside this transaction must equal the approved dry-run.
select private.account_lifecycle_backfill(false) as plan \gset
select 'plan=' || :'plan';
select (:'plan'::jsonb ->> 'auth_users')::int = :exp_auth_users
   and (:'plan'::jsonb ->> 'common_accounts_to_create')::int = :exp_accounts_to_create
   and (:'plan'::jsonb ->> 'kabumori_to_create')::int = :exp_kab_to_create
   and (:'plan'::jsonb ->> 'kabumori_with_activity')::int = :exp_kab_activity
   and (:'plan'::jsonb ->> 'kabumori_profile_only')::int = :exp_kab_profile_only
   and (:'plan'::jsonb ->> 'x_autopost_to_create')::int = :exp_x_to_create
   and (:'plan'::jsonb ->> 'x_autopost_identity_verified')::int = :exp_x_verified
   and (:'plan'::jsonb ->> 'x_autopost_workspace_pending')::int = :exp_x_pending
   and (:'plan'::jsonb ->> 'x_autopost_excluded_admin')::int = :exp_x_excluded_admin
   and (:'plan'::jsonb ->> 'auth_only')::int = :exp_auth_only
   and (:'plan'::jsonb ->> 'not_active_accounts_with_candidates')::int = 0 as plan_ok \gset
\if :plan_ok
\else
  select 'STOP=' || '{"reason":"BACKFILL_PLAN_CHANGED"}';
  do $$ begin raise exception 'BACKFILL_PLAN_CHANGED'; end $$;
\endif

-- 3. The write: the reviewed function only.
select private.account_lifecycle_backfill(true) as result \gset
select 'result=' || :'result';

-- 4. Postcondition inside the same transaction; nothing is committed unless all of it holds.
select (:'result'::jsonb ->> 'applied')::boolean
   and (:'result'::jsonb ->> 'created_common_accounts')::int = :exp_accounts_to_create
   and (:'result'::jsonb ->> 'created_kabumori')::int = :exp_kab_to_create
   and (:'result'::jsonb ->> 'created_x_autopost')::int = :exp_x_to_create
   and (:'result'::jsonb ->> 'skipped_account_not_active')::int = 0
   and (select count(*) from public.common_accounts) = :exp_auth_users
   and (select count(*) from public.common_accounts where status = 'active') = :exp_auth_users
   and (select count(*) from auth.users u where not exists (select 1 from public.common_accounts c where c.user_id = u.id)) = 0
   and (select count(*) from public.service_entitlements) = :exp_kab_to_create + :exp_x_to_create
   and (select count(*) from public.service_entitlements
         where status <> 'active' or source <> 'legacy_backfill' or activated_at is null or ended_at is not null) = 0
   and (select count(*) from public.service_entitlements where service_key = 'kabumori' and legacy_evidence = 'kabumori_activity') = :exp_kab_activity
   and (select count(*) from public.service_entitlements where service_key = 'kabumori' and legacy_evidence = 'kabumori_profile_only') = :exp_kab_profile_only
   and (select count(*) from public.service_entitlements where service_key = 'x_autopost' and legacy_evidence = 'x_identity_verified') = :exp_x_verified
   and (select count(*) from public.service_entitlements where service_key = 'x_autopost' and legacy_evidence = 'x_workspace_pending') = :exp_x_pending
   and (select count(*) from public.service_entitlements e join public.admin_users a on a.user_id = e.user_id
         where e.service_key = 'x_autopost') = 0
   and (select count(*) from public.common_accounts c
         where not exists (select 1 from public.service_entitlements e where e.user_id = c.user_id)) = :exp_auth_only
   and (select count(*) from public.common_accounts c
         where c.lifecycle_version <> 1 + (select count(*) from public.service_entitlements e where e.user_id = c.user_id)) = 0
   and (select count(*) from private.account_lifecycle_operations) = 0
   and (select count(*) = 1 from private.account_lifecycle_settings
         where auth_delete_guard = 'shadow' and integration_state = 'not_started') as post_ok \gset
\if :post_ok
\else
  select 'STOP=' || '{"reason":"BACKFILL_POSTCONDITION"}';
  do $$ begin raise exception 'BACKFILL_POSTCONDITION'; end $$;
\endif

-- 5. Idempotence inside the transaction: nothing is left to create.
select private.account_lifecycle_backfill(false) as after \gset
select 'after=' || :'after';
select (:'after'::jsonb ->> 'common_accounts_to_create')::int = 0
   and (:'after'::jsonb ->> 'kabumori_to_create')::int = 0
   and (:'after'::jsonb ->> 'x_autopost_to_create')::int = 0 as after_ok \gset
\if :after_ok
\else
  select 'STOP=' || '{"reason":"BACKFILL_NOT_IDEMPOTENT"}';
  do $$ begin raise exception 'BACKFILL_NOT_IDEMPOTENT'; end $$;
\endif

commit;
select 'COMMITTED=' || jsonb_build_object(
  'common_accounts', (select count(*) from public.common_accounts),
  'entitlements', (select count(*) from public.service_entitlements),
  'operations', (select count(*) from private.account_lifecycle_operations))::text;
