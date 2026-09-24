-- Fake-only Phase1D behavior proof. Run by x_autopost_phase1d_run.sh against a
-- disposable database after: fixture -> Phase1B migration -> Phase1D migration.
-- Every block raises on failure; ON_ERROR_STOP makes the run fail.
\set ON_ERROR_STOP on
set timezone = 'UTC';

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
end;
$$;
create function pg_temp.post(p_slot smallint) returns public.scheduled_posts
language sql as $$
  select * from public.scheduled_posts where brand_id in ('brand_a', 'brand_b', 'kabumori')
    and schedule_date = current_date and slot_no = p_slot
$$;

-- 0. Security / ACL / domain configuration.
do $$
declare r record;
begin
  for r in
    select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('x_queue_legacy_claim_retired_v2', 'scheduled_posts_claim_domain_guard',
       'claim_due_post_legacy_unbound_v2')
  loop
    if not r.prosecdef or not ('search_path=""' = any(r.proconfig)) then
      raise exception 'security definer/search_path mismatch: %', r.proname;
    end if;
    if has_function_privilege('anon', r.oid, 'EXECUTE')
       or has_function_privilege('authenticated', r.oid, 'EXECUTE') then
      raise exception 'API role can execute %', r.proname;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.claim_due_post_legacy_unbound_v2()', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.x_queue_legacy_claim_retired_v2()', 'EXECUTE') then
    raise exception 'service_role cannot execute Phase1D RPCs';
  end if;
  -- Reviewed Phase1B bodies live on as *_core, callable by no API role; the
  -- public v2 names are service_role-only wrappers that enter the v2 domain.
  for r in
    select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('schedule_account_bound_post_v2', 'plan_daily_posts_v2', 'claim_due_post_v2',
       'mark_post_provider_started_v2', 'settle_post_pre_x_v2', 'record_post_x_uncertain_v2',
       'record_post_x_confirmed_incomplete_v2', 'complete_post_x_confirmed_v2',
       'reconcile_stale_pre_x_v2')
  loop
    if not r.prosecdef or not ('search_path=""' = any(r.proconfig))
       or has_function_privilege('anon', r.oid, 'EXECUTE')
       or has_function_privilege('authenticated', r.oid, 'EXECUTE')
       or not has_function_privilege('service_role', r.oid, 'EXECUTE')
       or strpos(pg_get_functiondef(r.oid), $m$set_config('kabumori.x_queue_domain', 'v2', true)$m$) = 0 then
      raise exception 'v2 wrapper mismatch: %', r.proname;
    end if;
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like '%\_v2\_core' escape '\'
        and p.prosecdef
        and not has_function_privilege('service_role', p.oid, 'EXECUTE')
        and not has_function_privilege('anon', p.oid, 'EXECUTE')
        and not has_function_privilege('authenticated', p.oid, 'EXECUTE')) <> 9 then
    raise exception 'Phase1B core functions are not all present and API-closed';
  end if;
  if strpos(pg_get_functiondef('public.claim_due_post_legacy_unbound_v2()'::regprocedure),
            $m$set_config('kabumori.x_queue_domain', 'legacy', true)$m$) = 0 then
    raise exception 'versioned legacy claim is not in the legacy domain';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'scheduled_posts_claim_domain_v2'
                 and tgrelid = 'public.scheduled_posts'::regclass and not tgisinternal) then
    raise exception 'claim-domain trigger missing';
  end if;
  if current_setting('kabumori.x_queue_domain', true) is not null
     and current_setting('kabumori.x_queue_domain', true) <> '' then
    raise exception 'session unexpectedly starts inside a queue domain';
  end if;
end $$;

insert into public.posting_windows (brand_id, post_type, slot_no, start_time, end_time)
values ('brand_b', 'tip', 99, '00:00', '23:59');
set role service_role;

-- 1. Activation gate: while the unpartitioned legacy claim is callable, no bound
--    row can be written by any path.
do $$
begin
  if public.x_queue_legacy_claim_retired_v2() then raise exception 'gate should be closed'; end if;
  perform pg_temp.expect_error($q$select public.schedule_account_bound_post_v2(
    'brand_a','acct_a',current_date,'tip',10::smallint,now())$q$, 'LEGACY_UNPARTITIONED_CLAIM_ACTIVE');
  perform pg_temp.expect_error($q$select public.plan_daily_posts_v2('brand_b','acct_b')$q$,
    'LEGACY_UNPARTITIONED_CLAIM_ACTIVE');
  perform pg_temp.expect_error($q$insert into public.scheduled_posts
    (brand_id, social_account_id, schedule_date, post_type, slot_no, scheduled_for)
    values ('brand_a','acct_a',current_date,'tip',10,now())$q$, 'LEGACY_UNPARTITIONED_CLAIM_ACTIVE');
  if exists (select 1 from public.scheduled_posts where social_account_id is not null) then
    raise exception 'bound row exists before legacy claim retirement';
  end if;
end $$;

-- Activation step simulated: retire EXECUTE on the unpartitioned legacy claim.
reset role;
delete from public.posting_windows where brand_id = 'brand_b' and slot_no = 99;
revoke execute on function public.claim_due_post() from service_role;
set role service_role;
do $$ begin
  if not public.x_queue_legacy_claim_retired_v2() then raise exception 'gate should be open'; end if;
end $$;

-- 2. Seed: bound rows are OLDER than the unbound row, so a global-oldest legacy
--    claim would pick them if it were not partitioned.
insert into public.scheduled_posts (brand_id, schedule_date, post_type, slot_no, scheduled_for)
values ('brand_a', current_date, 'tip', 1, now() - interval '10 minutes');
select public.schedule_account_bound_post_v2('brand_a','acct_a',current_date,'tip',2::smallint,now()-interval '3 hours');
select public.schedule_account_bound_post_v2('brand_b','acct_b',current_date,'tip',3::smallint,now()-interval '2 hours');

do $$ begin
  if coalesce(current_setting('kabumori.x_queue_domain', true), '') <> '' then
    raise exception 'v2 wrapper leaked its domain into the caller transaction';
  end if;
end $$;

create temporary table claims (label text primary key, scheduled_post_id uuid not null,
  attempt_id uuid, claim_token uuid);

-- 3. Legacy lane: unbound only, never binds, bound rows invisible.
do $$
declare v public.scheduled_posts%rowtype;
begin
  select * into v from public.claim_due_post_legacy_unbound_v2();
  if v.id is null or v.social_account_id is not null or v.slot_no <> 1 or v.status <> 'running' then
    raise exception 'legacy lane did not claim exactly the unbound row';
  end if;
  insert into claims(label, scheduled_post_id) values ('legacy_1', v.id);
  select * into v from public.claim_due_post_legacy_unbound_v2();
  if v.id is not null then raise exception 'legacy lane claimed a bound row'; end if;
  if (select count(*) from public.post_execution_logs
      where scheduled_post_id = (select scheduled_post_id from claims where label = 'legacy_1')
        and status = 'started') <> 1 then
    raise exception 'legacy started log not written';
  end if;
end $$;

-- 4. v2 lane: bound only; two accounts progress independently; an unbound due
--    row (even older) is never eligible.
insert into public.scheduled_posts (brand_id, schedule_date, post_type, slot_no, scheduled_for)
values ('brand_b', current_date, 'tip', 4, now() - interval '5 hours');
insert into claims(label, scheduled_post_id, attempt_id, claim_token)
select 'v2_1', scheduled_post_id, attempt_id, claim_token from public.claim_due_post_v2();
insert into claims(label, scheduled_post_id, attempt_id, claim_token)
select 'v2_2', scheduled_post_id, attempt_id, claim_token from public.claim_due_post_v2();
do $$
begin
  if exists (select 1 from public.claim_due_post_v2()) then
    raise exception 'v2 lane claimed an unbound row';
  end if;
  if (select count(distinct s.social_account_id) from claims c
      join public.scheduled_posts s on s.id = c.scheduled_post_id
      where c.label like 'v2_%' and s.social_account_id is not null) <> 2 then
    raise exception 'two accounts were not independently claimable';
  end if;
  if exists (select 1 from claims group by scheduled_post_id having count(*) > 1) then
    raise exception 'a row was claimed in both domains';
  end if;
  if (pg_temp.post(4::smallint)).status <> 'pending' then
    raise exception 'unbound row was touched by v2';
  end if;
end $$;
update claims set label = 'v2_a' where scheduled_post_id = (pg_temp.post(2::smallint)).id;
update claims set label = 'v2_b' where scheduled_post_id = (pg_temp.post(3::smallint)).id;

-- 5. Legacy RPCs and direct writes cannot change a bound row; bindings are
--    immutable in both directions.
do $$
declare v_a uuid := (pg_temp.post(2::smallint)).id;
        v_l uuid := (pg_temp.post(1::smallint)).id;
begin
  perform pg_temp.expect_error(format('select public.retry_scheduled_post(%L, now(), %L)', v_a, 'X'),
    'BOUND_ROW_REQUIRES_V2_PATH');
  perform pg_temp.expect_error(format('select public.fail_scheduled_post(%L, %L)', v_a, 'X'),
    'BOUND_ROW_REQUIRES_V2_PATH');
  perform pg_temp.expect_error(format('select public.complete_tip_post(%L, null, %L)', v_a, 'x1'),
    'BOUND_ROW_REQUIRES_V2_PATH');
  perform pg_temp.expect_error(format('update public.scheduled_posts set status = %L where id = %L', 'failed', v_a),
    'BOUND_ROW_REQUIRES_V2_PATH');
  perform pg_temp.expect_error(format('update public.scheduled_posts set social_account_id = null where id = %L', v_a),
    'CLAIM_DOMAIN_IMMUTABLE');
  perform pg_temp.expect_error(format('update public.scheduled_posts set social_account_id = %L where id = %L', 'acct_a', v_l),
    'CLAIM_DOMAIN_IMMUTABLE');
  if (pg_temp.post(2::smallint)).status <> 'running'
     or (pg_temp.post(2::smallint)).social_account_id <> 'acct_a'
     or (pg_temp.post(1::smallint)).social_account_id is not null then
    raise exception 'bound/unbound row changed by a rejected write';
  end if;
  if exists (select 1 from public.post_execution_logs where scheduled_post_id = v_a) then
    raise exception 'rejected legacy RPC left a log for a bound row';
  end if;
end $$;

-- 6. v2 pre-X retry keeps the binding and returns to the v2 lane only.
select public.settle_post_pre_x_v2(attempt_id, claim_token, true, 'FAKE_PRE_X') from claims where label = 'v2_a';
do $$
declare v public.scheduled_posts%rowtype := pg_temp.post(2::smallint);
begin
  if v.status <> 'pending' or v.social_account_id <> 'acct_a' then
    raise exception 'v2 retry changed status/binding';
  end if;
  -- The legacy lane takes the older unbound slot 4, never the pending bound
  -- retry; slot 4 is then returned to pending unchanged via legacy retry.
  select * into v from public.claim_due_post_legacy_unbound_v2();
  if v.slot_no <> 4 or v.social_account_id is not null then
    raise exception 'legacy lane claimed a v2 retry row';
  end if;
  perform public.retry_scheduled_post(v.id, now() - interval '5 hours', 'FAKE_LEGACY_RETRY');
  if exists (select 1 from public.claim_due_post_legacy_unbound_v2() where social_account_id is not null) then
    raise exception 'legacy lane claimed a v2 retry row';
  end if;
  v := pg_temp.post(4::smallint);
  perform public.retry_scheduled_post(v.id, now() - interval '5 hours', 'FAKE_LEGACY_RETRY');
end $$;
insert into claims(label, scheduled_post_id, attempt_id, claim_token)
select 'v2_a_retry', scheduled_post_id, attempt_id, claim_token from public.claim_due_post_v2();
do $$ begin
  if (select s.social_account_id from claims c join public.scheduled_posts s on s.id = c.scheduled_post_id
      where c.label = 'v2_a_retry') is distinct from 'acct_a' then
    raise exception 'v2 retry was not reclaimed on the same account';
  end if;
end $$;

-- 7. Stale reconciliation: v2 reconciles only v2 pre-X; legacy running rows are
--    invisible to it; legacy retry/reclaim/fail keep NULL.
reset role;
update public.post_queue_attempts_v2 set claimed_at = now() - interval '1 hour'
where id = (select attempt_id from claims where label = 'v2_b');
set role service_role;
do $$
declare v_l uuid := (pg_temp.post(1::smallint)).id;
begin
  reset role;
  update public.scheduled_posts set started_at = now() - interval '2 hours' where id = v_l;
  set role service_role;
  if public.reconcile_stale_pre_x_v2() <> 1 then raise exception 'stale v2 pre-X not reconciled'; end if;
  if (pg_temp.post(3::smallint)).social_account_id <> 'acct_b'
     or (pg_temp.post(3::smallint)).status <> 'pending' then
    raise exception 'stale reconciliation changed binding/status';
  end if;
  if (pg_temp.post(1::smallint)).status <> 'running' then
    raise exception 'v2 reconciliation touched a legacy running row';
  end if;
  if exists (select 1 from public.post_queue_attempts_v2 a join public.scheduled_posts s
             on s.id = a.scheduled_post_id where s.social_account_id is null) then
    raise exception 'unbound row entered the v2 attempt ledger';
  end if;
  perform public.retry_scheduled_post(v_l, now() - interval '1 minute', 'FAKE_LEGACY_RETRY');
  if (pg_temp.post(1::smallint)).status <> 'pending' or (pg_temp.post(1::smallint)).social_account_id is not null then
    raise exception 'legacy retry changed domain';
  end if;
end $$;
do $$
declare v public.scheduled_posts%rowtype;
begin
  -- slot 4 (unbound, oldest) is claimed first, then the retried slot 1.
  select * into v from public.claim_due_post_legacy_unbound_v2();
  if v.slot_no <> 4 or v.social_account_id is not null then raise exception 'legacy order/domain broken'; end if;
  select * into v from public.claim_due_post_legacy_unbound_v2();
  if v.slot_no <> 1 or v.social_account_id is not null then raise exception 'legacy reclaim crossed domains'; end if;
  perform public.fail_scheduled_post(v.id, 'FAKE_LEGACY_FAILURE');
  if (pg_temp.post(1::smallint)).status <> 'failed' or (pg_temp.post(1::smallint)).social_account_id is not null then
    raise exception 'legacy failure changed domain';
  end if;
end $$;

-- 8. Uncertain and confirmed-X/DB-incomplete outcomes are non-reclaimable by
--    either lane; confirmed completion stays inside v2.
insert into claims(label, scheduled_post_id, attempt_id, claim_token)
select 'v2_b_retry', scheduled_post_id, attempt_id, claim_token from public.claim_due_post_v2();
select public.mark_post_provider_started_v2(attempt_id, claim_token) from claims where label in ('v2_a_retry', 'v2_b_retry');
select public.record_post_x_uncertain_v2(attempt_id, claim_token, 'FAKE_TIMEOUT') from claims where label = 'v2_a_retry';
select public.record_post_x_confirmed_incomplete_v2(attempt_id, claim_token, 'fake_x_1', 'FAKE_DB_WRITE')
from claims where label = 'v2_b_retry';
do $$
begin
  if exists (select 1 from public.claim_due_post_v2()) then raise exception 'v2 reclaimed an X-started row'; end if;
  if exists (select 1 from public.claim_due_post_legacy_unbound_v2() where social_account_id is not null) then
    raise exception 'legacy reclaimed an X-started row';
  end if;
  if public.reconcile_stale_pre_x_v2() <> 0 then raise exception 'reconcile touched an X-started row'; end if;
  -- Legacy retry/fail only match running rows, so on these failed bound rows
  -- they are no-ops; they cannot revive an X-started row.
  perform public.fail_scheduled_post((pg_temp.post(3::smallint)).id, 'X');
  perform public.retry_scheduled_post((pg_temp.post(2::smallint)).id, now(), 'X');
  if (pg_temp.post(3::smallint)).status <> 'failed' or (pg_temp.post(2::smallint)).status <> 'failed'
     or exists (select 1 from public.post_execution_logs
                where scheduled_post_id in ((pg_temp.post(2::smallint)).id, (pg_temp.post(3::smallint)).id)) then
    raise exception 'legacy retry/fail revived or logged an X-started bound row';
  end if;
end $$;
select public.complete_post_x_confirmed_v2(attempt_id, claim_token, 'fake_x_1') from claims where label = 'v2_b_retry';
do $$ begin
  if (pg_temp.post(3::smallint)).status <> 'succeeded' or (pg_temp.post(3::smallint)).social_account_id <> 'acct_b'
     or (pg_temp.post(2::smallint)).status <> 'failed' or (pg_temp.post(2::smallint)).social_account_id <> 'acct_a' then
    raise exception 'terminal outcome/binding mismatch';
  end if;
end $$;

-- 9. Mismatched brand/account and non-X bindings fail; no automatic legacy
--    binding; a legacy-occupied slot is never rebound.
do $$
begin
  perform pg_temp.expect_error($q$select public.schedule_account_bound_post_v2(
    'brand_a','acct_b',current_date,'tip',20::smallint,now())$q$, 'ACCOUNT_BINDING_NOT_VERIFIED');
  perform pg_temp.expect_error($q$select public.schedule_account_bound_post_v2(
    'brand_a','acct_other',current_date,'tip',21::smallint,now())$q$, 'ACCOUNT_BINDING_NOT_VERIFIED');
  perform pg_temp.expect_error($q$insert into public.scheduled_posts
    (brand_id, social_account_id, schedule_date, post_type, slot_no, scheduled_for)
    values ('brand_a','acct_b',current_date,'tip',22,now())$q$, '23503');
end $$;
reset role;
insert into public.posting_windows (brand_id, post_type, slot_no, start_time, end_time)
values ('brand_a', 'interaction', 30, '00:00', '00:01');
set role service_role;
select public.claim_due_post_legacy_unbound_v2();  -- runs the legacy planners
do $$
begin
  if (pg_temp.post(30::smallint)).id is null or (pg_temp.post(30::smallint)).social_account_id is not null then
    raise exception 'legacy planner row was not unbound';
  end if;
  perform pg_temp.expect_error($q$select public.schedule_account_bound_post_v2(
    'brand_a','acct_a',current_date,'interaction',30::smallint,now())$q$, 'ACCOUNT_BINDING_CONFLICT');
  if (pg_temp.post(30::smallint)).social_account_id is not null then
    raise exception 'legacy slot was rebound';
  end if;
  if exists (select 1 from public.scheduled_posts where social_account_id is not null
             and slot_no not in (2, 3)) then
    raise exception 'unexpected bound row created';
  end if;
end $$;

-- 10. A v2-domain bug cannot touch unbound rows.
do $$
begin
  perform set_config('kabumori.x_queue_domain', 'v2', true);
  perform pg_temp.expect_error(format('update public.scheduled_posts set status = %L where id = %L',
    'failed', (pg_temp.post(30::smallint)).id), 'UNBOUND_ROW_IN_V2_DOMAIN');
  perform pg_temp.expect_error($q$insert into public.scheduled_posts
    (brand_id, schedule_date, post_type, slot_no, scheduled_for)
    values ('brand_a',current_date,'tip',40,now())$q$, 'UNBOUND_ROW_IN_V2_DOMAIN');
  perform set_config('kabumori.x_queue_domain', '', true);
end $$;

-- 11. Re-granting the unpartitioned legacy claim closes the gate again: v2 claim
--     fails closed and the old claim cannot take a bound row.
select public.schedule_account_bound_post_v2('brand_a','acct_a',current_date,'tip',50::smallint,now()-interval '9 hours');
reset role;
grant execute on function public.claim_due_post() to service_role;
set role service_role;
do $$
begin
  perform pg_temp.expect_error('select * from public.claim_due_post_v2()', 'LEGACY_UNPARTITIONED_CLAIM_ACTIVE');
  perform pg_temp.expect_error('select * from public.claim_due_post()', 'BOUND_ROW_REQUIRES_V2_PATH');
  if (pg_temp.post(50::smallint)).status <> 'pending' then raise exception 'bound row claimed while gate closed'; end if;
end $$;
reset role;
revoke execute on function public.claim_due_post() from service_role;

-- 12. API roles cannot reach the Phase1D helpers.
set role authenticated;
do $$ begin
  perform pg_temp.expect_error('select * from public.claim_due_post_legacy_unbound_v2()', '42501');
  perform pg_temp.expect_error('select public.x_queue_legacy_claim_retired_v2()', '42501');
end $$;
reset role;

select 'PHASE1D_BEHAVIOR_PASS' as result;
