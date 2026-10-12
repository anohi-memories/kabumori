-- 検証用の最小の auth（使い捨ての手元の PostgreSQL 専用。本番には絶対に当てない）。
-- auth.uid() は Supabase と同じく request.jwt.claim.sub を読む。
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text
);
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
