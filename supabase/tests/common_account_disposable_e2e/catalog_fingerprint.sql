-- Read-only catalog fingerprint for the Phase 3c disposable-Supabase proof (E1, E8, E9, E11, E12). Run it, inside
-- `begin transaction read only; ... rollback;`, before and after every destructive experiment and keep the sha256 of
-- the output. Catalog only: no user rows, no data, no secrets. Absent objects simply produce no line. Proven
-- offline against the local fixtures by fingerprint_local_run.sh; never run against production.
with auth_tables as (
  select c.oid, c.relname, c.relkind, c.relrowsecurity, pg_get_userbyid(c.relowner) as owner
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'auth' and c.relkind in ('r', 'p')
),
watched_columns as (
  select t.relname, a.attname, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull
    from auth_tables t join pg_attribute a on a.attrelid = t.oid
   where a.attnum > 0 and not a.attisdropped
     and t.relname in ('users', 'identities', 'sessions', 'refresh_tokens', 'audit_log_entries', 'mfa_factors', 'one_time_tokens', 'flow_state')
),
user_fks as (
  select con.conrelid::regclass::text as child, con.conname, con.confdeltype, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
   where con.contype = 'f'
     and (con.confrelid = to_regclass('auth.users') or con.confrelid = to_regclass('auth.sessions')
          or con.conrelid in (select oid from auth_tables))
),
watched_triggers as (
  select t.tgrelid::regclass::text as tbl, t.tgname, t.tgenabled, t.tgfoid::regprocedure::text as fn
    from pg_trigger t
   where not t.tgisinternal
     and (t.tgrelid in (select oid from auth_tables)
          or t.tgrelid in (to_regclass('public.common_accounts'), to_regclass('public.service_entitlements'), to_regclass('public.profiles')))
),
g5_functions as (
  select p.oid::regprocedure::text as fn, pg_get_userbyid(p.proowner) as owner, p.prosecdef,
         coalesce(array_to_string(p.proacl::text[], ','), '-') as acl, md5(pg_get_functiondef(p.oid)) as body_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname in ('public', 'private') and (p.proname like 'account\_lifecycle\_%' or p.proname like '%common\_account%'
          or p.proname in ('start_kabumori_service', 'start_x_autopost_service', 'reactivate_kabumori_service', 'reactivate_x_autopost_service', 'withdraw_kabumori_service', 'begin_service_deletion', 'finish_service_deletion', 'abort_service_deletion')))
      or (n.nspname = 'auth' and p.proname in ('uid', 'jwt', 'role'))
),
watched_roles as (
  select r.rolname, r.rolsuper, r.rolinherit, r.rolbypassrls, r.rolcanlogin,
         coalesce((select string_agg(g.rolname, ',' order by g.rolname) from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid), '-') as member_of
    from pg_roles r
   where r.rolname in ('postgres', 'authenticator', 'anon', 'authenticated', 'service_role', 'supabase_auth_admin', 'supabase_storage_admin', 'supabase_admin')
)
select line from (
  select 'meta|server_version_num|' || current_setting('server_version_num') as line
  union all
  select 'meta|current_user|' || current_user
  union all
  select format('auth_table|%s|%s|owner=%s|rls=%s|select=%s|delete=%s', relname, relkind, owner, relrowsecurity,
                has_table_privilege(oid, 'SELECT'), has_table_privilege(oid, 'DELETE'))
    from auth_tables
  union all
  select format('auth_column|%s|%s|%s|not_null=%s', relname, attname, type, attnotnull) from watched_columns
  union all
  select format('fk|%s|%s|on_delete=%s|%s', child, conname, confdeltype, def) from user_fks
  union all
  select format('trigger|%s|%s|enabled=%s|%s', tbl, tgname, tgenabled, fn) from watched_triggers
  union all
  select format('function|%s|owner=%s|definer=%s|acl=%s|body_md5=%s', fn, owner, prosecdef, acl, body_md5) from g5_functions
  union all
  select format('role|%s|super=%s|inherit=%s|bypassrls=%s|login=%s|member_of=%s', rolname, rolsuper, rolinherit, rolbypassrls, rolcanlogin, member_of)
    from watched_roles
) lines
order by line;
