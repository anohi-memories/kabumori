-- 03 (read-only, counts only): lifecycle state that decides whether an apply window is safe.
select jsonb_build_object(
  'settings', (select jsonb_agg(auth_delete_guard || '/' || integration_state || '/' || requirement_epoch) from private.account_lifecycle_settings),
  'accounts', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from public.common_accounts group by 1) a),
  'entitlements', (select coalesce(jsonb_object_agg(service_key || '/' || status || '/' || source, n), '{}')
                     from (select service_key, status, source, count(*) n from public.service_entitlements group by 1, 2, 3) e),
  'operations', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from private.account_lifecycle_operations group by 1) o),
  'logins_without_account', (select count(*) from auth.users u where not exists (select 1 from public.common_accounts a where a.user_id = u.id)),
  'long_open_transactions', (select count(*) from pg_stat_activity where datname = current_database() and xact_start < now() - interval '1 minute')
) as result;
