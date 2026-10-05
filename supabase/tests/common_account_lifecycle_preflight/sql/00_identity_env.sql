-- Production preflight / read-back (read-only). Session identity, server version and the settings that decide
-- how the migration's own transaction and its RPCs behave. Role attributes only, no data.
-- role_settings prints setting NAMES for every role/database pair and VALUES only for an
-- allow-list of non-secret settings.
select jsonb_build_object(
  'current_user', current_user,
  'session_user', session_user,
  'database', current_database(),
  'server_version_num', current_setting('server_version_num'),
  'server_version', current_setting('server_version'),
  'transaction_read_only', current_setting('transaction_read_only'),
  'default_transaction_isolation', current_setting('default_transaction_isolation'),
  'search_path', current_setting('search_path'),
  'statement_timeout', current_setting('statement_timeout'),
  'lock_timeout', current_setting('lock_timeout'),
  'idle_in_transaction_session_timeout', current_setting('idle_in_transaction_session_timeout'),
  'roles', (
    select jsonb_object_agg(r.rolname, jsonb_build_object(
             'super', r.rolsuper, 'inherit', r.rolinherit, 'createrole', r.rolcreaterole,
             'createdb', r.rolcreatedb, 'login', r.rolcanlogin, 'bypassrls', r.rolbypassrls,
             'replication', r.rolreplication))
      from pg_roles r
     where r.rolname in ('postgres', 'anon', 'authenticated', 'service_role', 'authenticator',
                         'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin',
                         'supabase_read_only_user', 'dashboard_user', 'pgbouncer',
                         'supabase_replication_admin', 'supabase_realtime_admin', 'supabase_etl_admin')),
  'role_count_total', (select count(*) from pg_roles),
  'role_settings', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'role', coalesce(r.rolname, '*'),
             'db', coalesce(d.datname, '*'),
             'keys', (select jsonb_agg(split_part(c, '=', 1) order by split_part(c, '=', 1) collate "C")
                        from unnest(s.setconfig) c),
             'values', (select jsonb_object_agg(split_part(c, '=', 1), substr(c, strpos(c, '=') + 1))
                          from unnest(s.setconfig) c
                         where split_part(c, '=', 1) in (
                           'search_path', 'statement_timeout', 'lock_timeout',
                           'idle_in_transaction_session_timeout', 'default_transaction_isolation',
                           'default_transaction_read_only', 'pgrst.db_schemas',
                           'pgrst.db_extra_search_path', 'session_preload_libraries', 'log_statement')))
           order by coalesce(r.rolname, '*') collate "C", coalesce(d.datname, '*') collate "C"), '[]'::jsonb)
      from pg_db_role_setting s
      left join pg_roles r on r.oid = s.setrole
      left join pg_database d on d.oid = s.setdatabase)
) as result;
