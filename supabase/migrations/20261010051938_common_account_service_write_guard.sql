-- SOURCE CANDIDATE ONLY. NOT applied to production. Independent review is mandatory before any apply;
-- apply as a single reviewed file (never db push), after the Phase 1 foundation (20261001150000).
--
-- Common account Phase 3b (G5): the shared service-write guard, NOT WIRED.
--
-- One internal function, private.account_lifecycle_assert_active_service_write(p_user_id, p_service_key),
-- that a reviewed, owner-controlled SECURITY DEFINER writer of a service (POSTONA's X / Threads
-- connection RPCs, a future Kabumori profile writer) calls FIRST in its own transaction, before it
-- writes anything (contract: docs/postona/threads-g5-t9-t10-t13-shared-contract-20261010.md, T13;
-- design and limits: docs/common-account/phase3b-identity-writer-fence-feasibility.md). It returns
-- nothing when the write may proceed and raises a fixed code otherwise, keeping the locks it took until
-- the caller's transaction ends:
--
--   * the caller is the person: an 'authenticated' JWT whose subject equals p_user_id and auth.uid(),
--     with a session id that is still a live row of auth.sessions (read, never locked);
--   * lock order I1, as every lifecycle RPC: the login row KEY SHARE, the common account FOR UPDATE,
--     then the service entitlement FOR UPDATE;
--   * the account is 'active' with no open account deletion; the entitlement exists, is 'active' and
--     has no open service deletion. Nothing is created: a missing account or entitlement is a refusal.
--   * READ COMMITTED only (I6); anything unknown or unreadable fails closed.
--
-- What this file does NOT do: it changes no existing object, policy, grant or row. No writer calls the
-- guard yet, so nothing that runs today behaves differently. It grants EXECUTE to nobody: only its owner
-- (the role that owns the lifecycle and the service writers) can call it, so it is reachable only from
-- inside such a writer. It does not fence Supabase Auth: identity links, sign-ins and token refreshes
-- happen in GoTrue, not here, and the managed Auth delete stays behind the Phase 3a release gate
-- (state 'blocked'). It writes nothing to auth, Storage or Vault.
--
-- Codes (message text, SQLSTATE 42501): ACCOUNT_LIFECYCLE_AUTH_REQUIRED, ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND,
-- ACCOUNT_DELETION_IN_PROGRESS, ACCOUNT_LOCKED, SERVICE_NOT_REGISTERED, SERVICE_DELETION_IN_PROGRESS,
-- SERVICE_NOT_ACTIVE, ACCOUNT_LIFECYCLE_SERVICE_INVALID, ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE.

begin;

do $$
begin
  if to_regprocedure('private.account_lifecycle_lock(uuid,boolean,boolean)') is null
     or to_regclass('public.common_accounts') is null
     or to_regclass('public.service_entitlements') is null
     or to_regclass('private.account_lifecycle_operations') is null
     or to_regprocedure('auth.uid()') is null then
    raise exception 'COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_FOUNDATION_MISSING';
  end if;
  if exists (select 1 from pg_proc p where p.proname = 'account_lifecycle_assert_active_service_write') then
    raise exception 'COMMON_ACCOUNT_WRITE_GUARD_ALREADY_APPLIED';
  end if;
  -- The lifecycle lock must still be reachable by this owner and by no API role (Phase 1 ACL).
  if not has_function_privilege(current_user, 'private.account_lifecycle_lock(uuid,boolean,boolean)', 'EXECUTE')
     or not has_function_privilege(current_user, 'auth.uid()', 'EXECUTE')
     or exists (select 1 from pg_roles r
                 where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                   and has_function_privilege(r.oid, 'private.account_lifecycle_lock(uuid,boolean,boolean)', 'EXECUTE')) then
    raise exception 'COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_LOCK_ACL_CHANGED';
  end if;
  -- auth.sessions as GoTrue creates it: id, user_id and not_after, readable by this owner.
  if to_regclass('auth.sessions') is null
     or (select count(*) from pg_attribute a
          where a.attrelid = to_regclass('auth.sessions') and not a.attisdropped
            and ((a.attname = 'id' and a.atttypid = 'uuid'::regtype)
              or (a.attname = 'user_id' and a.atttypid = 'uuid'::regtype)
              or (a.attname = 'not_after' and a.atttypid = 'timestamptz'::regtype))) <> 3 then
    raise exception 'COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_AUTH_SESSIONS_SHAPE';
  end if;
  if not has_table_privilege(current_user, 'auth.sessions', 'SELECT') then
    raise exception 'COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_AUTH_SESSIONS_UNREADABLE';
  end if;
end;
$$;

create function private.account_lifecycle_assert_active_service_write(p_user_id uuid, p_service_key text)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_legacy_sub text := nullif(current_setting('request.jwt.claim.sub', true), '');
  v_claims jsonb;
  v_sub text;
  v_role text;
  v_session text;
  v_subject uuid;
  v_session_id uuid;
  v_account public.common_accounts;
  v_status text;
  v_live boolean;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE' using errcode = '42501';
  end if;
  if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then
    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID' using errcode = '42501';
  end if;

  -- 1. The person, from the one claim source auth.uid() reads first: the per-claim settings of an
  --    older PostgREST when present, else the JSON claims. Never p_user_id alone.
  if v_legacy_sub is not null then
    v_sub := v_legacy_sub;
    v_role := nullif(current_setting('request.jwt.claim.role', true), '');
    v_session := nullif(current_setting('request.jwt.claim.session_id', true), '');
  else
    begin
      v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    exception when others then
      v_claims := null;
    end;
    if jsonb_typeof(v_claims) = 'object' then
      v_sub := v_claims ->> 'sub';
      v_role := v_claims ->> 'role';
      v_session := v_claims ->> 'session_id';
    end if;
  end if;
  begin
    v_subject := v_sub::uuid;
    v_session_id := v_session::uuid;
  exception when others then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end;
  if p_user_id is null or v_subject is null or v_session_id is null or v_role is distinct from 'authenticated'
     or v_subject <> p_user_id or (select auth.uid()) is distinct from p_user_id then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end if;

  -- 2. I1 lock order: login KEY SHARE -> account FOR UPDATE (the lifecycle lock), then the entitlement.
  --    Nothing is created. Every read below is a fresh READ COMMITTED snapshot taken after the waits.
  v_account := private.account_lifecycle_lock(p_user_id, false);
  if v_account.user_id is null then
    raise exception 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND' using errcode = '42501';
  end if;
  if v_account.status = 'deleting'
     or exists (select 1 from private.account_lifecycle_operations o
                 where o.user_id = p_user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress') then
    raise exception 'ACCOUNT_DELETION_IN_PROGRESS' using errcode = '42501';
  end if;
  if v_account.status <> 'active' then
    raise exception 'ACCOUNT_LOCKED' using errcode = '42501';
  end if;
  select e.status into v_status from public.service_entitlements e
   where e.user_id = p_user_id and e.service_key = p_service_key
   for update;
  if not found then
    raise exception 'SERVICE_NOT_REGISTERED' using errcode = '42501';
  end if;
  if v_status = 'deleting'
     or exists (select 1 from private.account_lifecycle_operations o
                 where o.user_id = p_user_id and o.operation_type = 'service_deletion'
                   and o.service_key = p_service_key and o.status = 'in_progress') then
    raise exception 'SERVICE_DELETION_IN_PROGRESS' using errcode = '42501';
  end if;
  if v_status <> 'active' then
    raise exception 'SERVICE_NOT_ACTIVE' using errcode = '42501';
  end if;

  -- 3. The session is still live, read after the locks: a logout or revocation that committed while
  --    this waited is seen. Read only; GoTrue owns these rows and nothing here locks them.
  begin
    v_live := exists (select 1 from auth.sessions s
                       where s.id = v_session_id and s.user_id = p_user_id
                         and (s.not_after is null or s.not_after > clock_timestamp()));
  exception when undefined_table or undefined_column or insufficient_privilege then
    raise exception 'ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE' using errcode = '42501';
  end;
  if not v_live then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.account_lifecycle_assert_active_service_write(uuid, text) from public, anon, authenticated, service_role;

-- Postcondition: the owner alone holds EXECUTE, and no API role reaches it through a membership.
do $$
declare
  v_fn regprocedure := 'private.account_lifecycle_assert_active_service_write(uuid,text)'::regprocedure;
begin
  if (select array_to_string(p.proacl::text[], ',') from pg_proc p where p.oid = v_fn)
       is distinct from format('%s=X/%s', quote_ident(current_user), quote_ident(current_user))
     or exists (select 1 from pg_roles r
                 where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                   and (has_function_privilege(r.oid, v_fn, 'EXECUTE') or pg_has_role(r.oid, current_user, 'USAGE'))) then
    raise exception 'COMMON_ACCOUNT_WRITE_GUARD_POSTCONDITION_ACL';
  end if;
end;
$$;

commit;
