-- G5 SOURCE CANDIDATE (2026-10-24, Issue #320 G5-01 task 27, D1 of docs/common-account/g5-26-personal-claim-workspace-if-contract.md). NOT in
-- supabase/migrations/. Never apply to a managed or production database without an independent focused Codex Sol (high) review of this file, the
-- G5 担当ちゃ's acceptance and the owner's explicit production approval.
--
-- R1 (public.common_account_authorization_verdict), R0 (public.common_account_bootstrap_verdict) and SV (private.account_lifecycle_session_verdict),
-- the reviewed G5 candidates 001 / 002 / 003 (common_account_authorization_verdict, unchanged since ceb77ce4), read a MISSING, null or empty
-- `is_anonymous` claim as "not anonymous". T13 with S2-1 (PR #483, H4 PASS_SOURCE_FOCUSED) refuses it. This file makes the three agree with T13.
--
-- It REPLACES ONLY THE THREE FUNCTION BODIES (CREATE OR REPLACE: same OIDs, owner, ACL, definer, STABLE, settings), each the reviewed body with two
-- reading lines changed (and their comments): the per-claim setting must be exactly 'false', the JSON claim must be the boolean false. Anything else
-- leaves the subject unset, so the existing answer follows: R1 / R0 the v1 deny `AUTH_REQUIRED` (subject system), SV 'AUTH_REQUIRED'. No key,
-- reason, owner epoch, entitlement, row read, lock or ordering changes; the v1 wire stays byte for byte for every other input.
--
-- It refuses unless each body is EXACTLY the reviewed one (md5) and each function has the reviewed owner (the running role, not a superuser),
-- definer, STABLE, settings and ACL (R1 / R0: owner + authenticated; SV: owner only), and no API role is a member of the owner. Postconditions:
-- the same OIDs, the expected bodies, the same shape and ACL. It writes no row, creates no object, grants nothing.
-- Rollback: 002_verdicts_anonymous_strict_rollback.sql (the reviewed bodies, byte for byte).
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure;
  v_md5 text;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'D1_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  v_fn := pg_catalog.to_regprocedure('public.common_account_authorization_verdict(text,text,text)');
  if v_fn is null then
    raise exception 'D1_PRECONDITION_R1_MISSING';
  end if;
  v_md5 := (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn);
  if v_md5 = '7e84d9a2ecc53923d0c7846a4514dfdd' then
    raise exception 'D1_ALREADY_APPLIED';
  end if;
  if v_md5 is distinct from '781b00e342e29b709df967571922d27f' then
    raise exception 'D1_PRECONDITION_R1_BODY_NOT_REVIEWED';
  end if;
  -- owner, definer, STABLE, the reviewed settings (empty search_path, row_security off), the reviewed ACL, no API role reaching the owner
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner
     or not (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""', 'row_security=off']
               from pg_catalog.pg_proc p where p.oid = v_fn)
     or (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from pg_catalog.format('%s=X/%s,authenticated=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user))
     or exists (select 1 from pg_catalog.pg_roles r
                 where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') and pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER')) then
    raise exception 'D1_PRECONDITION_R1_SHAPE';
  end if;
  perform pg_catalog.set_config('postona_personal_d1.oid_r1', v_fn::oid::text, true);
  v_fn := pg_catalog.to_regprocedure('public.common_account_bootstrap_verdict(text,text)');
  if v_fn is null then
    raise exception 'D1_PRECONDITION_R0_MISSING';
  end if;
  v_md5 := (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn);
  if v_md5 = 'f3fb1fb4102b0cbf969145045e079318' then
    raise exception 'D1_ALREADY_APPLIED';
  end if;
  if v_md5 is distinct from 'e999adeb6cb877b2b3001501d58397a4' then
    raise exception 'D1_PRECONDITION_R0_BODY_NOT_REVIEWED';
  end if;
  -- owner, definer, STABLE, the reviewed settings (empty search_path, row_security off), the reviewed ACL, no API role reaching the owner
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner
     or not (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""', 'row_security=off']
               from pg_catalog.pg_proc p where p.oid = v_fn)
     or (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from pg_catalog.format('%s=X/%s,authenticated=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user))
     or exists (select 1 from pg_catalog.pg_roles r
                 where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') and pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER')) then
    raise exception 'D1_PRECONDITION_R0_SHAPE';
  end if;
  perform pg_catalog.set_config('postona_personal_d1.oid_r0', v_fn::oid::text, true);
  v_fn := pg_catalog.to_regprocedure('private.account_lifecycle_session_verdict()');
  if v_fn is null then
    raise exception 'D1_PRECONDITION_SV_MISSING';
  end if;
  v_md5 := (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn);
  if v_md5 = 'a5d4d71c532847a8573e86a4bd0c791d' then
    raise exception 'D1_ALREADY_APPLIED';
  end if;
  if v_md5 is distinct from '69840800118ab8d66ceabfa81fbc93dd' then
    raise exception 'D1_PRECONDITION_SV_BODY_NOT_REVIEWED';
  end if;
  -- owner, definer, STABLE, the reviewed settings (empty search_path, row_security off), the reviewed ACL, no API role reaching the owner
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner
     or not (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""', 'row_security=off']
               from pg_catalog.pg_proc p where p.oid = v_fn)
     or (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from pg_catalog.format('%s=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user))
     or exists (select 1 from pg_catalog.pg_roles r
                 where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') and pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER')) then
    raise exception 'D1_PRECONDITION_SV_SHAPE';
  end if;
  perform pg_catalog.set_config('postona_personal_d1.oid_sv', v_fn::oid::text, true);
  perform pg_catalog.set_config('postona_personal_d1.acl_r1',
    (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.common_account_authorization_verdict(text,text,text)')), true);
  perform pg_catalog.set_config('postona_personal_d1.acl_r0',
    (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.common_account_bootstrap_verdict(text,text)')), true);
  perform pg_catalog.set_config('postona_personal_d1.acl_sv',
    (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('private.account_lifecycle_session_verdict()')), true);
end $$;

-- the reviewed R1 / R0 / SV bodies with the strict is_anonymous reading (D1)
create or replace function public.common_account_authorization_verdict(p_app text, p_feature text, p_brand_id text)
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
  f_brand_found boolean;
  f_brand_kind text;
  f_caller_role text;
  f_owner uuid;
  f_owner_count bigint;
  f_epoch bigint;
begin
  -- 1. the subject: the request's JWT only (F5 P3b's sources: the per-claim settings of an older PostgREST, else the JSON claims) (I-1). No row is
  --    read here: settings and auth.uid() only.
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

  -- 2. the question, before any row is read (I-2): app, feature, brand id. The refusal names the caller only when the caller was accepted above.
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

  -- 3. every fact in ONE statement: the caller's login, session, account, x_autopost entitlement, the brand, the caller's role, the single owner and
  --    the owner epoch (I-4, I-5). Read as the lifecycle owner; nothing of another person is returned.
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
         private.account_lifecycle_brand_owner(b.id),
         (select pg_catalog.count(*) from public.brand_memberships o where o.brand_id = b.id and o.role = 'owner'),
         private.account_lifecycle_brand_owner_epoch(b.id)
    into f_user_exists, f_session_state, f_account_status, f_lifecycle, f_account_deletion, f_ent_status, f_ent_deletion,
         f_brand_found, f_brand_kind, f_caller_role, f_owner, f_owner_count, f_epoch
    from (select 1) x
    left join public.common_accounts a on a.user_id = v_user
    left join public.service_entitlements e on e.user_id = v_user and e.service_key = 'x_autopost'
    left join public.brands b on b.id = p_brand_id;

  if not f_user_exists then
    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'AUTH_REQUIRED', 'scope', v_scope,
      'subject', v_subject, 'session', null, 'owner_epoch', null, 'entitlements', '[]'::jsonb);
  end if;
  -- the session reference is a hash: the raw session id never leaves this function
  v_session_ref := 's:' || pg_catalog.left(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('g5-session:' || v_session_id::text, 'UTF8')), 'hex'), 32);
  if f_session_state <> 'active' then
    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', case f_session_state when 'revoked' then 'SESSION_REVOKED' else 'SESSION_EXPIRED' end,
      'scope', v_scope, 'subject', v_subject, 'session', pg_catalog.jsonb_build_object('state', f_session_state, 'ref', v_session_ref),
      'owner_epoch', null, 'entitlements', '[]'::jsonb);
  end if;

  -- 4. the decision, in the order of the reference (decide() in verdict.ts); anything unexpected is unknown, never allow (I-8)
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
    -- an unknown brand and a brand the caller is not a member of: the same answer (I-3)
    when not f_brand_found or f_caller_role is null then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'BRAND_ACCESS_DENIED')
    when f_caller_role <> 'owner' then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'ROLE_NOT_ALLOWED')
    when f_brand_kind is distinct from 'social_mobile_user_v1' then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'WORKSPACE_KIND_UNSUPPORTED')
    when f_owner_count <> 1 or f_owner is null then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'unknown', 'reason', 'WORKSPACE_OWNER_UNKNOWN')
    when f_owner <> v_user then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'BRAND_ACCESS_DENIED')
    when f_epoch is null or f_epoch < 1 then
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'unknown', 'reason', 'OWNER_EPOCH_UNAVAILABLE')
    else
      pg_catalog.jsonb_build_object('v', 1, 'decision', 'allow', 'reason', null)
  end || pg_catalog.jsonb_build_object('scope', v_scope, 'subject', v_subject)
      || case
           when f_account_status = 'active' and not f_account_deletion and f_ent_status = 'active' and not f_ent_deletion and f_brand_found
                and f_caller_role = 'owner' and f_brand_kind = 'social_mobile_user_v1' and f_owner_count = 1 and f_owner = v_user and f_epoch >= 1
                and f_lifecycle >= 1 then
             pg_catalog.jsonb_build_object('session', pg_catalog.jsonb_build_object('state', 'active', 'ref', v_session_ref),
               'owner_epoch', 'g5oe:' || f_epoch::text || ':' || f_lifecycle::text, 'entitlements', '["postona:x_autopost"]'::jsonb)
           else
             pg_catalog.jsonb_build_object('session', null, 'owner_epoch', null, 'entitlements', '[]'::jsonb)
         end;
end $$;

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

create or replace function private.account_lifecycle_session_verdict()
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

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure;
begin
  v_fn := pg_catalog.to_regprocedure('public.common_account_authorization_verdict(text,text,text)');
  if v_fn is null or v_fn::oid::text is distinct from pg_catalog.current_setting('postona_personal_d1.oid_r1', true) then
    raise exception 'D1_POSTCONDITION_R1_OID';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from '7e84d9a2ecc53923d0c7846a4514dfdd' then
    raise exception 'D1_POSTCONDITION_R1_BODY';
  end if;
  if not (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""', 'row_security=off'] and p.proowner = v_owner
            and pg_catalog.array_to_string(p.proacl::text[], ',') = pg_catalog.current_setting('postona_personal_d1.acl_r1', true)
            from pg_catalog.pg_proc p where p.oid = v_fn) then
    raise exception 'D1_POSTCONDITION_R1_SHAPE';
  end if;
  v_fn := pg_catalog.to_regprocedure('public.common_account_bootstrap_verdict(text,text)');
  if v_fn is null or v_fn::oid::text is distinct from pg_catalog.current_setting('postona_personal_d1.oid_r0', true) then
    raise exception 'D1_POSTCONDITION_R0_OID';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from 'f3fb1fb4102b0cbf969145045e079318' then
    raise exception 'D1_POSTCONDITION_R0_BODY';
  end if;
  if not (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""', 'row_security=off'] and p.proowner = v_owner
            and pg_catalog.array_to_string(p.proacl::text[], ',') = pg_catalog.current_setting('postona_personal_d1.acl_r0', true)
            from pg_catalog.pg_proc p where p.oid = v_fn) then
    raise exception 'D1_POSTCONDITION_R0_SHAPE';
  end if;
  v_fn := pg_catalog.to_regprocedure('private.account_lifecycle_session_verdict()');
  if v_fn is null or v_fn::oid::text is distinct from pg_catalog.current_setting('postona_personal_d1.oid_sv', true) then
    raise exception 'D1_POSTCONDITION_SV_OID';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from 'a5d4d71c532847a8573e86a4bd0c791d' then
    raise exception 'D1_POSTCONDITION_SV_BODY';
  end if;
  if not (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""', 'row_security=off'] and p.proowner = v_owner
            and pg_catalog.array_to_string(p.proacl::text[], ',') = pg_catalog.current_setting('postona_personal_d1.acl_sv', true)
            from pg_catalog.pg_proc p where p.oid = v_fn) then
    raise exception 'D1_POSTCONDITION_SV_SHAPE';
  end if;
end $$;

commit;
