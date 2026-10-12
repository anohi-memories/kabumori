-- Fake-only additions for the Phase 4 service fence proof (20261012130000). Applied after the candidate in the
-- disposable database; never part of it.
--
-- * public.fixture_fenced_rows: a service owner's own table with the generic insert fence attached, exactly
--   the one line another owner would write.
-- * As in a Supabase project, the service role holds table privileges on public tables (the lifecycle
--   fixture grants only the client role): needed so that a service-role insert reaches the trigger
--   instead of a privilege error.
set timezone = 'UTC';

grant select, insert on public.profiles to service_role;

create table public.fixture_fenced_rows (
  id bigserial primary key,
  owner_id uuid,
  note text not null default ''
);
revoke all on table public.fixture_fenced_rows from public, anon, authenticated, service_role;
revoke all on sequence public.fixture_fenced_rows_id_seq from public, anon, authenticated, service_role;
grant insert, select on public.fixture_fenced_rows to authenticated, service_role;
grant usage on sequence public.fixture_fenced_rows_id_seq to authenticated, service_role;
create trigger fixture_fenced_rows_fence before insert on public.fixture_fenced_rows
  for each row execute function private.account_lifecycle_service_insert_fence('owner_id', 'x_autopost');
