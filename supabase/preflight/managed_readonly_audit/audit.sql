-- G5-18 MANAGED READ-ONLY AUDIT (catalog metadata only). Design: docs/security/managed-readonly-audit-gates-20261022.md.
-- NEVER run against a managed / production project without the user's explicit approval of: the project, the role, the time window, and where the
-- output goes (gate G0 of the design). Run with psql, from this directory:
--   psql -X -A -F '|' -v ON_ERROR_STOP=1 -f audit.sql > audit-output.txt
-- It reads catalog METADATA only: names, owners, ACLs, RLS flags, policy expressions, role flags / memberships, column shapes, default privileges,
-- event triggers, migration versions, and md5 of function bodies. It never reads a row of a data table (no auth.users / auth.sessions / storage /
-- vault / application rows), never pg_authid or a password, never a secret-bearing role setting (only an allowlisted set of keys is printed), and it
-- runs inside BEGIN READ ONLY so any write fails. Any error stops it (ON_ERROR_STOP).
\set ON_ERROR_STOP on
\set schemas '''public'', ''private'', ''auth'', ''ai_ledger'', ''storage'', ''postona_x_resv'', ''postona_threads_resv'', ''postona_threads_binding'''
begin read only;
set local statement_timeout = '30s';
set local lock_timeout = '2s';
set local idle_in_transaction_session_timeout = '120s';
-- an empty search_path makes every regclass / regprocedure / regrole print schema-qualified (pg_catalog is still searched implicitly)
set local search_path = '';

\echo '## S0 session (STOP unless read-only)'
-- the divisor depends on the setting (a constant 1 / 0 would be folded at plan time even in an untaken CASE branch)
select 1 / (case when pg_catalog.current_setting('transaction_read_only') = 'on' then 1 else 0 end) as read_only_guard;
select 'read_only=' || pg_catalog.current_setting('transaction_read_only'), 'isolation=' || pg_catalog.current_setting('transaction_isolation'),
       'role=' || current_user, 'server_version_num=' || pg_catalog.current_setting('server_version_num');

\echo '## S1 relations: schema|name|kind|owner|rls|forced|acl'
select n.nspname, c.relname, c.relkind::text, c.relowner::regrole::text, c.relrowsecurity, c.relforcerowsecurity, coalesce(pg_catalog.array_to_string(c.relacl::text[], ','), '-')
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname in (:schemas) and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
 order by 1, 2;

\echo '## S2 column ACLs incl. system columns: schema|table|column|attnum|acl'
select n.nspname, c.relname, a.attname, a.attnum, pg_catalog.array_to_string(a.attacl::text[], ',')
  from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname in (:schemas) and a.attacl is not null and not a.attisdropped
 order by 1, 2, 4;

\echo '## S3 default ACLs (global and per schema): schema|role|objtype|acl'
select coalesce(n.nspname, '<global>'), d.defaclrole::regrole::text, d.defaclobjtype::text, pg_catalog.array_to_string(d.defaclacl::text[], ',')
  from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
 order by 1, 2, 3;

\echo '## S4 functions: schema|signature|owner|secdef|volatile|config|acl|md5(body)'
select n.nspname, p.oid::regprocedure::text, p.proowner::regrole::text, p.prosecdef, p.provolatile::text, coalesce(pg_catalog.array_to_string(p.proconfig, ','), '-'),
       coalesce(pg_catalog.array_to_string(p.proacl::text[], ','), '-'), pg_catalog.md5(p.prosrc)
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname in (:schemas) and p.prokind in ('f', 'p')
 order by 1, 2;

\echo '## S5 policies: schema|table|policy|cmd|permissive|roles|using|check'
select n.nspname, c.relname, p.polname, p.polcmd::text, p.polpermissive, p.polroles::regrole[]::text,
       coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), ''), coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')
  from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname in (:schemas)
 order by 1, 2, 3;

\echo '## S6 roles (allowlisted settings only): role|super|inherit|createrole|login|bypassrls|settings'
with relevant as (
  select r.oid from pg_catalog.pg_roles r
   where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'postgres', 'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin')
  union select c.relowner from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname in (:schemas)
  union select p.proowner from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname in (:schemas)
)
select r.rolname, r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcanlogin, r.rolbypassrls,
       coalesce((select pg_catalog.string_agg(x, ',' order by x) from pg_catalog.unnest(r.rolconfig) x
                  where x ~ '^(pgrst\.db_schemas|pgrst\.db_extra_search_path|default_transaction_isolation|default_transaction_read_only|statement_timeout|search_path|row_security|session_replication_role)='), '-')
  from pg_catalog.pg_roles r where r.oid in (select oid from relevant)
 order by 1;

\echo '## S7 memberships of the relevant roles: role|member|admin|inherit|set|grantor'
with relevant as (
  select r.oid from pg_catalog.pg_roles r
   where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'postgres', 'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin')
  union select c.relowner from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname in (:schemas)
  union select p.proowner from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname in (:schemas)
)
select m.roleid::regrole::text, m.member::regrole::text, m.admin_option, m.inherit_option, m.set_option, m.grantor::regrole::text
  from pg_catalog.pg_auth_members m
 where m.roleid in (select oid from relevant) or m.member in (select oid from relevant)
 order by 1, 2;

\echo '## S8 auth shape (columns only, no rows): relation|column|type|nullable'
select a.attrelid::regclass::text, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), not a.attnotnull
  from pg_catalog.pg_attribute a
 where a.attrelid in (select c.oid from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                       where n.nspname = 'auth' and c.relname in ('users', 'sessions', 'identities'))
   and a.attnum > 0 and not a.attisdropped
 order by 1, 2;
\echo '## S8b auth.uid() definition md5'
select coalesce((select pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)) from pg_catalog.pg_proc p
                  where p.oid = pg_catalog.to_regprocedure('auth.uid()')), 'absent');

\echo '## S9 extensions: name|version'
select e.extname, e.extversion from pg_catalog.pg_extension e order by 1;

\echo '## S10 migration history (versions and names only)'
select pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null as has_history \gset
\if :has_history
select m.version, m.name from supabase_migrations.schema_migrations m order by 1;
\else
\echo 'absent'
\endif

\echo '## S11 event triggers: name|event|owner|enabled|function|tags'
select t.evtname, t.evtevent, t.evtowner::regrole::text, t.evtenabled::text, t.evtfoid::regprocedure::text, coalesce(pg_catalog.array_to_string(t.evttags, ','), '-')
  from pg_catalog.pg_event_trigger t order by 1;

\echo '## S12 effective API privileges on public (the G5-12 audit)'
\ir ../../tests/common_account_data_api_grants_audit.sql

rollback;
\echo '## END (rolled back; nothing was written)'
