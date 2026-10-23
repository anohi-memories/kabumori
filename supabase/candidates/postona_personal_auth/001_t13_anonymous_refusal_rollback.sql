-- Rollback of 001_t13_anonymous_refusal.sql (G5-24, S2-1). Puts back the reviewed T13 body of 20261010051938 BYTE FOR BYTE (CREATE OR REPLACE:
-- same OID, owner, ACL). It refuses unless the function is exactly the S2-1 body (another body is someone else's change and is left alone),
-- with the same shape checks as the candidate. After it, an anonymous sign-in passes T13 again (the reviewed behaviour); the consumers keep
-- working unchanged. It writes no row, creates nothing, grants nothing.
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure := pg_catalog.to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)');
  v_md5 text;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'T13_ANON_ROLLBACK_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if v_fn is null then
    raise exception 'T13_ANON_ROLLBACK_PRECONDITION_T13_MISSING';
  end if;
  v_md5 := (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn);
  if v_md5 = '08840016794a973225be767952265e79' then
    raise exception 'T13_ANON_ROLLBACK_NOT_APPLIED';
  end if;
  -- only the exact reviewed body is replaced: anything else is a different function and stays untouched
  if v_md5 is distinct from '1f8cd9c764c251f3232c61b7a77ff597' then
    raise exception 'T13_ANON_ROLLBACK_PRECONDITION_BODY_NOT_REVIEWED';
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
    raise exception 'T13_ANON_ROLLBACK_PRECONDITION_SHAPE';
  end if;
  perform pg_catalog.set_config('postona_personal_s2_1.oid', v_fn::oid::text, true);
end $$;

-- the reviewed T13 body of 20261010051938, byte for byte
create or replace function private.account_lifecycle_assert_active_service_write(p_user_id uuid, p_service_key text)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_legacy_sub text := nullif(current_setting('request.jwt.claim.sub', true), '');
  v_claims jsonb;
  v_sub text;
  v_role text;
  v_session text;
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
    end if;
  end if;
  begin
    v_subject := v_sub::uuid;
    v_session_id := v_session::uuid;
  exception when others then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end;
  if p_user_id is null or v_subject is null or v_session_id is null or v_role is distinct from 'authenticated'
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
    raise exception 'T13_ANON_ROLLBACK_POSTCONDITION_OID';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from '08840016794a973225be767952265e79' then
    raise exception 'T13_ANON_ROLLBACK_POSTCONDITION_BODY';
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
    raise exception 'T13_ANON_ROLLBACK_POSTCONDITION_SHAPE';
  end if;
end $$;

commit;
