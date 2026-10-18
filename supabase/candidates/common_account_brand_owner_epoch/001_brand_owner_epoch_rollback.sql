-- Rollback of 001_brand_owner_epoch.sql. It removes the write triggers and the functions, so the getter DISAPPEARS (a caller that needs it refuses, which is the
-- safe direction). It KEEPS private.account_lifecycle_brand_owner_epochs, its history guard trigger and the guard function: dropping the numbers would let an
-- earlier epoch repeat after a re-install. A re-install reconciles against the retained numbers (a workspace whose owners changed meanwhile moves up).
begin;
set local lock_timeout = '5s';
lock table public.brand_memberships in share row exclusive mode;
drop trigger if exists account_lifecycle_owner_epoch_row on public.brand_memberships;
drop trigger if exists account_lifecycle_owner_epoch_truncate on public.brand_memberships;
drop function if exists private.account_lifecycle_brand_owner_epoch(text);
drop function if exists private.account_lifecycle_brand_owner_epoch_resync(text);
drop function if exists private.account_lifecycle_brand_owner_epoch_covered();
drop function if exists private.account_lifecycle_owner_epoch_record();
drop function if exists private.account_lifecycle_owner_epoch_truncated();
drop function if exists private.account_lifecycle_owner_epoch_bump(text);
commit;
