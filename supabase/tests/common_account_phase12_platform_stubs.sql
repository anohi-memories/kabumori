-- ANALYSIS ONLY (F5 Phase 12). The least a bare PostgreSQL needs so that the repository's own migrations can be REPLAYED
-- and their effect on the required relations observed. These stand in for objects Supabase creates and this repository
-- never does (auth, storage, vault, cron, net, the API roles, one extension). They claim nothing about what a managed
-- project holds: that is read back in a project by the release probe, or approved from a production inventory.
-- Never applied anywhere but a throw-away local database; no secret, no data.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text, is_anonymous boolean not null default false, raw_user_meta_data jsonb, created_at timestamptz default now());
create table if not exists auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade, provider text not null, provider_id text);
create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade, not_after timestamptz);
create or replace function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
grant usage on schema auth to anon, authenticated, service_role;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, owner uuid, owner_id text, public boolean default false);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text, owner uuid, owner_id text, metadata jsonb, created_at timestamptz default now());
create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $f$ insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $f$;
create or replace function cron.unschedule(job_name text) returns boolean language sql as $f$ delete from cron.job where jobname = job_name returning true $f$;
create schema if not exists net;
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 1000) returns bigint language sql as $f$ select 1::bigint $f$;
create schema if not exists vault;
create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text);
create or replace view vault.decrypted_secrets as select s.id, s.name, s.secret as decrypted_secret from vault.secrets s;
create or replace function vault.create_secret(secret text, name text default null, description text default '') returns uuid language sql as $f$ insert into vault.secrets (secret, name) values (secret, name) returning id $f$;
