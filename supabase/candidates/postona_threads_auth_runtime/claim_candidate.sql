-- H5 source candidate only. NOT migration / NOT apply-approved. Requires reviewed PR124 + G5 T13.
-- Owner channel only; no public RPC, positive API grant, auth schema DDL, or token column.
begin;
set local lock_timeout='2s';
set local search_path='';
do $$
declare o oid := (select proowner from pg_proc where oid=to_regprocedure('public.consume_social_mobile_threads_oauth_state(text)'));
begin
  if o is null or o <> (select oid from pg_roles where rolname=current_user)
     or (select rolsuper from pg_roles where oid=o)
     or to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)') is null
     or to_regclass('auth.sessions') is null then raise exception 'H5_OWNER_DEPENDENCY_UNAVAILABLE'; end if;
  if exists(select 1 from pg_roles r where r.rolname in ('anon','authenticated','service_role','authenticator')
    and pg_has_role(r.oid,o,'MEMBER')) then raise exception 'H5_ROLE_GRAPH_UNSAFE'; end if;
  if exists(select 1 from pg_proc f where f.oid=to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)')
    and (f.proowner<>o or f.prorettype<>'void'::regtype))
    or exists(select 1 from pg_roles r where r.rolname in ('anon','authenticated','service_role','authenticator')
      and has_function_privilege(r.oid,to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)'),'EXECUTE'))
    then raise exception 'H5_T13_AUTHORITY_UNSAFE'; end if;
end $$;
create schema postona_threads_runtime;
revoke all on schema postona_threads_runtime from public,anon,authenticated,service_role;
create table postona_threads_runtime.attempts (
  state_hash text primary key check(state_hash ~ '^[0-9a-f]{64}$'),
  oauth_state_id uuid not null unique,
  user_id uuid not null,
  session_id uuid not null,
  redirect_uri text not null,
  brand_id text not null,
  social_account_id text not null,
  expires_at timestamptz not null,
  status text not null default 'pending' check(status in ('pending','claimed','complete','uncertain','failed')),
  code_hash text unique check(code_hash ~ '^[0-9a-f]{64}$'),
  claimed_at timestamptz,
  token_expires_at timestamptz,
  check((status='pending') = (code_hash is null))
);
-- Retain one-shot code tombstones independently from deletable user/session/account data. Never release.
create table postona_threads_runtime.burned_codes (code_hash text primary key check(code_hash ~ '^[0-9a-f]{64}$'));
alter table postona_threads_runtime.attempts enable row level security;
alter table postona_threads_runtime.burned_codes enable row level security;
revoke all on all tables in schema postona_threads_runtime from public,anon,authenticated,service_role;

-- SECURITY INVOKER: only an already-authorized owner connection can execute. T13 is first; then
-- active session KEY SHARE, parent read-only consume, then H5 attempt/unique-code lock. No inversion.
create function postona_threads_runtime.assert_actor(p_user uuid,p_session uuid) returns void
language plpgsql security invoker set search_path='' as $$
begin
  if p_user is distinct from auth.uid() or p_session is null then raise exception 'H5_ACTOR_INVALID'; end if;
  perform private.account_lifecycle_assert_active_service_write(p_user,'x_autopost');
  perform 1 from auth.sessions s where s.id=p_session and s.user_id=p_user
    and (s.not_after is null or s.not_after>clock_timestamp()) for key share;
  if not found then raise exception 'H5_SESSION_INACTIVE'; end if;
end $$;
create function postona_threads_runtime.remember(p_hash text,p_user uuid,p_session uuid,p_redirect text)
returns void language plpgsql security invoker set search_path='' as $$
declare r record;
begin
  perform postona_threads_runtime.assert_actor(p_user,p_session);
  select * into strict r from public.consume_social_mobile_threads_oauth_state(p_hash);
  if r.redirect_uri is distinct from p_redirect then raise exception 'H5_REDIRECT_MISMATCH'; end if;
  insert into postona_threads_runtime.attempts(state_hash,oauth_state_id,user_id,session_id,redirect_uri,brand_id,social_account_id,expires_at)
    select p_hash,r.oauth_state_id,p_user,p_session,p_redirect,r.brand_id,r.social_account_id,s.expires_at
      from public.social_account_oauth_states s where s.id=r.oauth_state_id;
  if not found then raise exception 'H5_STATE_UNAVAILABLE'; end if;
end $$;
create function postona_threads_runtime.claim(p_hash text,p_code text,p_user uuid,p_session uuid,p_redirect text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r record; a postona_threads_runtime.attempts;
begin
  perform postona_threads_runtime.assert_actor(p_user,p_session);
  if p_code is null or p_code !~ '^[0-9a-f]{64}$' then raise exception 'H5_CODE_HASH_INVALID'; end if;
  select * into strict r from public.consume_social_mobile_threads_oauth_state(p_hash);
  select * into a from postona_threads_runtime.attempts where state_hash=p_hash for update;
  if not found or a.user_id is distinct from p_user or a.session_id is distinct from p_session
    or a.redirect_uri is distinct from p_redirect or a.status<>'pending' or a.expires_at<=clock_timestamp()
    or a.oauth_state_id is distinct from r.oauth_state_id or a.brand_id is distinct from r.brand_id
    or a.social_account_id is distinct from r.social_account_id then raise exception 'H5_STATE_NOT_USABLE'; end if;
  insert into postona_threads_runtime.burned_codes values(p_code); -- duplicate => whole claim refused
  update postona_threads_runtime.attempts set status='claimed',code_hash=p_code,claimed_at=clock_timestamp() where state_hash=p_hash;
  return jsonb_build_object('oauth_state_id',a.oauth_state_id,'brand_id',a.brand_id,'social_account_id',a.social_account_id,
    'expires_at',a.expires_at,'redirect_uri',a.redirect_uri);
end $$;
-- No takeover/lease expiry/retry: a dead worker stays burned. Owner reconciliation records facts only.
create function postona_threads_runtime.outcome(p_hash text,p_user uuid,p_session uuid,p_status text,p_expiry timestamptz)
returns void language plpgsql security invoker set search_path='' as $$
begin
  perform postona_threads_runtime.assert_actor(p_user,p_session);
  if p_status not in ('complete','uncertain','failed') or p_status is null
    or (p_status='complete' and (p_expiry is null or p_expiry<=clock_timestamp()
                                or p_expiry>clock_timestamp()+interval '61 days')) then raise exception 'H5_OUTCOME_INVALID'; end if;
  update postona_threads_runtime.attempts set status=p_status,token_expires_at=p_expiry
    where state_hash=p_hash and user_id=p_user and session_id=p_session and status='claimed';
  if not found then raise exception 'H5_OUTCOME_NOT_USABLE'; end if;
end $$;
revoke all on all functions in schema postona_threads_runtime from public,anon,authenticated,service_role;
commit;
