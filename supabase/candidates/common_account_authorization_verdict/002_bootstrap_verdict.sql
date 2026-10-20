-- G5 SOURCE CANDIDATE (2026-10-20, Issue #320 G5-01 task 7). NOT in supabase/migrations/. Never apply to a managed or production database without
-- an independent focused Codex Sol (high) review of this file, the G5 担当ちゃ's acceptance and the owner's explicit production approval.
--
-- R0  public.common_account_bootstrap_verdict(p_app text, p_feature text) -> jsonb                                  EXECUTE: authenticated ONLY
--       The brand-less BOOTSTRAP verdict for the FIRST POSTONA X / Threads connection (contract: docs/common-account/g5-06-brandless-oauth-bootstrap.md
--       §4; reference: bootstrapVerdict() in supabase/candidates/common_account_postona_authz/bootstrap.ts, which the PG17 suite uses as the oracle).
--       It answers only "may this person START a connection now": R1's person checks (the subject from the JWT claims only -- the per-claim settings
--       of an older PostgREST, else request.jwt.claims; equal to auth.uid(); not anonymous; a live auth.sessions row), the common account and the
--       x_autopost entitlement; plus ONE fact about the person's own workspace, looked up by the id the SERVER derives from the subject with the rule
--       the begin RPC and the deletion saga use ('u_' || substr(md5(user), 1, 24)): absent, or exactly theirs (a user workspace whose single owner
--       is the caller). There is no brand and no person parameter. The answer is the G5-01 8-key wire without times, with scope.brand_slug null and
--       owner_epoch null; the Edge stamps the times (allow 60 s). An allow authorises ONLY the begin of that connection: R1 does not answer the
--       bootstrap features, a worker cannot bind to it (no owner epoch), and the code exchange stays behind R1 + a recheck.
--
-- STABLE, SECURITY DEFINER, empty search_path, owned by the lifecycle owner, read-only: no write, no row lock, no workspace, no OAuth state, no
-- grant beyond the one above. Installed after 001_authorization_verdict.sql (it does not depend on it; the two never call each other). The install
-- refuses unless the F5 chain and the owner-epoch candidate are installed (helpers STABLE / definer / owner-owned), no relation read has RLS FORCED
-- and PR #303's exposure check is clean; its postconditions check the exact ACL and the role graph (direct and indirect membership).
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn text;
  v_rel text;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'BOOTSTRAP_VERDICT_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if to_regprocedure('public.common_account_bootstrap_verdict(text,text)') is not null then
    raise exception 'BOOTSTRAP_VERDICT_ALREADY_APPLIED';
  end if;
  -- the helper this file calls (the exposure check) and auth.uid(): present; the helper STABLE, definer, empty search path, owned by this owner
  foreach v_fn in array array['private.account_lifecycle_owner_epoch_exposure()', 'auth.uid()'] loop
    if to_regprocedure(v_fn) is null then
      raise exception 'BOOTSTRAP_VERDICT_PRECONDITION_MISSING %', v_fn;
    end if;
  end loop;
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = 'private.account_lifecycle_owner_epoch_exposure()'::regprocedure
                  and p.provolatile = 's' and p.prosecdef and p.proconfig @> array['search_path=""'] and p.proowner = v_owner)
     or (select p.provolatile from pg_catalog.pg_proc p where p.oid = 'auth.uid()'::regprocedure) <> 's' then
    raise exception 'BOOTSTRAP_VERDICT_PRECONDITION_HELPER_SHAPE';
  end if;
  -- the relations read: readable by this owner, RLS not FORCED
  foreach v_rel in array array['public.common_accounts', 'public.service_entitlements', 'public.brands', 'public.brand_memberships',
                               'private.account_lifecycle_operations', 'auth.users', 'auth.sessions'] loop
    if to_regclass(v_rel) is null or not pg_catalog.has_table_privilege(v_owner, v_rel, 'SELECT') then
      raise exception 'BOOTSTRAP_VERDICT_PRECONDITION_RELATION %', v_rel;
    end if;
    if (select c.relforcerowsecurity from pg_catalog.pg_class c where c.oid = to_regclass(v_rel)) then
      raise exception 'BOOTSTRAP_VERDICT_PRECONDITION_RLS_FORCED %', v_rel;
    end if;
  end loop;
  if (select count(*) from pg_catalog.pg_attribute a where a.attrelid = 'auth.sessions'::regclass and not a.attisdropped
       and ((a.attname = 'id' and a.atttypid = 'uuid'::regtype) or (a.attname = 'user_id' and a.atttypid = 'uuid'::regtype)
         or (a.attname = 'not_after' and a.atttypid = 'timestamptz'::regtype))) <> 3 then
    raise exception 'BOOTSTRAP_VERDICT_PRECONDITION_SESSIONS_SHAPE';
  end if;
  -- the derivation must be the one the deletion saga names (main 20260928160000:98-100), so R0 and the begin / deletion paths agree on the id
  if to_regprocedure('public.social_mobile_account_deletion_workspace(uuid)') is null
     or public.social_mobile_account_deletion_workspace('00000000-0000-4000-8000-000000000001'::uuid)
        is distinct from 'u_' || pg_catalog.substr(pg_catalog.md5('00000000-0000-4000-8000-000000000001'), 1, 24) then
    raise exception 'BOOTSTRAP_VERDICT_PRECONDITION_WORKSPACE_DERIVATION';
  end if;
  if private.account_lifecycle_owner_epoch_exposure() is not null then
    raise exception 'BOOTSTRAP_VERDICT_PRECONDITION_%', private.account_lifecycle_owner_epoch_exposure();
  end if;
end $$;

-- R0: the brand-less bootstrap verdict.
create function public.common_account_bootstrap_verdict(p_app text, p_feature text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
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

revoke all on function public.common_account_bootstrap_verdict(text, text) from public, anon, authenticated, service_role;
grant execute on function public.common_account_bootstrap_verdict(text, text) to authenticated;

-- Postconditions: the exact ACL, the shape, the role graph (every role an API role is a MEMBER of; authenticator reaching the API roles is PostgREST's
-- role switch), and the exposure check.
do $$
declare
  v_owner text := quote_ident(current_user);
  v_r0 regprocedure := 'public.common_account_bootstrap_verdict(text,text)'::regprocedure;
begin
  if (select array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_r0) is distinct from format('%s=X/%s,authenticated=X/%s', v_owner, v_owner, v_owner) then
    raise exception 'BOOTSTRAP_VERDICT_POSTCONDITION_ACL';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_r0 and p.provolatile = 's' and p.prosecdef and p.proconfig @> array['search_path=""']
                  and p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)) then
    raise exception 'BOOTSTRAP_VERDICT_POSTCONDITION_SHAPE';
  end if;
  if exists (select 1 from pg_catalog.pg_roles a join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
              where a.rolname in ('anon', 'service_role') and pg_catalog.has_function_privilege(r.oid, v_r0, 'EXECUTE'))
     or exists (select 1 from pg_catalog.pg_roles a join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
              where a.rolname = 'authenticator' and r.rolname not in ('authenticator', 'anon', 'authenticated', 'service_role')
                and pg_catalog.has_function_privilege(r.oid, v_r0, 'EXECUTE')) then
    raise exception 'BOOTSTRAP_VERDICT_POSTCONDITION_API_ROLE_REACHES';
  end if;
  if private.account_lifecycle_owner_epoch_exposure() is not null then
    raise exception 'BOOTSTRAP_VERDICT_POSTCONDITION_EXPOSURE';
  end if;
end $$;

commit;
