-- G3 SOURCE CANDIDATE ROLLBACK (2026-10-20, Issue #318 TASK 8/50). NOT in supabase/migrations/. Same review / GO / window / read-back as the candidate.
--
-- Puts back exactly what 001 took away from the state the table's migration (20260918120000) leaves under default table privileges:
-- TRIGGER, TRUNCATE, REFERENCES for authenticated and TRIGGER for service_role. anon and PUBLIC get nothing back (the migration revokes all from anon;
-- PUBLIC never had a grant). Nothing else changes.
--
-- Refused while G5's owner-epoch candidate (PR #303) or anything built on it is installed: that install requires 001, and putting the privileges back
-- would turn its coverage check off for every workspace. Roll G5 back first (PR #358, then PR #303), then this file.
begin;

set local lock_timeout = '5s';

do $$
declare
  v_me oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  if to_regclass('public.brand_memberships') is null then
    raise exception 'BM_PRIV_ROLLBACK_TABLE_MISSING';
  end if;
  if (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.brand_memberships'::regclass) is distinct from v_me then
    raise exception 'BM_PRIV_ROLLBACK_NOT_TABLE_OWNER';
  end if;
  if to_regprocedure('private.account_lifecycle_owner_epoch_exposure()') is not null
     or to_regprocedure('private.account_lifecycle_brand_owner_epoch(text)') is not null
     or exists (select 1 from pg_catalog.pg_trigger t
                 where t.tgrelid = 'public.brand_memberships'::regclass
                   and t.tgname in ('account_lifecycle_owner_epoch_row', 'account_lifecycle_owner_epoch_truncate')) then
    raise exception 'BM_PRIV_ROLLBACK_REFUSED_OWNER_EPOCH_INSTALLED';
  end if;
end $$;

lock table public.brand_memberships in share row exclusive mode;

grant trigger, truncate, references on table public.brand_memberships to authenticated;
grant trigger on table public.brand_memberships to service_role;

commit;
