-- G5 SOURCE CANDIDATE (2026-11-05, Issue #587 G5-02 task 8). NOT applied anywhere. The ROLLBACK of 001_workspace_ownership_lock.sql: drops
-- the trigger and its function. Afterwards a brand_memberships INSERT no longer waits for a notification being written (the G5-02 #8 race is
-- open again). Idempotent. Run as the owner of public.brand_memberships with ON_ERROR_STOP.

begin;
set local lock_timeout = '5s';
set local search_path = '';

do $rollback$
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'WO_SUPERUSER: run it as the owner of public.brand_memberships, not a superuser';
  end if;
  if exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = pg_catalog.to_regclass('public.brand_memberships') and t.tgname = 'postona_workspace_ownership_lock'
              and t.tgfoid is distinct from pg_catalog.to_regprocedure('private.postona_workspace_ownership_lock()')) then
    raise exception 'WO_TAKEN: a trigger of this name that is not this candidate''s (left alone)';
  end if;
end;
$rollback$;

drop trigger if exists postona_workspace_ownership_lock on public.brand_memberships;
drop function if exists private.postona_workspace_ownership_lock();

do $post$
begin
  if exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = pg_catalog.to_regclass('public.brand_memberships') and t.tgname = 'postona_workspace_ownership_lock')
     or pg_catalog.to_regprocedure('private.postona_workspace_ownership_lock()') is not null then
    raise exception 'WO_ROLLBACK_POSTCONDITION';
  end if;
end;
$post$;

commit;
