-- G5 SOURCE CANDIDATE (2026-10-28, Issue #320 G5-01 task 47). NOT in supabase/migrations/, NOT applied anywhere. Part of the PERSONAL MVP
-- profile (../MVP_INSTALL.sql), after M10. Production NO_GO without the one bundled independent review of this profile (M10 + M20 + the stricter
-- P3 + the two verbatim slices), the G5 担当ちゃ's acceptance and the owner's explicit production approval.
--
-- R1-MVP public.common_account_authorization_verdict(text, text, text) -> jsonb         EXECUTE: the lifecycle owner ONLY in this file
--   The R1 v1 verdict for the personal MVP, WITHOUT the brand owner epoch (PR #285 / #303 / #457). Same name, signature, arguments and v1 wire as
--   the reviewed R1 (D1 body, bundle part 40): the subject is taken from the request's JWT only, with D1's strict claims (sub = auth.uid(), role
--   authenticated, a session_id, is_anonymous exactly the boolean false); the same reasons in the same order for the caller, the session, the
--   account and the x_autopost service. What differs is ONLY the workspace step and the token:
--     * the workspace must be the caller's PERSONAL one: the derived id 'u_' || substr(md5(user), 1, 24) and S2-3 'own' (exactly one membership,
--       the caller as owner, no other owned brand). Another id, an absent one -> BRAND_ACCESS_DENIED (same answer: no oracle); two owners ->
--       unknown WORKSPACE_OWNER_UNKNOWN; anything else S2-3 refuses -> deny OWN_WORKSPACE_CONFLICT;
--     * the generation coverage GC must hold, else unknown SERVICE_GENERATION_UNAVAILABLE;
--     * an allow carries owner_epoch = 'g5pv:' || lifecycle_version -- the PERSONAL GENERATION TOKEN (not an owner epoch; the field name is
--       the v1 wire's). lifecycle_version is moved only by P1's trigger (+1 on every account / entitlement change, GC-checked on every call),
--       so the token strictly increases per person and an old token never comes back.
--   An UNCHANGED G6 port (PR #500) refuses this allow (`OWNER_EPOCH_SHAPE`: it accepts only g5oe:...): fail-closed until G6 accepts g5pv
--   (docs/common-account/g5-47-postona-mvp-r1-personal-token.md). The reviewed R1 ACL (EXECUTE to authenticated, the G6 transport's role) is
--   NOT granted here: adopting it is a decision of the bundled review.
-- Rollback: RM20_personal_authorization_verdict_rollback.sql (refuses while anything calls it).
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'R1MVP_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  -- R1 exists only in the full profile (G5-42): the two profiles exclude each other
  if pg_catalog.to_regprocedure('public.common_account_authorization_verdict(text,text,text)') is not null then
    raise exception 'R1MVP_PRECONDITION_NAME_TAKEN';
  end if;
  foreach v_fn in array array['private.postona_personal_workspace_eligibility(uuid)', 'private.account_lifecycle_generation_covered()']::regprocedure[] loop
    if v_fn is null or not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.proowner = v_owner and p.prosecdef
                                     and p.proconfig @> array['search_path=""'] and p.proacl is not null)
       or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) x where p.oid = v_fn and x.grantee <> p.proowner) then
      raise exception 'R1MVP_PRECONDITION_DEPENDENCY %', v_fn;
    end if;
  end loop;
  if pg_catalog.to_regprocedure('auth.uid()') is null or pg_catalog.to_regclass('auth.users') is null or pg_catalog.to_regclass('auth.sessions') is null
     or pg_catalog.to_regclass('public.common_accounts') is null or pg_catalog.to_regclass('public.service_entitlements') is null
     or pg_catalog.to_regclass('private.account_lifecycle_operations') is null then
    raise exception 'R1MVP_PRECONDITION_RELATION';
  end if;
end $$;

create function public.common_account_authorization_verdict(p_app text, p_feature text, p_brand_id text)
returns jsonb language plpgsql stable security definer set search_path = '' set row_security = off as $$
declare
  v_scope jsonb := pg_catalog.jsonb_build_object('app', p_app, 'feature', p_feature, 'brand_slug', p_brand_id);
  v_claims jsonb;
  v_sub text;
  v_role text;
  v_session text;
  v_anonymous text;
  v_user uuid;
  v_session_id uuid;
  v_subject jsonb;
  v_session_ref text;
  -- the facts, one statement
  f_user_exists boolean;
  f_session_state text;
  f_account_status text;
  f_lifecycle bigint;
  f_account_deletion boolean;
  f_ent_status text;
  f_ent_deletion boolean;
  f_personal boolean;
  f_eligibility text;
  f_covered boolean;
begin
  -- 1. the subject: the request's JWT only, exactly as the reviewed R1 (D1): per-claim settings, else the JSON claims; is_anonymous must be the
  --    boolean false
  v_sub := nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '');
  if v_sub is not null then
    v_role := nullif(pg_catalog.current_setting('request.jwt.claim.role', true), '');
    v_session := nullif(pg_catalog.current_setting('request.jwt.claim.session_id', true), '');
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

  -- 2. the question, before any row is read (same order and answers as the reviewed R1)
  if p_app is distinct from 'postona'
     or p_feature is null or p_feature not in ('read_workspace', 'x_connect', 'x_publish', 'threads_connect', 'threads_publish', 'consult', 'post_generation') then
    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'FEATURE_NOT_ENABLED', 'scope', v_scope,
      'subject', coalesce(v_subject, pg_catalog.jsonb_build_object('kind', 'system')), 'session', null, 'owner_epoch', null, 'entitlements', '[]'::jsonb);
  end if;
  if p_brand_id is null or p_brand_id !~ '^[a-z][a-z0-9_-]{0,63}$' then
    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'BRAND_REQUIRED', 'scope', v_scope,
      'subject', coalesce(v_subject, pg_catalog.jsonb_build_object('kind', 'system')), 'session', null, 'owner_epoch', null, 'entitlements', '[]'::jsonb);
  end if;
  if v_user is null then
    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'AUTH_REQUIRED', 'scope', v_scope,
      'subject', pg_catalog.jsonb_build_object('kind', 'system'), 'session', null, 'owner_epoch', null, 'entitlements', '[]'::jsonb);
  end if;

  -- 3. every fact in ONE statement (STABLE: one snapshot): login, session, account, x_autopost, the personal workspace (S2-3) and GC. No owner
  --    epoch. S2-3 is asked only for the caller (a verified subject), and only when the asked id IS the caller's derived one.
  f_personal := p_brand_id = 'u_' || pg_catalog.substr(pg_catalog.md5(v_user::text), 1, 24);
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
         case when f_personal then private.postona_personal_workspace_eligibility(v_user) end,
         private.account_lifecycle_generation_covered()
    into f_user_exists, f_session_state, f_account_status, f_lifecycle, f_account_deletion, f_ent_status, f_ent_deletion, f_eligibility, f_covered
    from (select 1) x
    left join public.common_accounts a on a.user_id = v_user
    left join public.service_entitlements e on e.user_id = v_user and e.service_key = 'x_autopost';

  if not f_user_exists then
    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'AUTH_REQUIRED', 'scope', v_scope,
      'subject', v_subject, 'session', null, 'owner_epoch', null, 'entitlements', '[]'::jsonb);
  end if;
  -- the session reference is a hash: the raw session id never leaves this function (as the reviewed R1)
  v_session_ref := 's:' || pg_catalog.left(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('g5-session:' || v_session_id::text, 'UTF8')), 'hex'), 32);
  if f_session_state <> 'active' then
    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', case f_session_state when 'revoked' then 'SESSION_REVOKED' else 'SESSION_EXPIRED' end,
      'scope', v_scope, 'subject', v_subject, 'session', pg_catalog.jsonb_build_object('state', f_session_state, 'ref', v_session_ref),
      'owner_epoch', null, 'entitlements', '[]'::jsonb);
  end if;

  -- 4. the decision: the reviewed R1's order for the account and the service; then the personal workspace and GC; anything unexpected is
  --    unknown, never allow
  return case
    when f_account_status is null then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'ACCOUNT_NOT_FOUND')
    when f_lifecycle is null or f_lifecycle < 1 then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'unknown', 'reason', 'ACCOUNT_UNREADABLE')
    when f_account_deletion then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'ACCOUNT_DELETION_IN_PROGRESS')
    when f_account_status = 'locked' then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'ACCOUNT_LOCKED')
    when f_account_status <> 'active' then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'unknown', 'reason', 'ACCOUNT_STATE_UNKNOWN')
    when f_ent_status is null then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'SERVICE_NOT_REGISTERED')
    when f_ent_status = 'deleting' or f_ent_deletion then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'SERVICE_DELETION_IN_PROGRESS')
    when f_ent_status = 'provisioning' then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'pending', 'reason', 'SERVICE_PROVISIONING')
    when f_ent_status = 'suspended' then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'SERVICE_SUSPENDED')
    when f_ent_status = 'ended' then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'SERVICE_NOT_ACTIVE')
    when f_ent_status <> 'active' then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'unknown', 'reason', 'SERVICE_STATE_UNKNOWN')
    -- another id, or the caller's own id without a workspace: the same answer (no oracle)
    when not f_personal or f_eligibility is null or f_eligibility = 'absent' then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'BRAND_ACCESS_DENIED')
    when f_eligibility = 'WORKSPACE_OWNER_UNKNOWN' then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'unknown', 'reason', 'WORKSPACE_OWNER_UNKNOWN')
    when f_eligibility <> 'own' then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'OWN_WORKSPACE_CONFLICT')
    when f_covered is not true then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'unknown', 'reason', 'SERVICE_GENERATION_UNAVAILABLE')
    else
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'allow', 'reason', null)
  end || pg_catalog.jsonb_build_object('scope', v_scope, 'subject', v_subject)
      || case
           when f_account_status = 'active' and not f_account_deletion and f_ent_status = 'active' and not f_ent_deletion and f_personal
                and f_eligibility = 'own' and f_covered is true and f_lifecycle >= 1 then
             pg_catalog.jsonb_build_object('session', pg_catalog.jsonb_build_object('state', 'active', 'ref', v_session_ref),
               'owner_epoch', 'g5pv:' || f_lifecycle::text, 'entitlements', '["postona:x_autopost"]'::jsonb)
           else
             pg_catalog.jsonb_build_object('session', null, 'owner_epoch', null, 'entitlements', '[]'::jsonb)
         end;
end $$;

revoke all on function public.common_account_authorization_verdict(text, text, text) from public, anon, authenticated, service_role;

do $$
declare v_fn regprocedure := 'public.common_account_authorization_verdict(text,text,text)'::regprocedure;
begin
  if (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from pg_catalog.format('%s=X/%s', current_user, current_user)
     or exists (select 1 from pg_catalog.pg_roles a join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
                 where a.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') and pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE')) then
    raise exception 'R1MVP_POSTCONDITION_ACL';
  end if;
end $$;

commit;
