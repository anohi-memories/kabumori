-- G5 SOURCE CANDIDATE (2026-10-25, Issue #320 G5-01 task 33, S2-3 of docs/common-account/g5-32-personal-workspace-session-consumer-matrix.md §4).
-- NOT in supabase/migrations/. Never apply to a managed or production database without an independent focused Codex Sol (high) review of this
-- file, the G5 担当ちゃ's acceptance and the owner's explicit production approval. It needs D1 (002_verdicts_anonymous_strict.sql, PR #494) applied.
--
-- S2-3 private.postona_personal_workspace_eligibility(uuid) -> text                         EXECUTE: the lifecycle owner ONLY (no grant)
--      The ONE personal-workspace rule (G5-23 §4.1, the same as G4's Threads provisioner, PR #124): the id 'u_' || substr(md5(user), 1, 24), kind
--      social_mobile_user_v1, exactly one membership (the person as owner), and the person owns NO other brand.
--      -> 'absent' | 'own' | 'OWN_WORKSPACE_CONFLICT' | 'WORKSPACE_OWNER_UNKNOWN'; a NULL user or an unreadable fact RAISES (never 'own').
--      STABLE, SECURITY DEFINER, empty search_path, row_security = off, read-only, no lock. Its input must be a VERIFIED subject (R0's, or
--      auth.uid() inside a reviewed owner-owned caller): with no grant, no API role can ask about another person.
-- R0   public.common_account_bootstrap_verdict(text,text): ONLY ITS BODY is replaced (CREATE OR REPLACE: same OID, owner, ACL, attributes). Its
--      own-workspace step now calls the predicate and answers with its existing v1 reasons (OWN_WORKSPACE_CONFLICT deny, WORKSPACE_OWNER_UNKNOWN
--      unknown). New refusals, all OWN_WORKSPACE_CONFLICT: (C4) no own workspace but another owned brand; (C5) the own workspace AND another owned
--      brand; another member on the own workspace; memberships under the derived id without its brand row. Every other answer is byte-identical.
--
-- Not changed: R1, SV, T13, W1, the v1 wire, the owner epoch, entitlements, auth.users / brands / brand_memberships (nothing is written, moved or
-- taken over). The main X begin (G4's) is NOT changed: it still joins / reuses (recorded for G4, docs/common-account/g5-33-s2-3-personal-workspace-eligibility.md).
-- Rollback: 003_s2_3_workspace_eligibility_rollback.sql (R0 back to the D1 body byte for byte, the predicate dropped).
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure;
  v_md5 text;
  v_rel text;
  v_kind "char";
  v_rls boolean;
  v_forced boolean;
  v_relowner oid;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'S23_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  v_fn := pg_catalog.to_regprocedure('public.common_account_bootstrap_verdict(text,text)');
  if v_fn is null then
    raise exception 'S23_PRECONDITION_R0_MISSING';
  end if;
  v_md5 := (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn);
  if v_md5 = '3e89fcff1a3232ef794cdf0483a75130' then
    raise exception 'S23_ALREADY_APPLIED';
  end if;
  -- only R0 exactly as D1 leaves it (PR #494) is replaced: anything else is someone else's change and stays untouched
  if v_md5 is distinct from 'f3fb1fb4102b0cbf969145045e079318' then
    raise exception 'S23_PRECONDITION_R0_BODY_NOT_REVIEWED';
  end if;
  -- R0's reviewed shape: owner, definer, STABLE, the settings, every attribute a CREATE OR REPLACE resets (G5-28 / G5-29), the ACL
  -- (owner + authenticated), no API role reaching the owner; `is not true` so a NULL refuses (G5-31)
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
    raise exception 'S23_PRECONDITION_R0_SHAPE';
  end if;
  perform pg_catalog.set_config('postona_personal_s23.oid_r0', v_fn::oid::text, true);
  -- the predicate is new: a function already under its name is someone else's
  if pg_catalog.to_regprocedure('private.postona_personal_workspace_eligibility(uuid)') is not null then
    raise exception 'S23_PRECONDITION_PREDICATE_EXISTS';
  end if;
  -- the relations the predicate reads: plain tables this owner may SELECT, with EVERY row visible to it (the G5-08 rule: RLS off, BYPASSRLS, or the
  -- table owner's privileges with RLS not FORCED) -- a hidden membership would turn a conflict into 'absent' / 'own'; and the expected columns
  foreach v_rel in array array['public.brands', 'public.brand_memberships'] loop
    select c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relowner into v_kind, v_rls, v_forced, v_relowner
      from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass(v_rel);
    if not found or v_kind not in ('r', 'p') or not pg_catalog.has_table_privilege(v_owner, v_rel, 'SELECT') then
      raise exception 'S23_PRECONDITION_RELATION %', v_rel;
    end if;
    if v_forced then
      raise exception 'S23_PRECONDITION_RLS_FORCED %', v_rel;
    end if;
    if v_rls and not (select r.rolbypassrls from pg_catalog.pg_roles r where r.oid = v_owner) and not pg_catalog.pg_has_role(v_owner, v_relowner, 'USAGE') then
      raise exception 'S23_PRECONDITION_RLS_HIDES_ROWS %', v_rel;
    end if;
  end loop;
  if (select pg_catalog.count(*) from pg_catalog.pg_attribute a where a.attrelid = 'public.brands'::pg_catalog.regclass and not a.attisdropped
       and ((a.attname = 'id' and a.atttypid = 'text'::pg_catalog.regtype) or (a.attname = 'code_profile_key' and a.atttypid = 'text'::pg_catalog.regtype))) <> 2
     or (select pg_catalog.count(*) from pg_catalog.pg_attribute a where a.attrelid = 'public.brand_memberships'::pg_catalog.regclass and not a.attisdropped
       and ((a.attname = 'brand_id' and a.atttypid = 'text'::pg_catalog.regtype) or (a.attname = 'user_id' and a.atttypid = 'uuid'::pg_catalog.regtype)
         or (a.attname = 'role' and a.atttypid = 'text'::pg_catalog.regtype))) <> 3 then
    raise exception 'S23_PRECONDITION_RELATION_SHAPE';
  end if;
  -- the derivation must be the one the deletion saga names (main 20260928160000:98-100), as R0's own install checks
  if pg_catalog.to_regprocedure('public.social_mobile_account_deletion_workspace(uuid)') is null
     or public.social_mobile_account_deletion_workspace('00000000-0000-4000-8000-000000000001'::uuid)
        is distinct from 'u_' || pg_catalog.substr(pg_catalog.md5('00000000-0000-4000-8000-000000000001'), 1, 24) then
    raise exception 'S23_PRECONDITION_WORKSPACE_DERIVATION';
  end if;
end $$;

-- S2-3: the personal-workspace eligibility (owner-only)
create function private.postona_personal_workspace_eligibility(p_user uuid)
returns text language plpgsql stable security definer set search_path = '' set row_security = off as $$
declare
  v_workspace text;
  f_ws_found boolean;
  f_ws_kind text;
  f_caller_role text;
  f_owner uuid;
  f_owner_count bigint;
  f_member_count bigint;
  f_orphans bigint;
  f_other_owned boolean;
begin
  if p_user is null then
    raise exception 'POSTONA_PERSONAL_WORKSPACE_USER_REQUIRED' using errcode = '22004';
  end if;
  -- the derived id, as the begin RPC, the deletion saga and R0 name it ('u_' || substr(md5(user), 1, 24))
  v_workspace := 'u_' || pg_catalog.substr(pg_catalog.md5(p_user::text), 1, 24);
  -- every fact in ONE statement (STABLE: the caller's snapshot), read as the lifecycle owner with every row visible (install check)
  select b.id is not null, b.code_profile_key,
         (select m.role from public.brand_memberships m where m.brand_id = b.id and m.user_id = p_user),
         (select case when pg_catalog.count(*) = 1 then (pg_catalog.array_agg(m.user_id))[1] end
            from public.brand_memberships m where m.brand_id = b.id and m.role = 'owner'),
         (select pg_catalog.count(*) from public.brand_memberships o where o.brand_id = b.id and o.role = 'owner'),
         (select pg_catalog.count(*) from public.brand_memberships o where o.brand_id = b.id),
         (select pg_catalog.count(*) from public.brand_memberships o where o.brand_id = v_workspace),
         exists (select 1 from public.brand_memberships o where o.user_id = p_user and o.role = 'owner' and o.brand_id <> v_workspace)
    into f_ws_found, f_ws_kind, f_caller_role, f_owner, f_owner_count, f_member_count, f_orphans, f_other_owned
    from (select 1) x
    left join public.brands b on b.id = v_workspace;
  -- the G5-23 section 4.1 rule (= PR #124's provisioner): the id above, kind social_mobile_user_v1, exactly one membership (the caller as owner),
  -- and the person owns NO other brand. The first four branches keep R0's reviewed answers; the last three are the S2-3 additions.
  return case
    when not f_ws_found and f_orphans = 0 and not f_other_owned then 'absent'
    when not f_ws_found then 'OWN_WORKSPACE_CONFLICT'  -- memberships under the id without its brand row, or another owned brand
    when f_ws_kind is distinct from 'social_mobile_user_v1' then 'OWN_WORKSPACE_CONFLICT'
    when f_owner_count <> 1 or f_owner is null then 'WORKSPACE_OWNER_UNKNOWN'
    when f_owner <> p_user or f_caller_role is distinct from 'owner' then 'OWN_WORKSPACE_CONFLICT'
    when f_member_count <> 1 then 'OWN_WORKSPACE_CONFLICT'  -- (S2-3) another member on the own workspace: it is not personal
    when f_other_owned then 'OWN_WORKSPACE_CONFLICT'        -- (S2-3) the person owns another brand (legacy / shared: PENDING P-1)
    else 'own'
  end;
end $$;

revoke all on function private.postona_personal_workspace_eligibility(uuid) from public, anon, authenticated, service_role;

-- R0 with the S2-3 workspace step (the D1 body otherwise unchanged)
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
  -- the facts, one statement
  f_user_exists boolean;
  f_session_state text;
  f_account_status text;
  f_lifecycle bigint;
  f_account_deletion boolean;
  f_ent_status text;
  f_ent_deletion boolean;
  f_ws_eligibility text;
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

  -- 3. (S2-3, G5-33) the own workspace is judged by the shared owner-only rule private.postona_personal_workspace_eligibility, for the verified
  --    subject only (never a value from the request); it derives the id itself.

  -- 4. every fact in ONE statement: the caller's login, session, account, x_autopost entitlement and the own-workspace answer (the predicate is
  --    STABLE, so it reads the same snapshot). Read as the lifecycle owner; nothing of another person is returned.
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
         private.postona_personal_workspace_eligibility(v_user)
    into f_user_exists, f_session_state, f_account_status, f_lifecycle, f_account_deletion, f_ent_status, f_ent_deletion,
         f_ws_eligibility
    from (select 1) x
    left join public.common_accounts a on a.user_id = v_user
    left join public.service_entitlements e on e.user_id = v_user and e.service_key = 'x_autopost';

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
    -- (S2-3) the own workspace by the shared rule: absent (and no other owned brand), or exactly the caller's alone; anything else is never
    -- joined. The predicate answers one of four values or raises; any other value (unreachable) is unknown, never an allow.
    when f_ws_eligibility in ('absent', 'own') then null
    when f_ws_eligibility = 'OWN_WORKSPACE_CONFLICT' then pg_catalog.jsonb_build_object('decision', 'deny', 'reason', 'OWN_WORKSPACE_CONFLICT')
    else pg_catalog.jsonb_build_object('decision', 'unknown', 'reason', 'WORKSPACE_OWNER_UNKNOWN')
  end;
  if v_person is not null then
    return pg_catalog.jsonb_build_object('v', 1, 'scope', v_scope, 'subject', v_subject, 'session', null, 'owner_epoch', null, 'entitlements', '[]'::jsonb) || v_person;
  end if;
  return pg_catalog.jsonb_build_object('v', 1, 'decision', 'allow', 'reason', null, 'scope', v_scope, 'subject', v_subject,
    'session', pg_catalog.jsonb_build_object('state', 'active', 'ref', v_session_ref), 'owner_epoch', null, 'entitlements', '["postona:x_autopost"]'::jsonb);
end $$;

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure;
begin
  -- the predicate: exactly the expected body, owner-only, the expected shape, no API role may EXECUTE it or reach the owner
  v_fn := pg_catalog.to_regprocedure('private.postona_personal_workspace_eligibility(uuid)');
  if v_fn is null or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from 'fa4623601fe2ef6efc38478c9f65105e' then
    raise exception 'S23_POSTCONDITION_PREDICATE_BODY';
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
    raise exception 'S23_POSTCONDITION_PREDICATE_SHAPE';
  end if;
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') and pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE')) then
    raise exception 'S23_POSTCONDITION_PREDICATE_EXECUTE';
  end if;
  -- R0: the same function (same OID), the expected body, the same shape
  v_fn := pg_catalog.to_regprocedure('public.common_account_bootstrap_verdict(text,text)');
  if v_fn is null or v_fn::oid::text is distinct from pg_catalog.current_setting('postona_personal_s23.oid_r0', true) then
    raise exception 'S23_POSTCONDITION_R0_OID';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from '3e89fcff1a3232ef794cdf0483a75130' then
    raise exception 'S23_POSTCONDITION_R0_BODY';
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
    raise exception 'S23_POSTCONDITION_R0_SHAPE';
  end if;
end $$;

commit;
