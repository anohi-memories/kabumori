-- G5 SOURCE CANDIDATE (2026-10-21, Issue #320 G5-01 task 10). NOT in supabase/migrations/. Never apply to a managed or production database without
-- an independent focused Codex Sol (high) review of this file, the G5 担当ちゃ's acceptance and the owner's explicit production approval.
--
-- SV  private.account_lifecycle_session_verdict() -> text                                          EXECUTE: the lifecycle owner ONLY (no grant)
--       The SESSION-ONLY verdict (contract: docs/common-account/g5-09-session-verdict-interface.md §4; reference: sessionVerdict() in
--       supabase/candidates/common_account_postona_authz/session_verdict.ts, which the PG17 suite uses as the oracle). It answers only "is this
--       request made by a signed-in, non-anonymous person whose session is live right now": R1's subject stage (the claims only -- the per-claim
--       settings of an older PostgREST, else request.jwt.claims; sub and session_id uuids; role authenticated; not anonymous; sub = auth.uid()),
--       then the login and the auth.sessions row by id AND user_id with not_after in the future. Nothing about the common account, an entitlement
--       or a brand: a person-facing read / stop (G3's reservation receipt / cancel, P7 of G3 PR #392) keeps working after a service ended.
--       -> 'active' | 'AUTH_REQUIRED' | 'SESSION_REVOKED' | 'SESSION_EXPIRED'. An unreadable fact RAISES (never 'active').
--       No parameter: there is no user id, session id or brand to pass.
--
-- STABLE, SECURITY DEFINER, empty search_path, row_security = off, owned by the lifecycle owner, read-only: no write, no row lock, no grant. A
-- consumer is a reviewed function owned by the same owner (or one given a separately reviewed grant later), which calls it FIRST and touches no row
-- unless it answered 'active'. Independent of 001 / 002 (it calls neither). The install refuses unless auth.uid() and PR #303's exposure check are
-- present, both relations read (auth.users, auth.sessions) are tables whose EVERY row this owner sees (G5-08: RLS off, BYPASSRLS, or the table
-- owner's privileges with RLS not FORCED), auth.sessions has the expected shape and the exposure check is clean; its postconditions check the exact
-- ACL and that no API role reaches it over the role graph.
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_rel text;
  v_kind "char";
  v_rls boolean;
  v_forced boolean;
  v_relowner oid;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'SESSION_VERDICT_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if to_regprocedure('private.account_lifecycle_session_verdict()') is not null then
    raise exception 'SESSION_VERDICT_ALREADY_APPLIED';
  end if;
  if to_regnamespace('private') is null or not pg_catalog.has_schema_privilege(v_owner, 'private', 'CREATE') then
    raise exception 'SESSION_VERDICT_PRECONDITION_SCHEMA';
  end if;
  -- auth.uid() (STABLE) and PR #303's exposure check (STABLE, definer, empty search path, owned by this owner)
  if to_regprocedure('auth.uid()') is null or (select p.provolatile from pg_catalog.pg_proc p where p.oid = 'auth.uid()'::regprocedure) <> 's' then
    raise exception 'SESSION_VERDICT_PRECONDITION_HELPER_SHAPE auth.uid()';
  end if;
  if to_regprocedure('private.account_lifecycle_owner_epoch_exposure()') is null
     or not exists (select 1 from pg_catalog.pg_proc p where p.oid = 'private.account_lifecycle_owner_epoch_exposure()'::regprocedure
                     and p.provolatile = 's' and p.prosecdef and p.proconfig @> array['search_path=""'] and p.proowner = v_owner) then
    raise exception 'SESSION_VERDICT_PRECONDITION_HELPER_SHAPE private.account_lifecycle_owner_epoch_exposure()';
  end if;
  -- the relations read: plain tables this owner may SELECT, with EVERY row visible to it (G5-08). A hidden row can only turn 'active' into a
  -- refusal here (allow needs the session row), but install and call apply the same rule as R0 / R1, and the call runs with row_security = off.
  foreach v_rel in array array['auth.users', 'auth.sessions'] loop
    select c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relowner into v_kind, v_rls, v_forced, v_relowner
      from pg_catalog.pg_class c where c.oid = to_regclass(v_rel);
    if not found or v_kind not in ('r', 'p') or not pg_catalog.has_table_privilege(v_owner, v_rel, 'SELECT') then
      raise exception 'SESSION_VERDICT_PRECONDITION_RELATION %', v_rel;
    end if;
    if v_forced then
      raise exception 'SESSION_VERDICT_PRECONDITION_RLS_FORCED %', v_rel;
    end if;
    if v_rls and not (select r.rolbypassrls from pg_catalog.pg_roles r where r.oid = v_owner) and not pg_catalog.pg_has_role(v_owner, v_relowner, 'USAGE') then
      raise exception 'SESSION_VERDICT_PRECONDITION_RLS_HIDES_ROWS %', v_rel;
    end if;
  end loop;
  if (select count(*) from pg_catalog.pg_attribute a where a.attrelid = 'auth.sessions'::regclass and not a.attisdropped
       and ((a.attname = 'id' and a.atttypid = 'uuid'::regtype) or (a.attname = 'user_id' and a.atttypid = 'uuid'::regtype)
         or (a.attname = 'not_after' and a.atttypid = 'timestamptz'::regtype))) <> 3 then
    raise exception 'SESSION_VERDICT_PRECONDITION_SESSIONS_SHAPE';
  end if;
  if private.account_lifecycle_owner_epoch_exposure() is not null then
    raise exception 'SESSION_VERDICT_PRECONDITION_%', private.account_lifecycle_owner_epoch_exposure();
  end if;
end $$;

-- SV: the session-only verdict.
create function private.account_lifecycle_session_verdict()
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
    v_anonymous := coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.is_anonymous', true), ''), 'false');
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
      v_anonymous := coalesce(nullif((v_claims -> 'is_anonymous')::text, 'null'), 'false');
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

revoke all on function private.account_lifecycle_session_verdict() from public, anon, authenticated, service_role;

-- Postconditions: the exact ACL (the owner only), the shape, and the role graph: no API role is a MEMBER (direct or indirect, INHERIT or not, SET or
-- not) of a role that may EXECUTE it, and no non-superuser role but the owner's own may.
do $$
declare
  v_owner text := quote_ident(current_user);
  v_sv regprocedure := 'private.account_lifecycle_session_verdict()'::regprocedure;
begin
  if (select array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_sv) is distinct from format('%s=X/%s', v_owner, v_owner) then
    raise exception 'SESSION_VERDICT_POSTCONDITION_ACL';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_sv and p.provolatile = 's' and p.prosecdef
                  and p.proconfig @> array['search_path=""', 'row_security=off'] and p.pronargs = 0
                  and p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)) then
    raise exception 'SESSION_VERDICT_POSTCONDITION_SHAPE';
  end if;
  if exists (select 1 from pg_catalog.pg_roles a join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
              where a.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') and pg_catalog.has_function_privilege(r.oid, v_sv, 'EXECUTE')) then
    raise exception 'SESSION_VERDICT_POSTCONDITION_API_ROLE_REACHES';
  end if;
  if exists (select 1 from pg_catalog.pg_roles r
              where not r.rolsuper and pg_catalog.has_function_privilege(r.oid, v_sv, 'EXECUTE')
                and not pg_catalog.pg_has_role(r.oid, (select o.oid from pg_catalog.pg_roles o where o.rolname = current_user), 'USAGE')) then
    raise exception 'SESSION_VERDICT_POSTCONDITION_OTHER_ROLE_EXECUTES';
  end if;
  if private.account_lifecycle_owner_epoch_exposure() is not null then
    raise exception 'SESSION_VERDICT_POSTCONDITION_EXPOSURE';
  end if;
end $$;

commit;
