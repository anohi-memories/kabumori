-- Rollback of 003_s2_3_workspace_eligibility.sql (G5-33, S2-3). Puts back R0's D1 body BYTE FOR BYTE (CREATE OR REPLACE: same OID, owner, ACL,
-- attributes) and drops the predicate. It refuses unless R0 is exactly the S2-3 body and the predicate exactly the installed one (another body
-- or shape is someone else's change and is left alone), with the same shape checks as the install. Run R0 first, so nothing calls the predicate
-- when it goes. After it, R0 answers as D1 again (C4 / C5 / a shared own workspace / an orphan membership are allowed again). It writes no row.
--
-- G5-37 REVISION (2026-10-25, Issue #320 task 37, F-2 of G5-36): after R0 is restored and BEFORE the drop, it refuses while anything else still
-- uses the predicate, so the whole transaction rolls back and R0 and the predicate stay exactly as they were:
--   S23_ROLLBACK_PRECONDITION_CALLERS     another function's source text names it (PL/pgSQL / plain SQL bodies; PL/pgSQL calls are not recorded
--                                         as dependencies). Compared in lower case: an unquoted name may be written in any case.
--   S23_ROLLBACK_PRECONDITION_DEPENDENTS  a recorded dependency on it (a view, a SQL-standard BEGIN ATOMIC body, a default ...): stated before
--                                         PostgreSQL's own DROP ... RESTRICT would stop it anyway.
-- What it CANNOT see: a name assembled at run time (dynamic SQL), a caller in another database, or callers outside the database (Edge / app).
-- Those consumers must be removed first, by procedure; this check is a fence for the reachable cases, not a complete call graph.
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure;
  v_md5 text;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'S23_ROLLBACK_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  v_fn := pg_catalog.to_regprocedure('public.common_account_bootstrap_verdict(text,text)');
  if v_fn is null then
    raise exception 'S23_ROLLBACK_PRECONDITION_R0_MISSING';
  end if;
  v_md5 := (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn);
  if v_md5 = 'f3fb1fb4102b0cbf969145045e079318' then
    raise exception 'S23_ROLLBACK_NOT_APPLIED';
  end if;
  if v_md5 is distinct from '3e89fcff1a3232ef794cdf0483a75130' then
    raise exception 'S23_ROLLBACK_PRECONDITION_R0_BODY_NOT_REVIEWED';
  end if;
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner
     or (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""', 'row_security=off']
                and not p.proisstrict and not p.proleakproof and p.proparallel = 'u' and p.prokind = 'f' and not p.proretset
                and p.procost = 100 and p.prorows = 0 and p.prosupport::oid = 0 and p.prorettype = 'jsonb'::pg_catalog.regtype
                and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
                and p.pronargdefaults = 0 and p.proargmodes is null and p.protrftypes is null
                and p.proargnames is not distinct from array['p_app', 'p_feature']::text[]
           from pg_catalog.pg_proc p where p.oid = v_fn) is not true
     or (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from pg_catalog.format('%s=X/%s,authenticated=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user))
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') and pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER')) then
    raise exception 'S23_ROLLBACK_PRECONDITION_R0_SHAPE';
  end if;
  perform pg_catalog.set_config('postona_personal_s23.oid_r0', v_fn::oid::text, true);
  v_fn := pg_catalog.to_regprocedure('private.postona_personal_workspace_eligibility(uuid)');
  if v_fn is null or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from 'fa4623601fe2ef6efc38478c9f65105e' then
    raise exception 'S23_ROLLBACK_PRECONDITION_PREDICATE_BODY';
  end if;
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner
     or (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""', 'row_security=off']
                and not p.proisstrict and not p.proleakproof and p.proparallel = 'u' and p.prokind = 'f' and not p.proretset
                and p.procost = 100 and p.prorows = 0 and p.prosupport::oid = 0 and p.prorettype = 'text'::pg_catalog.regtype
                and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
                and p.pronargdefaults = 0 and p.proargmodes is null and p.protrftypes is null
                and p.proargnames is not distinct from array['p_user']::text[]
           from pg_catalog.pg_proc p where p.oid = v_fn) is not true
     or (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from pg_catalog.format('%s=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user))
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') and pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER')) then
    raise exception 'S23_ROLLBACK_PRECONDITION_PREDICATE_SHAPE';
  end if;
end $$;

-- R0: the D1 body, byte for byte
create or replace function public.common_account_bootstrap_verdict(p_app text, p_feature text)
returns jsonb language plpgsql stable security definer set search_path = '' set row_security = off as $$
declare
  v_scope jsonb := pg_catalog.jsonb_build_object('app', p_app, 'feature', p_feature, 'brand_slug', null);
  v_claims jsonb;
  v_sub text;
  v_role text;
  v_session text;
  v_anonymous text;
  v_user uuid;
  v_session_id uuid;
  v_subject jsonb;
  v_session_ref text;
  v_workspace text;
  -- the facts, one statement
  f_user_exists boolean;
  f_session_state text;
  f_account_status text;
  f_lifecycle bigint;
  f_account_deletion boolean;
  f_ent_status text;
  f_ent_deletion boolean;
  f_ws_found boolean;
  f_ws_kind text;
  f_caller_role text;
  f_owner uuid;
  f_owner_count bigint;
  v_person jsonb;
begin
  -- 1. the question, before anything else: only the two bootstrap features of POSTONA (no brand parameter exists)
  if p_app is distinct from 'postona' or p_feature is null or p_feature not in ('x_connect_bootstrap', 'threads_connect_bootstrap') then
    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'FEATURE_NOT_ENABLED', 'scope', v_scope,
      'subject', pg_catalog.jsonb_build_object('kind', 'system'), 'session', null, 'owner_epoch', null, 'entitlements', '[]'::jsonb);
  end if;

  -- 2. the subject: the request's JWT only, exactly as R1 (settings and auth.uid() only; no row is read)
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
      v_subject := pg_catalog.jsonb_build_object('kind', 'user', 'user_id', v_user);
    end if;
  end if;
  if v_user is null then
    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'AUTH_REQUIRED', 'scope', v_scope,
      'subject', pg_catalog.jsonb_build_object('kind', 'system'), 'session', null, 'owner_epoch', null, 'entitlements', '[]'::jsonb);
  end if;

  -- 3. the person's own workspace id, derived on the server from the verified subject (never from the request)
  v_workspace := 'u_' || pg_catalog.substr(pg_catalog.md5(v_user::text), 1, 24);

  -- 4. every fact in ONE statement: the caller's login, session, account, x_autopost entitlement and the own workspace (kind, the caller's role,
  --    the owner count, the single owner). Read as the lifecycle owner; nothing of another person is returned.
  select exists (select 1 from auth.users u where u.id = v_user),
         (select case when s.id is null then 'revoked'
                      when s.not_after is null or s.not_after > pg_catalog.clock_timestamp() then 'active' else 'expired' end
            from (select 1) x left join auth.sessions s on s.id = v_session_id and s.user_id = v_user),
         a.status, a.lifecycle_version,
         (a.status = 'deleting' or exists (select 1 from private.account_lifecycle_operations o
                                            where o.user_id = v_user and o.operation_type = 'account_deletion' and o.status = 'in_progress')),
         e.status,
         exists (select 1 from private.account_lifecycle_operations o
                  where o.user_id = v_user and o.operation_type = 'service_deletion' and o.service_key = 'x_autopost' and o.status = 'in_progress'),
         b.id is not null, b.code_profile_key,
         (select m.role from public.brand_memberships m where m.brand_id = b.id and m.user_id = v_user),
         (select case when pg_catalog.count(*) = 1 then (pg_catalog.array_agg(m.user_id))[1] end
            from public.brand_memberships m where m.brand_id = b.id and m.role = 'owner'),
         (select pg_catalog.count(*) from public.brand_memberships o where o.brand_id = b.id and o.role = 'owner')
    into f_user_exists, f_session_state, f_account_status, f_lifecycle, f_account_deletion, f_ent_status, f_ent_deletion,
         f_ws_found, f_ws_kind, f_caller_role, f_owner, f_owner_count
    from (select 1) x
    left join public.common_accounts a on a.user_id = v_user
    left join public.service_entitlements e on e.user_id = v_user and e.service_key = 'x_autopost'
    left join public.brands b on b.id = v_workspace;

  if not f_user_exists then
    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'AUTH_REQUIRED', 'scope', v_scope,
      'subject', v_subject, 'session', null, 'owner_epoch', null, 'entitlements', '[]'::jsonb);
  end if;
  v_session_ref := 's:' || pg_catalog.left(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('g5-session:' || v_session_id::text, 'UTF8')), 'hex'), 32);
  if f_session_state <> 'active' then
    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', case f_session_state when 'revoked' then 'SESSION_REVOKED' else 'SESSION_EXPIRED' end,
      'scope', v_scope, 'subject', v_subject, 'session', pg_catalog.jsonb_build_object('state', f_session_state, 'ref', v_session_ref),
      'owner_epoch', null, 'entitlements', '[]'::jsonb);
  end if;

  -- 5. the person checks (R1's order), then the own-workspace rule; anything unexpected is unknown, never allow
  v_person := case
    when f_account_status is null then pg_catalog.jsonb_build_object('decision', 'deny', 'reason', 'ACCOUNT_NOT_FOUND')
    when f_lifecycle is null or f_lifecycle < 1 then pg_catalog.jsonb_build_object('decision', 'unknown', 'reason', 'ACCOUNT_UNREADABLE')
    when f_account_deletion then pg_catalog.jsonb_build_object('decision', 'deny', 'reason', 'ACCOUNT_DELETION_IN_PROGRESS')
    when f_account_status = 'locked' then pg_catalog.jsonb_build_object('decision', 'deny', 'reason', 'ACCOUNT_LOCKED')
    when f_account_status <> 'active' then pg_catalog.jsonb_build_object('decision', 'unknown', 'reason', 'ACCOUNT_STATE_UNKNOWN')
    when f_ent_status is null then pg_catalog.jsonb_build_object('decision', 'deny', 'reason', 'SERVICE_NOT_REGISTERED')
    when f_ent_status = 'deleting' or f_ent_deletion then pg_catalog.jsonb_build_object('decision', 'deny', 'reason', 'SERVICE_DELETION_IN_PROGRESS')
    when f_ent_status = 'provisioning' then pg_catalog.jsonb_build_object('decision', 'pending', 'reason', 'SERVICE_PROVISIONING')
    when f_ent_status = 'suspended' then pg_catalog.jsonb_build_object('decision', 'deny', 'reason', 'SERVICE_SUSPENDED')
    when f_ent_status = 'ended' then pg_catalog.jsonb_build_object('decision', 'deny', 'reason', 'SERVICE_NOT_ACTIVE')
    when f_ent_status <> 'active' then pg_catalog.jsonb_build_object('decision', 'unknown', 'reason', 'SERVICE_STATE_UNKNOWN')
    -- the own workspace: absent, or exactly the caller's; a workspace under the derived id that is not is never joined
    when not f_ws_found then null
    when f_ws_kind is distinct from 'social_mobile_user_v1' then pg_catalog.jsonb_build_object('decision', 'deny', 'reason', 'OWN_WORKSPACE_CONFLICT')
    when f_owner_count <> 1 or f_owner is null then pg_catalog.jsonb_build_object('decision', 'unknown', 'reason', 'WORKSPACE_OWNER_UNKNOWN')
    when f_owner <> v_user or f_caller_role is distinct from 'owner' then pg_catalog.jsonb_build_object('decision', 'deny', 'reason', 'OWN_WORKSPACE_CONFLICT')
    else null
  end;
  if v_person is not null then
    return pg_catalog.jsonb_build_object('v', 1, 'scope', v_scope, 'subject', v_subject, 'session', null, 'owner_epoch', null, 'entitlements', '[]'::jsonb) || v_person;
  end if;
  return pg_catalog.jsonb_build_object('v', 1, 'decision', 'allow', 'reason', null, 'scope', v_scope, 'subject', v_subject,
    'session', pg_catalog.jsonb_build_object('state', 'active', 'ref', v_session_ref), 'owner_epoch', null, 'entitlements', '["postona:x_autopost"]'::jsonb);
end $$;

-- (G5-37) nothing else may still use the predicate (checked AFTER R0 is restored: R0's S2-3 body itself names it)
do $$
declare
  v_fn regprocedure := pg_catalog.to_regprocedure('private.postona_personal_workspace_eligibility(uuid)');
begin
  if exists (select 1 from pg_catalog.pg_proc p
              where p.oid <> v_fn and pg_catalog.strpos(pg_catalog.lower(p.prosrc), 'postona_personal_workspace_eligibility') > 0) then
    raise exception 'S23_ROLLBACK_PRECONDITION_CALLERS';
  end if;
  if exists (select 1 from pg_catalog.pg_depend d where d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.refobjid = v_fn) then
    raise exception 'S23_ROLLBACK_PRECONDITION_DEPENDENTS';
  end if;
end $$;

drop function private.postona_personal_workspace_eligibility(uuid);

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure;
begin
  if pg_catalog.to_regprocedure('private.postona_personal_workspace_eligibility(uuid)') is not null then
    raise exception 'S23_ROLLBACK_POSTCONDITION_PREDICATE_LEFT';
  end if;
  v_fn := pg_catalog.to_regprocedure('public.common_account_bootstrap_verdict(text,text)');
  if v_fn is null or v_fn::oid::text is distinct from pg_catalog.current_setting('postona_personal_s23.oid_r0', true) then
    raise exception 'S23_ROLLBACK_POSTCONDITION_R0_OID';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from 'f3fb1fb4102b0cbf969145045e079318' then
    raise exception 'S23_ROLLBACK_POSTCONDITION_R0_BODY';
  end if;
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner
     or (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""', 'row_security=off']
                and not p.proisstrict and not p.proleakproof and p.proparallel = 'u' and p.prokind = 'f' and not p.proretset
                and p.procost = 100 and p.prorows = 0 and p.prosupport::oid = 0 and p.prorettype = 'jsonb'::pg_catalog.regtype
                and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
                and p.pronargdefaults = 0 and p.proargmodes is null and p.protrftypes is null
                and p.proargnames is not distinct from array['p_app', 'p_feature']::text[]
           from pg_catalog.pg_proc p where p.oid = v_fn) is not true
     or (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from pg_catalog.format('%s=X/%s,authenticated=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user))
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') and pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER')) then
    raise exception 'S23_ROLLBACK_POSTCONDITION_R0_SHAPE';
  end if;
end $$;

commit;
