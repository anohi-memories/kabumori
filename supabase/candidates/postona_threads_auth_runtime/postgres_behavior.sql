-- LOCAL ONLY. Caller is non-superuser owner. Failure cases use subtransactions.
set request.jwt.claims='{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select postona_threads_runtime.remember(repeat(i::text,64),'00000000-0000-4000-8000-000000000001',
 '00000000-0000-4000-8000-000000000002','https://postona.example/callback') from generate_series(3,9) i;
do $$declare u uuid:='00000000-0000-4000-8000-000000000001';s uuid:='00000000-0000-4000-8000-000000000002';
begin
 begin perform postona_threads_runtime.claim(repeat('3',64),repeat('a',64),u,s,'https://evil.example/callback');
 raise exception 'TEST_WRONG_REDIRECT_ACCEPTED'; exception when others then
 if sqlerrm<>'H5_STATE_NOT_USABLE' then raise;end if;end;
 begin perform postona_threads_runtime.claim(repeat('3',64),repeat('a',64),u,u,'https://postona.example/callback');
 raise exception 'TEST_WRONG_SESSION_ACCEPTED'; exception when others then
 if sqlerrm<>'H5_SESSION_INACTIVE' then raise;end if;end;
 begin perform postona_threads_runtime.claim(repeat('3',64),repeat('a',64),s,s,'https://postona.example/callback');
 raise exception 'TEST_FOREIGN_USER_ACCEPTED'; exception when others then
 if sqlerrm<>'H5_ACTOR_INVALID' then raise;end if;end;
 perform postona_threads_runtime.claim(repeat('3',64),repeat('a',64),u,s,'https://postona.example/callback');
 begin perform postona_threads_runtime.claim(repeat('3',64),repeat('b',64),u,s,'https://postona.example/callback');
 raise exception 'TEST_REPLAY_ACCEPTED'; exception when others then
 if sqlerrm<>'H5_STATE_NOT_USABLE' then raise;end if;end;
 begin perform postona_threads_runtime.claim(repeat('4',64),repeat('a',64),u,s,'https://postona.example/callback');
 raise exception 'TEST_DUPLICATE_CODE_ACCEPTED'; exception when unique_violation then null;end;
 perform postona_threads_runtime.outcome(repeat('3',64),u,s,'uncertain',null);
 begin perform postona_threads_runtime.outcome(repeat('3',64),u,s,'complete',clock_timestamp()+interval '1 day');
 raise exception 'TEST_OUTCOME_RETRY_ACCEPTED'; exception when others then
 if sqlerrm<>'H5_OUTCOME_NOT_USABLE' then raise;end if;end;
 update private.lifecycle set active=false where user_id=u;
 begin perform postona_threads_runtime.claim(repeat('4',64),repeat('b',64),u,s,'https://postona.example/callback');
 raise exception 'TEST_INACTIVE_ACCEPTED'; exception when others then
 if sqlerrm<>'MOCK_T13_INACTIVE' then raise;end if;end;
 update private.lifecycle set active=true where user_id=u;
 update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=s;
 begin perform postona_threads_runtime.claim(repeat('4',64),repeat('b',64),u,s,'https://postona.example/callback');
 raise exception 'TEST_EXPIRED_SESSION_ACCEPTED'; exception when others then
 if sqlerrm<>'H5_SESSION_INACTIVE' then raise;end if;end;
 update auth.sessions set not_after=null where id=s;
 update postona_threads_runtime.attempts set expires_at=clock_timestamp()-interval '1 second' where state_hash=repeat('9',64);
 begin perform postona_threads_runtime.claim(repeat('9',64),repeat('b',64),u,s,'https://postona.example/callback');
 raise exception 'TEST_EXPIRED_STATE_ACCEPTED'; exception when others then
 if sqlerrm<>'H5_STATE_NOT_USABLE' then raise;end if;end;
 if exists(select 1 from postona_threads_runtime.attempts where state_hash=repeat('4',64) and status<>'pending')
 or exists(select 1 from postona_threads_runtime.burned_codes where code_hash=repeat('b',64)) then raise exception 'TEST_FAILED_CLAIM_MUTATED';end if;
end$$;
do $$declare r record;f record;begin
 for r in select rolname from pg_roles where rolname in ('anon','authenticated','service_role','authenticator') loop
  if has_schema_privilege(r.rolname,'postona_threads_runtime','USAGE') then raise exception 'TEST_SCHEMA_ACL';end if;
  for f in select oid from pg_proc where pronamespace='postona_threads_runtime'::regnamespace loop
   if has_function_privilege(r.rolname,f.oid,'EXECUTE') then raise exception 'TEST_FUNCTION_ACL';end if;
  end loop;
  if has_table_privilege(r.rolname,'postona_threads_runtime.attempts','INSERT,UPDATE,DELETE,SELECT')
     or has_any_column_privilege(r.rolname,'postona_threads_runtime.attempts','INSERT,UPDATE,SELECT') then raise exception 'TEST_TABLE_COLUMN_ACL';end if;
 end loop;
end$$;
select 'PASS: real PostgreSQL actor/session/lifecycle/replay/code uniqueness/outcome rollback/ACL';
