-- Fake-only Phase1H behavior proof (snapshot, plan-before-start, resumable
-- listing, resume credential). Run by x_autopost_phase1h_run.sh after:
-- 1D/1E/1F/1G fixtures -> 1B -> 1D -> 1E -> 1F -> 1G -> 1H migrations.
\set ON_ERROR_STOP on
set timezone = 'Asia/Tokyo';

create function pg_temp.expect_error(p_sql text, p_expected text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'EXPECTED_ERROR_NOT_RAISED: % :: %', p_expected, p_sql;
exception when others then
  if sqlerrm like 'EXPECTED_ERROR_NOT_RAISED%' then raise; end if;
  if sqlerrm <> p_expected and sqlstate <> p_expected then
    raise exception 'WRONG_ERROR expected % got % (%) :: %', p_expected, sqlerrm, sqlstate, p_sql;
  end if;
  if sqlerrm like '%fake_tok%' then raise exception 'SECRET_IN_ERROR'; end if;
end;
$$;

do $$
declare r record;
begin
  for r in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('record_v2_content_snapshot', 'list_resumable_v2_attempts',
             'read_x_publish_credential_for_resume_v2', 'x_v2_attempt_resumable', 'x_v2_require_plan_before_start')
  loop
    if not r.prosecdef or not ('search_path=""' = any(r.proconfig)) then raise exception 'secdef/search_path: %', r.proname; end if;
    if has_function_privilege('anon', r.oid, 'EXECUTE') or has_function_privilege('authenticated', r.oid, 'EXECUTE') then
      raise exception 'API role can execute %', r.proname; end if;
    if (r.proname like 'x\_v2\_%' escape '\') = has_function_privilege('service_role', r.oid, 'EXECUTE') then
      raise exception 'service_role ACL wrong for %', r.proname; end if;
  end loop;
  if has_table_privilege('service_role', 'public.post_v2_content_snapshots', 'INSERT') then raise exception 'snapshot table writable'; end if;
end $$;

revoke execute on function public.claim_due_post() from service_role;
set role service_role;

create temporary table plan (label text, post_type text, slot smallint);
insert into plan values ('tip3', 'tip', 1), ('tip2', 'tip', 2), ('tip_flight', 'tip', 3), ('tip_unc', 'tip', 4),
  ('tip_nosnap', 'tip', 5), ('useful', 'useful_tip', 6);
select public.schedule_account_bound_post_v2('brand_a', 'acct_a', current_date, p.post_type, p.slot,
  now() - interval '1 hour' - p.slot * interval '1 second') from plan p;
create temporary table claims (label text primary key, attempt_id uuid, claim_token uuid);
do $$
declare r record;
begin
  loop
    select * into r from public.claim_due_post_v2();
    exit when r.scheduled_post_id is null;
    insert into claims select p.label, r.attempt_id, r.claim_token from plan p
      join public.scheduled_posts s on s.post_type = p.post_type and s.slot_no = p.slot and s.brand_id = 'brand_a'
      where s.id = r.scheduled_post_id;
  end loop;
  if (select count(*) from claims) <> 6 then raise exception 'setup claims'; end if;
end $$;
create function pg_temp.c(p_label text) returns claims language sql as $$ select * from claims where label = p_label $$;
create function pg_temp.q(p_fmt text, p_label text, variadic p_args text[] default '{}') returns text language sql as $$
  select format(p_fmt, variadic array[(pg_temp.c(p_label)).attempt_id::text, (pg_temp.c(p_label)).claim_token::text] || p_args)
$$;

-- 1. Snapshot validation and immutability; plan + snapshot required before start.
do $$
begin
  perform pg_temp.expect_error(pg_temp.q('select public.record_v2_content_snapshot(%L,%L,%L::jsonb)', 'tip3',
    '{"tip_id":"00000000-0000-4000-8000-0000000000f1","parts":["a","b","c"]}'), 'PROVIDER_STEP_PLAN_REQUIRED');
  perform public.plan_provider_steps_v2(c.attempt_id, c.claim_token, 'tip_thread', n::smallint)
  from claims c join (values ('tip3', 3), ('tip2', 2), ('tip_flight', 2), ('tip_unc', 2), ('tip_nosnap', 1)) v(l, n) on v.l = c.label;
  perform pg_temp.expect_error(pg_temp.q('select public.record_v2_content_snapshot(%L,%L,%L::jsonb)', 'tip3',
    '{"tip_id":"00000000-0000-4000-8000-0000000000f1","parts":["a","b"]}'), 'V2_CONTENT_SNAPSHOT_INVALID');
  perform pg_temp.expect_error(pg_temp.q('select public.record_v2_content_snapshot(%L,%L,%L::jsonb)', 'tip3',
    '{"tip_id":"00000000-0000-4000-8000-0000000000f1","parts":["a"," ","c"]}'), 'V2_CONTENT_SNAPSHOT_INVALID');
  perform pg_temp.expect_error(pg_temp.q('select public.record_v2_content_snapshot(%L,%L,%L::jsonb)', 'tip3',
    '{"tip_id":"nope","parts":["a","b","c"]}'), 'V2_CONTENT_SNAPSHOT_INVALID');
  perform pg_temp.expect_error(pg_temp.q('select public.record_v2_content_snapshot(%L,%L,%L::jsonb)', 'tip3',
    '{"tip_id":"00000000-0000-4000-8000-0000000000f1","parts":["a","b","c"],"extra":1}'), 'V2_CONTENT_SNAPSHOT_INVALID');
  if public.record_v2_content_snapshot((pg_temp.c('tip3')).attempt_id, (pg_temp.c('tip3')).claim_token,
       '{"tip_id":"00000000-0000-4000-8000-0000000000f1","parts":["a","b","c"]}') <> 'recorded'
     or public.record_v2_content_snapshot((pg_temp.c('tip3')).attempt_id, (pg_temp.c('tip3')).claim_token,
       '{"tip_id":"00000000-0000-4000-8000-0000000000f1","parts":["a","b","c"]}') <> 'already_recorded' then
    raise exception 'snapshot not idempotent'; end if;
  perform pg_temp.expect_error(pg_temp.q('select public.record_v2_content_snapshot(%L,%L,%L::jsonb)', 'tip3',
    '{"tip_id":"00000000-0000-4000-8000-0000000000f1","parts":["a","b","X"]}'), 'V2_CONTENT_SNAPSHOT_CONFLICT');
  perform public.record_v2_content_snapshot(c.attempt_id, c.claim_token,
    jsonb_build_object('tip_id', '00000000-0000-4000-8000-0000000000f1', 'parts', jsonb_build_array('p1', 'p2')))
  from claims c where c.label in ('tip2', 'tip_flight', 'tip_unc');
  perform pg_temp.expect_error(pg_temp.q('select public.mark_post_provider_started_v2(%L,%L)', 'tip_nosnap'), 'V2_CONTENT_SNAPSHOT_REQUIRED');
  perform public.mark_post_provider_started_v2((pg_temp.c('useful')).attempt_id, (pg_temp.c('useful')).claim_token);  -- single-create unaffected
  perform public.mark_post_provider_started_v2(c.attempt_id, c.claim_token) from claims c where c.label in ('tip3', 'tip2', 'tip_flight', 'tip_unc');
end $$;

-- tip_nosnap was left pre-X; give it a snapshot now (still pre-X) to show order.
select public.record_v2_content_snapshot(attempt_id, claim_token, '{"tip_id":"00000000-0000-4000-8000-0000000000f1","parts":["a"]}')
from claims where label = 'tip_nosnap';

-- 2. Resumable listing and resume credential.
do $$
declare v_ids uuid[];
begin
  -- tip2: root confirmed -> resumable; tip_flight: step in flight -> not; tip_unc: uncertain -> not.
  perform public.begin_planned_provider_step_v2((pg_temp.c('tip2')).attempt_id, (pg_temp.c('tip2')).claim_token, 1::smallint, 'create_post');
  perform public.finish_provider_step_v2((pg_temp.c('tip2')).attempt_id, (pg_temp.c('tip2')).claim_token, 1::smallint, 'provider_object_confirmed', 'x_t2_1', null);
  perform public.begin_planned_provider_step_v2((pg_temp.c('tip_flight')).attempt_id, (pg_temp.c('tip_flight')).claim_token, 1::smallint, 'create_post');
  perform public.begin_planned_provider_step_v2((pg_temp.c('tip_unc')).attempt_id, (pg_temp.c('tip_unc')).claim_token, 1::smallint, 'create_post');
  perform public.finish_provider_step_v2((pg_temp.c('tip_unc')).attempt_id, (pg_temp.c('tip_unc')).claim_token, 1::smallint, 'x_outcome_uncertain', null, 'X_STEP_HTTP_503');
  select array_agg(r.attempt_id order by r.attempt_id) into v_ids from public.list_resumable_v2_attempts(10) r;
  if v_ids is distinct from (select array_agg(attempt_id order by attempt_id) from claims where label in ('tip3', 'tip2')) then
    raise exception 'resumable set wrong: %', v_ids;
  end if;
  if (select confirmed_steps from public.list_resumable_v2_attempts(10) where attempt_id = (pg_temp.c('tip2')).attempt_id) <> 1 then
    raise exception 'confirmed_steps wrong'; end if;
  if (select r.access_token from claims c, public.read_x_publish_credential_for_resume_v2(c.attempt_id, c.claim_token, 'acct_a', 'brand_a') r
      where c.label = 'tip2') <> 'fake_tok_acct_a' then raise exception 'resume credential wrong'; end if;
  perform pg_temp.expect_error(pg_temp.q('select * from public.read_x_publish_credential_for_resume_v2(%L,%L,%L,%L)', 'tip_flight', 'acct_a', 'brand_a'), 'X_RESUME_NOT_ALLOWED');
  perform pg_temp.expect_error(pg_temp.q('select * from public.read_x_publish_credential_for_resume_v2(%L,%L,%L,%L)', 'tip_unc', 'acct_a', 'brand_a'), 'X_RESUME_NOT_ALLOWED');
  perform pg_temp.expect_error(pg_temp.q('select * from public.read_x_publish_credential_for_resume_v2(%L,%L,%L,%L)', 'tip_nosnap', 'acct_a', 'brand_a'), 'X_RESUME_NOT_ALLOWED');
  perform pg_temp.expect_error(pg_temp.q('select * from public.read_x_publish_credential_for_resume_v2(%L,%L,%L,%L)', 'useful', 'acct_a', 'brand_a'), 'X_RESUME_NOT_ALLOWED');
  perform pg_temp.expect_error(pg_temp.q('select * from public.read_x_publish_credential_for_resume_v2(%L,%L,%L,%L)', 'tip2', 'acct_b', 'brand_b'), 'X_CLAIM_ACCOUNT_MISMATCH');
  perform pg_temp.expect_error(format('select * from public.read_x_publish_credential_for_resume_v2(%L,gen_random_uuid(),%L,%L)',
    (pg_temp.c('tip2')).attempt_id, 'acct_a', 'brand_a'), 'X_RESUME_NOT_ALLOWED');
  -- Once every planned step exists, only completion remains: no more tokens.
  perform public.begin_planned_provider_step_v2((pg_temp.c('tip2')).attempt_id, (pg_temp.c('tip2')).claim_token, 2::smallint, 'create_reply', 'x_t2_1');
  perform pg_temp.expect_error(pg_temp.q('select * from public.read_x_publish_credential_for_resume_v2(%L,%L,%L,%L)', 'tip2', 'acct_a', 'brand_a'), 'X_RESUME_NOT_ALLOWED');
  perform public.finish_provider_step_v2((pg_temp.c('tip2')).attempt_id, (pg_temp.c('tip2')).claim_token, 2::smallint, 'provider_object_confirmed', 'x_t2_2', null);
  perform pg_temp.expect_error(pg_temp.q('select * from public.read_x_publish_credential_for_resume_v2(%L,%L,%L,%L)', 'tip2', 'acct_a', 'brand_a'), 'X_RESUME_NOT_ALLOWED');
  if not exists (select 1 from public.list_resumable_v2_attempts(10) where attempt_id = (pg_temp.c('tip2')).attempt_id) then
    raise exception 'ready-to-complete attempt not listed'; end if;
  perform public.complete_tip_post_v2((pg_temp.c('tip2')).attempt_id, (pg_temp.c('tip2')).claim_token, 'acct_a', 'brand_a', '00000000-0000-4000-8000-0000000000f1');
  if exists (select 1 from public.list_resumable_v2_attempts(10) where attempt_id = (pg_temp.c('tip2')).attempt_id) then
    raise exception 'completed attempt still listed'; end if;
  -- Pre-X attempts are never resumable, even with a snapshot.
  perform pg_temp.expect_error(pg_temp.q('select * from public.read_x_publish_credential_for_resume_v2(%L,%L,%L,%L)', 'tip_nosnap', 'acct_a', 'brand_a'), 'X_RESUME_NOT_ALLOWED');
end $$;
reset role;
set role authenticated;
do $$ begin
  perform pg_temp.expect_error('select * from public.list_resumable_v2_attempts(1)', '42501');
  perform pg_temp.expect_error($q$select * from public.read_x_publish_credential_for_resume_v2(gen_random_uuid(), gen_random_uuid(), 'a', 'b')$q$, '42501');
end $$;
reset role;

select 'PHASE1H_BEHAVIOR_PASS' as result;
