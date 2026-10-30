-- G5 SOURCE CANDIDATE (2026-10-30, Issue #320 G5-01 task 51). NOT applied anywhere. W0: the person's own first-run provisioning of the
-- personal workspace, so AI post assist no longer waits for the first X connection (G5-50 gap 2 / G6-26 F4).
-- Run it as the lifecycle owner (never a superuser) with ON_ERROR_STOP, AFTER MVP_INSTALL.sql. It creates ONE function, owner-only:
--   public.postona_ensure_my_personal_workspace() returns jsonb      (no argument: the person is the request's JWT, never an input)
-- MVP_W0_EXECUTE_GRANT.sql then gives it to `authenticated` (the same one-role pattern as R1-MVP); MVP_W0_EXECUTE_REVOKE.sql is the stop and
-- MVP_W0_ROLLBACK.sql removes it (MVP_ROLLBACK.sql refuses while W0 exists: W0 calls S2-2 and S2-3).
-- What it does, in one READ COMMITTED transaction of the caller:
--   1. S2-2 private.postona_personal_session(): the JWT claims (D1 strict: role authenticated, is_anonymous false, sub = auth.uid()) and the
--      auth.sessions row live. A refusal returns {"status": AUTH_REQUIRED | SESSION_REVOKED | SESSION_EXPIRED}; nothing is locked or written.
--   2. T13 private.account_lifecycle_assert_active_service_write(person, 'x_autopost'): READ COMMITTED, the same person again, the I1 locks
--      (login KEY SHARE, then the common account FOR UPDATE, held to commit: two calls of one person, and a call against a lifecycle change,
--      are serialized), the account active, POSTONA (x_autopost) started and active, the session live after the waits. Its own refusals
--      (42501 with a known message) are returned as {"status": <that message>}; any other error is raised unchanged.
--   3. S2-3 private.postona_personal_workspace_eligibility(person), under that lock:
--        own     -> {"status":"ready","workspace_id":"u_...","created":false}  (idempotent; nothing written)
--        absent  -> step 4, unless the person has ANY other membership: {"status":"OTHER_WORKSPACE_MEMBERSHIP"} (1 person / 1 workspace;
--                   shared and staff workspaces are outside the personal MVP, P-1)
--        other   -> {"status": OWN_WORKSPACE_CONFLICT | WORKSPACE_OWNER_UNKNOWN}; nothing written, nothing repaired
--   4. the same two rows the X OAuth begin RPC (20260919120000) creates: brands (u_<md5(user)[1..24]>, 'My Workspace', inactive, publish
--      disabled, social_mobile_user_v1) and brand_memberships (that id, the person, owner), each checked by RETURNING: if the brand insert
--      did not write (another writer took the derived id after step 3 -- H1 P2 F1, G5-02 task 1) W0 adds NO membership and answers
--      {"status":"OWN_WORKSPACE_CONFLICT"} with nothing written; the final S2-3 = own alone is never enough. Then S2-3 again in a fresh
--      statement: anything but own (a concurrent writer left another shape) undoes both inserts (a subtransaction), same answer.
--      A refusal writes nothing, so one more call is safe: if the other writer was the person's own begin RPC, it answers ready / created false.
-- X is NOT required: the workspace is inactive and publish-disabled exactly as the begin RPC leaves it; the begin RPC later finds it (one owned
-- brand) and adds the X account to it. No other table, setting, entitlement or lifecycle version is written; R1-MVP's g5pv:<lifecycle_version>
-- is unchanged by W0.
-- Owner (G6-26 F2, measured on the Supabase image 17.6.1.165): T13 locks the auth.users row, which needs UPDATE on auth.users, and every gate
-- reads auth tables with RLS enabled. The image's `postgres` holds them; it cannot GRANT schema USAGE on auth or UPDATE on auth.users to
-- another role (no grant option). The precondition below refuses an owner without them (W0_PRECONDITION_OWNER_AUTH).
-- Production NO_GO.
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_pin record;
  v_rel text;
  v_col text;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'W0_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if pg_catalog.to_regprocedure('public.postona_ensure_my_personal_workspace()') is not null then
    raise exception 'W0_PRECONDITION_EXISTS';
  end if;
  -- (G6-26 F2) what T13 and S2-2 need of the auth schema at RUN time: USAGE (checked alone first: every name lookup below needs it), the
  -- auth.users row lock (UPDATE on a column), auth.users / auth.sessions read, and every row (BYPASSRLS or the table owner). Without them W0
  -- (and every T13 caller) fails with "permission denied" on the first call.
  if not pg_catalog.has_schema_privilege(v_owner, 'auth', 'USAGE') then
    raise exception 'W0_PRECONDITION_OWNER_AUTH schema';
  end if;
  if not pg_catalog.has_any_column_privilege(v_owner, 'auth.users', 'UPDATE')
     or not pg_catalog.has_column_privilege(v_owner, 'auth.users', 'id', 'SELECT')
     or not pg_catalog.has_column_privilege(v_owner, 'auth.sessions', 'id', 'SELECT')
     or not pg_catalog.has_column_privilege(v_owner, 'auth.sessions', 'user_id', 'SELECT')
     or not pg_catalog.has_column_privilege(v_owner, 'auth.sessions', 'not_after', 'SELECT')
     or exists (select 1 from pg_catalog.pg_class c where c.oid in ('auth.users'::pg_catalog.regclass, 'auth.sessions'::pg_catalog.regclass)
                 and (c.relforcerowsecurity or (c.relrowsecurity and not pg_catalog.pg_has_role(v_owner, c.relowner, 'USAGE')
                                                and not (select r.rolbypassrls from pg_catalog.pg_roles r where r.oid = v_owner)))) then
    raise exception 'W0_PRECONDITION_OWNER_AUTH tables';
  end if;
  -- the three gates W0 calls: present, this owner's, exactly the reviewed bodies (S2-2 / T13 as MVP_INSTALL.sql pins them; S2-3 measured)
  for v_pin in select * from (values ('private.postona_personal_session()', 'a5d4d71c532847a8573e86a4bd0c791d'),
                                     ('private.account_lifecycle_assert_active_service_write(uuid,text)', '1f8cd9c764c251f3232c61b7a77ff597'),
                                     ('private.postona_personal_workspace_eligibility(uuid)', 'fa4623601fe2ef6efc38478c9f65105e')) g(sig, body) loop
    if pg_catalog.to_regprocedure(v_pin.sig) is null
       or not exists (select 1 from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(v_pin.sig) and p.proowner = v_owner and p.prosecdef
                        and pg_catalog.md5(p.prosrc) = v_pin.body
                        and pg_catalog.array_to_string(p.proacl::text[], ',') = pg_catalog.format('%s=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user))) then
      raise exception 'W0_PRECONDITION_GATE %', v_pin.sig;
    end if;
  end loop;
  -- the rows W0 writes: the columns exist, the owner may INSERT and SELECT them, and sees every row (RLS off, BYPASSRLS, or the table owner)
  for v_rel, v_col in select * from (values ('public.brands', 'id'), ('public.brands', 'display_name'), ('public.brands', 'is_active'),
                                            ('public.brands', 'publish_mode'), ('public.brands', 'code_profile_key'),
                                            ('public.brand_memberships', 'brand_id'), ('public.brand_memberships', 'user_id'),
                                            ('public.brand_memberships', 'role')) c(rel, col) loop
    if pg_catalog.to_regclass(v_rel) is null
       or not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = pg_catalog.to_regclass(v_rel) and a.attname = v_col and not a.attisdropped)
       or not pg_catalog.has_column_privilege(v_owner, v_rel, v_col, 'INSERT') or not pg_catalog.has_column_privilege(v_owner, v_rel, v_col, 'SELECT') then
      raise exception 'W0_PRECONDITION_RELATION %.%', v_rel, v_col;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_class c where c.oid in ('public.brands'::pg_catalog.regclass, 'public.brand_memberships'::pg_catalog.regclass)
              and (c.relforcerowsecurity or (c.relrowsecurity and c.relowner <> v_owner
                                             and not (select r.rolbypassrls from pg_catalog.pg_roles r where r.oid = v_owner)))) then
    raise exception 'W0_PRECONDITION_RLS_HIDES_ROWS';
  end if;
end $$;

create function public.postona_ensure_my_personal_workspace()
returns jsonb language plpgsql volatile security definer set search_path = '' set row_security = off as $$
declare
  v_session text;
  v_user uuid;
  v_workspace text;
  v_state text;
  v_brand_written boolean;
  v_member_written boolean;
begin
  -- 1. the person and the session (S2-2). A refusal takes no lock and writes nothing.
  v_session := private.postona_personal_session();
  if v_session is distinct from 'active' then
    return pg_catalog.jsonb_build_object('status', coalesce(v_session, 'AUTH_REQUIRED'));
  end if;
  v_user := (select auth.uid());

  -- 2. the POSTONA writer fence (T13): its locks are kept to commit when it passes; its own refusals are answered, anything else is raised
  begin
    perform private.account_lifecycle_assert_active_service_write(v_user, 'x_autopost');
  exception when insufficient_privilege then
    if sqlerrm in ('ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', 'ACCOUNT_DELETION_IN_PROGRESS', 'ACCOUNT_LOCKED',
                   'SERVICE_NOT_REGISTERED', 'SERVICE_DELETION_IN_PROGRESS', 'SERVICE_NOT_ACTIVE', 'ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE') then
      return pg_catalog.jsonb_build_object('status', sqlerrm);
    end if;
    raise;
  end;

  -- 3. the S2-3 facts, read under that lock in a fresh READ COMMITTED snapshot
  v_workspace := 'u_' || pg_catalog.substr(pg_catalog.md5(v_user::text), 1, 24);
  v_state := private.postona_personal_workspace_eligibility(v_user);
  if v_state = 'own' then
    return pg_catalog.jsonb_build_object('status', 'ready', 'workspace_id', v_workspace, 'created', false);
  end if;
  if v_state is distinct from 'absent' then
    return pg_catalog.jsonb_build_object('status', coalesce(v_state, 'OWN_WORKSPACE_CONFLICT'));
  end if;
  if exists (select 1 from public.brand_memberships m where m.user_id = v_user and m.brand_id <> v_workspace) then
    return pg_catalog.jsonb_build_object('status', 'OTHER_WORKSPACE_MEMBERSHIP');
  end if;

  -- 4. the begin RPC's two rows, BOTH written by this call or none: a row W0 did not write is never joined, changed or reported as created
  --    (G5-02 task 1, H1 P2 F1: another writer that takes the derived id after step 3 -- a backend as postgres / service_role, or the begin RPC --
  --    is refused here, whatever shape it left). Then S2-3 must answer own; otherwise both inserts are undone.
  begin
    insert into public.brands (id, display_name, is_active, publish_mode, code_profile_key)
    values (v_workspace, 'My Workspace', false, 'disabled', 'social_mobile_user_v1')
    on conflict (id) do nothing
    returning true into v_brand_written;
    if v_brand_written is not true then
      raise exception 'W0_POSTCONDITION_NOT_OWN';
    end if;
    insert into public.brand_memberships (brand_id, user_id, role)
    values (v_workspace, v_user, 'owner')
    on conflict on constraint brand_memberships_pkey do nothing
    returning true into v_member_written;
    if v_member_written is not true or private.postona_personal_workspace_eligibility(v_user) is distinct from 'own' then
      raise exception 'W0_POSTCONDITION_NOT_OWN';
    end if;
  exception when raise_exception then
    if sqlerrm = 'W0_POSTCONDITION_NOT_OWN' then
      return pg_catalog.jsonb_build_object('status', 'OWN_WORKSPACE_CONFLICT');
    end if;
    raise;
  end;
  return pg_catalog.jsonb_build_object('status', 'ready', 'workspace_id', v_workspace, 'created', true);
end $$;

revoke all on function public.postona_ensure_my_personal_workspace() from public, anon, authenticated, service_role;

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure := pg_catalog.to_regprocedure('public.postona_ensure_my_personal_workspace()');
begin
  if v_fn is null then
    raise exception 'W0_POSTCONDITION_MISSING';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from '3b3cc024c7816fa5e86a65e71f90060c' then
    raise exception 'W0_POSTCONDITION_BODY';
  end if;
  if (select p.proowner = v_owner and p.prosecdef and p.provolatile = 'v' and p.proconfig = array['search_path=""', 'row_security=off']
             and not p.proisstrict and not p.proleakproof and p.proparallel = 'u' and p.prokind = 'f' and not p.proretset
             and p.procost = 100 and p.prorows = 0 and p.prosupport::oid = 0 and p.prorettype = 'jsonb'::pg_catalog.regtype
             and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
             and p.pronargs = 0 and p.pronargdefaults = 0 and p.proargmodes is null and p.protrftypes is null and p.proargnames is null
        from pg_catalog.pg_proc p where p.oid = v_fn) is not true
     or (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn)
          is distinct from pg_catalog.format('%s=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user)) then
    raise exception 'W0_POSTCONDITION_SHAPE';
  end if;
  -- no API role reaches it before the grant: not by EXECUTE, not as a MEMBER (direct or indirect, INHERIT or not) of the owner
  if exists (select 1 from pg_catalog.pg_roles a where a.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
              and (pg_catalog.has_function_privilege(a.oid, v_fn, 'EXECUTE') or pg_catalog.pg_has_role(a.oid, v_owner, 'MEMBER'))) then
    raise exception 'W0_POSTCONDITION_API_ROLE_REACHES';
  end if;
end $$;

commit;
