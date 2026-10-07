-- 01 (read-only): identity and the migration-history rows that matter for 20261006230000.
-- Pending neighbours: PR #81 hardening (20261003120000) and PR #41 Stage 3B (20261006160000..160200).
select jsonb_build_object(
  'database', current_database(),
  'current_user', current_user,
  'server_version_num', current_setting('server_version_num'),
  'history_count', (select count(*) from supabase_migrations.schema_migrations),
  'history_latest', (select max(version) from supabase_migrations.schema_migrations),
  'rows', (select coalesce(jsonb_object_agg(v.version, coalesce(h.name, 'ABSENT')), '{}')
             from (values ('20261001150000'), ('20261003120000'), ('20261006160000'), ('20261006160100'),
                          ('20261006160200'), ('20261006230000')) v(version)
             left join supabase_migrations.schema_migrations h on h.version = v.version)
) as result;
