-- AI provider budget ledger (migration 20261010050613): READ-ONLY fingerprint of what ALREADY exists (Phase 1d).
--
-- Taken right before and right after the apply with this same file; every category must be equal. Equal = the
-- migration changed no existing table, column, constraint, index, trigger, policy, function, type, schema ACL,
-- default privilege, role, membership or event trigger of the business schemas public / private. The seven
-- public.ai_ledger_* RPCs are the only objects excluded (they are new). Code and ACL text are hashed, never printed;
-- no table data is read.
--
-- It also covers the inputs of G5's existing-object fingerprints (common_account_lifecycle_preflight/sql/
-- 07_existing_fingerprint.sql and common_account_service_start_intent_preflight/sql/04_touched_and_fingerprints.sql):
-- those include EVERY public function, so after the apply they will differ by exactly the seven RPCs (see
-- functions_including_ai_ledger below), and by nothing else.
with
rel as (
  select c.oid, n.nspname, c.relname, c.relkind, c.relowner, c.relacl, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private') and c.relkind in ('r', 'v', 'm', 'p', 'f', 'S', 'i', 'I')
),
fn as (
  select p.oid, n.nspname, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private')
),
facts(category, fact) as (
  select 'schemas', n.nspname || '|' || pg_get_userbyid(n.nspowner) || '|' || coalesce(n.nspacl::text, '-')
    from pg_namespace n where n.nspname in ('public', 'private')
  union all
  select 'relations', r.nspname || '.' || r.relname || '|' || r.relkind::text || '|' || pg_get_userbyid(r.relowner) || '|'
         || coalesce(r.relacl::text, '-') || '|' || r.relrowsecurity::text || r.relforcerowsecurity::text
    from rel r
  union all
  select 'columns', r.nspname || '.' || r.relname || '.' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|'
         || a.attnotnull::text || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-') || '|' || coalesce(a.attacl::text, '-')
    from rel r join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  union all
  select 'constraints', n.nspname || '.' || con.conname || '|' || con.conrelid::regclass::text || '|' || pg_get_constraintdef(con.oid)
    from pg_constraint con join pg_namespace n on n.oid = con.connamespace
   where n.nspname in ('public', 'private')
  union all
  select 'indexes', r.nspname || '.' || r.relname || '|' || pg_get_indexdef(r.oid)
    from rel r where r.relkind in ('i', 'I')
  union all
  select 'triggers', tg.tgrelid::regclass::text || '.' || tg.tgname || '|' || tg.tgenabled::text || '|' || md5(pg_get_triggerdef(tg.oid))
    from pg_trigger tg join rel r on r.oid = tg.tgrelid where not tg.tgisinternal
  union all
  select 'policies', pol.polrelid::regclass::text || '.' || pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
         || pol.polroles::regrole[]::text || '|' || coalesce(md5(pg_get_expr(pol.polqual, pol.polrelid)), '-') || '|'
         || coalesce(md5(pg_get_expr(pol.polwithcheck, pol.polrelid)), '-')
    from pg_policy pol join rel r on r.oid = pol.polrelid
  union all
  select 'functions', f.nspname || '.' || f.proname || '(' || pg_get_function_identity_arguments(f.oid) || ')|'
         || md5(pg_get_functiondef(f.oid)) || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '-') || '|'
         || coalesce(p.proacl::text, '-') || '|' || pg_get_userbyid(p.proowner)
    from fn f join pg_proc p on p.oid = f.oid
   where p.prokind in ('f', 'p', 'w') and not (f.nspname = 'public' and f.proname like 'ai\_ledger\_%')
  union all
  select 'types', n.nspname || '.' || t.typname || '|' || t.typtype::text || '|' || pg_get_userbyid(t.typowner) || '|'
         || coalesce(t.typacl::text, '-') || '|'
         || coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid), '-')
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
   where n.nspname in ('public', 'private') and t.typtype in ('e', 'd', 'r', 'm')
  union all
  select 'default_acl', pg_get_userbyid(d.defaclrole) || '|' || coalesce(d.defaclnamespace::regnamespace::text, '*') || '|'
         || d.defaclobjtype::text || '|' || d.defaclacl::text
    from pg_default_acl d
  union all
  select 'roles', r.rolname || '|' || r.rolsuper::text || r.rolinherit::text || r.rolcreaterole::text || r.rolcreatedb::text
         || r.rolcanlogin::text || r.rolreplication::text || r.rolbypassrls::text
    from pg_roles r where r.rolname !~ '^pg_'
  union all
  select 'memberships', m.roleid::regrole::text || '>' || m.member::regrole::text || '|' || m.admin_option::text || '|'
         || m.inherit_option::text || m.set_option::text
    from pg_auth_members m
  union all
  select 'event_triggers', e.evtname || '|' || e.evtevent || '|' || e.evtenabled::text || '|' || coalesce(e.evttags::text, '-') || '|'
         || md5(pg_get_functiondef(e.evtfoid))
    from pg_event_trigger e
)
select jsonb_build_object(
  'checked_at_jst', to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI:SS'),
  'categories', (select jsonb_object_agg(s.category, jsonb_build_object('count', s.n, 'md5', s.h))
                   from (select f.category, count(*) as n, md5(string_agg(f.fact, E'\n' order by f.fact collate "C")) as h
                           from facts f group by f.category) s),
  'functions_including_ai_ledger', (select count(*) from fn f join pg_proc p on p.oid = f.oid where p.prokind in ('f', 'p', 'w')),
  'ai_ledger_rpcs', (select count(*) from fn f where f.nspname = 'public' and f.proname like 'ai\_ledger\_%')
) as result;
