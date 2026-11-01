-- Fail-before on the LIVE switch (no guard): ON goes through for a person whose x_autopost has ended, whose common
-- account is locked, whose session is gone, and whose X identity G4 has not verified (the shipped G4 stub is DENY).
-- Prints FBn:<answer> lines; dispatch by run.sh. TEST STAND-INS: owner UPDATEs set the lifecycle states.
\ir setup.sql
select pg_temp.onboarded(31) as a31 \gset
select pg_temp.session(pg_temp.uid(31)) as s31 \gset
select pg_temp.end_service(pg_temp.uid(31));
select 'FB1:' || pg_temp.status_of(pg_temp.as_person(pg_temp.toggle_sql(:'a31', true, false), pg_temp.uid(31), :'s31')) || ':' || pg_temp.enabled(:'a31') as result;
select pg_temp.onboarded(32) as a32 \gset
select pg_temp.session(pg_temp.uid(32)) as s32 \gset
update public.common_accounts set status = 'locked' where user_id = pg_temp.uid(32);
select 'FB2:' || pg_temp.status_of(pg_temp.as_person(pg_temp.toggle_sql(:'a32', true, false), pg_temp.uid(32), :'s32')) || ':' || pg_temp.enabled(:'a32') as result;
select pg_temp.onboarded(33) as a33 \gset
select pg_temp.session(pg_temp.uid(33)) as s33 \gset
delete from auth.sessions where user_id = pg_temp.uid(33);
select 'FB3:' || pg_temp.status_of(pg_temp.as_person(pg_temp.toggle_sql(:'a33', true, false), pg_temp.uid(33), :'s33')) || ':' || pg_temp.enabled(:'a33') as result;
select 'FB4:' || (select prosrc ~ 'select false' from pg_proc where oid = 'postona_x_resv.g4_x_account_verified(uuid,text)'::regprocedure)::text as result;
