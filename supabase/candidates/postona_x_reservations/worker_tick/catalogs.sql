-- TEST ONLY (G3-02 #11). Fake catalogs for 016 on a disposable PostgreSQL: run by worker_tick_run.sh as the superuser. No network:
-- net.http_post only queues a row. The queue is readable by PUBLIC, as H4-17 measured Supabase's default (the P1 condition).
-- pg_cron's job list is row-level filtered to the job's owner, as pg_cron does for non-superusers.
create schema extensions;
create extension pgcrypto with schema extensions;

create schema net;
create table net.http_request_queue (id bigserial primary key, method text not null, url text not null, headers jsonb, body bytea, timeout_milliseconds integer);
create table net._http_response (id bigint primary key, status_code integer, content_type text, headers jsonb, content text, timed_out boolean, error_msg text, created timestamptz not null default now());
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000)
returns bigint language sql security definer set search_path = '' as $$
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds) values ('POST', url, headers, convert_to(body::text, 'UTF8'), timeout_milliseconds) returning id
$$;
grant usage on schema net to public;
grant select on net.http_request_queue to public;
grant select on net._http_response to public;
grant execute on function net.http_post(text, jsonb, jsonb, jsonb, integer) to public;

create schema vault;
create table vault.secrets (name text primary key, secret text not null);
create view vault.decrypted_secrets as select s.name, s.secret as decrypted_secret from vault.secrets s;

create schema cron;
create table cron.job (jobid bigserial primary key, schedule text not null, command text not null, jobname text, username text not null default current_user);
alter table cron.job enable row level security;
create policy cron_job_owner on cron.job using (username = current_user) with check (username = current_user);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (schedule, command, jobname) values (schedule, command, job_name) returning jobid $$;
create function cron.unschedule(job_name text) returns boolean language plpgsql as $$
begin delete from cron.job j where j.jobname = job_name; return found; end $$;
grant usage on schema cron to public;
grant select, insert, delete on cron.job to public;
grant usage on sequence cron.job_jobid_seq to public;
