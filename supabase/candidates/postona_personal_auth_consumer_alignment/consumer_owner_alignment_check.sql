-- G5 SOURCE CANDIDATE (G5-43, Issue #320 task 43) -- NOT in supabase/migrations/, NOT applied, NOT run against any managed or production
-- database by this work. READ-ONLY: one SELECT over the catalog; it creates, changes and grants nothing (the tests run it inside a
-- READ ONLY transaction). Run it as any role, after the G5 migration candidate (20261028090000) and after each consumer install.
--
-- What it answers: are the consumers of G5's OWNER-ONLY gates aligned with the one ownership rule of G5-42 (docs/common-account/
-- g5-42-...-consumer-contract.md section 3) -- "a function that calls an owner-only gate is a SECURITY DEFINER function OWNED BY THE
-- LIFECYCLE OWNER, and G5 grants no EXECUTE on an owner-only gate to anyone else"? This is how G4's begin / complete owner / EXECUTE
-- mismatch is closed WITHOUT a grant: G4's own install precondition (has_function_privilege(<owner of begin>, <gate>, 'EXECUTE'))
-- holds when begin / complete are owned by the lifecycle owner, and this check refuses every other way of making it hold (a grant,
-- a superuser owner, an API role that can become the owner).
--
-- Zero rows = aligned. Each row is one finding: (code, object, detail).
--   GATE_OWNER_MISSING        private.postona_personal_session() is absent: the lifecycle owner cannot be determined (install first)
--   GATE_OWNER_IS_SUPERUSER   the lifecycle owner is a superuser (the candidate itself refuses that)
--   GATE_OWNER_REACHABLE      an API role (anon / authenticated / service_role / authenticator) is a member of the lifecycle owner
--   GATE_OWNER_DIFFERS        a G5 private function (account_lifecycle_* / postona_personal_*) is owned by another role
--   GATE_ACL_WIDENED          a G5 private function is executable by someone other than its owner (including a NULL ACL = PUBLIC)
--   ENTRY_ACL_CHANGED         R1 / R0 are not exactly {owner, authenticated}, or W2 not exactly {owner, service_role}
--   CONSUMER_OWNER_MISMATCH   a function naming an owner-only gate -- directly, or through an owner-only helper that does -- is
--                             owned by another role (a superuser included)
--   CONSUMER_NOT_DEFINER      ... is SECURITY INVOKER (it would need the caller to hold EXECUTE, i.e. a grant)
--   CONSUMER_SEARCH_PATH      ... is SECURITY DEFINER without a fixed search_path, or with "$user" / pg_temp in it
--   CONSUMER_SEARCH_PATH_WRITABLE  ... has a search_path schema in which an API role may CREATE
--   NON_FUNCTION_DEPENDENT    a view, rule, default, policy ... records a dependency on an owner-only gate (it would run the gate
--                             with someone else's privileges, or fail): to be reviewed and removed, never granted around. A trigger
--                             is not one: it can only name a trigger function, which runs as its (definer) owner.
-- "Names an owner-only gate" = the lower-cased source contains the gate's name (comments included: conservative), or pg_depend records
-- the call (SQL-standard bodies). NOT seen: a name built by dynamic SQL, other databases, callers outside the database (Edge / app).
with recursive
api(rolname) as (values ('anon'), ('authenticated'), ('service_role'), ('authenticator')),
owner as (
  select p.proowner as oid, r.rolname, r.rolsuper
  from pg_catalog.pg_proc p join pg_catalog.pg_roles r on r.oid = p.proowner
  where p.oid = pg_catalog.to_regprocedure('private.postona_personal_session()')
),
gate as (
  select p.oid, p.proname, p.proowner, p.proacl
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and (p.proname like 'account\_lifecycle\_%' or p.proname like 'postona\_personal\_%')
),
-- a function's name as schema.name(argument types), whatever the caller's search_path (regprocedure output depends on it)
fn as (
  select p.oid, n.nspname || '.' || p.proname || '(' || coalesce((select pg_catalog.string_agg(pg_catalog.format_type(a.t, null), ',' order by a.i)
           from pg_catalog.unnest(p.proargtypes::pg_catalog.oid[]) with ordinality as a(t, i)), '') || ')' as name
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
),
entry(sig, role) as (values
  ('public.common_account_authorization_verdict(text,text,text)', 'authenticated'),
  ('public.common_account_bootstrap_verdict(text,text)', 'authenticated'),
  ('public.common_account_worker_brand_verdict(text,text,bigint,bigint)', 'service_role')),
-- protected = the gates, plus every function that names a protected function AND is itself executable by its owner only (an internal
-- helper such as G4's postona_g4_x_oauth.require_person or G3's postona_x_resv.caller): reaching it is reaching the gate. A gate is
-- matched by its bare name (distinctive prefixes), a helper by schema.name (helper names such as "caller" are not distinctive).
protected(oid, needle) as (
  select g.oid, g.proname::text from gate g
  union
  select p.oid, n.nspname || '.' || p.proname
  from protected t
  join pg_catalog.pg_proc p on pg_catalog.strpos(pg_catalog.lower(p.prosrc), t.needle) > 0
    or exists (select 1 from pg_catalog.pg_depend d
               where d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.objid = p.oid
                 and d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.refobjid = t.oid)
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where p.proacl is not null and not exists (select 1 from pg_catalog.aclexplode(p.proacl) x where x.grantee <> p.proowner)
),
-- consumer = every function (not a G5 gate itself) that names a protected function, whoever may execute it
consumer as (
  select distinct p.oid, p.proowner, p.prosecdef, p.proconfig
  from protected t
  join pg_catalog.pg_proc p on pg_catalog.strpos(pg_catalog.lower(p.prosrc), t.needle) > 0
    or exists (select 1 from pg_catalog.pg_depend d
               where d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.objid = p.oid
                 and d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.refobjid = t.oid)
  where p.oid not in (select oid from gate)
),
consumer_path as (
  select c.oid, pg_catalog.btrim(s.part, ' "') as schema
  from consumer c
  cross join lateral pg_catalog.unnest(c.proconfig) as cfg(setting)
  cross join lateral pg_catalog.regexp_split_to_table(pg_catalog.substr(cfg.setting, 13), ',') as s(part)
  where cfg.setting like 'search\_path=%'
),
finding(code, object, detail) as (
  select 'GATE_OWNER_MISSING', 'private.postona_personal_session()', 'install the G5 migration candidate first'
  where not exists (select 1 from owner)
  union all
  select 'GATE_OWNER_IS_SUPERUSER', o.rolname::text, 'the lifecycle owner must not be a superuser' from owner o where o.rolsuper
  union all
  select 'GATE_OWNER_REACHABLE', o.rolname::text, a.rolname || ' is a member of the lifecycle owner'
  from owner o join api a on true join pg_catalog.pg_roles r on r.rolname = a.rolname
  where pg_catalog.pg_has_role(r.oid, o.oid, 'MEMBER')
  union all
  select 'GATE_OWNER_DIFFERS', (select f.name from fn f where f.oid = g.oid), 'owned by ' || g.proowner::pg_catalog.regrole::text
  from gate g join owner o on true where g.proowner <> o.oid
  union all
  select 'GATE_ACL_WIDENED', (select f.name from fn f where f.oid = g.oid),
         coalesce(pg_catalog.array_to_string(g.proacl::text[], ','), 'NULL ACL (PUBLIC may execute)')
  from gate g
  where g.proacl is null
     or exists (select 1 from pg_catalog.aclexplode(g.proacl) x where x.grantee <> g.proowner)
  union all
  select 'ENTRY_ACL_CHANGED', e.sig, coalesce(pg_catalog.array_to_string(p.proacl::text[], ','), 'missing or NULL ACL')
  from entry e join owner o on true
  left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(e.sig)
  where p.oid is null or p.proacl is null or p.proowner <> o.oid
     or (select pg_catalog.array_agg(distinct x.grantee order by x.grantee) from pg_catalog.aclexplode(p.proacl) x where x.privilege_type = 'EXECUTE')
        is distinct from (select pg_catalog.array_agg(distinct r.oid order by r.oid) from pg_catalog.pg_roles r where r.oid = o.oid or r.rolname = e.role)
     or exists (select 1 from pg_catalog.aclexplode(p.proacl) x where x.privilege_type <> 'EXECUTE')
  union all
  select 'CONSUMER_OWNER_MISMATCH', (select f.name from fn f where f.oid = c.oid), 'owned by ' || c.proowner::pg_catalog.regrole::text
  from consumer c join owner o on true where c.proowner <> o.oid
  union all
  select 'CONSUMER_NOT_DEFINER', (select f.name from fn f where f.oid = c.oid), 'SECURITY INVOKER' from consumer c where not c.prosecdef
  union all
  select 'CONSUMER_SEARCH_PATH', (select f.name from fn f where f.oid = c.oid), coalesce(pg_catalog.array_to_string(c.proconfig, ','), 'no SET search_path')
  from consumer c
  where c.prosecdef
    and (not exists (select 1 from consumer_path cp where cp.oid = c.oid)
         or exists (select 1 from consumer_path cp where cp.oid = c.oid and (cp.schema = '$user' or cp.schema like 'pg\_temp%')))
  union all
  select distinct 'CONSUMER_SEARCH_PATH_WRITABLE', (select f.name from fn f where f.oid = cp.oid), cp.schema || ' is writable by ' || a.rolname
  from consumer_path cp join consumer c on c.oid = cp.oid and c.prosecdef
  join pg_catalog.pg_namespace n on n.nspname = cp.schema
  join api a on true join pg_catalog.pg_roles r on r.rolname = a.rolname
  where pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE')
  union all
  select distinct 'NON_FUNCTION_DEPENDENT', (select f.name from fn f where f.oid = t.oid),
         pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)
  from protected t join pg_catalog.pg_depend d on d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.refobjid = t.oid
  where d.classid not in ('pg_catalog.pg_proc'::pg_catalog.regclass, 'pg_catalog.pg_trigger'::pg_catalog.regclass) and d.deptype = 'n'
)
select code, object, detail from finding order by code, object, detail;
