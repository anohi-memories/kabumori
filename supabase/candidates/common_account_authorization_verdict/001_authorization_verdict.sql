-- G5 SOURCE CANDIDATE (2026-10-19, Issue #320 G5-01 task 3). NOT in supabase/migrations/. Never apply to a managed or production database without
-- an independent focused Codex Sol (high) review of this file, the G5 担当ちゃ's acceptance and the owner's explicit production approval.
--
-- The G5 authorization verdict for POSTONA, as SQL (contract: docs/common-account/g5-02-authorization-verdict-rpc-preflight.md §3-§4; wire:
-- docs/common-account/g5-01-postona-entitlement-auth-boundary.md §4; reference: supabase/candidates/common_account_postona_authz/):
--
--   R1  public.common_account_authorization_verdict(p_app text, p_feature text, p_brand_id text) -> jsonb       EXECUTE: authenticated ONLY
--         the person's verdict: the 8-key wire WITHOUT times (the Edge stamps them). The subject is the request's JWT (per-claim settings, else
--         request.jwt.claims; equal to auth.uid(); not anonymous); there is no identity parameter. App / feature / brand id are refused before
--         any row is read. Every fact is read in ONE statement (one snapshot). An unknown brand and a brand the caller is not a member of give
--         the same answer; no other person's id or role, no owner id, no raw session id is ever returned. No exception is caught into a value.
--   W1  private.account_lifecycle_worker_brand_verdict(p_brand_id, p_service_key, p_expected_owner_epoch, p_expected_lifecycle_version) -> text
--         owner-only. A worker's answer for a reservation / attestation bound earlier: F5 P5's brand state, the F5 owner epoch EQUAL to the bound one,
--         and the owner's lifecycle_version EQUAL to the bound one ('active' or a fixed code). lifecycle_version is the service GENERATION: F5 P1's
--         row trigger moves it on every insert / update / delete of the owner's entitlements and on every account status change, and it never goes
--         back -- so a service ended and re-started after the bind (even inside one transaction, or a long one: no clock is compared) is a new
--         generation (H1 C1 P2 of PR #351). The bound pair is what R1's allow token `g5oe:<epoch>:<lifecycle_version>` carries. For a reviewed SQL
--         writer of another owner, inside its statement.
--   W2  public.common_account_worker_brand_verdict(...same...) -> text                                            EXECUTE: service_role ONLY
--         W1 for an Edge worker's last check right before the provider. Never callable by a person.
--
-- All three are STABLE, SECURITY DEFINER, empty search_path, owned by the lifecycle owner, read-only: no write, no row lock, no table, no grant
-- beyond the two above. The install refuses unless the F5 chain (P1..P10) and the owner-epoch candidate (PR #303) are installed, every helper is
-- STABLE / definer / owner-owned, no relation read has RLS FORCED, and PR #303's exposure check is clean (no API role reaches the owner, a
-- superuser, TRIGGER, session_replication_role, ...). Its postconditions check the ACL over the role graph (direct and indirect membership).
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn text;
  v_rel text;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'AUTH_VERDICT_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if to_regprocedure('public.common_account_authorization_verdict(text,text,text)') is not null
     or to_regprocedure('private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)') is not null
     or to_regprocedure('public.common_account_worker_brand_verdict(text,text,bigint,bigint)') is not null then
    raise exception 'AUTH_VERDICT_ALREADY_APPLIED';
  end if;
  -- the helpers this file calls: present, STABLE, definer with an empty search path, owned by this owner
  foreach v_fn in array array['private.account_lifecycle_brand_owner(text)', 'private.account_lifecycle_brand_owner_epoch(text)',
                              'private.account_lifecycle_owner_epoch_exposure()', 'public.common_account_brand_service_state(text,text)', 'auth.uid()'] loop
    if to_regprocedure(v_fn) is null then
      raise exception 'AUTH_VERDICT_PRECONDITION_MISSING %', v_fn;
    end if;
    if v_fn <> 'auth.uid()' and not exists (select 1 from pg_catalog.pg_proc p where p.oid = to_regprocedure(v_fn)
                    and p.provolatile = 's' and p.prosecdef and p.proconfig @> array['search_path=""'] and p.proowner = v_owner) then
      raise exception 'AUTH_VERDICT_PRECONDITION_HELPER_SHAPE %', v_fn;
    end if;
  end loop;
  if (select p.provolatile from pg_catalog.pg_proc p where p.oid = 'auth.uid()'::regprocedure) <> 's' then
    raise exception 'AUTH_VERDICT_PRECONDITION_HELPER_SHAPE auth.uid()';
  end if;
  -- the relations read: readable by this owner, RLS not FORCED (the owner reads past RLS only when it is not forced)
  foreach v_rel in array array['public.common_accounts', 'public.service_entitlements', 'public.brands', 'public.brand_memberships',
                               'private.account_lifecycle_operations', 'auth.users', 'auth.sessions'] loop
    if to_regclass(v_rel) is null or not pg_catalog.has_table_privilege(v_owner, v_rel, 'SELECT') then
      raise exception 'AUTH_VERDICT_PRECONDITION_RELATION %', v_rel;
    end if;
    if (select c.relforcerowsecurity from pg_catalog.pg_class c where c.oid = to_regclass(v_rel)) then
      raise exception 'AUTH_VERDICT_PRECONDITION_RLS_FORCED %', v_rel;
    end if;
  end loop;
  if (select count(*) from pg_catalog.pg_attribute a where a.attrelid = 'auth.sessions'::regclass and not a.attisdropped
       and ((a.attname = 'id' and a.atttypid = 'uuid'::regtype) or (a.attname = 'user_id' and a.atttypid = 'uuid'::regtype)
         or (a.attname = 'not_after' and a.atttypid = 'timestamptz'::regtype))) <> 3 then
    raise exception 'AUTH_VERDICT_PRECONDITION_SESSIONS_SHAPE';
  end if;
  -- the service generation W1 compares: F5 P1's lifecycle_version triggers, present, enabled and pointing at their functions
  if not exists (select 1 from pg_catalog.pg_trigger g where g.tgrelid = 'public.service_entitlements'::regclass and g.tgname = 'account_lifecycle_touch_entitlement'
                  and g.tgenabled in ('O', 'A') and g.tgtype = 29 and g.tgfoid = 'private.account_lifecycle_touch_entitlement()'::regprocedure)
     or not exists (select 1 from pg_catalog.pg_trigger g where g.tgrelid = 'public.common_accounts'::regclass and g.tgname = 'account_lifecycle_touch_account'
                  and g.tgenabled in ('O', 'A') and g.tgfoid = 'private.account_lifecycle_touch_account()'::regprocedure) then
    raise exception 'AUTH_VERDICT_PRECONDITION_LIFECYCLE_TRIGGERS';
  end if;
  -- PR #303's exposure check: no API role reaches the owner, a superuser, TRIGGER, session_replication_role or a membership write
  if private.account_lifecycle_owner_epoch_exposure() is not null then
    raise exception 'AUTH_VERDICT_PRECONDITION_%', private.account_lifecycle_owner_epoch_exposure();
  end if;
end $$;

-- R1: the person's verdict.
create function public.common_account_authorization_verdict(p_app text, p_feature text, p_brand_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
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
      -- absent or JSON null = not anonymous; anything but the JSON boolean false is anonymous
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

-- W1: the worker's answer for a reservation / attestation bound earlier. The bind is the pair (owner epoch, owner lifecycle_version) -- both
-- monotonic counters, compared for EQUALITY in one statement; no timestamp is trusted.
create function private.account_lifecycle_worker_brand_verdict(p_brand_id text, p_service_key text, p_expected_owner_epoch bigint, p_expected_lifecycle_version bigint)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_state text;
  v_epoch bigint;
  v_lifecycle bigint;
begin
  if p_service_key is distinct from 'x_autopost' then
    return 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  if p_expected_owner_epoch is null or p_expected_owner_epoch < 1 then
    return 'EXPECTED_OWNER_EPOCH_REQUIRED';
  end if;
  if p_expected_lifecycle_version is null or p_expected_lifecycle_version < 1 then
    return 'EXPECTED_LIFECYCLE_VERSION_REQUIRED';
  end if;
  -- one statement: F5 P5's state, the owner epoch and the owner's lifecycle_version (the service generation)
  select public.common_account_brand_service_state(p_brand_id, p_service_key),
         private.account_lifecycle_brand_owner_epoch(p_brand_id),
         (select a.lifecycle_version from public.common_accounts a where a.user_id = private.account_lifecycle_brand_owner(p_brand_id))
    into v_state, v_epoch, v_lifecycle;
  if v_state is distinct from 'active' then
    return case when v_state in ('WORKSPACE_OWNER_UNKNOWN', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', 'ACCOUNT_DELETION_IN_PROGRESS', 'ACCOUNT_LOCKED',
                                 'SERVICE_NOT_REGISTERED', 'SERVICE_DELETION_IN_PROGRESS', 'SERVICE_NOT_ACTIVE', 'ACCOUNT_LIFECYCLE_SERVICE_INVALID')
                then v_state else 'SERVICE_STATE_UNKNOWN' end;
  end if;
  if v_epoch is null or v_epoch < 1 then
    return 'OWNER_EPOCH_UNAVAILABLE';
  end if;
  if v_epoch <> p_expected_owner_epoch then
    return 'OWNER_EPOCH_CHANGED';
  end if;
  -- null-safe: an unreadable generation is a changed one (P5 'active' implies the account row, so NULL is not expected here)
  if v_lifecycle is distinct from p_expected_lifecycle_version then
    return 'SERVICE_GENERATION_CHANGED';
  end if;
  return 'active';
end $$;

-- W2: W1 for an Edge worker (service_role).
create function public.common_account_worker_brand_verdict(p_brand_id text, p_service_key text, p_expected_owner_epoch bigint, p_expected_lifecycle_version bigint)
returns text language sql stable security definer set search_path = '' as $$
  select private.account_lifecycle_worker_brand_verdict(p_brand_id, p_service_key, p_expected_owner_epoch, p_expected_lifecycle_version)
$$;

revoke all on function public.common_account_authorization_verdict(text, text, text),
  private.account_lifecycle_worker_brand_verdict(text, text, bigint, bigint),
  public.common_account_worker_brand_verdict(text, text, bigint, bigint) from public, anon, authenticated, service_role;
grant execute on function public.common_account_authorization_verdict(text, text, text) to authenticated;
grant execute on function public.common_account_worker_brand_verdict(text, text, bigint, bigint) to service_role;

-- Postconditions: the exact ACL, the shape, and the role graph -- every role an API role is a MEMBER of (direct or indirect, INHERIT or not,
-- SET or not, ADMIN-only) is checked with its own privileges. authenticator reaching authenticated / service_role is PostgREST's role switch.
do $$
declare
  v_owner text := quote_ident(current_user);
  v_r1 regprocedure := 'public.common_account_authorization_verdict(text,text,text)'::regprocedure;
  v_w1 regprocedure := 'private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)'::regprocedure;
  v_w2 regprocedure := 'public.common_account_worker_brand_verdict(text,text,bigint,bigint)'::regprocedure;
  v_fn regprocedure;
  v_allowed text;
begin
  if (select array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_r1) is distinct from format('%s=X/%s,authenticated=X/%s', v_owner, v_owner, v_owner)
     or (select array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_w2) is distinct from format('%s=X/%s,service_role=X/%s', v_owner, v_owner, v_owner)
     or (select array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_w1) is distinct from format('%s=X/%s', v_owner, v_owner) then
    raise exception 'AUTH_VERDICT_POSTCONDITION_ACL';
  end if;
  foreach v_fn in array array[v_r1, v_w1, v_w2] loop
    if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.provolatile = 's' and p.prosecdef and p.proconfig @> array['search_path=""']
                    and p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)) then
      raise exception 'AUTH_VERDICT_POSTCONDITION_SHAPE %', v_fn;
    end if;
    v_allowed := case v_fn when v_r1 then 'authenticated' when v_w2 then 'service_role' else null end;
    if exists (select 1 from pg_catalog.pg_roles a join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
                where a.rolname in ('anon', 'authenticated', 'service_role')
                  and a.rolname is distinct from v_allowed
                  and pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE')) then
      raise exception 'AUTH_VERDICT_POSTCONDITION_API_ROLE_REACHES %', v_fn;
    end if;
    if exists (select 1 from pg_catalog.pg_roles a join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
                where a.rolname = 'authenticator' and r.rolname not in ('authenticator', 'anon', 'authenticated', 'service_role')
                  and pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE')) then
      raise exception 'AUTH_VERDICT_POSTCONDITION_API_ROLE_REACHES %', v_fn;
    end if;
  end loop;
  if private.account_lifecycle_owner_epoch_exposure() is not null then
    raise exception 'AUTH_VERDICT_POSTCONDITION_EXPOSURE';
  end if;
end $$;

commit;
