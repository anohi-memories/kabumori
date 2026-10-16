-- F5 Phase 12: read-only, schema-only inventory of a Postgres database (the BG1 baseline gap).
-- SOURCE ONLY: written for a SEPARATELY AUTHORIZED run against production, which has NOT happened. This repository's
-- tests ran it only against throw-away local databases with fake data.
--
-- What it is:  one JSON object per line (kind, key, attributes) describing STRUCTURE: schemas, extensions, roles,
--              relations, columns, constraints, indexes, triggers, functions, policies, types, view dependencies,
--              event triggers, publications, foreign servers, per-database/role setting NAMES, default ACLs.
-- What it is NOT: a data export. It reads no row of any application, auth, storage, vault or cron table, no sequence
--              value, no statistics, no password, no function body, no option value, no setting value. Every
--              expression the database stores (column defaults, check constraints, index predicates, policy
--              expressions, trigger definitions, view definitions) is emitted only as (a) a SHAPE with every string
--              literal replaced by '?' and (b) the SHA-256 of the full text. A function body is emitted only as its
--              SHA-256, its length and five booleans (does it mention cron / net / vault / a URL / a Supabase host).
-- Least privilege: it needs a login that can CONNECT and nothing else. Every catalog read below is open to PUBLIC.
--              Do NOT run it as a superuser or as an owner of the application tables.
-- Safety:      the whole script is one READ ONLY, REPEATABLE READ transaction with short timeouts; it ends with
--              ROLLBACK. It uses no temp object, no function it defines, no extension function, no dynamic SQL.
-- Run (psql, no password on the command line, output goes to a file the operator keeps OUT of git and chat):
--              psql -X -q -A -t -v ON_ERROR_STOP=1 -f schema_inventory.sql "$KABUMORI_INVENTORY_DB_URL" > inventory.ndjson
-- The statement list is checked mechanically by inventory_test.ts (statements and FROM targets are allowlisted).
begin transaction isolation level repeatable read read only;
set local statement_timeout = '60s';
set local lock_timeout = '2s';
set local idle_in_transaction_session_timeout = '120s';

-- 0. meta
select jsonb_build_object('k', 'meta', 'key', 'inventory', 'a', jsonb_build_object(
  'format', 1, 'server_major', current_setting('server_version_num')::int / 10000))::text;

-- 1. schemas
select jsonb_build_object('k', 'schema', 'key', n.nspname, 'a', jsonb_build_object(
  'scope', case when n.nspname in ('public', 'private') then 'app'
                when n.nspname in ('auth', 'storage', 'vault', 'extensions', 'cron', 'net', 'realtime', 'supabase_functions', 'graphql', 'graphql_public', 'pgsodium', 'pgsodium_masks', 'pgbouncer', 'supabase_migrations', 'vault') then 'platform'
                else 'unclassified' end,
  'owner', pg_get_userbyid(n.nspowner),
  'acl', case when n.nspacl is null then 'null'::jsonb else coalesce((select jsonb_agg(x order by x) from (select distinct case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type || case when a.is_grantable then '*' else '' end as x from aclexplode(n.nspacl) a) s), '[]'::jsonb) end))::text
from pg_namespace n
where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_toast%' and n.nspname not like 'pg\_temp\_%'
order by n.nspname;

-- 2. extensions (their member objects are counted, not listed)
select jsonb_build_object('k', 'extension', 'key', e.extname, 'a', jsonb_build_object(
  'schema', n.nspname, 'version', e.extversion, 'owner', pg_get_userbyid(e.extowner),
  'members', (select count(*) from pg_depend d where d.refclassid = 'pg_extension'::regclass and d.refobjid = e.oid and d.deptype = 'e')))::text
from pg_extension e join pg_namespace n on n.oid = e.extnamespace
order by e.extname;

-- 3. roles (attributes only: pg_roles never shows a password; no valid-until, no per-role settings) and memberships
select jsonb_build_object('k', 'role', 'key', r.rolname, 'a', jsonb_build_object(
  'superuser', r.rolsuper, 'inherit', r.rolinherit, 'createrole', r.rolcreaterole, 'createdb', r.rolcreatedb,
  'login', r.rolcanlogin, 'replication', r.rolreplication, 'bypassrls', r.rolbypassrls, 'connlimit', r.rolconnlimit))::text
from pg_roles r
where r.rolname not like 'pg\_%'
order by r.rolname;

select jsonb_build_object('k', 'membership', 'key', pg_get_userbyid(m.member) || '>' || pg_get_userbyid(m.roleid), 'a', jsonb_build_object(
  'member', pg_get_userbyid(m.member), 'role', pg_get_userbyid(m.roleid),
  'admin', to_jsonb(m)->'admin_option', 'inherit', to_jsonb(m)->'inherit_option', 'set', to_jsonb(m)->'set_option'))::text
from pg_auth_members m
order by 1;

-- 4. relations: tables, partitioned tables, views, materialized views, sequences, foreign tables
select jsonb_build_object('k', 'relation', 'key', n.nspname || '.' || c.relname, 'a', jsonb_build_object(
  'schema', n.nspname,
  'relkind', c.relkind::text, 'owner', pg_get_userbyid(c.relowner), 'persistence', c.relpersistence::text,
  'rls', c.relrowsecurity, 'rls_forced', c.relforcerowsecurity, 'partition', c.relispartition,
  'options', coalesce((select jsonb_agg(o order by o) from unnest(c.reloptions) o), '[]'::jsonb),
  'acl', case when c.relacl is null then 'null'::jsonb else coalesce((select jsonb_agg(x order by x) from (select distinct case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type || case when a.is_grantable then '*' else '' end as x from aclexplode(c.relacl) a) s), '[]'::jsonb) end,
  'def_shape', case when c.relkind in ('v', 'm') then regexp_replace(pg_get_viewdef(c.oid), '(E|U&)?''(?:[^'']|'''')*''', '''?''', 'g') end,
  'def_sha256', case when c.relkind in ('v', 'm') then encode(sha256(convert_to(pg_get_viewdef(c.oid), 'UTF8')), 'hex') end,
  'bound_sha256', case when c.relispartition then encode(sha256(convert_to(pg_get_expr(c.relpartbound, c.oid), 'UTF8')), 'hex') end,
  'sequence', case when c.relkind = 'S' then (select jsonb_build_object('type', format_type(s.seqtypid, null), 'start', s.seqstart::text, 'increment', s.seqincrement::text, 'min', s.seqmin::text, 'max', s.seqmax::text, 'cache', s.seqcache::text, 'cycle', s.seqcycle) from pg_sequence s where s.seqrelid = c.oid) end,
  'foreign_server', case when c.relkind = 'f' then (select srv.srvname from pg_foreign_table ft join pg_foreign_server srv on srv.oid = ft.ftserver where ft.ftrelid = c.oid) end,
  'foreign_option_keys', case when c.relkind = 'f' then coalesce((select jsonb_agg(split_part(o, '=', 1) order by split_part(o, '=', 1)) from pg_foreign_table ft cross join lateral unnest(ft.ftoptions) o where ft.ftrelid = c.oid), '[]'::jsonb) end))::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_toast%' and n.nspname not like 'pg\_temp\_%'
  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
order by n.nspname, c.relname;

-- 5. columns (the default is a shape + hash; the column ACL, when there is one, is normalised like the others)
select jsonb_build_object('k', 'column', 'key', t.rel || '.' || t.attname, 'a', jsonb_build_object(
  'rel', t.rel, 'ord', t.ord, 'type', t.type, 'notnull', t.attnotnull, 'generated', t.attgenerated::text, 'identity', t.attidentity::text,
  'default_shape', case when t.def is not null then regexp_replace(t.def, '(E|U&)?''(?:[^'']|'''')*''', '''?''', 'g') end,
  'default_sha256', case when t.def is not null then encode(sha256(convert_to(t.def, 'UTF8')), 'hex') end,
  'acl', case when t.attacl is null then 'null'::jsonb else coalesce((select jsonb_agg(x order by x) from (select distinct case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type || case when a.is_grantable then '*' else '' end as x from aclexplode(t.attacl) a) s), '[]'::jsonb) end))::text
from (
  select n.nspname || '.' || c.relname as rel, a.attname, a.attnum, row_number() over (partition by a.attrelid order by a.attnum) as ord,
         format_type(a.atttypid, a.atttypmod) as type, a.attnotnull, a.attgenerated, a.attidentity, a.attacl,
         pg_get_expr(d.adbin, d.adrelid) as def
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_toast%' and n.nspname not like 'pg\_temp\_%'
    and not exists (select 1 from pg_depend dd where dd.classid = 'pg_class'::regclass and dd.objid = c.oid and dd.deptype = 'e')
) t
order by t.rel, t.attnum;

-- 6. constraints (primary / unique / foreign / check / exclusion). A foreign key also carries its parsed target.
select jsonb_build_object('k', 'constraint', 'key', n.nspname || '.' || c.relname || '.' || con.conname, 'a', jsonb_build_object(
  'rel', n.nspname || '.' || c.relname, 'type', con.contype::text, 'validated', con.convalidated,
  'deferrable', con.condeferrable, 'deferred', con.condeferred,
  'def_shape', regexp_replace(pg_get_constraintdef(con.oid), '(E|U&)?''(?:[^'']|'''')*''', '''?''', 'g'),
  'def_sha256', encode(sha256(convert_to(pg_get_constraintdef(con.oid), 'UTF8')), 'hex'),
  'fk', case when con.contype = 'f' then jsonb_build_object(
      'columns', (select jsonb_agg(att.attname order by k.ord) from unnest(con.conkey) with ordinality k(attnum, ord) join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum),
      'references', (select rn.nspname || '.' || rc.relname from pg_class rc join pg_namespace rn on rn.oid = rc.relnamespace where rc.oid = con.confrelid),
      'referenced_columns', (select jsonb_agg(att.attname order by k.ord) from unnest(con.confkey) with ordinality k(attnum, ord) join pg_attribute att on att.attrelid = con.confrelid and att.attnum = k.attnum),
      'on_delete', con.confdeltype::text, 'on_update', con.confupdtype::text) end))::text
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where con.contype in ('p', 'u', 'f', 'c', 'x')
  and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_toast%' and n.nspname not like 'pg\_temp\_%'
  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
order by n.nspname, c.relname, con.conname;

-- 7. indexes
select jsonb_build_object('k', 'index', 'key', n.nspname || '.' || c.relname || '.' || ic.relname, 'a', jsonb_build_object(
  'rel', n.nspname || '.' || c.relname, 'unique', i.indisunique, 'primary', i.indisprimary, 'valid', i.indisvalid, 'ready', i.indisready,
  'method', (select am.amname from pg_am am where am.oid = ic.relam),
  'def_shape', regexp_replace(pg_get_indexdef(i.indexrelid), '(E|U&)?''(?:[^'']|'''')*''', '''?''', 'g'),
  'def_sha256', encode(sha256(convert_to(pg_get_indexdef(i.indexrelid), 'UTF8')), 'hex')))::text
from pg_index i
join pg_class ic on ic.oid = i.indexrelid
join pg_class c on c.oid = i.indrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_toast%' and n.nspname not like 'pg\_temp\_%'
  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
order by n.nspname, c.relname, ic.relname;

-- 8. triggers (user triggers only; the internal ones that implement foreign keys are the constraints above)
select jsonb_build_object('k', 'trigger', 'key', n.nspname || '.' || c.relname || '.' || t.tgname, 'a', jsonb_build_object(
  'rel', n.nspname || '.' || c.relname, 'enabled', t.tgenabled::text,
  'function', (select pn.nspname || '.' || p.proname from pg_proc p join pg_namespace pn on pn.oid = p.pronamespace where p.oid = t.tgfoid),
  'def_shape', regexp_replace(pg_get_triggerdef(t.oid), '(E|U&)?''(?:[^'']|'''')*''', '''?''', 'g'),
  'def_sha256', encode(sha256(convert_to(pg_get_triggerdef(t.oid), 'UTF8')), 'hex')))::text
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where not t.tgisinternal
  and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_toast%' and n.nspname not like 'pg\_temp\_%'
order by n.nspname, c.relname, t.tgname;

-- 9. functions and procedures (a body is a hash, a length and five booleans; function settings keep only search_path's value)
select jsonb_build_object('k', 'function', 'key', n.nspname || '.' || p.proname || '(' || replace(oidvectortypes(p.proargtypes), ', ', ',') || ')', 'a', jsonb_build_object(
  'schema', n.nspname, 'kind', p.prokind::text, 'language', (select l.lanname from pg_language l where l.oid = p.prolang),
  'security_definer', p.prosecdef, 'volatility', p.provolatile::text, 'strict', p.proisstrict, 'leakproof', p.proleakproof,
  'parallel', p.proparallel::text, 'owner', pg_get_userbyid(p.proowner), 'returns', format_type(p.prorettype, null),
  'config', coalesce((select jsonb_object_agg(split_part(cfg, '=', 1), case when split_part(cfg, '=', 1) = 'search_path' then substr(cfg, strpos(cfg, '=') + 1) else '<redacted>' end) from unnest(p.proconfig) cfg), '{}'::jsonb),
  'acl', case when p.proacl is null then 'null'::jsonb else coalesce((select jsonb_agg(x order by x) from (select distinct case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type || case when a.is_grantable then '*' else '' end as x from aclexplode(p.proacl) a) s), '[]'::jsonb) end,
  'body_sha256', encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'), 'body_length', length(p.prosrc),
  'mentions', jsonb_build_object(
    'cron', lower(p.prosrc) ~ '(\mcron\.|pg_cron)',
    'net', lower(p.prosrc) ~ '(\mnet\.|pg_net|http_post|http_get)',
    'vault', lower(p.prosrc) ~ '(\mvault\.|pgsodium)',
    'url', lower(p.prosrc) ~ 'https?://',
    'supabase_host', lower(p.prosrc) ~ 'supabase\.(co|in|net)')))::text
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_toast%' and n.nspname not like 'pg\_temp\_%'
  and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
order by 1;

-- 10. row-level-security policies
select jsonb_build_object('k', 'policy', 'key', n.nspname || '.' || c.relname || '.' || pol.polname, 'a', jsonb_build_object(
  'rel', n.nspname || '.' || c.relname, 'command', pol.polcmd::text, 'permissive', pol.polpermissive,
  'roles', case when pol.polroles = '{0}'::oid[] then '["PUBLIC"]'::jsonb else coalesce((select jsonb_agg(pg_get_userbyid(r) order by pg_get_userbyid(r)) from unnest(pol.polroles) r), '[]'::jsonb) end,
  'using_shape', case when pol.polqual is not null then regexp_replace(pg_get_expr(pol.polqual, pol.polrelid), '(E|U&)?''(?:[^'']|'''')*''', '''?''', 'g') end,
  'using_sha256', case when pol.polqual is not null then encode(sha256(convert_to(pg_get_expr(pol.polqual, pol.polrelid), 'UTF8')), 'hex') end,
  'check_shape', case when pol.polwithcheck is not null then regexp_replace(pg_get_expr(pol.polwithcheck, pol.polrelid), '(E|U&)?''(?:[^'']|'''')*''', '''?''', 'g') end,
  'check_sha256', case when pol.polwithcheck is not null then encode(sha256(convert_to(pg_get_expr(pol.polwithcheck, pol.polrelid), 'UTF8')), 'hex') end))::text
from pg_policy pol
join pg_class c on c.oid = pol.polrelid
join pg_namespace n on n.oid = c.relnamespace
order by n.nspname, c.relname, pol.polname;

-- 11. user types: enums (labels), composites (attribute types), domains (base type, default shape, checks)
select jsonb_build_object('k', 'type', 'key', n.nspname || '.' || t.typname, 'a', jsonb_build_object(
  'kind', t.typtype::text, 'owner', pg_get_userbyid(t.typowner),
  'labels', case when t.typtype = 'e' then (select jsonb_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) end,
  'attributes', case when t.typtype = 'c' then (select jsonb_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) order by a.attnum) from pg_attribute a where a.attrelid = t.typrelid and a.attnum > 0 and not a.attisdropped) end,
  'base', case when t.typtype = 'd' then format_type(t.typbasetype, t.typtypmod) end,
  'notnull', case when t.typtype = 'd' then t.typnotnull end,
  'default_sha256', case when t.typtype = 'd' and t.typdefaultbin is not null then encode(sha256(convert_to(pg_get_expr(t.typdefaultbin, 0), 'UTF8')), 'hex') end,
  'checks', case when t.typtype = 'd' then (select jsonb_agg(regexp_replace(pg_get_constraintdef(con.oid), '(E|U&)?''(?:[^'']|'''')*''', '''?''', 'g') order by con.conname) from pg_constraint con where con.contypid = t.oid) end))::text
from pg_type t join pg_namespace n on n.oid = t.typnamespace
where t.typtype in ('e', 'c', 'd', 'r', 'm')
  and (t.typtype <> 'c' or exists (select 1 from pg_class rc where rc.oid = t.typrelid and rc.relkind = 'c'))
  and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_toast%' and n.nspname not like 'pg\_temp\_%'
  and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e')
order by n.nspname, t.typname;

-- 12. references: which relations a view reads
select distinct jsonb_build_object('k', 'view_reference', 'key', vn.nspname || '.' || v.relname || '>' || tn.nspname || '.' || t.relname, 'a', jsonb_build_object(
  'view', vn.nspname || '.' || v.relname, 'reads', tn.nspname || '.' || t.relname))::text
from pg_depend d
join pg_rewrite r on r.oid = d.objid
join pg_class v on v.oid = r.ev_class
join pg_namespace vn on vn.oid = v.relnamespace
join pg_class t on t.oid = d.refobjid
join pg_namespace tn on tn.oid = t.relnamespace
where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype = 'n'
  and v.oid <> t.oid and v.relkind in ('v', 'm')
  and vn.nspname not in ('pg_catalog', 'information_schema') and tn.nspname not in ('pg_catalog', 'information_schema')
order by 1;

-- 13. event triggers
select jsonb_build_object('k', 'event_trigger', 'key', et.evtname, 'a', jsonb_build_object(
  'event', et.evtevent, 'enabled', et.evtenabled::text, 'owner', pg_get_userbyid(et.evtowner),
  'function', (select pn.nspname || '.' || p.proname from pg_proc p join pg_namespace pn on pn.oid = p.pronamespace where p.oid = et.evtfoid),
  'tags', coalesce((select jsonb_agg(tag order by tag) from unnest(et.evttags) tag), '[]'::jsonb)))::text
from pg_event_trigger et
order by et.evtname;

-- 14. publications (names only)
select jsonb_build_object('k', 'publication', 'key', p.pubname, 'a', jsonb_build_object(
  'owner', pg_get_userbyid(p.pubowner), 'all_tables', p.puballtables, 'insert', p.pubinsert, 'update', p.pubupdate, 'delete', p.pubdelete, 'truncate', p.pubtruncate,
  'tables', coalesce((select jsonb_agg(n.nspname || '.' || c.relname order by n.nspname, c.relname) from pg_publication_rel pr join pg_class c on c.oid = pr.prrelid join pg_namespace n on n.oid = c.relnamespace where pr.prpubid = p.oid), '[]'::jsonb)))::text
from pg_publication p
order by p.pubname;

-- 15. foreign data wrappers, servers and user mappings: names and option KEYS only, never an option value
select jsonb_build_object('k', 'foreign_data_wrapper', 'key', w.fdwname, 'a', jsonb_build_object(
  'owner', pg_get_userbyid(w.fdwowner),
  'option_keys', coalesce((select jsonb_agg(split_part(o, '=', 1) order by split_part(o, '=', 1)) from unnest(w.fdwoptions) o), '[]'::jsonb)))::text
from pg_foreign_data_wrapper w
order by w.fdwname;

select jsonb_build_object('k', 'foreign_server', 'key', s.srvname, 'a', jsonb_build_object(
  'wrapper', (select w.fdwname from pg_foreign_data_wrapper w where w.oid = s.srvfdw), 'owner', pg_get_userbyid(s.srvowner),
  'option_keys', coalesce((select jsonb_agg(split_part(o, '=', 1) order by split_part(o, '=', 1)) from unnest(s.srvoptions) o), '[]'::jsonb)))::text
from pg_foreign_server s
order by s.srvname;

select jsonb_build_object('k', 'user_mapping', 'key', um.srvname || '|' || um.usename, 'a', jsonb_build_object(
  'server', um.srvname, 'user', um.usename,
  'option_keys', coalesce((select jsonb_agg(split_part(o, '=', 1) order by split_part(o, '=', 1)) from unnest(um.umoptions) o), '[]'::jsonb)))::text
from pg_user_mappings um
order by 1;

-- 16. per-database / per-role settings: the NAMES that are set (a value is often a key or a URL)
select jsonb_build_object('k', 'setting_scope', 'key', coalesce((select d.datname from pg_database d where d.oid = s.setdatabase), '*') || '|' || coalesce((select pg_get_userbyid(s.setrole) where s.setrole <> 0), '*'), 'a', jsonb_build_object(
  'names', coalesce((select jsonb_agg(split_part(o, '=', 1) order by split_part(o, '=', 1)) from unnest(s.setconfig) o), '[]'::jsonb)))::text
from pg_db_role_setting s
order by 1;

-- 17. default privileges
select jsonb_build_object('k', 'default_acl', 'key', pg_get_userbyid(d.defaclrole) || '|' || coalesce((select n.nspname from pg_namespace n where n.oid = d.defaclnamespace and d.defaclnamespace <> 0), '*') || '|' || d.defaclobjtype::text, 'a', jsonb_build_object(
  'acl', case when d.defaclacl is null then 'null'::jsonb else coalesce((select jsonb_agg(x order by x) from (select distinct case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type || case when a.is_grantable then '*' else '' end as x from aclexplode(d.defaclacl) a) s), '[]'::jsonb) end))::text
from pg_default_acl d
order by 1;

-- 18. procedural languages other than the built-in ones
select jsonb_build_object('k', 'language', 'key', l.lanname, 'a', jsonb_build_object(
  'trusted', l.lanpltrusted, 'owner', pg_get_userbyid(l.lanowner)))::text
from pg_language l
where l.lanname not in ('internal', 'c', 'sql')
order by l.lanname;

rollback;
