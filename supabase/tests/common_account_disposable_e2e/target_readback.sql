-- Per-target read-only read-back for the disposable-Supabase proof (Phase 3e, H2 E11 review R1 / R5; Phase 3f RLS).
-- Counts rows by the ids captured BEFORE the delete -- never by joining from the user row, which is gone afterwards
-- and would report a vacuous 0 even when rows remain. Run inside `begin transaction read only; ... rollback;` with
--   psql -v target_user=<uuid> -v target_identities='{uuid,...}' -v target_sessions='{uuid,...}' \
--        -v target_refresh_tokens='{id,...}' -v target_objects='{uuid,...}' -f target_readback.sql
-- (fake users of the disposable project only; output goes through redaction before it is stored).
-- A count is printed ONLY when the inspecting role sees the table unfiltered; otherwise, never 0:
--   ABSENT          the table does not exist;
--   UNKNOWN_DENIED  no table SELECT privilege (ACL);
--   UNKNOWN_RLS     row level security would filter what this role sees: RLS is enabled and the role is neither a
--                   superuser, nor BYPASSRLS, nor the table's owner (or it is the owner under FORCE ROW LEVEL
--                   SECURITY). Table SELECT privilege says nothing about row visibility. A future operator
--                   read-back with an independently proven unfiltered role is then required; nothing here elevates
--                   privileges.
-- Counts only. A physical Storage object is never inferred from these metadata rows (Storage-service read-back).
with probes(label, tbl, query) as (
  values
    ('users', 'auth.users', format('select count(*) as c from auth.users where id = %L::uuid', :'target_user')),
    ('identities_by_id', 'auth.identities', format('select count(*) as c from auth.identities where id = any(%L::uuid[])', :'target_identities')),
    ('sessions_by_id', 'auth.sessions', format('select count(*) as c from auth.sessions where id = any(%L::uuid[])', :'target_sessions')),
    ('refresh_tokens_by_id', 'auth.refresh_tokens', format('select count(*) as c from auth.refresh_tokens where id = any(%L::bigint[])', :'target_refresh_tokens')),
    ('audit_identity_linked_for_actor', 'auth.audit_log_entries', format(
      'select count(*) as c from auth.audit_log_entries where payload->>''action'' = ''identity_linked'' and payload->>''actor_id'' = %L', :'target_user')),
    ('audit_user_deleted_for_target', 'auth.audit_log_entries', format(
      'select count(*) as c from auth.audit_log_entries where payload->>''action'' = ''user_deleted'' and payload->''traits''->>''user_id'' = %L', :'target_user')),
    ('storage_objects_by_id', 'storage.objects', format('select count(*) as c from storage.objects where id = any(%L::uuid[])', :'target_objects')),
    ('storage_objects_owned_by_target', 'storage.objects', format('select count(*) as c from storage.objects where owner_id = %L', :'target_user')),
    ('common_accounts', 'public.common_accounts', format('select count(*) as c from public.common_accounts where user_id = %L::uuid', :'target_user')),
    ('service_entitlements', 'public.service_entitlements', format('select count(*) as c from public.service_entitlements where user_id = %L::uuid', :'target_user'))
),
visibility as (
  select p.label, p.query,
         case
           when to_regclass(p.tbl) is null then 'ABSENT'
           when not has_table_privilege(to_regclass(p.tbl), 'SELECT') then 'UNKNOWN_DENIED'
           when exists (select 1 from pg_class c join pg_roles r on r.rolname = current_user
                         where c.oid = to_regclass(p.tbl) and c.relrowsecurity
                           and not (r.rolsuper or r.rolbypassrls or (pg_has_role(current_user, c.relowner, 'USAGE') and not c.relforcerowsecurity)))
             then 'UNKNOWN_RLS'
           else 'VISIBLE'
         end as state
    from probes p
)
select 'target|' || v.label || '|' || case
         when v.state <> 'VISIBLE' then v.state
         else (xpath('/row/c/text()', query_to_xml(v.query, false, true, '')))[1]::text
       end as line
  from visibility v
 order by 1;
