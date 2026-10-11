-- AI provider budget ledger (migration 20261010050613): production READ-ONLY preflight (Phase 1c, extended in 1d).
--
-- One SELECT over the system catalogs and the migration history. It reads no table data, no personal data and no
-- secrets, and writes nothing. Run it as the role that would apply the migration (postgres), because default
-- privileges and "owner" are judged for the current user:
--
--   supabase db query --linked --project-ref <ref> -o json -f supabase/tests/ai_provider_budget_ledger_preflight.sql
--   (or through supabase/tests/ai_provider_budget_ledger_rollout.sh check, which also judges it)
--
-- It predicts whether the migration's own postcondition would refuse on this database (every predicted_refusals
-- value must be false / empty) and shows what the apply would land on: server version, history, name collisions,
-- the role / SET ROLE graph, default privileges that would reach the new objects, event triggers that run during
-- the DDL, the PostgREST conditions for calling the RPCs, and the effect on G5's existing-function fingerprints.
with app as (
  select r.oid, r.rolname from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')
),
reach as (
  -- Section 5b of the migration: roles an application role reaches by inheritance or by SET ROLE (PG16+).
  select app.rolname as app_role, t.oid as target_oid, t.rolname as target, t.rolsuper,
         case when pg_has_role(app.oid, t.oid, 'USAGE') then 'inheritance' else 'set_role' end as path
    from app join pg_roles t on t.oid <> app.oid
   where pg_has_role(app.oid, t.oid, 'USAGE') or pg_has_role(app.oid, t.oid, 'SET')
),
held as (
  -- Whose privileges an application role can exercise: its own (with what it inherits) and every role it reaches.
  -- A reached role is judged by what IT holds, inherited roles included (the migration checks the reached role's
  -- effective privileges), so a SET hop into a role that inherits service_role counts as reaching service_role.
  select app.rolname as app_role, app.oid as role_oid, false as reached from app
  union all
  select reach.app_role, reach.target_oid, true from reach
),
defacl as (
  -- Default privileges the current user's new objects would receive: global ones (any schema, so the new
  -- ai_ledger schema too) and the ones for schema public (where the seven RPCs are created).
  select d.defaclobjtype::text as objtype,
         case when d.defaclnamespace = 0 then '*' else d.defaclnamespace::regnamespace::text end as in_schema,
         case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee,
         a.privilege_type
    from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
   where d.defaclrole = (select oid from pg_roles where rolname = current_user)
     and (d.defaclnamespace = 0 or d.defaclnamespace = 'public'::regnamespace)
)
select jsonb_build_object(
  'identity', jsonb_build_object(
    'database', current_database(),
    'current_user', current_user::text,
    'current_user_is_superuser', (select r.rolsuper from pg_roles r where r.rolname = current_user),
    'server_version_num', current_setting('server_version_num')::int,
    'can_create_schema', has_database_privilege(current_database(), 'CREATE'),
    'can_create_in_public', has_schema_privilege('public', 'CREATE'),
    'checked_at_jst', to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI:SS')),
  -- Every Supabase project has supabase_migrations.schema_migrations (the statement fails without it).
  'history', (
    select jsonb_build_object(
      'rows', count(*),
      'max_version', max(m.version),
      'has_20261010050613_ai_ledger', coalesce(bool_or(m.version = '20261010050613'), false),
      'has_20261009120000_g5_deletion_completion', coalesce(bool_or(m.version = '20261009120000'), false),
      'newer_than_20261010050613', count(*) filter (where m.version > '20261010050613'))
      from supabase_migrations.schema_migrations m),
  'target_absent', jsonb_build_object(
    'schema_ai_ledger_absent', to_regnamespace('ai_ledger') is null,
    'public_ai_ledger_functions', (select count(*) from pg_proc p
                                    where p.pronamespace = 'public'::regnamespace and p.proname like 'ai\_ledger\_%'),
    -- Same-named objects elsewhere (informational: only public and the new ai_ledger schema are written).
    'other_ai_ledger_named_objects', (select count(*) from pg_proc p where p.proname like 'ai\_ledger\_%'
                                         and p.pronamespace <> 'public'::regnamespace)
                                     + (select count(*) from pg_class c where c.relname like 'ai\_ledger%')
                                     + (select count(*) from pg_type t where t.typname like 'ai\_ledger%' and t.typtype <> 'c')),
  'g5_objects', jsonb_build_object(
    'deletion_completion_applied', to_regclass('private.account_lifecycle_release_gates') is not null,
    'lifecycle_foundation_present', to_regclass('private.account_lifecycle_operations') is not null,
    -- G5's existing-object fingerprints (07_existing_fingerprint / 04_touched_and_fingerprints) hash every function
    -- in public and private: the apply adds exactly seven there and changes nothing else they read.
    'public_private_functions_now', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                      where n.nspname in ('public', 'private') and p.prokind in ('f', 'p', 'w')),
    'functions_added_by_apply', 7),
  'app_roles', (select jsonb_object_agg(r.rolname, jsonb_build_object(
                  'super', r.rolsuper, 'inherit', r.rolinherit, 'bypassrls', r.rolbypassrls, 'login', r.rolcanlogin))
                  from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')),
  'reachable_roles', (select coalesce(jsonb_agg(jsonb_build_object('from', app_role, 'to', target, 'path', path, 'super', rolsuper)
                                                order by app_role, target), '[]'::jsonb) from reach),
  'predicted_refusals', jsonb_build_object(
    -- Section 2 (any membership) / 5b (reach): an application role tied to the owner (current user) or a superuser,
    -- or reaching a role that is one or inherits the owner's privileges.
    'app_role_reaches_owner_or_superuser', exists (select 1 from reach where reach.rolsuper)
                                           or exists (select 1 from held where held.reached
                                                       and pg_has_role(held.role_oid, (select oid from pg_roles where rolname = current_user), 'USAGE'))
                                           or exists (select 1 from app join pg_roles s on s.rolsuper or s.rolname = current_user
                                                       where pg_has_role(app.oid, s.oid, 'MEMBER')),
    -- Section 5 / 5b: service_role will hold EXECUTE on the RPCs. anon / authenticated must not hold it themselves,
    -- and no application role may reach another role that is or inherits service_role.
    'app_role_reaches_service_role_privileges', exists (select 1 from held
                                                         where (held.reached or held.app_role in ('anon', 'authenticated'))
                                                           and pg_has_role(held.role_oid, 'service_role', 'USAGE')),
    -- Section 5 / 5b: predefined roles that read or write every table would hold privileges on the ledger, whether
    -- the application role inherits them or reaches a role that does.
    'app_role_reaches_all_data_role', exists (select 1 from held
                                               where pg_has_role(held.role_oid, 'pg_read_all_data', 'USAGE')
                                                  or pg_has_role(held.role_oid, 'pg_write_all_data', 'USAGE')),
    -- Section 3: a default privilege for a role the migration does not revoke from leaves a direct grant behind.
    'default_acl_grantees_not_revoked', (select coalesce(jsonb_agg(distinct format('%s %s %s:%s', d.objtype, d.in_schema, d.grantee, d.privilege_type)), '[]'::jsonb)
                                           from defacl d
                                          where d.grantee not in ('PUBLIC', 'anon', 'authenticated', 'service_role', current_user::text))),
  'default_acl', (select coalesce(jsonb_agg(distinct format('%s %s %s:%s', d.objtype, d.in_schema, d.grantee, d.privilege_type)), '[]'::jsonb) from defacl d),
  'event_triggers', (select coalesce(jsonb_agg(jsonb_build_object(
                       'name', e.evtname, 'event', e.evtevent, 'enabled', e.evtenabled::text, 'tags', e.evttags,
                       'owner', pg_get_userbyid(e.evtowner), 'function', e.evtfoid::regprocedure::text,
                       'function_md5', md5(pg_get_functiondef(e.evtfoid)))
                       order by e.evtname), '[]'::jsonb) from pg_event_trigger e),
  'postgrest', jsonb_build_object(
    'ddl_watch_trigger', exists (select 1 from pg_event_trigger e where e.evtname = 'pgrst_ddl_watch' and e.evtenabled <> 'D'),
    'drop_watch_trigger', exists (select 1 from pg_event_trigger e where e.evtname = 'pgrst_drop_watch' and e.evtenabled <> 'D'),
    'authenticator_config', (select to_jsonb(r.rolconfig) from pg_roles r where r.rolname = 'authenticator'),
    -- PostgREST logs in as authenticator and switches to the role of the key with SET ROLE: a service key works
    -- only when authenticator may SET ROLE service_role.
    'authenticator_can_set_service_role', case when to_regrole('authenticator') is null or to_regrole('service_role') is null then null
                                               else pg_has_role('authenticator', 'service_role', 'SET') end,
    'service_role_public_usage', case when to_regrole('service_role') is null then null
                                      else has_schema_privilege('service_role', 'public', 'USAGE') end),
  'extensions', (select jsonb_object_agg(x.extname, x.extversion) from pg_extension x
                  where x.extname in ('pg_cron', 'pg_net', 'pg_graphql', 'supabase_vault'))
) as result;
