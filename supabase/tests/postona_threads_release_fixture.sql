-- Fake-only, applied by postona_threads_release_run.sh as the non-superuser table owner on a disposable
-- local database that has the publish-permission fixture, the real X / deletion migrations and Phase
-- 2a-2 applied, plus pgcrypto in schema extensions (created by the runner as superuser). Never production.
--
-- Provides, before the three G4 candidates (custody -> manual publish -> release):
--   * a stand-in for the G5 fence that follows the agreed contract and raises its fixed codes with a
--     per-user SQLSTATE (P0001 or 42501, the code G5's guard candidate uses) — NOT G5's implementation;
--   * auth.sessions as GoTrue shapes it, and Vault secrets with names (as Supabase), including the
--     publish attestation key (a fake value; the Edge server would hold the same one);
--   * helpers that call the candidates exactly as the Data API would: the caller's JWT claims
--     (sub, role, session_id) and role `authenticated`, nothing else; and helpers that compute the
--     server attestation independently of the candidate.
set timezone = 'UTC';

create schema private;
revoke all on schema private from public;

create schema postona_rel;
create table postona_rel.lifecycle (
  user_id uuid primary key,
  state text not null check (state in ('active', 'not_registered', 'ended', 'deleting', 'locked')),
  sqlstate text not null default 'P0001' check (sqlstate in ('P0001', '42501'))
);
create table postona_rel.fence_calls (n bigserial primary key, user_id uuid, tx xid8 not null default pg_current_xact_id());

create function private.account_lifecycle_assert_active_service_write(p_user_id uuid, p_service_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare v postona_rel.lifecycle%rowtype;
begin
  insert into postona_rel.fence_calls (user_id) values (p_user_id);
  if p_user_id is null or p_user_id is distinct from auth.uid() then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_service_key is distinct from 'x_autopost' then raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID' using errcode = '42501'; end if;
  perform 1 from auth.users u where u.id = p_user_id for key share;
  select l.* into v from postona_rel.lifecycle l where l.user_id = p_user_id for update;
  if v.user_id is null then raise exception 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND' using errcode = '42501'; end if;
  if v.state = 'not_registered' then raise exception 'SERVICE_NOT_REGISTERED' using errcode = v.sqlstate; end if;
  if v.state = 'ended' then raise exception 'SERVICE_NOT_ACTIVE' using errcode = v.sqlstate; end if;
  if v.state = 'deleting' then raise exception 'ACCOUNT_DELETION_IN_PROGRESS' using errcode = v.sqlstate; end if;
  if v.state = 'locked' then raise exception 'ACCOUNT_LOCKED' using errcode = v.sqlstate; end if;
end;
$$;
revoke all on function private.account_lifecycle_assert_active_service_write(uuid, text) from public, anon, authenticated, service_role;

create table if not exists auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  not_after timestamptz
);

alter table vault.secrets add column name text unique;
create or replace view vault.decrypted_secrets as select s.id, s.secret as decrypted_secret, s.name from vault.secrets s;
insert into vault.secrets (name, secret) values ('postona_threads_publish_attestation_v1', 'fake_publish_attestation_key_0123456789abcdef0123');

-- ---- Helpers ---------------------------------------------------------------------------------------------

create function postona_rel.session_of(p_user uuid) returns uuid language sql immutable
as $$ select md5('session:' || p_user::text)::uuid $$;

create function postona_rel.login(p_user uuid) returns void language plpgsql as $$
begin
  insert into auth.users values (p_user) on conflict do nothing;
  insert into auth.sessions (id, user_id) values (postona_rel.session_of(p_user), p_user) on conflict (id) do nothing;
end $$;

-- The JWT claims PostgREST would set for this person's session.
create function postona_rel.act(p_user uuid, p_session uuid default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p_user is null then '' else 'authenticated' end, true);
  perform set_config('request.jwt.claim.session_id', coalesce(coalesce(p_session, postona_rel.session_of(p_user))::text, ''), true);
end $$;

-- The server's attestation, computed independently of the candidate with the fake key.
-- PL/pgSQL so the fixture also loads where pgcrypto is absent (the runner's precondition case).
create function postona_rel.hmac(p_message text, p_key text default 'fake_publish_attestation_key_0123456789abcdef0123') returns text
language plpgsql immutable as $$
begin
  return encode(extensions.hmac(convert_to(p_message, 'UTF8'), convert_to(p_key, 'UTF8'), 'sha256'), 'hex');
end $$;

create function postona_rel.nonce() returns text language sql volatile as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') $$;

-- Calls release as the person (role authenticated). p_key / p_issued / p_nonce override the honest server.
create function postona_rel.release(p_user uuid, p_attempt uuid, p_step text, p_session uuid default null,
                                    p_key text default null, p_issued bigint default null, p_nonce text default null)
returns jsonb language plpgsql as $$
declare
  v_session uuid := coalesce(p_session, postona_rel.session_of(p_user));
  v_issued bigint := coalesce(p_issued, extract(epoch from clock_timestamp())::bigint);
  v_nonce text := coalesce(p_nonce, postona_rel.nonce());
  v_att text;
  v_out jsonb;
begin
  v_att := postona_rel.hmac(concat_ws(chr(10), 'postona-threads-publish-release-v1', p_user::text,
                                      p_attempt::text, p_step, v_issued::text, v_nonce),
                            coalesce(p_key, 'fake_publish_attestation_key_0123456789abcdef0123'));
  perform postona_rel.act(p_user, v_session);
  set local role authenticated;
  v_out := public.release_threads_manual_publish_step(p_attempt, p_step, v_issued, v_nonce, v_att);
  reset role;
  perform postona_rel.act(null);
  return v_out;
end $$;

create function postona_rel.record(p_user uuid, p_attempt uuid, p_step text, p_grant text, p_to text,
                                   p_container text default null, p_post text default null, p_permalink text default null,
                                   p_error text default null, p_session uuid default null, p_key text default null)
returns jsonb language plpgsql as $$
declare
  v_session uuid := coalesce(p_session, postona_rel.session_of(p_user));
  v_issued bigint := extract(epoch from clock_timestamp())::bigint;
  v_nonce text := postona_rel.nonce();
  v_att text;
  v_out jsonb;
begin
  v_att := postona_rel.hmac(concat_ws(chr(10), 'postona-threads-publish-record-v1', p_user::text,
                                      p_attempt::text, p_step, p_grant, p_to, coalesce(p_container, ''), coalesce(p_post, ''),
                                      coalesce(p_permalink, ''), coalesce(p_error, ''), v_issued::text, v_nonce),
                            coalesce(p_key, 'fake_publish_attestation_key_0123456789abcdef0123'));
  perform postona_rel.act(p_user, v_session);
  set local role authenticated;
  v_out := public.record_threads_manual_publish_result(p_attempt, p_step, p_grant, p_to, p_container, p_post, p_permalink,
                                                       p_error, v_issued, v_nonce, v_att);
  reset role;
  perform postona_rel.act(null);
  return v_out;
end $$;

-- Caller functions that hand out nothing (begin, permission, state, read), as the person.
create function postona_rel.as_user(p_user uuid, p_call text, variadic p_args text[] default '{}') returns jsonb language plpgsql as $$
declare v_out jsonb;
begin
  perform postona_rel.act(p_user);
  set local role authenticated;
  case p_call
    when 'permission' then v_out := public.set_threads_manual_publish_permission(p_args[1], p_args[2]::boolean, p_args[3]::boolean);
    when 'state' then v_out := public.get_threads_manual_publish_state(p_args[1]);
    when 'begin' then v_out := public.begin_threads_manual_publish(p_args[1], p_args[2]::uuid, p_args[3]);
    when 'read' then v_out := public.get_threads_manual_publish_attempt(p_args[1]::uuid);
  end case;
  reset role;
  perform postona_rel.act(null);
  return v_out;
end $$;

-- A verified Threads account in p_brand, connected NOW by p_owner, with its custody recorded in the same
-- transaction (as the connect owner transaction would). Returns the account id.
create function postona_rel.connect_threads(p_owner uuid, p_brand text, p_tag text, p_expires interval default interval '50 days')
returns text language plpgsql as $$
declare v_access uuid; v_id text := 'sa_th_' || p_tag;
begin
  insert into vault.secrets (secret, name) values ('fake_threads_' || p_tag || '_TOKEN_0123456789', v_id || '_access_token') returning id into v_access;
  insert into public.social_accounts
    (id, brand_id, platform, handle, platform_user_id, connection_status, verified_at, vault_access_token_secret_id)
  values (v_id, p_brand, 'threads', p_tag, '178414057931' || lpad((abs(hashtext(p_tag)) % 1000000)::text, 6, '0'),
          'identity_verified', now(), v_access);
  perform postona_rel.act(p_owner);
  perform public.record_threads_credential_custody(v_id, now() + p_expires);
  perform postona_rel.act(null);
  return v_id;
end $$;

-- 'ok' or the SQLSTATE a role gets.
create function postona_rel.try_as(p_role text, p_sql text) returns text language plpgsql as $$
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
end $$;

create function postona_rel.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAIL %', p_label; end if;
end $$;
