-- Run ONLY in an isolated disposable Supabase Postgres. This replaces the
-- local pg_net function with a recorder BEFORE any Scenario Cron job exists;
-- executing cron.job.command in the test can never contact Production.
-- Explicit disposable marker AND a Unix-socket connection are required.
do $disposable_guard$
begin
  if current_database() <> 'postgres'
     or inet_server_addr() is not null
     or current_setting('mic_phase3c.disposable', true) is distinct from 'yes' then
    raise exception 'MIC_PHASE3C_DISPOSABLE_DB_REQUIRED';
  end if;
end
$disposable_guard$;

create table if not exists public.mic_phase3c_http_calls (
  id bigint generated always as identity primary key,
  url text not null,
  body jsonb not null,
  timeout_ms integer not null,
  content_type_ok boolean not null,
  cron_secret_ok boolean not null
);

create or replace function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000
)
returns bigint
language plpgsql
as $$
declare
  v_id bigint;
begin
  insert into public.mic_phase3c_http_calls
    (url, body, timeout_ms, content_type_ok, cron_secret_ok)
  values
    (url, body, timeout_milliseconds,
     headers->>'Content-Type' = 'application/json',
     headers->>'X-Cron-Secret' = 'local_dummy_only')
  returning id into v_id;
  return v_id;
end;
$$;
