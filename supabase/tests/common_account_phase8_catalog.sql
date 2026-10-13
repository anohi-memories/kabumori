-- A deterministic listing of the catalog of the assembled world (functions with body hash and ACL, relations with
-- ACL, columns, constraints, policies, triggers, schema ACLs), sorted. Two databases are "the same schema" when the
-- listings are byte-equal. Read-only. Run with psql -q -A -t.
select 'fn ' || n.nspname || '.' || p.proname || '(' || array_to_string(p.proargtypes::regtype[], ',') || ') ' || md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(array_to_string(p.proacl::text[], ','), '-')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public', 'private', 'postona_x_resv', 'auth', 'storage', 'vault') and p.prokind = 'f'
union all
select 'rel ' || c.oid::regclass::text || ' ' || c.relkind::text || ' ' || c.relrowsecurity || ' ' || coalesce(array_to_string(c.relacl::text[], ','), '-')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private', 'postona_x_resv', 'auth', 'storage', 'vault')
union all
select 'col ' || a.attrelid::regclass::text || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull::text || ' ' || coalesce(array_to_string(a.attacl::text[], ','), '-')
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('public', 'private', 'postona_x_resv', 'auth', 'storage', 'vault') and a.attnum > 0 and not a.attisdropped
union all
select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) from pg_constraint where conrelid <> 0
union all
select 'pol ' || polrelid::regclass::text || ' ' || polname || ' ' || coalesce(pg_get_expr(polqual, polrelid), '-') || ' ' || coalesce(pg_get_expr(polwithcheck, polrelid), '-') from pg_policy
union all
select 'trg ' || (select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = tgrelid) || ' ' || tgname || ' ' || tgenabled::text
  from pg_trigger where not tgisinternal
union all
select 'nsp ' || nspname || ' ' || coalesce(array_to_string(nspacl::text[], ','), '-') from pg_namespace where nspname in ('public', 'private', 'postona_x_resv', 'auth', 'storage', 'vault')
order by 1;
