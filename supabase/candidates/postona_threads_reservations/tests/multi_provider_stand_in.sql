-- TEST STAND-IN (postona_threads_reservations_run.sh only, disposable DB): the platform rule of the reviewed 2a-2
-- multi-provider migration (supabase/migrations/20261007150000_postona_social_accounts_multi_provider.sql: platform in
-- x / threads / instagram), which refuses to apply on this test baseline's social_accounts shape. 2a-2's rule
-- "Threads rows cannot be publish-enabled" is deliberately NOT stood in: it models the later, separately reviewed lift
-- that a Threads publish path needs (G4). Never applied anywhere else.
alter table public.social_accounts drop constraint social_accounts_platform_check;
alter table public.social_accounts add constraint social_accounts_platform_supported check (platform in ('x', 'threads', 'instagram'));
