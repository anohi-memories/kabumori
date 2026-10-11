-- Fake-only, applied by postona_threads_publish_run.sh as the non-superuser table owner on a disposable
-- local database that already has the publish-permission fixture, the real X / deletion migrations and
-- Phase 2a-2 (20261007150000) applied. Never production.
--
-- 1. A stand-in for the G5 writer fence the candidate requires
--    (private.account_lifecycle_assert_active_service_write, docs/postona/threads-g5-t9-t10-t13-shared-contract-20261010.md).
--    It is NOT G5's implementation: it follows the agreed contract (caller must be auth.uid(), service
--    'x_autopost', fixed P0001 codes, locks the user's lifecycle row FOR UPDATE and keeps it) over a
--    proof-only state table, so the candidate's use of it can be exercised.
-- 2. Helpers that call the candidate exactly as the Data API would: the caller's JWT subject and role
--    `authenticated`, or role `service_role`, and nothing else.
-- 3. A Threads account per test workspace, written as the table owner (2a-2's provider guard).
set timezone = 'UTC';

create schema private;
revoke all on schema private from public;

create schema postona_threads_proof;
create table postona_threads_proof.lifecycle (
  user_id uuid primary key,
  state text not null check (state in ('active', 'not_registered', 'ended', 'deleting', 'locked', 'fence_broken'))
);
create table postona_threads_proof.fence_calls (n bigserial primary key, user_id uuid, service_key text);

create function private.account_lifecycle_assert_active_service_write(p_user_id uuid, p_service_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_state text;
begin
  insert into postona_threads_proof.fence_calls (user_id, service_key) values (p_user_id, p_service_key);
  if p_user_id is null or p_user_id is distinct from auth.uid() then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED';
  end if;
  if p_service_key is distinct from 'x_autopost' then raise exception 'ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE'; end if;
  perform 1 from auth.users u where u.id = p_user_id for key share;
  select l.state into v_state from postona_threads_proof.lifecycle l where l.user_id = p_user_id for update;
  if v_state is null then raise exception 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'; end if;
  if v_state = 'not_registered' then raise exception 'SERVICE_NOT_REGISTERED'; end if;
  if v_state = 'ended' then raise exception 'SERVICE_NOT_ACTIVE'; end if;
  if v_state = 'deleting' then raise exception 'ACCOUNT_DELETION_IN_PROGRESS'; end if;
  if v_state = 'locked' then raise exception 'ACCOUNT_LOCKED'; end if;
  if v_state = 'fence_broken' then raise exception division_by_zero; end if;
end;
$$;
revoke all on function private.account_lifecycle_assert_active_service_write(uuid, text) from public, anon, authenticated, service_role;

-- A stand-in for the credential custody owner's expiry reader (contract: NULL = unknown = expired).
create table postona_threads_proof.credential_expiry (social_account_id text primary key, expires_at timestamptz);
create function public.threads_account_credential_expires_at(p_social_account_id text) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select e.expires_at from postona_threads_proof.credential_expiry e where e.social_account_id = p_social_account_id
$$;
revoke all on function public.threads_account_credential_expires_at(text) from public, anon, authenticated, service_role;

-- A Threads account (as the owner) with its own Vault access secret and no refresh reference.
create function postona_threads_proof.threads_account(p_brand text, p_tag text, p_status text default 'identity_verified')
returns text language plpgsql as $$
declare v_access uuid;
begin
  insert into vault.secrets (secret) values ('fake_threads_' || p_tag || '_TOKEN_0123456789') returning id into v_access;
  insert into public.social_accounts
    (id, brand_id, platform, handle, platform_user_id, connection_status, verified_at, vault_access_token_secret_id)
  values ('sa_th_' || p_tag, p_brand, 'threads', p_tag, '1784140579318' || lpad((abs(hashtext(p_tag)) % 100000)::text, 5, '0'),
          p_status, case when p_status = 'identity_verified' then now() end, v_access);
  insert into postona_threads_proof.credential_expiry values ('sa_th_' || p_tag, now() + interval '50 days');
  return 'sa_th_' || p_tag;
end;
$$;

-- As the Data API runs caller functions: JWT subject + role authenticated. SECURITY INVOKER.
create function postona_threads_proof.as_user(p_user uuid, p_call text, variadic p_args text[] default '{}')
returns jsonb language plpgsql as $$
declare v_out jsonb;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  set local role authenticated;
  case p_call
    when 'permission' then v_out := public.set_threads_manual_publish_permission(p_args[1], p_args[2]::boolean, p_args[3]::boolean);
    when 'state' then v_out := public.get_threads_manual_publish_state(p_args[1]);
    when 'begin' then v_out := public.begin_threads_manual_publish(p_args[1], p_args[2]::uuid, p_args[3]);
    when 'claim' then v_out := public.claim_threads_manual_publish_step(p_args[1]::uuid, p_args[2]);
    when 'read' then v_out := public.get_threads_manual_publish_attempt(p_args[1]::uuid);
  end case;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end;
$$;

-- As the server runs the two server-only functions: role service_role.
create function postona_threads_proof.as_server(p_call text, variadic p_args text[])
returns jsonb language plpgsql as $$
declare v_out jsonb;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  set local role service_role;
  case p_call
    when 'redeem' then v_out := public.redeem_threads_manual_publish_step(p_args[1]::uuid, p_args[2], p_args[3]);
    when 'record' then v_out := public.record_threads_manual_publish_step(p_args[1]::uuid, p_args[2], p_args[3], p_args[4],
                                                                          p_args[5], p_args[6], p_args[7], p_args[8]);
  end case;
  reset role;
  return v_out;
end;
$$;

-- Whether a role may call something at all: 'ok', or the SQLSTATE it gets.
create function postona_threads_proof.try_as(p_role text, p_sql text) returns text language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
  exception when others then
    reset role;
    return sqlstate;
  end;
  reset role;
  return 'ok';
end;
$$;

create function postona_threads_proof.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAIL %', p_label; end if;
end;
$$;
