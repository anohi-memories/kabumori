-- AI provider budget ledger rollout: READ-ONLY proof of WHICH project this connection reaches (Phase 1d gate).
--
-- The rollout runner runs it before every step and again right before the migration, and compares it with
-- AIL_ROLLOUT_REF (ai_provider_budget_ledger_gate.py identity <ref>); anything but an exact match stops it before any
-- write. Two independent bindings:
--   * to the project ref: this project's own pg_cron jobs call its Edge Functions at https://<ref>.supabase.co/...
--     (important-news-monitor, send-push-notifications, market-intelligence-*), so the refs found in cron.job must
--     be exactly {AIL_ROLLOUT_REF};
--   * to the product: Kabumori / POSTONA / common-account objects and applied history rows that another project
--     (the family photo app, a disposable test project, a local database) does not have.
-- Only booleans, counts and 20-letter project refs are printed: never a job command, a secret or a row. Needs
-- cron.job and supabase_migrations.schema_migrations (the statement fails without them, which also stops the runner).
select jsonb_build_object(
  'database', current_database(),
  'cron_jobs', (select count(*) from cron.job),
  'cron_project_refs', (select coalesce(jsonb_agg(distinct m[1] order by m[1]), '[]'::jsonb)
                          from cron.job j
                          cross join lateral regexp_matches(j.command, 'https://([a-z]{20})\.supabase\.co', 'g') m),
  -- Catalog lookups (not to_regclass): they need no USAGE on the schema, so the answer never depends on grants.
  'product_markers', (select jsonb_object_agg(m.name, exists (
                          select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname || '.' || c.relname = m.name and c.relkind in ('r', 'p')))
                        from unnest(array['public.profiles', 'public.brands', 'public.social_accounts', 'public.common_accounts',
                                          'public.service_entitlements', 'private.account_lifecycle_operations']) m(name)),
  'history_markers', (select jsonb_build_object(
    '20261001150000_common_account_lifecycle_foundation', coalesce(bool_or(m.version = '20261001150000'), false),
    '20261006230000_common_account_service_start_intent', coalesce(bool_or(m.version = '20261006230000'), false))
    from supabase_migrations.schema_migrations m)
) as result;
