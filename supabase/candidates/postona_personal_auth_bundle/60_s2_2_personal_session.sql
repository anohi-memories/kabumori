-- G5 SOURCE CANDIDATE (2026-10-25, Issue #320 G5-01 task 34, S2-2 of docs/common-account/g5-32-personal-workspace-session-consumer-matrix.md §5).
-- NOT in supabase/migrations/. Never apply to a managed or production database without an independent focused Codex Sol (high) review of this
-- file, the G5 担当ちゃ's acceptance and the owner's explicit production approval.
--
-- S2-2 private.postona_personal_session() -> text                                            EXECUTE: the lifecycle owner ONLY (no grant)
--      The person-session gate for person-facing reads and stops (G3's cancel / receipt / readback; #463, #466): "is this request made by a
--      signed-in, non-anonymous person whose session is live right now". Its body is SV's (private.account_lifecycle_session_verdict) as D1
--      leaves it (PR #494), BYTE FOR BYTE (md5 a5d4d71c532847a8573e86a4bd0c791d): the same claim source and priority, a proven `is_anonymous` false
--      only, role authenticated, sub = auth.uid(), the login, and the auth.sessions row by id AND user_id with not_after null or in the future.
--      -> 'active' | 'AUTH_REQUIRED' | 'SESSION_REVOKED' | 'SESSION_EXPIRED'. A consumer acts only on exactly 'active' (`is distinct from 'active'`
--      refuses, so a NULL refuses too); an unreadable fact raises.
--      What differs from SV is ONLY the install: it does not need the owner-epoch exposure helper (SV's 003 install requires
--      private.account_lifecycle_owner_epoch_exposure(), part of the PR #285 / #303 / #457 chain whose independent review is still open), so a
--      consumer can adopt it without that chain. Nothing about the common account, an entitlement, a brand, an owner epoch, a ban or a sign-out
--      scope is read: those stay with R1 / T13 / W1, and the ban / sign-out meanings are the user's open decisions (P-3, P-4).
--      STABLE, SECURITY DEFINER, empty search_path, row_security = off, read-only, no lock, no parameter.
--
-- Not changed: SV, R0, R1, T13, W1, the S2-3 predicate, any migration. It writes no row and grants nothing.
-- Rollback: 004_s2_2_personal_session_rollback.sql (drops it; refuses while another function's body names it).
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure := pg_catalog.to_regprocedure('private.postona_personal_session()');
  v_rel text;
  v_kind "char";
  v_rls boolean;
  v_forced boolean;
  v_relowner oid;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'S22_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if v_fn is not null then
    if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn) = 'a5d4d71c532847a8573e86a4bd0c791d' then
      raise exception 'S22_ALREADY_APPLIED';
    end if;
    raise exception 'S22_PRECONDITION_NAME_TAKEN';
  end if;
  if pg_catalog.to_regnamespace('private') is null or not pg_catalog.has_schema_privilege(v_owner, 'private', 'CREATE') then
    raise exception 'S22_PRECONDITION_SCHEMA';
  end if;
  -- auth.uid() present and STABLE (the body compares the claims' sub with it). NO owner-epoch helper is required: that is the point of S2-2.
  if pg_catalog.to_regprocedure('auth.uid()') is null
     or (select p.provolatile from pg_catalog.pg_proc p where p.oid = 'auth.uid()'::pg_catalog.regprocedure) is distinct from 's' then
    raise exception 'S22_PRECONDITION_AUTH_UID';
  end if;
  -- the relations read: plain tables this owner may SELECT, with EVERY row visible to it (G5-08: RLS off, BYPASSRLS, or the table owner's
  -- privileges with RLS not FORCED); the call also runs with row_security = off, so a later filter raises instead of hiding a session row
  foreach v_rel in array array['auth.users', 'auth.sessions'] loop
    select c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relowner into v_kind, v_rls, v_forced, v_relowner
      from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass(v_rel);
    if not found or v_kind not in ('r', 'p') or not pg_catalog.has_table_privilege(v_owner, v_rel, 'SELECT') then
      raise exception 'S22_PRECONDITION_RELATION %', v_rel;
    end if;
    if v_forced then
      raise exception 'S22_PRECONDITION_RLS_FORCED %', v_rel;
    end if;
    if v_rls and not (select r.rolbypassrls from pg_catalog.pg_roles r where r.oid = v_owner) and not pg_catalog.pg_has_role(v_owner, v_relowner, 'USAGE') then
      raise exception 'S22_PRECONDITION_RLS_HIDES_ROWS %', v_rel;
    end if;
  end loop;
  if (select pg_catalog.count(*) from pg_catalog.pg_attribute a where a.attrelid = 'auth.sessions'::pg_catalog.regclass and not a.attisdropped
       and ((a.attname = 'id' and a.atttypid = 'uuid'::pg_catalog.regtype) or (a.attname = 'user_id' and a.atttypid = 'uuid'::pg_catalog.regtype)
         or (a.attname = 'not_after' and a.atttypid = 'timestamptz'::pg_catalog.regtype))) <> 3
     or (select pg_catalog.count(*) from pg_catalog.pg_attribute a where a.attrelid = 'auth.users'::pg_catalog.regclass and not a.attisdropped
       and a.attname = 'id' and a.atttypid = 'uuid'::pg_catalog.regtype) <> 1 then
    raise exception 'S22_PRECONDITION_AUTH_SHAPE';
  end if;
end $$;

-- S2-2: the person-session gate (SV's D1 body, byte for byte)
create function private.postona_personal_session()
returns text language plpgsql stable security definer set search_path = '' set row_security = off as $$
declare
  v_claims jsonb;
  v_sub text;
  v_role text;
  v_session text;
  v_anonymous text;
  v_user uuid;
  v_session_id uuid;
  f_user_exists boolean;
  f_session_state text;
begin
  -- 1. the subject: the request's JWT only, exactly as R1 (settings and auth.uid() only; no row is read)
  v_sub := nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '');
  if v_sub is not null then
    v_role := nullif(pg_catalog.current_setting('request.jwt.claim.role', true), '');
    v_session := nullif(pg_catalog.current_setting('request.jwt.claim.session_id', true), '');
    -- (D1, G5-27) the per-claim setting must be exactly 'false': missing or empty is not proof (as T13, PR #483)
    v_anonymous := nullif(pg_catalog.current_setting('request.jwt.claim.is_anonymous', true), '');
  else
    begin
      v_claims := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
    exception when others then
      v_claims := null;
    end;
    if pg_catalog.jsonb_typeof(v_claims) = 'object' then
      v_sub := v_claims ->> 'sub';
      v_role := v_claims ->> 'role';
      v_session := v_claims ->> 'session_id';
      -- (D1, G5-27) only the JSON boolean false is not anonymous; absent, null, another type or true is refused (as T13, PR #483)
      v_anonymous := case when pg_catalog.jsonb_typeof(v_claims -> 'is_anonymous') = 'boolean' then v_claims ->> 'is_anonymous' end;
    end if;
  end if;
  if v_sub ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and v_session ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and v_role = 'authenticated' and v_anonymous = 'false' then
    if (select auth.uid()) is not distinct from v_sub::uuid then
      v_user := v_sub::uuid;
      v_session_id := v_session::uuid;
    end if;
  end if;
  if v_user is null then
    return 'AUTH_REQUIRED';
  end if;

  -- 2. the login and the session, in ONE statement: the row by id AND user_id (another person's session is no session), not_after in the future
  select exists (select 1 from auth.users u where u.id = v_user),
         (select case when s.id is null then 'revoked'
                      when s.not_after is null or s.not_after > pg_catalog.clock_timestamp() then 'active' else 'expired' end
            from (select 1) x left join auth.sessions s on s.id = v_session_id and s.user_id = v_user)
    into f_user_exists, f_session_state;

  if not f_user_exists then
    return 'AUTH_REQUIRED';
  end if;
  return case f_session_state when 'active' then 'active' when 'revoked' then 'SESSION_REVOKED' when 'expired' then 'SESSION_EXPIRED' end;
end $$;

revoke all on function private.postona_personal_session() from public, anon, authenticated, service_role;

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure := pg_catalog.to_regprocedure('private.postona_personal_session()');
begin
  if v_fn is null then
    raise exception 'S22_POSTCONDITION_MISSING';
  end if;
  -- the expected body, owner, every attribute (G5-28 / G5-29 baseline, `is not true` from G5-31), the owner-only ACL, the role graph
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from 'a5d4d71c532847a8573e86a4bd0c791d' then
    raise exception 'S22_POSTCONDITION_BODY';
  end if;
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner
     or (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""', 'row_security=off']
                and not p.proisstrict and not p.proleakproof and p.proparallel = 'u' and p.prokind = 'f' and not p.proretset
                and p.procost = 100 and p.prorows = 0 and p.prosupport::oid = 0 and p.prorettype = 'text'::pg_catalog.regtype
                and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
                and p.pronargs = 0 and p.pronargdefaults = 0 and p.proargmodes is null and p.protrftypes is null and p.proargnames is null
           from pg_catalog.pg_proc p where p.oid = v_fn) is not true
     or (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn)
          is distinct from pg_catalog.format('%s=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user)) then
    raise exception 'S22_POSTCONDITION_SHAPE';
  end if;
  -- no API role reaches it: neither a MEMBER (direct or indirect, INHERIT or not) of a role that may EXECUTE it, nor of the owner
  if exists (select 1 from pg_catalog.pg_roles a join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
              where a.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') and (pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE') or r.oid = v_owner)) then
    raise exception 'S22_POSTCONDITION_API_ROLE_REACHES';
  end if;
  -- and no other non-superuser role may EXECUTE it
  if exists (select 1 from pg_catalog.pg_roles r
              where not r.rolsuper and pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE') and not pg_catalog.pg_has_role(r.oid, v_owner, 'USAGE')) then
    raise exception 'S22_POSTCONDITION_OTHER_ROLE_EXECUTES';
  end if;
end $$;

commit;
