-- G5 SOURCE CANDIDATE (2026-11-13, Issue #587 G5-02 task 9). NOT applied anywhere. Production NO_GO: new SECURITY DEFINER RPCs over a new
-- owner-only table that holds push tokens (secrets) -- an independent H review, the owner's approval and a read-only check of the managed
-- project come first. No push is sent by anything here; nothing calls APNs / FCM / Expo.
--
-- POSTONA push devices: the phones a person's POSTONA notifications may be delivered to, bound to the person, their personal workspace, the
-- auth session that registered them and the service generation, so that sign-out, service end / restart, account lock / deletion and
-- owner loss stop delivery without anyone having to remember to delete a row.
--   table   private.postona_push_devices (owner-only, row security on with no policy; no API role reads or writes it). One row per app
--           installation (installation_id, chosen by the app). The token is a SECRET: never answered to the app, never in an error, a
--           log or a notice; a revoked row keeps no token and no token hash.
--   API     three SECURITY DEFINER RPCs, EXECUTE for authenticated only (the only definers this adds):
--             postona_push_device_register(installation_id, platform, push_token, expected_version)   -> registered | unchanged | refusal
--             postona_push_device_unregister(installation_id)                                         -> unregistered | not_registered
--             postona_push_device_list()                                                              -> the person's devices, without tokens
--   worker  owner-only, SECURITY INVOKER (no grant to any API role; a G3 delivery function owned by the same owner calls them):
--             private.postona_push_delivery_targets(user_id, brand_id)            -> {verdict, lifecycle_version, targets[{.., push_token}]}
--             private.postona_push_device_invalidate(installation_id, version)    -> the provider said the token is dead (DeviceNotRegistered)
--             private.postona_push_devices_purge()                                -> erases the tokens of rows that can never deliver again
--
-- Binding (register), in W0's gate order: S2-2 private.postona_personal_session() = 'active' -> T13 (the lifecycle lock: account FOR UPDATE,
-- x_autopost active, no deletion, the session live after the locks) -> S2-3 'own'. The row takes the derived workspace ('u_' || md5 prefix),
-- the JWT's session_id, common_accounts.lifecycle_version (read under T13's lock), never a client-given workspace / user / session.
-- Delivery (targets) answers a token only while ALL hold, read in one STABLE snapshot every time it is asked:
--   1. G5's MV private.postona_personal_worker_verdict(user, brand, 'x_autopost', CURRENT lifecycle_version) = 'active' (the derived personal
--      workspace, S2-3 'own', account active / no deletion / x_autopost active, the generation triggers P1's);
--   2. the row: active, that user, that workspace, registered under the CURRENT lifecycle_version (a service end / restart / lock / deletion
--      bumps it: every earlier registration is stale until the app registers again);
--   3. the auth session the row was registered under still exists for that user and has not expired (sign-out deletes it: stopped even when
--      the app's unregister never reached the server).
-- Replays and races (register): compare-and-set on registration_version (the caller's own row moves only from the version it last saw; a new
-- row or another person's only from none); the same registration again is 'unchanged'; one token is active on at most ONE row (another
-- row holding it, the person's or anyone's, is revoked 'taken_over'); one installation is one row (another person registering it takes it
-- over); transaction advisory locks on the token and on the installation serialize same-token / same-installation registrations, the
-- person's own registrations already serialize on T13's account lock; rows are locked in installation_id order. At most 10 deliverable
-- devices per person (DEVICE_LIMIT).
--
-- Run as the lifecycle owner (the owner of the G5 gates; never a superuser) with ON_ERROR_STOP, after MVP_INSTALL.sql (S2-2, S2-3, T13, MV)
-- and W0. Re-running it changes nothing. Stop: 001_push_devices_stop.sql (no new registration, every token erased). Rollback:
-- 001_push_devices_rollback.sql (refuses while a device is active or another function names the worker functions).
--
-- Refusals (SQLSTATE P0001, nothing changed): PUSH_SUPERUSER, PUSH_PREREQUISITE_MISSING, PUSH_GATE_CHANGED (S2-2 / S2-3 / T13 / MV is not the
-- reviewed body owned by this role), PUSH_OWNER_FILTERED (a relation read would hide rows from the owner), PUSH_TAKEN (a table / function of
-- ours exists but is not ours), PUSH_POSTCONDITION_*.

begin;
set local lock_timeout = '5s';
set local search_path = '';

do $pre$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_rel text;
  v_kind "char";
  v_rls boolean;
  v_forced boolean;
  v_relowner oid;
  v_txt text;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) then
    raise exception 'PUSH_SUPERUSER: run it as the lifecycle owner, not a superuser';
  end if;
  if pg_catalog.to_regnamespace('private') is null or pg_catalog.to_regclass('auth.sessions') is null or pg_catalog.to_regclass('auth.users') is null
     or pg_catalog.to_regclass('public.common_accounts') is null or pg_catalog.to_regclass('public.service_entitlements') is null
     or pg_catalog.to_regclass('private.account_lifecycle_operations') is null
     or pg_catalog.to_regprocedure('private.postona_personal_session()') is null
     or pg_catalog.to_regprocedure('private.postona_personal_workspace_eligibility(uuid)') is null
     or pg_catalog.to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)') is null
     or pg_catalog.to_regprocedure('private.postona_personal_worker_verdict(uuid,text,text,bigint)') is null
     or not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = pg_catalog.to_regclass('public.common_accounts') and a.attname = 'lifecycle_version'
                     and a.atttypid = 'pg_catalog.int8'::pg_catalog.regtype and not a.attisdropped)
     or not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = pg_catalog.to_regclass('auth.sessions') and a.attname = 'not_after'
                     and a.atttypid = 'pg_catalog.timestamptz'::pg_catalog.regtype and not a.attisdropped) then
    raise exception 'PUSH_PREREQUISITE_MISSING: schema private, auth.users / auth.sessions, the P1 lifecycle tables and the MVP gates (S2-2, S2-3, T13, MV) are required';
  end if;
  if not pg_catalog.has_schema_privilege(v_owner, 'private', 'CREATE') then
    raise exception 'PUSH_PREREQUISITE_MISSING: % may not create in schema private', current_user;
  end if;
  -- the reviewed gates, by body and owner (as MVP_INSTALL pins them)
  if (select pg_catalog.md5(p.prosrc) || ':' || (p.proowner = v_owner) from pg_catalog.pg_proc p where p.oid = 'private.postona_personal_session()'::pg_catalog.regprocedure)
       is distinct from 'a5d4d71c532847a8573e86a4bd0c791d:true'
     or (select pg_catalog.md5(p.prosrc) || ':' || (p.proowner = v_owner) from pg_catalog.pg_proc p where p.oid = 'private.postona_personal_workspace_eligibility(uuid)'::pg_catalog.regprocedure)
       is distinct from 'fa4623601fe2ef6efc38478c9f65105e:true'
     or (select pg_catalog.md5(p.prosrc) || ':' || (p.proowner = v_owner) from pg_catalog.pg_proc p where p.oid = 'private.account_lifecycle_assert_active_service_write(uuid,text)'::pg_catalog.regprocedure)
       is distinct from '1f8cd9c764c251f3232c61b7a77ff597:true'
     or (select pg_catalog.md5(p.prosrc) || ':' || (p.proowner = v_owner) from pg_catalog.pg_proc p where p.oid = 'private.postona_personal_worker_verdict(uuid,text,text,bigint)'::pg_catalog.regprocedure)
       is distinct from '066b958a4845941133ea3de12630b955:true' then
    raise exception 'PUSH_GATE_CHANGED: S2-2, S2-3, T13 or MV is not the reviewed body owned by %', current_user;
  end if;
  -- the relations read with row_security = off: plain tables whose EVERY row this owner sees (RLS off, BYPASSRLS, or the owner's privileges
  -- with RLS not FORCED); a later filter then raises instead of hiding a session / account row
  foreach v_rel in array array['auth.users', 'auth.sessions', 'public.common_accounts', 'private.account_lifecycle_operations'] loop
    select c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relowner into v_kind, v_rls, v_forced, v_relowner
      from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass(v_rel);
    if v_kind not in ('r', 'p') or not pg_catalog.has_table_privilege(v_owner, v_rel, 'SELECT') then
      raise exception 'PUSH_PREREQUISITE_MISSING: % is not a table % may read', v_rel, current_user;
    end if;
    if v_forced or (v_rls and not (select r.rolbypassrls from pg_catalog.pg_roles r where r.oid = v_owner) and not pg_catalog.pg_has_role(v_owner, v_relowner, 'USAGE')) then
      raise exception 'PUSH_OWNER_FILTERED: row security on % would hide rows from %', v_rel, current_user;
    end if;
  end loop;
  -- ours, or absent
  if pg_catalog.to_regclass('private.postona_push_devices') is not null
     and ((select c.relowner from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('private.postona_push_devices')) <> v_owner
          or (select pg_catalog.string_agg(a.attname::text, ',' order by a.attname) from pg_catalog.pg_attribute a
               where a.attrelid = pg_catalog.to_regclass('private.postona_push_devices') and a.attnum > 0 and not a.attisdropped)
             is distinct from 'created_at,installation_id,lifecycle_version,platform,push_token,registration_version,revoked_at,revoked_reason,session_id,status,token_sha256,updated_at,user_id,workspace_id') then
    raise exception 'PUSH_TAKEN: private.postona_push_devices exists and is not this candidate''s';
  end if;
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::text, ', ') into v_txt from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.proname like 'postona\_push\_%' and p.proowner <> v_owner;
  if v_txt is not null then
    raise exception 'PUSH_TAKEN: %', v_txt;
  end if;
end;
$pre$;

-- ---- the devices (owner-only; row security on with no policy: only the definer RPCs and the owner's worker functions read or write it) ----
create table if not exists private.postona_push_devices (
  installation_id uuid primary key,              -- chosen by the app, once per installation (kept in its secure storage)
  user_id uuid not null,
  workspace_id text not null check (workspace_id ~ '^u_[0-9a-f]{24}$'),
  session_id uuid not null,                      -- the auth session that registered it (JWT session_id)
  lifecycle_version bigint not null check (lifecycle_version >= 1),
  platform text not null check (platform in ('ios', 'android')),
  push_token text,                               -- SECRET; only while active
  token_sha256 bytea,                            -- only while active (one active row per token)
  registration_version integer not null check (registration_version >= 1),
  status text not null check (status in ('active', 'revoked')),
  revoked_reason text check (revoked_reason in ('unregistered', 'taken_over', 'provider_rejected', 'session_ended', 'stale_generation', 'account_gone', 'stopped')),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  revoked_at timestamptz,
  check (push_token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{16,64}\]$'),
  check (token_sha256 = pg_catalog.sha256(pg_catalog.convert_to(push_token, 'UTF8'))),
  check ((status = 'active') = (push_token is not null and token_sha256 is not null and revoked_at is null and revoked_reason is null)),
  check ((status = 'revoked') = (push_token is null and token_sha256 is null and revoked_at is not null and revoked_reason is not null))
);
create unique index if not exists postona_push_devices_active_token on private.postona_push_devices (token_sha256) where status = 'active';
create index if not exists postona_push_devices_user on private.postona_push_devices (user_id, status);
alter table private.postona_push_devices enable row level security;
revoke all on table private.postona_push_devices from public, anon, authenticated, service_role;

-- ---- internal helpers (SECURITY INVOKER, owner-only: they run as the owner only inside the definer RPCs / the owner's own calls) ----------
-- the JWT's session_id, read from the claim source auth.uid() reads first (as S2-2 / T13): the per-claim settings when a per-claim sub is set
create or replace function private.postona_push_claims_session()
returns uuid language plpgsql stable set search_path = '' as $$
declare
  v_claims jsonb;
  v_session text;
begin
  if nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '') is not null then
    v_session := nullif(pg_catalog.current_setting('request.jwt.claim.session_id', true), '');
  else
    begin
      v_claims := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
    exception when others then
      v_claims := null;
    end;
    if pg_catalog.jsonb_typeof(v_claims) = 'object' then
      v_session := v_claims ->> 'session_id';
    end if;
  end if;
  if v_session ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return v_session::uuid;
  end if;
  return null;
end $$;

-- the writer's gates, in W0's order (S2-2 -> T13 with the lifecycle lock -> S2-3); null = go on, else the answer's status
create or replace function private.postona_push_writer_gate()
returns text language plpgsql volatile set search_path = '' as $$
declare
  v_session text;
  v_user uuid;
  v_state text;
begin
  v_session := private.postona_personal_session();
  if v_session is distinct from 'active' then
    return coalesce(v_session, 'AUTH_REQUIRED');
  end if;
  v_user := (select auth.uid());
  begin
    perform private.account_lifecycle_assert_active_service_write(v_user, 'x_autopost');
  exception when insufficient_privilege then
    if sqlerrm in ('ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', 'ACCOUNT_DELETION_IN_PROGRESS', 'ACCOUNT_LOCKED',
                   'SERVICE_NOT_REGISTERED', 'SERVICE_DELETION_IN_PROGRESS', 'SERVICE_NOT_ACTIVE', 'ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE',
                   'ACCOUNT_LIFECYCLE_BUSY') then
      return sqlerrm;
    end if;
    raise;
  end;
  v_state := private.postona_personal_workspace_eligibility(v_user);
  return case v_state when 'own' then null when 'absent' then 'WORKSPACE_REQUIRED' else coalesce(v_state, 'OWN_WORKSPACE_CONFLICT') end;
end $$;

-- the session row of a device is live: it exists for that user and has not expired
create or replace function private.postona_push_session_live(p_session_id uuid, p_user_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from auth.sessions s where s.id = p_session_id and s.user_id = p_user_id
                   and (s.not_after is null or s.not_after > pg_catalog.clock_timestamp()))
$$;

-- transaction advisory lock keys: one per token (by its hash), one per installation
create or replace function private.postona_push_lock_key(p_kind text, p_value text)
returns bigint language sql immutable set search_path = '' as $$
  select ('x' || pg_catalog.substr(pg_catalog.md5('postona_push_' || p_kind || ':' || p_value), 1, 16))::bit(64)::bigint
$$;

-- a device as the person's API answers it: never the token, its hash, the session id or another person's anything
create or replace function private.postona_push_device_json(d private.postona_push_devices, p_session uuid, p_deliverable boolean)
returns jsonb language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_build_object('installation_id', d.installation_id, 'platform', d.platform, 'status', d.status,
           'registration_version', d.registration_version, 'revoked_reason', d.revoked_reason, 'this_session', d.session_id = p_session,
           'deliverable', p_deliverable, 'created_at', d.created_at, 'updated_at', d.updated_at)
$$;

-- ---- the person's API (SECURITY DEFINER, EXECUTE for authenticated only) ---------------------------------------------------------------
create or replace function public.postona_push_device_register(p_installation_id uuid, p_platform text, p_push_token text, p_expected_version integer default null)
returns jsonb language plpgsql volatile security definer set search_path = '' set row_security = off as $$
declare
  v_gate text;
  v_user uuid;
  v_session uuid;
  v_ws text;
  v_lv bigint;
  v_hash bytea;
  v_holder uuid;
  v_others integer;
  r private.postona_push_devices;
begin
  v_gate := private.postona_push_writer_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('status', v_gate);
  end if;
  -- never echoes the token (nor says which part is wrong)
  if p_installation_id is null or p_platform is null or p_platform not in ('ios', 'android') or p_push_token is null
     or p_push_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{16,64}\]$' or p_expected_version < 1 then
    return pg_catalog.jsonb_build_object('status', 'INVALID_INPUT');
  end if;
  v_user := (select auth.uid());
  v_session := private.postona_push_claims_session();
  if v_user is null or v_session is null then
    return pg_catalog.jsonb_build_object('status', 'AUTH_REQUIRED');
  end if;
  v_ws := 'u_' || pg_catalog.substr(pg_catalog.md5(v_user::text), 1, 24);
  -- the generation, read under T13's account lock (a service end / restart waits for this registration, or this sees its new version)
  select a.lifecycle_version into v_lv from public.common_accounts a where a.user_id = v_user;
  if v_lv is null then
    return pg_catalog.jsonb_build_object('status', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND');
  end if;
  v_hash := pg_catalog.sha256(pg_catalog.convert_to(p_push_token, 'UTF8'));
  -- one registration of this token at a time (anyone's), then one of this installation at a time
  perform pg_catalog.pg_advisory_xact_lock(private.postona_push_lock_key('token', pg_catalog.encode(v_hash, 'hex')));
  perform pg_catalog.pg_advisory_xact_lock(private.postona_push_lock_key('installation', p_installation_id::text));
  -- another active row holding this token (it cannot change hands while the token lock is held); both rows locked in installation_id order
  select d.installation_id into v_holder from private.postona_push_devices d
   where d.token_sha256 = v_hash and d.status = 'active' and d.installation_id <> p_installation_id;
  perform 1 from private.postona_push_devices d where d.installation_id in (p_installation_id, v_holder) order by d.installation_id for update;
  select * into r from private.postona_push_devices d where d.installation_id = p_installation_id;

  -- the same registration again (a retry whose answer was lost): nothing changes
  if r.installation_id is not null and r.user_id = v_user and r.status = 'active' and r.token_sha256 = v_hash and r.session_id = v_session
     and r.lifecycle_version = v_lv and r.platform = p_platform and r.workspace_id = v_ws then
    return pg_catalog.jsonb_build_object('status', 'unchanged', 'device', private.postona_push_device_json(r, v_session, true));
  end if;
  -- compare-and-set: the person's own row moves only from the version they last saw; a new row, or another person's, only from none
  if r.installation_id is not null and r.user_id = v_user then
    if p_expected_version is distinct from r.registration_version then
      return pg_catalog.jsonb_build_object('status', 'STALE_REGISTRATION', 'registration_version', r.registration_version);
    end if;
  elsif p_expected_version is not null then
    return pg_catalog.jsonb_build_object('status', 'STALE_REGISTRATION', 'registration_version', null);
  end if;
  -- at most 10 deliverable devices (the person's registrations serialize on T13's account lock)
  select pg_catalog.count(*) into v_others from private.postona_push_devices d
   where d.user_id = v_user and d.status = 'active' and d.installation_id <> p_installation_id and d.lifecycle_version = v_lv
     and private.postona_push_session_live(d.session_id, v_user);
  if v_others >= 10 then
    return pg_catalog.jsonb_build_object('status', 'DEVICE_LIMIT');
  end if;
  -- one active row per token: the earlier holder (the person's own old installation, or anyone's) stops
  if v_holder is not null then
    update private.postona_push_devices d
       set status = 'revoked', revoked_reason = 'taken_over', revoked_at = pg_catalog.clock_timestamp(), push_token = null, token_sha256 = null,
           registration_version = d.registration_version + 1, updated_at = pg_catalog.clock_timestamp()
     where d.installation_id = v_holder and d.status = 'active' and d.token_sha256 = v_hash;
  end if;
  if r.installation_id is null then
    insert into private.postona_push_devices (installation_id, user_id, workspace_id, session_id, lifecycle_version, platform, push_token, token_sha256,
                                              registration_version, status)
    values (p_installation_id, v_user, v_ws, v_session, v_lv, p_platform, p_push_token, v_hash, 1, 'active')
    returning * into r;
  else
    update private.postona_push_devices d
       set user_id = v_user, workspace_id = v_ws, session_id = v_session, lifecycle_version = v_lv, platform = p_platform, push_token = p_push_token,
           token_sha256 = v_hash, registration_version = d.registration_version + 1, status = 'active', revoked_reason = null, revoked_at = null,
           created_at = case when d.user_id = v_user then d.created_at else pg_catalog.clock_timestamp() end, updated_at = pg_catalog.clock_timestamp()
     where d.installation_id = p_installation_id
    returning * into r;
  end if;
  return pg_catalog.jsonb_build_object('status', 'registered', 'device', private.postona_push_device_json(r, v_session, true));
end $$;

-- the person stops this installation's notifications (sign-out, "notifications off", account deletion): a live session is enough -- no
-- service / workspace gate, so a person whose service ended or whose workspace was lost can still remove it. Idempotent; another person's
-- installation (or none) answers not_registered and changes nothing.
create or replace function public.postona_push_device_unregister(p_installation_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' set row_security = off as $$
declare
  v_state text;
  v_user uuid;
  r private.postona_push_devices;
begin
  v_state := private.postona_personal_session();
  if v_state is distinct from 'active' then
    return pg_catalog.jsonb_build_object('status', coalesce(v_state, 'AUTH_REQUIRED'));
  end if;
  if p_installation_id is null then
    return pg_catalog.jsonb_build_object('status', 'INVALID_INPUT');
  end if;
  v_user := (select auth.uid());
  perform pg_catalog.pg_advisory_xact_lock(private.postona_push_lock_key('installation', p_installation_id::text));
  select * into r from private.postona_push_devices d where d.installation_id = p_installation_id and d.user_id = v_user for update;
  if r.installation_id is null then
    return pg_catalog.jsonb_build_object('status', 'not_registered');
  end if;
  if r.status = 'active' then
    update private.postona_push_devices d
       set status = 'revoked', revoked_reason = 'unregistered', revoked_at = pg_catalog.clock_timestamp(), push_token = null, token_sha256 = null,
           registration_version = d.registration_version + 1, updated_at = pg_catalog.clock_timestamp()
     where d.installation_id = r.installation_id
    returning * into r;
  end if;
  return pg_catalog.jsonb_build_object('status', 'unregistered', 'device', private.postona_push_device_json(r, private.postona_push_claims_session(), false));
end $$;

-- the person's own devices, newest first, without tokens; 'delivery' is what the worker would be told now (MV's verdict), 'deliverable'
-- per device whether a notification would reach it now
create or replace function public.postona_push_device_list()
returns jsonb language plpgsql stable security definer set search_path = '' set row_security = off as $$
declare
  v_state text;
  v_user uuid;
  v_ws text;
  v_lv bigint;
  v_verdict text;
  v_session uuid;
begin
  v_state := private.postona_personal_session();
  if v_state is distinct from 'active' then
    return pg_catalog.jsonb_build_object('status', coalesce(v_state, 'AUTH_REQUIRED'));
  end if;
  v_user := (select auth.uid());
  v_session := private.postona_push_claims_session();
  v_ws := 'u_' || pg_catalog.substr(pg_catalog.md5(v_user::text), 1, 24);
  select a.lifecycle_version into v_lv from public.common_accounts a where a.user_id = v_user;
  v_verdict := case when v_lv is null then 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'
                    else coalesce(private.postona_personal_worker_verdict(v_user, v_ws, 'x_autopost', v_lv), 'PUSH_VERDICT_UNKNOWN') end;
  return pg_catalog.jsonb_build_object('status', 'ok', 'delivery', v_verdict, 'devices', coalesce((
    select pg_catalog.jsonb_agg(private.postona_push_device_json(d, v_session,
             d.status = 'active' and v_verdict = 'active' and d.workspace_id = v_ws and d.lifecycle_version = v_lv
             and private.postona_push_session_live(d.session_id, v_user)) order by d.updated_at desc, d.installation_id)
      from private.postona_push_devices d where d.user_id = v_user), '[]'::jsonb));
end $$;

-- ---- the delivery side (SECURITY INVOKER, owner-only; for G3's push worker, called by a function the same owner owns) ----------------------
-- where (user, workspace)'s notification may go NOW: re-authorized on every call, one STABLE snapshot, no lock, no write. Never cache it:
-- read it right before each send. The tokens are secrets: the caller must not log them.
create or replace function private.postona_push_delivery_targets(p_user_id uuid, p_brand_id text)
returns jsonb language plpgsql stable set search_path = '' set row_security = off as $$
declare
  v_lv bigint;
  v_verdict text;
begin
  if p_user_id is null or p_brand_id is null then
    return pg_catalog.jsonb_build_object('verdict', 'PUSH_INPUT_REQUIRED', 'targets', '[]'::jsonb);
  end if;
  select a.lifecycle_version into v_lv from public.common_accounts a where a.user_id = p_user_id;
  v_verdict := case when v_lv is null then 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'
                    else coalesce(private.postona_personal_worker_verdict(p_user_id, p_brand_id, 'x_autopost', v_lv), 'PUSH_VERDICT_UNKNOWN') end;
  if v_verdict <> 'active' then
    return pg_catalog.jsonb_build_object('verdict', v_verdict, 'targets', '[]'::jsonb);
  end if;
  return pg_catalog.jsonb_build_object('verdict', 'active', 'lifecycle_version', v_lv, 'targets', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('installation_id', d.installation_id, 'platform', d.platform, 'push_token', d.push_token,
                                                              'registration_version', d.registration_version) order by d.installation_id)
      from private.postona_push_devices d
     where d.user_id = p_user_id and d.workspace_id = p_brand_id and d.status = 'active' and d.lifecycle_version = v_lv
       and private.postona_push_session_live(d.session_id, p_user_id)), '[]'::jsonb));
end $$;

-- the provider answered that a token is dead (e.g. DeviceNotRegistered): revoke THAT registration only -- a newer one (the app registered a
-- new token since the send was read) is left alone
create or replace function private.postona_push_device_invalidate(p_installation_id uuid, p_registration_version integer)
returns text language plpgsql volatile set search_path = '' set row_security = off as $$
begin
  if p_installation_id is null or p_registration_version is null then
    return 'PUSH_INPUT_REQUIRED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(private.postona_push_lock_key('installation', p_installation_id::text));
  update private.postona_push_devices d
     set status = 'revoked', revoked_reason = 'provider_rejected', revoked_at = pg_catalog.clock_timestamp(), push_token = null, token_sha256 = null,
         registration_version = d.registration_version + 1, updated_at = pg_catalog.clock_timestamp()
   where d.installation_id = p_installation_id and d.registration_version = p_registration_version and d.status = 'active';
  return case when found then 'revoked' else 'unchanged' end;
end $$;

-- erase the tokens of rows that can never deliver again (delivery already refuses them; this removes the secret): the account / login gone
-- or being deleted, a newer generation, the session ended. Each condition is in its UPDATE's WHERE, so a row re-registered meanwhile is
-- re-checked on its new values. Not scheduled by this candidate.
create or replace function private.postona_push_devices_purge()
returns jsonb language plpgsql volatile set search_path = '' set row_security = off as $$
declare
  v_gone integer;
  v_stale integer;
  v_ended integer;
begin
  update private.postona_push_devices d
     set status = 'revoked', revoked_reason = 'account_gone', revoked_at = pg_catalog.clock_timestamp(), push_token = null, token_sha256 = null,
         registration_version = d.registration_version + 1, updated_at = pg_catalog.clock_timestamp()
   where d.status = 'active'
     and (not exists (select 1 from public.common_accounts a where a.user_id = d.user_id and a.status <> 'deleting')
          or not exists (select 1 from auth.users u where u.id = d.user_id)
          or exists (select 1 from private.account_lifecycle_operations o where o.user_id = d.user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress'));
  get diagnostics v_gone = row_count;
  update private.postona_push_devices d
     set status = 'revoked', revoked_reason = 'stale_generation', revoked_at = pg_catalog.clock_timestamp(), push_token = null, token_sha256 = null,
         registration_version = d.registration_version + 1, updated_at = pg_catalog.clock_timestamp()
   where d.status = 'active' and d.lifecycle_version is distinct from (select a.lifecycle_version from public.common_accounts a where a.user_id = d.user_id);
  get diagnostics v_stale = row_count;
  update private.postona_push_devices d
     set status = 'revoked', revoked_reason = 'session_ended', revoked_at = pg_catalog.clock_timestamp(), push_token = null, token_sha256 = null,
         registration_version = d.registration_version + 1, updated_at = pg_catalog.clock_timestamp()
   where d.status = 'active' and not private.postona_push_session_live(d.session_id, d.user_id);
  get diagnostics v_ended = row_count;
  return pg_catalog.jsonb_build_object('account_gone', v_gone, 'stale_generation', v_stale, 'session_ended', v_ended);
end $$;

revoke all on function private.postona_push_claims_session(), private.postona_push_writer_gate(), private.postona_push_session_live(uuid, uuid),
  private.postona_push_lock_key(text, text), private.postona_push_device_json(private.postona_push_devices, uuid, boolean),
  private.postona_push_delivery_targets(uuid, text), private.postona_push_device_invalidate(uuid, integer), private.postona_push_devices_purge(),
  public.postona_push_device_register(uuid, text, text, integer), public.postona_push_device_unregister(uuid), public.postona_push_device_list()
  from public, anon, authenticated, service_role;
grant execute on function public.postona_push_device_register(uuid, text, text, integer), public.postona_push_device_unregister(uuid),
  public.postona_push_device_list() to authenticated;

do $post$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_me text := pg_catalog.quote_ident(current_user);
  v_txt text;
begin
  -- the table: ours, row security on, no policy, no grant to anyone else
  if (select c.relowner = v_owner and c.relrowsecurity and c.relkind = 'r'
             and coalesce(pg_catalog.array_to_string(c.relacl::text[], ','), '') in ('', pg_catalog.format('%s=arwdDxtm/%s', v_me, v_me), pg_catalog.format('%s=arwdDxt/%s', v_me, v_me))
        from pg_catalog.pg_class c where c.oid = 'private.postona_push_devices'::pg_catalog.regclass) is not true
     or exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'private.postona_push_devices'::pg_catalog.regclass) then
    raise exception 'PUSH_POSTCONDITION_TABLE';
  end if;
  -- every function of ours: owned here, empty search path; exactly the three public RPCs are definers with EXECUTE for authenticated
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::text, ', ') into v_txt from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.proname like 'postona\_push\_%'
     and (p.proowner <> v_owner or not ('search_path=""' = any (p.proconfig))
          or p.prosecdef is distinct from (n.nspname = 'public')
          or pg_catalog.array_to_string(p.proacl::text[], ',') is distinct from
               case when n.nspname = 'public' then pg_catalog.format('%s=X/%s,authenticated=X/%s', v_me, v_me, v_me) else pg_catalog.format('%s=X/%s', v_me, v_me) end);
  if v_txt is not null then
    raise exception 'PUSH_POSTCONDITION_FUNCTION %', v_txt;
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and p.proname like 'postona\_push\_%') <> 11 then
    raise exception 'PUSH_POSTCONDITION_FUNCTION_COUNT';
  end if;
  -- no API role reaches the worker side: neither a MEMBER of a role that may EXECUTE a private function of ours, nor of the owner
  if exists (select 1 from pg_catalog.pg_roles a join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
              join pg_catalog.pg_proc p on p.pronamespace = 'private'::pg_catalog.regnamespace and p.proname like 'postona\_push\_%'
              where a.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') and (pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE') or r.oid = v_owner)) then
    raise exception 'PUSH_POSTCONDITION_API_ROLE_REACHES';
  end if;
end;
$post$;

commit;
