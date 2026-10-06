-- Run ONLY after fixtures/mic_scenario_phase3a_dependencies.sql and the
-- Phase3A migration (twice) in a NEW disposable DB named mic_scenario_review.
\set ON_ERROR_STOP on
do $$ begin
 if current_database() <> 'mic_scenario_review' then raise exception 'DISPOSABLE_DB_REQUIRED'; end if;
end $$;

create table public.review_inputs (id integer primary key, data jsonb not null);
insert into public.review_inputs select 1, jsonb_build_object(
 'updated_at', (select updated_at from public.mic_scenario_current),
 'snapshots', (select jsonb_agg(to_jsonb(c)-'updated_at' order by domain) from public.market_state_current c),
 'fingerprint', 'mic-scenario-v1|' || (select string_agg(domain||':'||source_evaluation_run_id,'|' order by domain) from public.market_state_current),
 'meta', '[{"domain":"rates","freshness":"fresh","usability":"strong"},{"domain":"equity_index","freshness":"fresh","usability":"strong"}]'::jsonb
);
grant select,update on public.review_inputs to service_role;
create function public.review_assert(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT_FAILED:%',label; end if; end $$;
create function public.review_expect_error(stmt text, expected text) returns void language plpgsql as $$
begin
 begin execute stmt;
 exception when others then
   if position(expected in sqlerrm)=0 then raise exception 'WRONG_ERROR:% expected %',sqlerrm,expected; end if;
   return;
 end;
 raise exception 'EXPECTED_ERROR_MISSING:%',expected;
end $$;
create function public.review_prepare() returns uuid language plpgsql as $$
declare r uuid; u bigint;
begin
 insert into public.mic_scenario_evaluation_runs(scenario_key,run_window) values('market','review') returning id into r;
 insert into public.ai_usage_events(feature,model,input_tokens,output_tokens,cost_usd,related_table,related_id)
 values('mic_scenario_evaluation','gpt-5.6-luna',1000,400,0.00068,'mic_scenario_evaluation_runs',r::text) returning id into u;
 update public.review_inputs set data=data||jsonb_build_object('run_id',r,'usage_id',u);
 return r;
end $$;
create function public.review_apply(overrides jsonb default '{}'::jsonb) returns text language plpgsql as $$
declare d jsonb; result text;
begin
 select data||overrides into d from public.review_inputs where id=1;
 select result_status into result from public.apply_mic_scenario_update(
 'market',(d->>'run_id')::uuid,(d->>'updated_at')::timestamptz,d->>'fingerprint','mic-scenario-v1',
 coalesce(d->>'assessment','assessed'),'{}','{}','{}','[]',coalesce((d->>'confidence')::numeric,0.7),
 coalesce((d->>'ai_confidence')::numeric,0.8),d->'snapshots',d->'meta','gpt-5.6-luna',
 coalesce((d->>'input_tokens')::integer,1000),400,0.00068,'{"generate":true}',(d->>'usage_id')::bigint);
 return result;
end $$;

-- RLS/ACL, including the invoker function and the explicitly accepted
-- service_role direct-write boundary (a secret key is fully trusted).
select public.review_assert((select count(*)=4 from pg_class where relname in
 ('mic_scenario_evaluation_runs','mic_scenario_current','mic_scenario_history','mic_scenario_evidence') and relrowsecurity), '4 RLS tables');
select public.review_assert((select not prosecdef and proconfig=array['search_path=""'] from pg_proc where proname='apply_mic_scenario_update'), 'invoker empty search_path');
do $$ declare t text; f oid;
begin
 select oid into f from pg_proc where proname='apply_mic_scenario_update';
 perform public.review_assert(has_function_privilege('service_role',f,'execute'), 'service RPC');
 perform public.review_assert(not has_function_privilege('anon',f,'execute') and not has_function_privilege('authenticated',f,'execute'),'client RPC denied');
 foreach t in array array['mic_scenario_evaluation_runs','mic_scenario_current','mic_scenario_history','mic_scenario_evidence'] loop
  perform public.review_assert(not has_table_privilege('anon',t,'select,insert,update,delete,truncate'),'anon denied '||t);
  perform public.review_assert(not has_table_privilege('authenticated',t,'insert,update,delete,truncate'),'client writes denied '||t);
 end loop;
end $$;
begin;
set local role authenticated;
set local request.jwt.claim.sub='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select public.review_assert((select count(*)=0 from mic_scenario_current),'non-admin RLS');
set local request.jwt.claim.sub='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select public.review_assert((select count(*)=1 from mic_scenario_current),'admin SELECT');
select public.review_expect_error('update mic_scenario_current set confidence=0.2','permission denied');
rollback;
begin;
set local role anon;
select public.review_expect_error('select * from mic_scenario_current','permission denied');
rollback;

-- Each negative path is isolated. RPC failure must leave seed/current,
-- history and evidence untouched; the real usage row remains on this run.
begin;
set local role service_role;
select public.review_prepare();
select public.review_expect_error($q$insert into mic_scenario_evaluation_runs(scenario_key,run_window,status) values('market','invalid','no_change')$q$,'mic_scenario_runs_terminal_shape');
select public.review_expect_error($q$select public.review_apply('{"updated_at":"2000-01-01T00:00:00Z"}')$q$,'STALE_DECISION');
select public.review_expect_error($q$select public.review_apply('{"fingerprint":"wrong"}')$q$,'FINGERPRINT_MISMATCH');
select public.review_expect_error($q$select public.review_apply('{"usage_id":-1}')$q$,'AI_USAGE_EVENT_RUN_MISMATCH');
select public.review_expect_error($q$select public.review_apply('{"input_tokens":1}')$q$,'AI_USAGE_EVENT_RUN_MISMATCH');
select public.review_expect_error($q$select public.review_apply('{"confidence":0.91,"ai_confidence":0.95}')$q$,'CONFIDENCE_ABOVE_STATE_QUALITY');
select public.review_expect_error($q$select public.review_apply('{"confidence":0.85,"ai_confidence":0.95}')$q$,'CONFIDENCE_ABOVE_CAP');
select public.review_expect_error($q$select public.review_apply('{"confidence":0.4,"assessment":"indeterminate"}')$q$,'CONFIDENCE_ABOVE_CAP');
select public.review_expect_error($q$select public.review_apply('{"meta":[{"domain":"rates","freshness":"recent","usability":"weak"},{"domain":"equity_index","freshness":"fresh","usability":"strong"}]}')$q$,'FRESHNESS_META_MISMATCH');
select public.review_expect_error($q$select public.review_apply(jsonb_build_object('snapshots',(select jsonb_build_array(data->'snapshots'->0,data->'snapshots'->0) from review_inputs)))$q$,'STATE_SNAPSHOT_DUPLICATE');
select public.review_expect_error($q$select public.review_apply(jsonb_build_object('snapshots',(select jsonb_set(data->'snapshots','{0,data_confidence}','null') from review_inputs)))$q$,'STATE_SNAPSHOT_INVALID');
select public.review_assert((select count(*)=0 from mic_scenario_history),'failed history=0');
select public.review_assert((select count(*)=0 from mic_scenario_evidence),'failed evidence=0');
select public.review_assert((select source_scenario_run_id is null from mic_scenario_current),'failed current unchanged');
update mic_scenario_evaluation_runs set status='failed',completed_at=now() where status='running';
select public.review_assert((select count(*)=1 from ai_usage_events u join mic_scenario_evaluation_runs r on u.related_id=r.id::text where r.status='failed'),'usage owns failed run');
rollback;

-- Check every one of the 11 fields individually, including status-only
-- no_change refreshes. Timestamp representations use timestamptz equality.
begin;
select public.review_prepare();
do $$ declare field text; val jsonb; changed jsonb;
begin
 for field,val in select * from (values
  ('domain','"macro"'::jsonb),('narrative','"changed"'),('bullish_factors','["changed"]'),
  ('bearish_factors','["changed"]'),('key_risks','["changed"]'),('ai_confidence','0.7'),
  ('data_confidence','0.85'),('coverage_status','"partial"'),('observation_status','"delayed_expected"'),
  ('ai_evaluated_at',to_jsonb(now()-interval '1 hour')),
  ('source_evaluation_run_id','"11111111-1111-4111-8111-111111111111"')
 ) as x(field,val) loop
  select jsonb_set(data->'snapshots',array['0',field],val) into changed from review_inputs;
  begin
   perform review_apply(jsonb_build_object('snapshots',changed,'fingerprint','mic-scenario-v1|'||
    (select string_agg((e->>'domain')||':'||(e->>'source_evaluation_run_id'),'|' order by e->>'domain') from jsonb_array_elements(changed) as x(e)),
    'meta',case field
      when 'domain' then '[{"domain":"macro","freshness":"fresh","usability":"strong"},{"domain":"rates","freshness":"fresh","usability":"strong"}]'::jsonb
      when 'coverage_status' then '[{"domain":"equity_index","freshness":"fresh","usability":"weak"},{"domain":"rates","freshness":"fresh","usability":"strong"}]'::jsonb
      else (select data->'meta' from review_inputs) end));
  exception when others then
   if position('STATE_CHANGED_DURING_EVALUATION' in sqlerrm)=0 then raise exception '%: %',field,sqlerrm; end if;
   continue;
  end;
  raise exception 'MISSING_STATE_REVERIFY:%',field;
 end loop;
end $$;
rollback;

-- Late failure after current was updated rolls history/current/evidence/run
-- back together; the independently recorded usage remains.
begin;
create function public.review_late_fail() returns trigger language plpgsql as $$begin raise exception 'INJECTED_LATE_FAILURE'; end$$;
create trigger review_late_fail before insert on mic_scenario_evidence for each row execute function review_late_fail();
set local role service_role;
select public.review_prepare();
select public.review_expect_error('select review_apply()','INJECTED_LATE_FAILURE');
select public.review_assert((select source_scenario_run_id is null from mic_scenario_current),'late rollback current');
select public.review_assert((select count(*)=0 from mic_scenario_history),'late rollback history');
select public.review_assert((select count(*)=0 from mic_scenario_evidence),'late rollback evidence');
select public.review_assert((select status='running' from mic_scenario_evaluation_runs),'late rollback run');
select public.review_assert((select count(*)=1 from ai_usage_events),'late failure usage retained');
rollback;

-- Stale run based on older current version, and stale termination respects
-- terminal immutability. A still-running row blocks a second claim (23505).
begin;
set local role service_role;
select public.review_prepare();
update mic_scenario_evaluation_runs set started_at='2000-01-01';
select public.review_expect_error('select review_apply()','STALE_RUN');
select public.review_expect_error($q$insert into mic_scenario_evaluation_runs(scenario_key,run_window) values('market','second')$q$,'mic_scenario_runs_one_running_uidx');
update mic_scenario_evaluation_runs set status='failed',completed_at=now() where status='running' and started_at<now()-interval '15 minutes';
select public.review_expect_error($q$update mic_scenario_evaluation_runs set status='running'$q$,'TERMINAL_IMMUTABLE');
select public.review_assert((select count(*)=0 from mic_scenario_evaluation_runs where status='running'),'stale cleared');
rollback;

-- Recent-state penalty and stale rejection also hold at the DB boundary.
begin;
update market_state_current set ai_evaluated_at=now()-interval '50 hours' where domain='rates';
update review_inputs set data=data||jsonb_build_object(
 'snapshots',(select jsonb_agg(to_jsonb(c)-'updated_at' order by domain) from market_state_current c),
 'meta','[{"domain":"rates","freshness":"recent","usability":"weak"},{"domain":"equity_index","freshness":"fresh","usability":"strong"}]'::jsonb);
set local role service_role;
select public.review_prepare();
select public.review_expect_error($q$select review_apply('{"confidence":0.7}')$q$,'CONFIDENCE_ABOVE_CAP');
select public.review_assert(review_apply('{"confidence":0.62}')='applied','recent cap 0.9*0.8-0.1');
rollback;
begin;
update market_state_current set ai_evaluated_at=now()-interval '100 hours' where domain='rates';
update review_inputs set data=data||jsonb_build_object('snapshots',(select jsonb_agg(to_jsonb(c)-'updated_at' order by domain) from market_state_current c));
set local role service_role;
select public.review_prepare();
select public.review_expect_error('select review_apply()','STATE_UNUSABLE');
rollback;
begin;
update market_state_current set ai_evaluated_at=now()+interval '20 minutes' where domain='rates';
update review_inputs set data=data||jsonb_build_object('snapshots',(select jsonb_agg(to_jsonb(c)-'updated_at' order by domain) from market_state_current c));
set local role service_role;
select public.review_prepare();
select public.review_expect_error('select review_apply()','STATE_UNUSABLE');
rollback;

-- First successful Scenario: no empty-seed history. Equivalent response-loss
-- retry, including after a successor Scenario, is always a read-only no-op.
begin;
set local role service_role;
select public.review_prepare();
select public.review_assert(review_apply()='applied','initial applied');
select public.review_assert(review_apply()='already_applied','lost response retry');
select public.review_assert((select count(*)=0 from mic_scenario_history),'initial history excludes seed');
select public.review_assert((select count(*)=2 from mic_scenario_evidence),'two immutable snapshots');
select public.review_assert((select valid_until=(select min(ai_evaluated_at+interval '96 hours') from market_state_current) from mic_scenario_current),'expiry derived');
select public.review_expect_error($q$insert into mic_scenario_evidence(scenario_run_id,domain,state_evaluation_run_id,freshness,usability,state_snapshot)
select (data->>'run_id')::uuid,'rates','11111111-1111-4111-8111-111111111111','fresh','strong',
jsonb_set(data->'snapshots'->1,'{domain}','null') from review_inputs$q$,'mic_scenario_evidence_snapshot_shape');
select public.review_expect_error($q$update mic_scenario_evaluation_runs set status='failed'$q$,'TERMINAL_IMMUTABLE');
commit;

-- A second write with an already evaluated fingerprint must roll back.
begin;
update review_inputs set data=data||jsonb_build_object('updated_at',(select updated_at from mic_scenario_current));
set local role service_role;
select public.review_prepare();
select public.review_expect_error('select review_apply()','mic_scenario_runs_fingerprint_uidx');
select public.review_assert((select count(*)=0 from mic_scenario_history),'duplicate rollback history');
select public.review_assert((select count(*)=2 from mic_scenario_evidence),'duplicate rollback evidence');
rollback;

-- Service-role append-only grants and triggers (TRUNCATE has no grant;
-- owner trigger check separately proves the trigger even if grant changes).
begin;
set local role service_role;
select public.review_expect_error('update mic_scenario_evidence set freshness=''recent''','permission denied');
select public.review_expect_error('delete from mic_scenario_evidence','permission denied');
select public.review_expect_error('truncate mic_scenario_evidence','permission denied');
select public.review_expect_error('update mic_scenario_history set snapshot=''{}''','permission denied');
select public.review_expect_error('delete from mic_scenario_history','permission denied');
select public.review_expect_error('truncate mic_scenario_history','permission denied');
rollback;
begin;
select public.review_expect_error('update mic_scenario_evidence set freshness=''recent''','APPEND_ONLY');
select public.review_expect_error('delete from mic_scenario_evidence','APPEND_ONLY');
select public.review_expect_error('truncate mic_scenario_evidence','APPEND_ONLY');
select public.review_expect_error('truncate mic_scenario_history','APPEND_ONLY');
rollback;
select 'SCENARIO_DISPOSABLE_SQL_PASS' as result;
