-- One md5 over every catalog fact OUTSIDE the call-store objects (schema ai_calls and the public.ai_calls_* RPCs):
-- schemas, relations, columns, constraints, indexes, triggers, policies, functions (source + ACL + settings),
-- default ACLs, role attributes and memberships. Unlike the ledger digest it INCLUDES the ai_ledger schema and the
-- public.ai_ledger_* RPCs, so equal before and after the migration = the ledger and everything else that existed
-- was not changed; equal before the migration and after the rollback script = the rollback is complete.
select md5(string_agg(fact, E'\n' order by fact))
  from (
    select 'ns|' || n.nspname || '|' || pg_get_userbyid(n.nspowner) || '|' || coalesce(n.nspacl::text, '') as fact
      from pg_namespace n
     where n.nspname <> 'ai_calls' and n.nspname !~ '^pg_(toast_temp|temp)_'
    union all
    select 'rel|' || n.nspname || '.' || c.relname || '|' || c.relkind::text || '|' || pg_get_userbyid(c.relowner) || '|'
           || coalesce(c.relacl::text, '') || '|' || c.relrowsecurity::text || c.relforcerowsecurity::text
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname not in ('ai_calls', 'pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'
    union all
    select 'col|' || n.nspname || '.' || c.relname || '.' || a.attname || '|' || format_type(a.atttypid, a.atttypmod)
           || '|' || a.attnotnull::text || '|' || coalesce(a.attacl::text, '')
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
     where a.attnum > 0 and not a.attisdropped
       and n.nspname not in ('ai_calls', 'pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'
    union all
    select 'con|' || n.nspname || '.' || con.conname || '|' || pg_get_constraintdef(con.oid)
      from pg_constraint con join pg_namespace n on n.oid = con.connamespace
     where n.nspname not in ('ai_calls', 'pg_catalog', 'information_schema')
    union all
    select 'idx|' || n.nspname || '.' || c.relname || '|' || pg_get_indexdef(c.oid)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('i', 'I') and n.nspname not in ('ai_calls', 'pg_catalog', 'information_schema')
       and n.nspname !~ '^pg_(toast|temp)'
    union all
    select 'trg|' || tg.tgname || '|' || pg_get_triggerdef(tg.oid)
      from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where not tg.tgisinternal and n.nspname <> 'ai_calls'
    union all
    select 'pol|' || pol.polname || '|' || pol.polrelid::regclass::text || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
      from pg_policy pol join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname <> 'ai_calls'
    union all
    select 'fn|' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|'
           || md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|'
           || coalesce(p.proacl::text, '') || '|' || pg_get_userbyid(p.proowner)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname not in ('ai_calls', 'pg_catalog', 'information_schema')
       and not (n.nspname = 'public' and p.proname like 'ai\_calls\_%')
    union all
    select 'defacl|' || pg_get_userbyid(d.defaclrole) || '|' || coalesce(d.defaclnamespace::regnamespace::text, '') || '|'
           || d.defaclobjtype::text || '|' || d.defaclacl::text
      from pg_default_acl d
    union all
    select 'role|' || r.rolname || '|' || r.rolsuper::text || r.rolinherit::text || r.rolcanlogin::text || r.rolbypassrls::text
      from pg_roles r where r.rolname !~ '^pg_'
    union all
    select 'member|' || m.roleid::regrole::text || '>' || m.member::regrole::text || '|' || m.admin_option::text
           || '|' || m.inherit_option::text || '|' || m.set_option::text
      from pg_auth_members m
  ) facts;
