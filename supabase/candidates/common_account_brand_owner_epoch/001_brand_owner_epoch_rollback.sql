-- Rollback of 001_brand_owner_epoch.sql. It removes the write triggers and the functions, so the getter DISAPPEARS (a caller that needs it refuses, which is the
-- safe direction). It KEEPS private.account_lifecycle_brand_owner_epochs, its history guard trigger and the guard function: dropping the numbers would let an
-- earlier epoch repeat after a re-install. Before it goes, it moves EVERY recorded number on (the coverage ends here), and a re-install moves every one
-- on again: no number issued before the rollback is ever valid after it (J1 V1 R1).
-- (G5-21) While the kept history carries any trigger other than its two guards it REFUSES (OWNER_EPOCH_ROLLBACK_HISTORY_FOREIGN_TRIGGER): such a trigger
-- would run as the owner inside this file's update and could hold the numbers still. It never drops a trigger it did not create. Each number must move
-- by exactly one (OWNER_EPOCH_ROLLBACK_BUMP_NOT_RECORDED otherwise).
begin;
set local lock_timeout = '5s';
lock table public.brand_memberships in share row exclusive mode;
do $$
declare
  v_row record;
  v_got bigint;
begin
  if to_regclass('private.account_lifecycle_brand_owner_epochs') is not null then
    if exists (select 1 from pg_catalog.pg_trigger t
                where t.tgrelid = 'private.account_lifecycle_brand_owner_epochs'::regclass and not t.tgisinternal
                  and t.tgname not in ('account_lifecycle_owner_epoch_history_row', 'account_lifecycle_owner_epoch_history_truncate')) then
      raise exception 'OWNER_EPOCH_ROLLBACK_HISTORY_FOREIGN_TRIGGER';
    end if;
    for v_row in select e.brand_id, e.epoch from private.account_lifecycle_brand_owner_epochs e order by e.brand_id for update loop
      update private.account_lifecycle_brand_owner_epochs set epoch = v_row.epoch + 1 where brand_id = v_row.brand_id returning epoch into v_got;
      if not found or v_got is distinct from v_row.epoch + 1 then
        raise exception 'OWNER_EPOCH_ROLLBACK_BUMP_NOT_RECORDED';
      end if;
    end loop;
  end if;
end $$;
drop trigger if exists account_lifecycle_owner_epoch_row on public.brand_memberships;
drop trigger if exists account_lifecycle_owner_epoch_truncate on public.brand_memberships;
drop function if exists private.account_lifecycle_brand_owner_epoch(text);
drop function if exists private.account_lifecycle_brand_owner_epoch_resync(text);
drop function if exists private.account_lifecycle_brand_owner_epoch_covered();
drop function if exists private.account_lifecycle_owner_epoch_record();
drop function if exists private.account_lifecycle_owner_epoch_truncated();
drop function if exists private.account_lifecycle_owner_epoch_bump(text);
drop function if exists private.account_lifecycle_owner_epoch_exposure();
drop function if exists private.account_lifecycle_owner_epoch_history_triggers();
commit;
