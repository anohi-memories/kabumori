-- Rollback of 20261017150000_ai_ledger_user_erasure.sql (operator use only; never a migration).
-- Restores the two ledger triggers to exactly what 20261010050613 created and removes the four RPCs and the new
-- helpers. It does NOT (and cannot) undo an erasure: rows already pseudonymised stay pseudonymised, and the original
-- user ids are not recoverable from anywhere. Run it BEFORE rolling back the call store (20261017120000) or the
-- ledger (20261010050613). The proof runner checks that the catalog after this script equals the catalog before
-- the migration.
set client_min_messages = warning;
begin;
drop function public.ai_ledger_erase_user(jsonb);
drop function public.ai_ledger_user_footprint(jsonb);
drop function public.ai_calls_forget_system_brand(jsonb);
drop function public.ai_calls_recovery_candidates(jsonb);
-- The usage-events trigger back on ai_ledger.reject_change (same name, same definition as the ledger migration).
create or replace trigger usage_events_append_only before update or delete on ai_ledger.usage_events
  for each row execute function ai_ledger.reject_change();
drop function ai_ledger.usage_events_guard();
-- The reservation trigger function, verbatim from 20261010050613.
create or replace function ai_ledger.reservation_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.request_id, new.attempt, new.provider, new.model, new.application, new.feature, new.logical_role,
      new.subject_kind, new.user_id, new.brand_id, new.billing_month, new.usage_day, new.reserved_usd, new.bucket_ids,
      new.created_at, new.expires_at)
     is distinct from
     (old.id, old.request_id, old.attempt, old.provider, old.model, old.application, old.feature, old.logical_role,
      old.subject_kind, old.user_id, old.brand_id, old.billing_month, old.usage_day, old.reserved_usd, old.bucket_ids,
      old.created_at, old.expires_at) then
    raise exception 'AI_LEDGER_RESERVATION_IMMUTABLE' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'reserved' and new.status in ('sent', 'released', 'settled', 'unknown'))
    or (old.status = 'sent' and new.status in ('settled', 'unknown'))
    or (old.status = 'released' and new.status in ('settled', 'unknown'))
  ) then
    raise exception 'AI_LEDGER_RESERVATION_TRANSITION: % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop function ai_ledger.erasure_allows(uuid, uuid);
drop function ai_ledger.mentions_user(text, uuid);
drop function ai_ledger.new_erased_subject();
drop function ai_ledger.is_erased_subject(uuid);
commit;
