-- Run after fixture + migration in one disposable DB transaction, then ROLLBACK.
do $$
declare v_rpc record;
begin
  for v_rpc in select p.oid, p.proname from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like '%_v2'
  loop
    if has_function_privilege('authenticated', v_rpc.oid, 'EXECUTE')
       or has_function_privilege('anon', v_rpc.oid, 'EXECUTE')
       or not has_function_privilege('service_role', v_rpc.oid, 'EXECUTE') then
      raise exception 'RPC ACL mismatch: %', v_rpc.proname;
    end if;
  end loop;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname like '%_v2'
               and (not p.prosecdef or not ('search_path=""' = any(p.proconfig)))) then
    raise exception 'RPC security/search_path mismatch';
  end if;
end $$;

-- DB-level account integrity: missing account, cross-brand and non-X are rejected.
do $$
begin
  begin
    insert into public.scheduled_posts (brand_id,social_account_id,schedule_date,post_type,slot_no,scheduled_for)
    values ('brand_a','missing',current_date,'tip',90,now()-interval '1 minute');
    raise exception 'missing account accepted';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.scheduled_posts (brand_id,social_account_id,schedule_date,post_type,slot_no,scheduled_for)
    values ('brand_a','acct_b',current_date,'tip',91,now()-interval '1 minute');
    raise exception 'cross-brand account accepted';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.scheduled_posts (brand_id,social_account_id,schedule_date,post_type,slot_no,scheduled_for)
    values ('brand_a','acct_other',current_date,'tip',92,now()-interval '1 minute');
    raise exception 'non-X account accepted';
  exception when foreign_key_violation then null; end;
end $$;

create temp table proof_claims (
  seq integer generated always as identity,
  scheduled_post_id uuid, attempt_id uuid, claim_token uuid,
  brand_id text, social_account_id text, post_type text
);
insert into public.scheduled_posts (brand_id,schedule_date,post_type,slot_no,scheduled_for)
values ('brand_a',current_date,'tip',99,now()-interval '1 hour'); -- legacy unbound
select public.schedule_account_bound_post_v2('brand_a','acct_a',current_date,'tip',1::smallint,now()-interval '1 hour');
select public.schedule_account_bound_post_v2('brand_a','acct_a',current_date,'tip',2::smallint,now()-interval '1 hour');
select public.schedule_account_bound_post_v2('brand_b','acct_b',current_date,'tip',1::smallint,now()-interval '1 hour');
insert into public.posting_windows
  (brand_id,post_type,slot_no,start_time,end_time,timezone)
values ('brand_a','tip',8,'10:00','10:15','UTC');
select count(*) from public.plan_daily_posts_v2('brand_a','acct_a',current_date+1);
do $$ begin
  if (select count(*) from public.scheduled_posts
      where schedule_date=current_date+1 and post_type='tip' and slot_no=8
        and brand_id='brand_a' and social_account_id='acct_a') <> 1 then
    raise exception 'explicit-account daily planner failed';
  end if;
end $$;
do $$
begin
  begin
    perform public.schedule_account_bound_post_v2('brand_a','acct_b',current_date,'tip',3::smallint,now());
    raise exception 'enqueue cross-brand accepted';
  exception when raise_exception then
    if sqlerrm <> 'ACCOUNT_BINDING_NOT_VERIFIED' then raise; end if;
  end;
  begin
    perform public.schedule_account_bound_post_v2('brand_a','acct_other',current_date,'tip',3::smallint,now());
    raise exception 'enqueue non-X accepted';
  exception when raise_exception then
    if sqlerrm <> 'ACCOUNT_BINDING_NOT_VERIFIED' then raise; end if;
  end;
end $$;

insert into proof_claims (scheduled_post_id,attempt_id,claim_token,brand_id,social_account_id,post_type)
select * from public.claim_due_post_v2();
insert into proof_claims (scheduled_post_id,attempt_id,claim_token,brand_id,social_account_id,post_type)
select * from public.claim_due_post_v2();
do $$
begin
  if (select count(*) from proof_claims) <> 2
     or (select count(distinct brand_id) from proof_claims) <> 2 then
    raise exception 'fairness: two accounts did not progress';
  end if;
  if exists (select 1 from proof_claims where social_account_id is null)
     or (select status from public.scheduled_posts where slot_no=99) <> 'pending' then
    raise exception 'legacy unbound row claimed';
  end if;
end $$;

-- The first account enters provider phase. Stale cleanup may NOT replay it.
select public.mark_post_provider_started_v2(attempt_id,claim_token)
from proof_claims where seq=1;
update public.post_queue_attempts_v2 set claimed_at=now()-interval '1 hour' where id=(select attempt_id from proof_claims where seq=1);
do $$
begin
  if public.reconcile_stale_pre_x_v2() <> 0 then raise exception 'provider-started was reconciled'; end if;
  begin
    perform public.settle_post_pre_x_v2(
      (select attempt_id from proof_claims where seq=1),
      (select claim_token from proof_claims where seq=1), true,'FAKE_PRE_X');
    raise exception 'provider-started marked pre-X';
  exception when raise_exception then
    if sqlerrm <> 'ATTEMPT_NOT_PRE_X' then raise; end if;
  end;
end $$;

-- Second account fails safely before X, and can re-enter only within cap.
do $$
declare v_outcome text;
begin
  select public.settle_post_pre_x_v2(attempt_id,claim_token,true,'FAKE_PRE_X')
    into v_outcome from proof_claims where seq=2;
  if v_outcome <> 'pre_x_retryable' or
     (select status from public.scheduled_posts where id=(select scheduled_post_id from proof_claims where seq=2)) <> 'pending'
  then raise exception 'pre-X retry failed'; end if;
end $$;
insert into proof_claims (scheduled_post_id,attempt_id,claim_token,brand_id,social_account_id,post_type)
select * from public.claim_due_post_v2();
insert into proof_claims (scheduled_post_id,attempt_id,claim_token,brand_id,social_account_id,post_type)
select * from public.claim_due_post_v2();
do $$
begin
  if (select count(*) from proof_claims where scheduled_post_id=(select scheduled_post_id from proof_claims where seq=2)) <> 2 then
    raise exception 'pre-X retry not reclaimed';
  end if;
end $$;

-- Provider uncertainty remains terminal for automatic claim/reconcile.
select public.record_post_x_uncertain_v2(attempt_id,claim_token,'X_OUTCOME_UNKNOWN')
from proof_claims where seq=1;
do $$
begin
  if (select outcome from public.post_queue_attempts_v2 where id=(select attempt_id from proof_claims where seq=1)) <> 'x_outcome_uncertain'
    or (select status from public.scheduled_posts where id=(select scheduled_post_id from proof_claims where seq=1)) <> 'failed'
  then raise exception 'uncertain outcome replayable'; end if;
end $$;

-- Confirmed X receipt is durable before final DB completion; never republish.
select public.mark_post_provider_started_v2(attempt_id,claim_token)
from proof_claims where seq=3;
select public.record_post_x_confirmed_incomplete_v2(attempt_id,claim_token,'x_fake_123','DB_FINISH_FAILED')
from proof_claims where seq=3;
do $$
begin
  if (select outcome from public.post_queue_attempts_v2 where id=(select attempt_id from proof_claims where seq=3)) <> 'x_confirmed_db_incomplete'
  then raise exception 'confirmed X not recorded'; end if;
end $$;
select public.complete_post_x_confirmed_v2(attempt_id,claim_token,'x_fake_123')
from proof_claims where seq=3;
do $$
begin
  if (select outcome from public.post_queue_attempts_v2 where id=(select attempt_id from proof_claims where seq=3)) <> 'completed'
     or (select x_post_id from public.post_queue_attempts_v2 where id=(select attempt_id from proof_claims where seq=3)) <> 'x_fake_123'
  then raise exception 'confirmed X completion failed'; end if;
  begin
    perform public.complete_post_x_confirmed_v2(
      (select attempt_id from proof_claims where seq=3),
      (select claim_token from proof_claims where seq=3),'x_fake_123');
    raise exception 'double completion accepted';
  exception when raise_exception then
    if sqlerrm <> 'ATTEMPT_NOT_CONFIRMABLE' then raise; end if;
  end;
end $$;

-- The remaining pre-X attempt is stale; only that phase is reconciled.
update public.post_queue_attempts_v2 set claimed_at=now()-interval '1 hour'
where id=(select attempt_id from proof_claims where seq=4);
do $$
begin
  if public.reconcile_stale_pre_x_v2() <> 1 then raise exception 'stale pre-X not reconciled'; end if;
  if exists (select 1 from public.post_queue_attempts_v2
             where phase='pre_x' and claimed_at < now()-interval '15 minutes') then
    raise exception 'stale pre-X remained';
  end if;
  if (select status from public.scheduled_posts where id=(select scheduled_post_id from proof_claims where seq=4)) <> 'pending' then
    raise exception 'stale pre-X not returned to queue';
  end if;
end $$;

-- Third pre-X claim exhausts the cap: no fourth attempt and no provider call.
insert into proof_claims (scheduled_post_id,attempt_id,claim_token,brand_id,social_account_id,post_type)
select * from public.claim_due_post_v2();
do $$
declare v_outcome text;
begin
  if (select attempt_no from public.post_queue_attempts_v2 where id=(select attempt_id from proof_claims where seq=5)) <> 3 then
    raise exception 'attempt cap setup failed'; end if;
  select public.settle_post_pre_x_v2(attempt_id,claim_token,true,'FAKE_PRE_X')
    into v_outcome from proof_claims where seq=5;
  if v_outcome <> 'pre_x_terminal' or
     (select status from public.scheduled_posts where id=(select scheduled_post_id from proof_claims where seq=5)) <> 'failed' then
    raise exception 'attempt cap not enforced'; end if;
  if (select count(*) from public.claim_due_post_v2()) <> 0 then
    raise exception 'uncertain/confirmed/capped row was re-claimed'; end if;
end $$;
