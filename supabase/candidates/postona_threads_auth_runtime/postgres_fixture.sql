-- LOCAL FAKE WORLD ONLY. Not a Supabase Auth/T13/parent RPC security proof.
create schema auth;
create schema private;
create table auth.sessions(id uuid primary key,user_id uuid not null,not_after timestamptz);
create table private.lifecycle(user_id uuid primary key,active boolean not null);
create function auth.uid() returns uuid language sql stable as $$
 select (current_setting('request.jwt.claims',true)::jsonb->>'sub')::uuid
$$;
create function private.account_lifecycle_assert_active_service_write(uuid,text) returns void
language plpgsql as $$begin
 perform 1 from private.lifecycle where user_id=$1 and active for update;
 if not found then raise exception 'MOCK_T13_INACTIVE'; end if;
end$$;
create table public.social_account_oauth_states(id uuid primary key,state_hash text unique,user_id uuid,
 expires_at timestamptz,redirect_uri text,brand_id text,social_account_id text);
create function public.consume_social_mobile_threads_oauth_state(text)
returns table(oauth_state_id uuid,redirect_uri text,brand_id text,social_account_id text)
language sql as $$select id,redirect_uri,brand_id,social_account_id from public.social_account_oauth_states
 where state_hash=$1 and user_id=auth.uid() and expires_at>clock_timestamp()$$;
revoke all on all functions in schema auth,private,public from public,anon,authenticated,service_role;
insert into private.lifecycle values('00000000-0000-4000-8000-000000000001',true);
insert into auth.sessions values('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',null);
insert into public.social_account_oauth_states
select ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,repeat(i::text,64),
 '00000000-0000-4000-8000-000000000001',clock_timestamp()+interval '10 minutes',
 'https://postona.example/callback','u_'||repeat('a',24),'sa_'||repeat('b',24)
from generate_series(3,9) i;
