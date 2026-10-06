-- Local proof for 20261006120000_tdnet_intake_queue.sql. Run by run.sh on a disposable database.
-- Prerequisite stubs: roles + a minimal important_news_candidates (the real table is not needed for this table's FK).
\set ON_ERROR_STOP on
\pset tuples_only on

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create table public.important_news_candidates (id uuid primary key default gen_random_uuid());

\i supabase/migrations/20261006120000_tdnet_intake_queue.sql
-- re-applying must be a no-op (idempotent migration)
\i supabase/migrations/20261006120000_tdnet_intake_queue.sql

-- 1. privileges: RLS on, no anon/authenticated access, service_role has table privileges
select 'rls_on=' || relrowsecurity from pg_class where oid = 'public.tdnet_intake_queue'::regclass;
select 'anon_select=' || has_table_privilege('anon', 'public.tdnet_intake_queue', 'select');
select 'auth_insert=' || has_table_privilege('authenticated', 'public.tdnet_intake_queue', 'insert');
select 'svc_all=' || (has_table_privilege('service_role', 'public.tdnet_intake_queue', 'select') and has_table_privilege('service_role', 'public.tdnet_intake_queue', 'update'));

-- 2. insert + ON CONFLICT DO NOTHING by source_url (idempotent enqueue)
insert into public.tdnet_intake_queue (source_url, company_code, company_name, title, published_at, priority_tier, priority_reason, group_key)
values ('https://www.release.tdnet.info/inbs/a.pdf', '7203', 'トヨタ', '業績予想の修正', now(), 1, 'earnings_revision', '7203:1');
insert into public.tdnet_intake_queue (source_url, company_code, company_name, title, published_at, priority_tier, priority_reason, group_key)
values ('https://www.release.tdnet.info/inbs/a.pdf', '7203', 'トヨタ', '重複', now(), 1, 'earnings_revision', '7203:1')
on conflict (source_url) do nothing;
select 'rows_after_dup_insert=' || count(*) from public.tdnet_intake_queue;

-- 3. constraints reject bad rows
do $$ begin
  begin insert into public.tdnet_intake_queue (source_url, company_code, company_name, title, published_at, priority_tier, priority_reason, group_key) values ('http://x/a', 'c', 'n', 't', now(), 1, 'r', 'g'); raise exception 'http accepted'; exception when check_violation then null; end;
  begin insert into public.tdnet_intake_queue (source_url, company_code, company_name, title, published_at, priority_tier, priority_reason, group_key) values ('https://x/a', 'c', 'n', 't', now(), 4, 'r', 'g'); raise exception 'tier 4 accepted'; exception when check_violation then null; end;
  begin update public.tdnet_intake_queue set state = 'enriching'; raise exception 'enriching without lease accepted'; exception when check_violation then null; end;
  begin update public.tdnet_intake_queue set state = 'candidate_created'; raise exception 'completed without completed_at accepted'; exception when check_violation then null; end;
  begin update public.tdnet_intake_queue set state = 'bogus'; raise exception 'bogus state accepted'; exception when check_violation then null; end;
end $$;
select 'constraints=ok';

-- 4. the claim statement (the PATCH the worker sends), single winner
update public.tdnet_intake_queue set state = 'queued', attempt_count = 0;
with won as (
  update public.tdnet_intake_queue
     set state = 'enriching', claimed_by = 'w1', claimed_at = now(), lease_expires_at = now() + interval '3 minutes', attempt_count = 1
   where source_url = 'https://www.release.tdnet.info/inbs/a.pdf' and attempt_count = 0
     and (state = 'queued' or (state = 'failed_retryable' and next_attempt_at <= now()) or (state = 'enriching' and lease_expires_at < now()))
  returning 1)
select 'first_claim_rows=' || count(*) from won;
with won as (
  update public.tdnet_intake_queue
     set state = 'enriching', claimed_by = 'w2', claimed_at = now(), lease_expires_at = now() + interval '3 minutes', attempt_count = 1
   where source_url = 'https://www.release.tdnet.info/inbs/a.pdf' and attempt_count = 0
     and (state = 'queued' or (state = 'failed_retryable' and next_attempt_at <= now()) or (state = 'enriching' and lease_expires_at < now()))
  returning 1)
select 'second_claim_rows=' || count(*) from won;

-- 5. a stale lease can be taken over (attempt_count read as 1 by the new worker)
update public.tdnet_intake_queue set lease_expires_at = now() - interval '1 second';
with won as (
  update public.tdnet_intake_queue
     set state = 'enriching', claimed_by = 'w3', claimed_at = now(), lease_expires_at = now() + interval '3 minutes', attempt_count = 2
   where source_url = 'https://www.release.tdnet.info/inbs/a.pdf' and attempt_count = 1
     and (state = 'queued' or (state = 'failed_retryable' and next_attempt_at <= now()) or (state = 'enriching' and lease_expires_at < now()))
  returning 1)
select 'stale_takeover_rows=' || count(*) from won;
select 'claimed_by=' || claimed_by || ' attempts=' || attempt_count from public.tdnet_intake_queue;
