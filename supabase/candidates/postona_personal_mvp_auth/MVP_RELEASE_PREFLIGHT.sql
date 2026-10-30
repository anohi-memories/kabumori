-- G5 SOURCE CANDIDATE (2026-10-30, Issue #320 G5-01 task 50). NOT applied anywhere. The READ-ONLY release preflight of the personal MVP profile:
-- run it as the lifecycle owner (never a superuser) with ON_ERROR_STOP before MVP_INSTALL.sql, after it, after MVP_R1_EXECUTE_GRANT.sql and
-- whenever the release is in doubt. It changes nothing (a READ ONLY transaction that is rolled back; no CREATE / GRANT / SET outside it), reports
-- EVERY finding at once as a NOTICE line `G5_MVP_PREFLIGHT <code> <PASS|FAIL|WARN> <detail>`, then either raises
-- `G5_MVP_PREFLIGHT_FAILED <codes>` (any FAIL: do not install / grant / wire; see docs/common-account/g5-50-postona-mvp-release-integration.md)
-- or notes `G5_MVP_PREFLIGHT VERDICT PASS phase=<absent|installed|granted> warnings=<n>`.
-- What it adds to the install's own preconditions (which still run, and still refuse): the environment the managed project must provide for
-- G6's real path -- the PostgREST login role `authenticator` can SET ROLE authenticated and does not inherit it; no API role is a member of the
-- lifecycle owner; the owner's DEFAULT PRIVILEGES give no function to anyone (the install would refuse late with S22_POSTCONDITION_SHAPE);
-- auth.uid() reads the JSON claims PostgREST sets; the phase (and any drift of an installed profile: body, gate ACLs, R1 ACL); and the data shape
-- G1's workspace id depends on (counts only, no row is printed): a personal brand whose id is not its owner's derived id, a person with more
-- than one membership (G1 #576 then shows the first brand it reads; G5 answers only the derived one), a personal workspace that is shared, an
-- active x_autopost entitlement with no personal workspace (AI post assist answers 403 until the first X connection creates it).
-- G5-51 adds: PF_OWNER_AUTH (the owner can use schema auth and lock auth.users rows: on Supabase only `postgres` can, G6-26 F2), PF_W0 (the
-- optional W0 provisioning function: absent / installed / granted / drift), and PF_PHASE reports an owner without USAGE on schema private.
-- Production NO_GO: running it on a managed project is a read-only connection that still needs the owner's explicit approval.
begin transaction isolation level repeatable read read only;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_r1 regprocedure := pg_catalog.to_regprocedure('public.common_account_authorization_verdict(text,text,text)');
  v_w0 regprocedure;
  v_gates text[] := array['private.postona_personal_session()', 'private.postona_personal_workspace_eligibility(uuid)',
                          'private.account_lifecycle_generation_covered()', 'private.postona_personal_worker_verdict(uuid,text,text,bigint)'];
  v_p1 text[] := array['private.account_lifecycle_lock', 'private.account_lifecycle_start_service', 'private.account_lifecycle_gate_open',
                       'private.account_lifecycle_assert_active_service_write', 'private.account_lifecycle_service_state_refusal',
                       'private.account_lifecycle_brand_owner', 'private.account_lifecycle_finish_service_deletion', 'public.common_account_service_end_result',
                       'private.account_lifecycle_enrollment_fence', 'public.record_owned_service_deletion_x_unconfirmed'];
  v_lines text[] := '{}';
  v_fail text[] := '{}';
  v_warn int := 0;
  v_phase text;
  v_acl text;
  v_n bigint;
  v_txt text;
  v_sig text;
begin
  -- PF_OWNER: the lifecycle owner, never a superuser (every G5 file refuses a superuser)
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    v_lines := v_lines || 'PF_OWNER FAIL the current role is a superuser; run as the lifecycle owner'::text; v_fail := v_fail || 'PF_OWNER'::text;
  else
    v_lines := v_lines || ('PF_OWNER PASS ' || current_user);
  end if;

  -- PF_P1: the P1 lifecycle chain the MVP is built on
  select pg_catalog.count(*) into v_n from pg_catalog.unnest(v_p1) f
   where not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname || '.' || p.proname = f);
  if v_n > 0 then
    v_lines := v_lines || ('PF_P1 FAIL ' || v_n || ' of the 10 P1 lifecycle functions are missing'); v_fail := v_fail || 'PF_P1'::text;
  else
    v_lines := v_lines || 'PF_P1 PASS the P1 lifecycle chain is present'::text;
  end if;
  if pg_catalog.current_setting('session_replication_role') <> 'origin' then
    v_lines := v_lines || 'PF_TRIGGERS FAIL session_replication_role is not origin: GC is false and every verdict is unknown'::text; v_fail := v_fail || 'PF_TRIGGERS'::text;
  end if;

  -- PF_P3: no API write path on brand_memberships (the membership facts S2-3 reads)
  if pg_catalog.to_regclass('public.brand_memberships') is null
     or exists (select 1 from pg_catalog.pg_roles r, pg_catalog.unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) k
                 where r.rolname in ('anon', 'authenticated') and pg_catalog.has_table_privilege(r.oid, 'public.brand_memberships', k))
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'service_role' and pg_catalog.has_table_privilege(r.oid, 'public.brand_memberships', 'TRIGGER')) then
    v_lines := v_lines || 'PF_P3 FAIL brand_memberships is missing or an API role can write it (G3 L-1 revoke first)'::text; v_fail := v_fail || 'PF_P3'::text;
  else
    v_lines := v_lines || 'PF_P3 PASS no API write path on brand_memberships'::text;
  end if;

  -- PF_OWNER_AUTH (G5-51, G6-26 F2): the P1 lifecycle lock (T13, every service start / end, W0) takes the person's auth.users row FOR KEY SHARE /
  -- FOR UPDATE, so the owner needs USAGE on schema auth and UPDATE on a column of auth.users. On the Supabase image `postgres` holds both and
  -- cannot GRANT either to another role (no grant option, measured): a dedicated owner fails here, otherwise at the first call with
  -- "permission denied for table users". USAGE is checked first and alone: every auth name lookup below needs it.
  if pg_catalog.to_regnamespace('auth') is null or not pg_catalog.has_schema_privilege(v_owner, 'auth', 'USAGE') then
    v_lines := v_lines || 'PF_OWNER_AUTH FAIL the lifecycle owner has no USAGE on schema auth (on Supabase only `postgres` has it to use)'::text;
    v_fail := v_fail || 'PF_OWNER_AUTH'::text || 'PF_AUTH'::text;
    v_lines := v_lines || 'PF_AUTH FAIL not checked: no USAGE on schema auth'::text;
  else
  if pg_catalog.to_regclass('auth.users') is null or not pg_catalog.has_any_column_privilege(v_owner, 'auth.users', 'UPDATE') then
    v_lines := v_lines || 'PF_OWNER_AUTH FAIL the lifecycle owner cannot lock auth.users rows (needs UPDATE on a column): T13 / service start would refuse'::text;
    v_fail := v_fail || 'PF_OWNER_AUTH'::text;
  else
    v_lines := v_lines || 'PF_OWNER_AUTH PASS USAGE on auth and the auth.users row lock'::text;
  end if;

  -- PF_AUTH: auth.uid() STABLE and reading the JSON claims PostgREST sets; auth.users / auth.sessions readable with every row
  if pg_catalog.to_regprocedure('auth.uid()') is null or pg_catalog.to_regclass('auth.users') is null or pg_catalog.to_regclass('auth.sessions') is null
     or (select p.provolatile from pg_catalog.pg_proc p where p.oid = 'auth.uid()'::pg_catalog.regprocedure) is distinct from 's'
     or (select pg_catalog.count(*) from pg_catalog.pg_attribute a where a.attrelid = 'auth.sessions'::pg_catalog.regclass and not a.attisdropped
          and ((a.attname in ('id', 'user_id') and a.atttypid = 'uuid'::pg_catalog.regtype) or (a.attname = 'not_after' and a.atttypid = 'timestamptz'::pg_catalog.regtype))) <> 3
     or not pg_catalog.has_table_privilege(v_owner, 'auth.sessions', 'SELECT') or not pg_catalog.has_table_privilege(v_owner, 'auth.users', 'SELECT') then
    v_lines := v_lines || 'PF_AUTH FAIL auth.uid() (STABLE), auth.users or auth.sessions (id, user_id, not_after) missing, of another shape or not readable'::text;
    v_fail := v_fail || 'PF_AUTH'::text;
  elsif exists (select 1 from pg_catalog.pg_class c where c.oid in ('auth.users'::pg_catalog.regclass, 'auth.sessions'::pg_catalog.regclass)
                 and (c.relforcerowsecurity or (c.relrowsecurity and not (select r.rolbypassrls from pg_catalog.pg_roles r where r.oid = v_owner)
                                                and not pg_catalog.pg_has_role(v_owner, c.relowner, 'USAGE')))) then
    v_lines := v_lines || 'PF_AUTH FAIL row security would hide auth rows from the lifecycle owner'::text; v_fail := v_fail || 'PF_AUTH'::text;
  elsif pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p where p.oid = 'auth.uid()'::pg_catalog.regprocedure), 'request.jwt.claims') = 0 then
    -- PostgREST v10+ sets only request.jwt.claims: an auth.uid() that reads only request.jwt.claim.sub is NULL there, so every call is AUTH_REQUIRED
    v_lines := v_lines || 'PF_AUTH FAIL auth.uid() does not read request.jwt.claims: every person would be refused (AUTH_REQUIRED)'::text; v_fail := v_fail || 'PF_AUTH'::text;
  else
    v_lines := v_lines || 'PF_AUTH PASS auth.uid() reads request.jwt.claims; auth.users / auth.sessions readable'::text;
  end if;
  end if;

  -- PF_ROLES / PF_ROLE_GRAPH: the Supabase API roles and how they may reach the owner's functions
  if pg_catalog.to_regrole('anon') is null or pg_catalog.to_regrole('authenticated') is null or pg_catalog.to_regrole('service_role') is null
     or pg_catalog.to_regrole('authenticator') is null then
    v_lines := v_lines || 'PF_ROLES FAIL anon / authenticated / service_role / authenticator missing'::text; v_fail := v_fail || 'PF_ROLES'::text;
  else
    if exists (select 1 from pg_catalog.pg_roles a where a.rolname in ('anon', 'service_role') and pg_catalog.pg_has_role(a.oid, 'authenticated', 'MEMBER')) then
      v_lines := v_lines || 'PF_ROLE_GRAPH FAIL anon or service_role is a member of authenticated (the grant would reach it)'::text; v_fail := v_fail || 'PF_ROLE_GRAPH'::text;
    elsif exists (select 1 from pg_catalog.pg_roles a where a.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') and pg_catalog.pg_has_role(a.oid, v_owner, 'MEMBER')) then
      v_lines := v_lines || 'PF_ROLE_GRAPH FAIL an API role is a member of the lifecycle owner (it could alter or run every gate)'::text; v_fail := v_fail || 'PF_ROLE_GRAPH'::text;
    else
      v_lines := v_lines || 'PF_ROLE_GRAPH PASS no API role reaches authenticated or the lifecycle owner'::text;
    end if;
    -- PostgREST logs in as authenticator and switches to the request's role: it must be able to SET ROLE authenticated, and must not hold
    -- authenticated's privileges itself (then the grant would reach the login role before any switch)
    if not pg_catalog.pg_has_role('authenticator', 'authenticated', 'SET') then
      v_lines := v_lines || 'PF_AUTHENTICATOR FAIL authenticator cannot SET ROLE authenticated: G6''s calls never reach R1-MVP'::text; v_fail := v_fail || 'PF_AUTHENTICATOR'::text;
    elsif pg_catalog.pg_has_role('authenticator', 'authenticated', 'USAGE') then
      v_lines := v_lines || 'PF_AUTHENTICATOR FAIL authenticator inherits authenticated (expected NOINHERIT)'::text; v_fail := v_fail || 'PF_AUTHENTICATOR'::text;
    else
      v_lines := v_lines || 'PF_AUTHENTICATOR PASS authenticator can SET ROLE authenticated and does not inherit it'::text;
    end if;
  end if;

  -- PF_DEFAULT_ACL: every function the install creates is revoked from PUBLIC, anon, authenticated and service_role by name (Supabase's usual
  -- default privileges for those roles are therefore harmless); a default grant of functions to ANY OTHER role survives that revoke and makes the
  -- install's postcondition refuse the whole transaction late (S22_POSTCONDITION_SHAPE)
  select pg_catalog.string_agg(distinct coalesce(n.nspname::text, '*') || ':' || x.grantee::regrole::text, ' ') into v_txt
    from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace, pg_catalog.aclexplode(d.defaclacl) x
   where d.defaclrole = v_owner and d.defaclobjtype = 'f' and (d.defaclnamespace = 0 or n.nspname in ('public', 'private'))
     and x.grantee <> v_owner and x.grantee <> 0
     and x.grantee not in (select r.oid from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role'));
  if v_txt is not null then
    v_lines := v_lines || ('PF_DEFAULT_ACL FAIL the lifecycle owner''s default privileges give functions to a role the install does not revoke: ' || v_txt);
    v_fail := v_fail || 'PF_DEFAULT_ACL'::text;
  else
    v_lines := v_lines || 'PF_DEFAULT_ACL PASS the lifecycle owner''s default privileges give functions to no role the install leaves granted'::text;
  end if;
  if exists (select 1 from pg_catalog.pg_roles r, pg_catalog.unnest(array['public', 'private']) s
              where r.rolname in ('anon', 'authenticated', 'service_role') and pg_catalog.to_regnamespace(s) is not null
                and pg_catalog.has_schema_privilege(r.oid, s, 'CREATE')) then
    v_lines := v_lines || 'PF_SCHEMA_CREATE WARN an API role may CREATE in public or private (every gate pins search_path to empty)'::text; v_warn := v_warn + 1;
  end if;

  -- PF_PHASE: absent (install next), installed (grant next), granted (wire next); anything else is not this profile or has drifted.
  -- (G5-51) The gates live in schema private: an owner without USAGE there is reported, not crashed on (every lookup below needs it).
  if pg_catalog.to_regnamespace('private') is not null and not pg_catalog.has_schema_privilege(v_owner, 'private', 'USAGE') then
    v_phase := 'unknown'; v_lines := v_lines || 'PF_PHASE FAIL not checked: the lifecycle owner has no USAGE on schema private'::text; v_fail := v_fail || 'PF_PHASE'::text;
  elsif v_r1 is null then
    select pg_catalog.string_agg(g, ' ') into v_txt from pg_catalog.unnest(v_gates) g where pg_catalog.to_regprocedure(g) is not null;
    if v_txt is not null then
      v_phase := 'partial'; v_lines := v_lines || ('PF_PHASE FAIL R1-MVP is absent but gates exist: ' || v_txt); v_fail := v_fail || 'PF_PHASE'::text;
    else
      v_phase := 'absent'; v_lines := v_lines || 'PF_PHASE PASS absent: run MVP_INSTALL.sql next'::text;
    end if;
  elsif not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_r1 and pg_catalog.strpos(p.prosrc, '''g5pv:'' || f_lifecycle::text') > 0) then
    v_phase := 'other'; v_lines := v_lines || 'PF_PHASE FAIL public.common_account_authorization_verdict is not R1-MVP (the full profile or another function)'::text;
    v_fail := v_fail || 'PF_PHASE'::text;
  elsif not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_r1 and p.proowner = v_owner and p.prosecdef and p.provolatile = 's'
                     and p.proconfig = array['search_path=""', 'row_security=off'] and pg_catalog.md5(p.prosrc) = '8d8392a3ceee4e157dab73cab6b089a6') then
    v_phase := 'drift'; v_lines := v_lines || 'PF_PHASE FAIL R1-MVP is not the reviewed body / owner / config: run MVP_R1_EXECUTE_REVOKE.sql'::text; v_fail := v_fail || 'PF_PHASE'::text;
  else
    v_acl := (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_r1);
    if v_acl = pg_catalog.format('%s=X/%s', current_user, current_user) then
      v_phase := 'installed'; v_lines := v_lines || 'PF_PHASE PASS installed (owner-only): run MVP_R1_EXECUTE_GRANT.sql next'::text;
    elsif v_acl = pg_catalog.format('%s=X/%s,authenticated=X/%s', current_user, current_user, current_user) then
      v_phase := 'granted'; v_lines := v_lines || 'PF_PHASE PASS granted (owner + authenticated): G6 may be wired'::text;
    else
      v_phase := 'drift'; v_lines := v_lines || ('PF_PHASE FAIL R1-MVP ACL drifted (' || v_acl || '): run MVP_R1_EXECUTE_REVOKE.sql'); v_fail := v_fail || 'PF_PHASE'::text;
    end if;
    -- every other gate of an installed profile stays owner-only
    foreach v_sig in array v_gates loop
      if pg_catalog.to_regprocedure(v_sig) is null
         or exists (select 1 from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(v_sig) and (p.proowner <> v_owner or p.proacl is null))
         or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) x where p.oid = pg_catalog.to_regprocedure(v_sig) and x.grantee <> p.proowner) then
        v_lines := v_lines || ('PF_GATES FAIL ' || v_sig || ' is missing, not the owner''s or not owner-only'); v_fail := v_fail || 'PF_GATES'::text;
      end if;
    end loop;
  end if;

  -- PF_W0 (G5-51): the person's own workspace provisioning, optional: absent, installed (owner-only), granted (owner + authenticated);
  -- anything else (another body / owner / config, a wider ACL) is drift: run MVP_W0_EXECUTE_REVOKE.sql
  v_w0 := pg_catalog.to_regprocedure('public.postona_ensure_my_personal_workspace()');
  if v_w0 is null then
    v_lines := v_lines || 'PF_W0 PASS absent (optional: MVP_W0_INSTALL.sql after the profile)'::text;
  elsif not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_w0 and p.proowner = v_owner and p.prosecdef and p.provolatile = 'v'
                     and p.proconfig = array['search_path=""', 'row_security=off'] and pg_catalog.md5(p.prosrc) = '3b3cc024c7816fa5e86a65e71f90060c') then
    v_lines := v_lines || 'PF_W0 FAIL W0 is not the reviewed body / owner / config: run MVP_W0_EXECUTE_REVOKE.sql'::text; v_fail := v_fail || 'PF_W0'::text;
  else
    v_acl := (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_w0);
    if v_acl = pg_catalog.format('%s=X/%s', current_user, current_user) then
      v_lines := v_lines || 'PF_W0 PASS installed (owner-only): MVP_W0_EXECUTE_GRANT.sql next'::text;
    elsif v_acl = pg_catalog.format('%s=X/%s,authenticated=X/%s', current_user, current_user, current_user) then
      v_lines := v_lines || 'PF_W0 PASS granted (owner + authenticated): the app may call it'::text;
    else
      v_lines := v_lines || ('PF_W0 FAIL W0 ACL drifted (' || v_acl || '): run MVP_W0_EXECUTE_REVOKE.sql'); v_fail := v_fail || 'PF_W0'::text;
    end if;
  end if;

  -- PF_DATA_*: the shape G1's workspace id and G5's derived id must agree on (counts only; the owner reads with every row, as S2-3 does)
  begin
    set local row_security = off;
    if pg_catalog.to_regclass('public.brands') is not null and pg_catalog.to_regclass('public.brand_memberships') is not null then
      execute $q$select pg_catalog.count(*) from public.brands b where b.code_profile_key = 'social_mobile_user_v1'
                  and not exists (select 1 from public.brand_memberships m where m.brand_id = b.id and m.role = 'owner'
                                   and b.id = 'u_' || pg_catalog.substr(pg_catalog.md5(m.user_id::text), 1, 24))$q$ into v_n;
      if v_n > 0 then
        v_lines := v_lines || ('PF_DATA_PERSONAL_ID WARN ' || v_n || ' personal brand(s) whose id is not their owner''s derived id (refused: BRAND_ACCESS_DENIED)'); v_warn := v_warn + 1;
      end if;
      execute $q$select pg_catalog.count(*) from (select m.user_id from public.brand_memberships m group by m.user_id having pg_catalog.count(*) > 1) x$q$ into v_n;
      if v_n > 0 then
        v_lines := v_lines || ('PF_DATA_MULTI_MEMBERSHIP WARN ' || v_n || ' person(s) with more than one membership (G1 may show another brand; G5 refuses all but a sole personal one)');
        v_warn := v_warn + 1;
      end if;
      execute $q$select pg_catalog.count(*) from public.brands b where b.code_profile_key = 'social_mobile_user_v1'
                  and (select pg_catalog.count(*) from public.brand_memberships m where m.brand_id = b.id) <> 1$q$ into v_n;
      if v_n > 0 then
        v_lines := v_lines || ('PF_DATA_SHARED_PERSONAL WARN ' || v_n || ' personal workspace(s) without exactly one membership (OWN_WORKSPACE_CONFLICT / WORKSPACE_OWNER_UNKNOWN)');
        v_warn := v_warn + 1;
      end if;
      if pg_catalog.to_regclass('public.service_entitlements') is not null then
        execute $q$select pg_catalog.count(*) from public.service_entitlements e where e.service_key = 'x_autopost' and e.status = 'active'
                    and not exists (select 1 from public.brands b where b.id = 'u_' || pg_catalog.substr(pg_catalog.md5(e.user_id::text), 1, 24))$q$ into v_n;
        if v_n > 0 then
          v_lines := v_lines || ('PF_DATA_NO_WORKSPACE WARN ' || v_n || ' active x_autopost person(s) without a personal workspace (403 until W0 or the first X connection creates it)');
          v_warn := v_warn + 1;
        end if;
      end if;
      v_lines := v_lines || 'PF_DATA PASS counted (no row printed)'::text;
    else
      v_lines := v_lines || 'PF_DATA FAIL public.brands / public.brand_memberships missing'::text; v_fail := v_fail || 'PF_DATA'::text;
    end if;
  exception when insufficient_privilege then
    v_lines := v_lines || 'PF_DATA FAIL the lifecycle owner cannot read every brand / membership row (S2-3 would refuse to install)'::text; v_fail := v_fail || 'PF_DATA'::text;
  end;

  foreach v_txt in array v_lines loop
    raise notice 'G5_MVP_PREFLIGHT %', v_txt;
  end loop;
  if pg_catalog.cardinality(v_fail) > 0 then
    raise exception 'G5_MVP_PREFLIGHT_FAILED %', (select pg_catalog.string_agg(distinct f, ' ' order by f) from pg_catalog.unnest(v_fail) f);
  end if;
  raise notice 'G5_MVP_PREFLIGHT VERDICT PASS phase=% warnings=%', v_phase, v_warn;
end $$;

rollback;
