-- Extended read-only read-back for the disposable-Supabase proof (Phase 3e, H2 E11 review R5). The original
-- catalog_fingerprint.sql is a LIMITED catalog read (names, enabled flags, lifecycle function bodies, a current_user
-- SELECT/DELETE bit); this file adds what it leaves out:
--   trigger functions on auth / storage / private / lifecycle tables (owner, SECURITY DEFINER, search_path, body md5),
--   RLS state and policies, schema / table / column grants, default privileges, effective (inherited) privileges of
--   the API and service roles on the key tables, managed auth / storage function owners and ACLs, Storage counts.
-- Run it inside `begin transaction read only; ... rollback;` before and after each destructive step. A table or
-- role that is absent prints ABSENT; one the inspecting role cannot read prints UNKNOWN_DENIED, and one whose rows RLS
-- would filter for this role prints UNKNOWN_RLS (never 0; SELECT privilege is not row visibility). It reads
-- no user row, no secret and no object content. A match before/after says nothing about external provider effects,
-- physical Storage blobs or GoTrue's own state; those need their own read-backs (target_readback.sql, runbook).
with watched_tables as (
  select c.oid, n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relacl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p')
     and (n.nspname in ('auth', 'storage', 'private')
          or (n.nspname = 'public' and c.relname in ('common_accounts', 'service_entitlements', 'profiles', 'brand_memberships', 'admin_users', 'social_account_oauth_states')))
),
watched_roles as (
  select r.oid, r.rolname from pg_roles r
   where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'supabase_auth_admin', 'supabase_storage_admin', 'postgres')
),
key_tables as (
  select t.* from watched_tables t
   where (t.nspname, t.relname) in (('auth', 'users'), ('auth', 'identities'), ('auth', 'sessions'), ('auth', 'refresh_tokens'),
                                    ('auth', 'audit_log_entries'), ('storage', 'objects'), ('storage', 'buckets'),
                                    ('public', 'common_accounts'), ('public', 'service_entitlements'), ('public', 'profiles'))
)
select line from (
  select format('rls|%s.%s|enabled=%s|forced=%s', nspname, relname, relrowsecurity, relforcerowsecurity) as line from watched_tables
  union all
  select format('trigger_fn|%s.%s|%s|%s|owner=%s|definer=%s|config=%s|body_md5=%s', w.nspname, w.relname, t.tgname, p.oid::regprocedure,
                pg_get_userbyid(p.proowner), p.prosecdef, coalesce(array_to_string(p.proconfig, ';'), '-'), md5(pg_get_functiondef(p.oid)))
    from pg_trigger t join watched_tables w on w.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
   where not t.tgisinternal
  union all
  select format('policy|%s.%s|%s|cmd=%s|permissive=%s|roles=%s|qual_md5=%s|check_md5=%s', w.nspname, w.relname, pol.polname, pol.polcmd,
                pol.polpermissive, coalesce((select string_agg(case when r = 0 then 'public' else pg_get_userbyid(r) end, ',' order by 1) from unnest(pol.polroles) r), '-'),
                md5(coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')), md5(coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')))
    from pg_policy pol join watched_tables w on w.oid = pol.polrelid
  union all
  select format('schema_acl|%s|%s', n.nspname, coalesce(array_to_string(n.nspacl::text[], ','), '-'))
    from pg_namespace n where n.nspname in ('auth', 'storage', 'private', 'public')
  union all
  select format('table_acl|%s.%s|%s|%s|grantable=%s', w.nspname, w.relname,
                case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee) end, a.privilege_type, a.is_grantable)
    from watched_tables w cross join lateral aclexplode(w.relacl) a
  union all
  select format('column_acl|%s.%s.%s|%s|%s', w.nspname, w.relname, att.attname,
                case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee) end, a.privilege_type)
    from watched_tables w join pg_attribute att on att.attrelid = w.oid and att.attnum > 0 and not att.attisdropped and att.attacl is not null
    cross join lateral aclexplode(att.attacl) a
  union all
  select format('default_acl|%s|%s|%s|%s', pg_get_userbyid(d.defaclrole), coalesce(n.nspname, '*'), d.defaclobjtype, array_to_string(d.defaclacl::text[], ','))
    from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
  union all
  select format('effective|%s|%s.%s|select=%s|insert=%s|update=%s|delete=%s', r.rolname, k.nspname, k.relname,
                has_table_privilege(r.oid, k.oid, 'SELECT'), has_table_privilege(r.oid, k.oid, 'INSERT'),
                has_table_privilege(r.oid, k.oid, 'UPDATE'), has_table_privilege(r.oid, k.oid, 'DELETE'))
    from watched_roles r cross join key_tables k
  union all
  select format('managed_fn|%s|owner=%s|definer=%s|config=%s|acl=%s|body_md5=%s', p.oid::regprocedure, pg_get_userbyid(p.proowner), p.prosecdef,
                coalesce(array_to_string(p.proconfig, ';'), '-'), coalesce(array_to_string(p.proacl::text[], ','), '-'), md5(pg_get_functiondef(p.oid)))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('auth', 'storage') and p.prokind = 'f'
  union all
  -- Counts only when this role sees the table unfiltered (Phase 3f): SELECT privilege is not row visibility.
  select 'storage_count|' || s.label || '|' || case
           when to_regclass(s.tbl) is null then 'ABSENT'
           when not has_table_privilege(to_regclass(s.tbl), 'SELECT') then 'UNKNOWN_DENIED'
           when exists (select 1 from pg_class c join pg_roles r on r.rolname = current_user
                         where c.oid = to_regclass(s.tbl) and c.relrowsecurity
                           and not (r.rolsuper or r.rolbypassrls or (pg_has_role(current_user, c.relowner, 'USAGE') and not c.relforcerowsecurity)))
             then 'UNKNOWN_RLS'
           else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %s', s.tbl), false, true, '')))[1]::text end
    from (values ('objects', 'storage.objects'), ('buckets', 'storage.buckets')) s(label, tbl)
  union all
  -- Physical Storage blobs are not visible to SQL: their read-back is a future Storage-service observation.
  select 'storage_blob_readback|NOT_OBSERVABLE_BY_SQL|future_storage_service_readback'
) lines
order by line;
