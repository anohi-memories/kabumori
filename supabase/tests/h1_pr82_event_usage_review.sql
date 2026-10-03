-- H1 ONLY: run against an EMPTY DISPOSABLE PostgreSQL 17 database.
-- Never run on a Supabase project. Everything, including fake roles, rolls back.
\set ON_ERROR_STOP on
begin;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
alter default privileges in schema public grant all on tables to public, anon, authenticated, service_role;
create function pg_temp.probe(ok boolean, label text) returns text language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'PROBE FAILED: %', label; end if;
  return 'OBSERVED: ' || label;
end $$;
\ir ../migrations/20261003090000_ai_lab_topic_event_usage.sql
select pg_temp.probe((select relrowsecurity from pg_class where oid='public.ai_lab_topic_event_usage'::regclass), 'fresh RLS enabled');
select pg_temp.probe((select count(*)=0 from pg_policies where tablename='ai_lab_topic_event_usage'), 'fresh no public policies');
select pg_temp.probe(not exists(select 1 from (values('anon'),('authenticated')) r(role_name) cross join (values('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) p(priv) where has_table_privilege(r.role_name,'public.ai_lab_topic_event_usage',p.priv)), 'anon/authenticated no effective privileges');
select pg_temp.probe(has_table_privilege('service_role','public.ai_lab_topic_event_usage','SELECT') and has_table_privilege('service_role','public.ai_lab_topic_event_usage','INSERT'), 'service SELECT INSERT');
select pg_temp.probe(not exists(select 1 from (values('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) p(priv) where has_table_privilege('service_role','public.ai_lab_topic_event_usage',p.priv)), 'service no destructive/other privileges including TRUNCATE');
do $$
begin
  begin
    insert into public.ai_lab_topic_event_usage(scheduled_post_id,brand_id,event_key,x_post_id) values('00000000-0000-0000-0000-000000000001','kabumori','evergreen-1','1');
    raise exception 'brand CHECK did not reject';
  exception when check_violation then null; end;
  begin
    insert into public.ai_lab_topic_event_usage(scheduled_post_id,event_key,x_post_id) values('00000000-0000-0000-0000-000000000001','raw diary text','1');
    raise exception 'event CHECK did not reject';
  exception when check_violation then null; end;
  begin
    insert into public.ai_lab_topic_event_usage(scheduled_post_id,event_key,unit_key,x_post_id) values('00000000-0000-0000-0000-000000000001','evergreen-1','https://fixture.invalid','1');
    raise exception 'unit CHECK did not reject';
  exception when check_violation then null; end;
  begin
    insert into public.ai_lab_topic_event_usage(scheduled_post_id,event_key,x_post_id) values('00000000-0000-0000-0000-000000000001','evergreen-1','');
    raise exception 'X id CHECK did not reject';
  exception when check_violation then null; end;
end $$;
select pg_temp.probe(true, 'four CHECK violations rejected');
set local role service_role;
insert into public.ai_lab_topic_event_usage(scheduled_post_id,event_key,x_post_id) values
 ('00000000-0000-0000-0000-000000000001','diary-2026-09-30-1','1'),
 ('00000000-0000-0000-0000-000000000002','diary-2026-09-30-1','2');
reset role;
select pg_temp.probe((select count(*)=2 from public.ai_lab_topic_event_usage where event_key='diary-2026-09-30-1'), 'UNSAFE: different schedules can persist duplicate same event');
insert into public.ai_lab_topic_event_usage(scheduled_post_id,event_key,x_post_id) values('00000000-0000-0000-0000-000000000001','diary-2026-10-01-1','3') on conflict(scheduled_post_id) do nothing;
select pg_temp.probe((select event_key='diary-2026-09-30-1' and x_post_id='1' from public.ai_lab_topic_event_usage where scheduled_post_id='00000000-0000-0000-0000-000000000001'), 'UNSAFE: scheduled ID conflict silently retains different event/X id');
\ir ../migrations/20261003090000_ai_lab_topic_event_usage.sql
select pg_temp.probe((select count(*)=2 from public.ai_lab_topic_event_usage), 'clean reapply retains data');
select pg_temp.probe((select indexdef like '%(brand_id, published_at DESC)%' from pg_indexes where indexname='ai_lab_topic_event_usage_recent_idx'), 'fresh index matches brand/date/order query');
set local enable_seqscan=off;
explain(costs off) select event_key,published_at from public.ai_lab_topic_event_usage where brand_id='ai_salaryman_lab' and published_at>=now()-interval '14 days' order by published_at desc limit 200;
-- Explicit unsafe schema drift. Reapplying MUST refuse or repair this; candidate does neither.
alter table public.ai_lab_topic_event_usage drop constraint ai_lab_topic_event_usage_event_key_check;
alter table public.ai_lab_topic_event_usage drop constraint ai_lab_topic_event_usage_brand_id_check;
alter table public.ai_lab_topic_event_usage drop constraint ai_lab_topic_event_usage_pkey;
drop index public.ai_lab_topic_event_usage_recent_idx;
create index ai_lab_topic_event_usage_recent_idx on public.ai_lab_topic_event_usage(x_post_id);
create policy stale_allow_all on public.ai_lab_topic_event_usage for all to public using(true) with check(true);
\ir ../migrations/20261003090000_ai_lab_topic_event_usage.sql
select pg_temp.probe(not exists(select 1 from pg_constraint where conrelid='public.ai_lab_topic_event_usage'::regclass and contype='p'), 'UNSAFE: reapply silently accepts missing PK');
select pg_temp.probe(not exists(select 1 from pg_constraint where conrelid='public.ai_lab_topic_event_usage'::regclass and conname='ai_lab_topic_event_usage_event_key_check'), 'UNSAFE: reapply silently accepts missing event CHECK');
select pg_temp.probe(not exists(select 1 from pg_constraint where conrelid='public.ai_lab_topic_event_usage'::regclass and conname='ai_lab_topic_event_usage_brand_id_check'), 'UNSAFE: reapply silently accepts missing brand CHECK');
select pg_temp.probe((select indexdef like '%(x_post_id)%' from pg_indexes where indexname='ai_lab_topic_event_usage_recent_idx'), 'UNSAFE: same-named wrong index silently accepted');
select pg_temp.probe(exists(select 1 from pg_policies where tablename='ai_lab_topic_event_usage' and policyname='stale_allow_all'), 'UNSAFE: old permissive policy retained (named-role ACL still revoked)');
insert into public.ai_lab_topic_event_usage(scheduled_post_id,brand_id,event_key,x_post_id) values('00000000-0000-0000-0000-000000000001','kabumori','raw text admitted by drift','4');
select pg_temp.probe((select count(*)=1 from public.ai_lab_topic_event_usage where brand_id='kabumori'), 'UNSAFE: drift permits wrong brand/raw event/duplicate schedule');
rollback;
