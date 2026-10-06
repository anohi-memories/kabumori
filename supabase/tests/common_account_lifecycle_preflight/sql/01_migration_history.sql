-- Production preflight / read-back (read-only). Migration ledger shape and contents: versions and names only.
-- statements / rollback / created_by / idempotency_key contents are never printed (only
-- whether they are filled), so no SQL text or operator identity leaves the database.
select jsonb_build_object(
  'ledger_columns', (
    select jsonb_agg(jsonb_build_object('c', a.attname, 't', format_type(a.atttypid, a.atttypmod),
                                        'nn', a.attnotnull, 'def', pg_get_expr(d.adbin, d.adrelid))
                     order by a.attnum)
      from pg_attribute a
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = 'supabase_migrations.schema_migrations'::regclass and a.attnum > 0 and not a.attisdropped),
  'ledger_constraints', (
    select jsonb_agg(c.conname || ' ' || c.contype::text || ' ' || pg_get_constraintdef(c.oid) order by c.conname collate "C")
      from pg_constraint c where c.conrelid = 'supabase_migrations.schema_migrations'::regclass),
  'ledger_user_triggers', (
    select count(*) from pg_trigger t
     where t.tgrelid = 'supabase_migrations.schema_migrations'::regclass and not t.tgisinternal),
  'ledger_owner', (
    select pg_get_userbyid(c.relowner) from pg_class c where c.oid = 'supabase_migrations.schema_migrations'::regclass),
  'ledger_rls', (
    select c.relrowsecurity from pg_class c where c.oid = 'supabase_migrations.schema_migrations'::regclass),
  'postgres_can_select', has_table_privilege('postgres', 'supabase_migrations.schema_migrations', 'SELECT'),
  'postgres_can_insert', has_table_privilege('postgres', 'supabase_migrations.schema_migrations', 'INSERT'),
  'rows', (select count(*) from supabase_migrations.schema_migrations),
  'max_version', (select max(version) from supabase_migrations.schema_migrations),
  'target_version_rows', (select count(*) from supabase_migrations.schema_migrations where version = '20261001150000'),
  'target_name_rows', (select count(*) from supabase_migrations.schema_migrations where name = 'common_account_lifecycle_foundation'),
  'related_rows', (
    select coalesce(jsonb_agg(version || ' ' || coalesce(name, '-') order by version collate "C"), '[]'::jsonb)
      from supabase_migrations.schema_migrations
     where coalesce(name, '') ~ '(common_account|account_lifecycle|service_entitlement)'),
  'fill', (
    select jsonb_build_object(
             'statements_null', count(*) filter (where statements is null),
             'name_null', count(*) filter (where name is null))
      from supabase_migrations.schema_migrations),
  'versions', (
    select jsonb_agg(jsonb_build_array(version, name, statements is null) order by version collate "C")
      from supabase_migrations.schema_migrations)
) as result;
