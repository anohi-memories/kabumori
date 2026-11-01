-- Fail-before on the LIVE v1 X onboarding RPCs (no T13 guard): a person whose POSTONA x_autopost service has ended,
-- or whose common account is being deleted / is locked, still begins, consumes and completes an X connection
-- (workspace, X row, OAuth state and two Vault token secrets are written). TEST STAND-INS: owner UPDATEs set the
-- lifecycle states no client reaches directly. Prints FBn:<observed> lines; dispatch by run.sh.
\ir helpers.sql

select pg_temp.enrolled(61) is not null as fb_setup_61;
select pg_temp.session(pg_temp.uid(61)) as s61 \gset
select pg_temp.end_service(pg_temp.uid(61));
select pg_temp.as_person(pg_temp.begin_sql('fb61'), pg_temp.uid(61), :'s61') as fb61begin \gset
select pg_temp.as_person(pg_temp.consume_sql('fb61'), pg_temp.uid(61), :'s61') as fb61state \gset
select 'FB1:' || pg_temp.as_person(pg_temp.complete_sql(:'fb61state'::uuid, 'fb61'), pg_temp.uid(61), :'s61') || ':' || pg_temp.footprint(pg_temp.uid(61)) as result;

select pg_temp.enrolled(62) is not null as fb_setup_62;
select pg_temp.session(pg_temp.uid(62)) as s62 \gset
update public.common_accounts set status = 'deleting' where user_id = pg_temp.uid(62);
select 'FB2:' || pg_temp.as_person(pg_temp.begin_sql('fb62'), pg_temp.uid(62), :'s62') as result;

select pg_temp.enrolled(63) is not null as fb_setup_63;
select pg_temp.session(pg_temp.uid(63)) as s63 \gset
delete from auth.sessions where user_id = pg_temp.uid(63);
select 'FB3:' || pg_temp.as_person(pg_temp.begin_sql('fb63'), pg_temp.uid(63), :'s63') as result;
