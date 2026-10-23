-- G5 SOURCE CANDIDATE (2026-10-23, Issue #320 G5-01 task 24, S2-1 of docs/common-account/g5-23-postona-personal-auth-s1-contract.md). NOT in
-- supabase/migrations/. Never apply to a managed or production database without an independent focused Codex Sol (high) review of this file,
-- the G5 担当ちゃ's acceptance and the owner's explicit production approval.
--
-- G5-25 REVISION (2026-10-23, Issue #320 task 25): a missing / null / empty is_anonymous claim is now REFUSED (H4 #331 comment 6366601676).
--
-- T13 (private.account_lifecycle_assert_active_service_write, the reviewed Phase 3b migration 20261010051938, G5 Draft chain) checks that the
-- caller is the signed-in person with a live session, but it does not look at the JWT's `is_anonymous` claim: an anonymous sign-in (role
-- `authenticated`!) passes it (S1-F2; G3's finding, Issue #320 comment 6355355712). R0, R1 and the session verdict already refuse it.
--
-- This file REPLACES ONLY THAT FUNCTION'S BODY (CREATE OR REPLACE: same OID, owner, ACL, definer, volatility, empty search_path), with the
-- reviewed body plus a few lines: `is_anonymous` is read from the same claim source as `sub` (the per-claim setting of an older PostgREST,
-- else the JSON claims) and ONLY a proven false passes -- the JSON boolean false, or the per-claim text 'false'. A missing, null or empty claim,
-- another JSON type (a string, a number) or any other value is refused with the existing ACCOUNT_LIFECYCLE_AUTH_REQUIRED (SQLSTATE 42501), in
-- the subject step, BEFORE any lock (G5-25: fail closed on a missing claim, H4 P2 on PR #480). Every other check, code, lock and its order
-- is unchanged, so every consumer (G3 / G4 writers that call T13 first) inherits the refusal without being edited.
--
-- It refuses unless the function is EXACTLY the reviewed T13 (md5 of its body; another body is someone else's change and is left alone),
-- owned by the running role (not a superuser), definer, volatile, plpgsql, returning void, with an empty search_path, EXECUTE for its owner
-- alone and no API role reaching it through any membership. The postconditions check the same OID, the expected new body and the same shape.
-- It writes no row, creates no object, grants nothing. Rollback: 001_t13_anonymous_refusal_rollback.sql (the reviewed body, byte for byte).
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure := pg_catalog.to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)');
  v_md5 text;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'T13_ANON_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if v_fn is null then
    raise exception 'T13_ANON_PRECONDITION_T13_MISSING';
  end if;
  v_md5 := (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn);
  if v_md5 = '1f8cd9c764c251f3232c61b7a77ff597' then
    raise exception 'T13_ANON_ALREADY_APPLIED';
  end if;
  -- only the exact reviewed body is replaced: anything else is a different function and stays untouched
  if v_md5 is distinct from '08840016794a973225be767952265e79' then
    raise exception 'T13_ANON_PRECONDITION_BODY_NOT_REVIEWED';
  end if;
  -- the function is the reviewed T13 in every other respect: owner, definer, volatile, empty search_path, plpgsql, returns void,
  -- EXECUTE for its owner alone, and no API role reaches it through any membership (direct or indirect, INHERIT or not)
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner
     or not (select p.prosecdef and p.provolatile = 'v' and p.prorettype = 'void'::pg_catalog.regtype
                    and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
                    and p.proconfig = array['search_path=""']
               from pg_catalog.pg_proc p where p.oid = v_fn)
     or (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn)
          is distinct from pg_catalog.format('%s=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user))
     or exists (select 1 from pg_catalog.pg_roles r
                 where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                   and (pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE') or pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER'))) then
    raise exception 'T13_ANON_PRECONDITION_SHAPE';
  end if;
  perform pg_catalog.set_config('postona_personal_s2_1.oid', v_fn::oid::text, true);
end $$;

-- the reviewed T13 body + the anonymous refusal (S2-1)
create or replace function private.account_lifecycle_assert_active_service_write(p_user_id uuid, p_service_key text)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_legacy_sub text := nullif(current_setting('request.jwt.claim.sub', true), '');
  v_claims jsonb;
  v_sub text;
  v_role text;
  v_session text;
  v_anonymous text;
  v_subject uuid;
  v_session_id uuid;
  v_account public.common_accounts;
  v_status text;
  v_live boolean;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE' using errcode = '42501';
  end if;
  if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then
    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID' using errcode = '42501';
  end if;

  -- 1. The person, from the one claim source auth.uid() reads first: the per-claim settings of an
  --    older PostgREST when present, else the JSON claims. Never p_user_id alone.
  if v_legacy_sub is not null then
    v_sub := v_legacy_sub;
    v_role := nullif(current_setting('request.jwt.claim.role', true), '');
    v_session := nullif(current_setting('request.jwt.claim.session_id', true), '');
    v_anonymous := nullif(current_setting('request.jwt.claim.is_anonymous', true), '');
  else
    begin
      v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    exception when others then
      v_claims := null;
    end;
    if jsonb_typeof(v_claims) = 'object' then
      v_sub := v_claims ->> 'sub';
      v_role := v_claims ->> 'role';
      v_session := v_claims ->> 'session_id';
      v_anonymous := case when jsonb_typeof(v_claims -> 'is_anonymous') = 'boolean' then v_claims ->> 'is_anonymous' end;
    end if;
  end if;
  begin
    v_subject := v_sub::uuid;
    v_session_id := v_session::uuid;
  exception when others then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end;
  -- (S2-1, G5-24 / G5-25) an anonymous sign-in is not a person: refused here, before any lock. Only a PROVEN non-anonymous caller
  -- passes: the JSON claim must be the boolean false, the per-claim setting exactly 'false'; missing, null, empty, another type or
  -- any other value is refused (H4 P2 on PR #480).
  if p_user_id is null or v_subject is null or v_session_id is null or v_role is distinct from 'authenticated'
     or v_anonymous is distinct from 'false'
     or v_subject <> p_user_id or (select auth.uid()) is distinct from p_user_id then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end if;

  -- 2. I1 lock order: login KEY SHARE -> account FOR UPDATE (the lifecycle lock), then the entitlement.
  --    Nothing is created. Every read below is a fresh READ COMMITTED snapshot taken after the waits.
  v_account := private.account_lifecycle_lock(p_user_id, false);
  if v_account.user_id is null then
    raise exception 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND' using errcode = '42501';
  end if;
  if v_account.status = 'deleting'
     or exists (select 1 from private.account_lifecycle_operations o
                 where o.user_id = p_user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress') then
    raise exception 'ACCOUNT_DELETION_IN_PROGRESS' using errcode = '42501';
  end if;
  if v_account.status <> 'active' then
    raise exception 'ACCOUNT_LOCKED' using errcode = '42501';
  end if;
  select e.status into v_status from public.service_entitlements e
   where e.user_id = p_user_id and e.service_key = p_service_key
   for update;
  if not found then
    raise exception 'SERVICE_NOT_REGISTERED' using errcode = '42501';
  end if;
  if v_status = 'deleting'
     or exists (select 1 from private.account_lifecycle_operations o
                 where o.user_id = p_user_id and o.operation_type = 'service_deletion'
                   and o.service_key = p_service_key and o.status = 'in_progress') then
    raise exception 'SERVICE_DELETION_IN_PROGRESS' using errcode = '42501';
  end if;
  if v_status <> 'active' then
    raise exception 'SERVICE_NOT_ACTIVE' using errcode = '42501';
  end if;

  -- 3. The session is still live, read after the locks: a logout or revocation that committed while
  --    this waited is seen. Read only; GoTrue owns these rows and nothing here locks them.
  begin
    v_live := exists (select 1 from auth.sessions s
                       where s.id = v_session_id and s.user_id = p_user_id
                         and (s.not_after is null or s.not_after > clock_timestamp()));
  exception when undefined_table or undefined_column or insufficient_privilege then
    raise exception 'ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE' using errcode = '42501';
  end;
  if not v_live then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end if;
end;
$$;

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure := pg_catalog.to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)');
begin
  -- the same function (same OID: every consumer's reference and its ACL are kept), now with exactly the expected body
  if v_fn is null or v_fn::oid::text is distinct from pg_catalog.current_setting('postona_personal_s2_1.oid', true) then
    raise exception 'T13_ANON_POSTCONDITION_OID';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from '1f8cd9c764c251f3232c61b7a77ff597' then
    raise exception 'T13_ANON_POSTCONDITION_BODY';
  end if;
  -- the function is the reviewed T13 in every other respect: owner, definer, volatile, empty search_path, plpgsql, returns void,
  -- EXECUTE for its owner alone, and no API role reaches it through any membership (direct or indirect, INHERIT or not)
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner
     or not (select p.prosecdef and p.provolatile = 'v' and p.prorettype = 'void'::pg_catalog.regtype
                    and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
                    and p.proconfig = array['search_path=""']
               from pg_catalog.pg_proc p where p.oid = v_fn)
     or (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn)
          is distinct from pg_catalog.format('%s=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user))
     or exists (select 1 from pg_catalog.pg_roles r
                 where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                   and (pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE') or pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER'))) then
    raise exception 'T13_ANON_POSTCONDITION_SHAPE';
  end if;
end $$;

commit;
