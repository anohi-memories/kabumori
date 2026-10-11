-- Per-target read-only read-back for the disposable-Supabase proof (Phase 3e, H2 E11 review R1 / R5).
-- Counts rows by the ids captured BEFORE the delete -- never by joining from the user row, which is gone afterwards
-- and would report a vacuous 0 even when rows remain. Run inside `begin transaction read only; ... rollback;` with
--   psql -v target_user=<uuid> -v target_identities='{uuid,...}' -v target_sessions='{uuid,...}' \
--        -v target_refresh_tokens='{id,...}' -v target_objects='{uuid,...}' -f target_readback.sql
-- (fake users of the disposable project only; output goes through redaction before it is stored). A table that is
-- absent prints ABSENT, one the inspecting role cannot read prints UNKNOWN_DENIED -- never 0. Counts only.
select line from (
  select 'target|users|' || case
           when to_regclass('auth.users') is null then 'ABSENT'
           when not has_table_privilege('auth.users', 'SELECT') then 'UNKNOWN_DENIED'
           else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from auth.users where id = %L::uuid', :'target_user'), false, true, '')))[1]::text end as line
  union all
  select 'target|identities_by_id|' || case
           when to_regclass('auth.identities') is null then 'ABSENT'
           when not has_table_privilege('auth.identities', 'SELECT') then 'UNKNOWN_DENIED'
           else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from auth.identities where id = any(%L::uuid[])', :'target_identities'), false, true, '')))[1]::text end
  union all
  select 'target|sessions_by_id|' || case
           when to_regclass('auth.sessions') is null then 'ABSENT'
           when not has_table_privilege('auth.sessions', 'SELECT') then 'UNKNOWN_DENIED'
           else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from auth.sessions where id = any(%L::uuid[])', :'target_sessions'), false, true, '')))[1]::text end
  union all
  select 'target|refresh_tokens_by_id|' || case
           when to_regclass('auth.refresh_tokens') is null then 'ABSENT'
           when not has_table_privilege('auth.refresh_tokens', 'SELECT') then 'UNKNOWN_DENIED'
           else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from auth.refresh_tokens where id = any(%L::bigint[])', :'target_refresh_tokens'), false, true, '')))[1]::text end
  union all
  select 'target|audit_identity_linked_for_actor|' || case
           when to_regclass('auth.audit_log_entries') is null then 'ABSENT'
           when not has_table_privilege('auth.audit_log_entries', 'SELECT') then 'UNKNOWN_DENIED'
           else (xpath('/row/c/text()', query_to_xml(format(
             'select count(*) as c from auth.audit_log_entries where payload->>''action'' = ''identity_linked'' and payload->>''actor_id'' = %L', :'target_user'), false, true, '')))[1]::text end
  union all
  select 'target|audit_user_deleted_for_target|' || case
           when to_regclass('auth.audit_log_entries') is null then 'ABSENT'
           when not has_table_privilege('auth.audit_log_entries', 'SELECT') then 'UNKNOWN_DENIED'
           else (xpath('/row/c/text()', query_to_xml(format(
             'select count(*) as c from auth.audit_log_entries where payload->>''action'' = ''user_deleted'' and payload->''traits''->>''user_id'' = %L', :'target_user'), false, true, '')))[1]::text end
  union all
  select 'target|storage_objects_by_id|' || case
           when to_regclass('storage.objects') is null then 'ABSENT'
           when not has_table_privilege('storage.objects', 'SELECT') then 'UNKNOWN_DENIED'
           else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from storage.objects where id = any(%L::uuid[])', :'target_objects'), false, true, '')))[1]::text end
  union all
  select 'target|storage_objects_owned_by_target|' || case
           when to_regclass('storage.objects') is null then 'ABSENT'
           when not has_table_privilege('storage.objects', 'SELECT') then 'UNKNOWN_DENIED'
           else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from storage.objects where owner_id = %L', :'target_user'), false, true, '')))[1]::text end
  union all
  select 'target|common_accounts|' || case
           when to_regclass('public.common_accounts') is null then 'ABSENT'
           when not has_table_privilege('public.common_accounts', 'SELECT') then 'UNKNOWN_DENIED'
           else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.common_accounts where user_id = %L::uuid', :'target_user'), false, true, '')))[1]::text end
  union all
  select 'target|service_entitlements|' || case
           when to_regclass('public.service_entitlements') is null then 'ABSENT'
           when not has_table_privilege('public.service_entitlements', 'SELECT') then 'UNKNOWN_DENIED'
           else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.service_entitlements where user_id = %L::uuid', :'target_user'), false, true, '')))[1]::text end
) lines
order by line;
