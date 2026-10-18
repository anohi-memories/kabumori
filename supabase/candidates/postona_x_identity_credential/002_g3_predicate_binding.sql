-- SOURCE CANDIDATE ONLY. NOT a migration, NOT applied anywhere (F4 / G4,
-- postona-f4-m1-x-identity-verified-credential-port-source-20261018). The ONE integration point F3 left for G4:
-- postona_x_resv.g4_x_account_verified(user, account), shipped by F3's 001 as the DENY `select false`, now answers
-- G4's predicate public.x_account_g4_verified (001 of this directory).
--
-- Apply only AFTER F3's reservation candidates 001-004 (003 refuses unless this function is still the DENY) and
-- G4's 001, and only after F3 / G3 acknowledged the contract (Issue #269). It replaces exactly that one function body:
-- same name, arguments, return type, language, STABLE, SECURITY DEFINER, empty search_path, owner; still no EXECUTE
-- for anon / authenticated / service_role (PR #257 K6). It refuses to apply over anything but F3's shipped DENY
-- (a test double, or another body, stops it). Rollback: put F3's DENY back (002_g3_predicate_binding_rollback.sql).
begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_owner oid;
  v_fn regprocedure := pg_catalog.to_regprocedure('postona_x_resv.g4_x_account_verified(uuid,text)');
begin
  select c.relowner into v_owner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass;
  if v_owner is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
     or (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'X_G4_BINDING_PRECONDITION_OWNER';
  end if;
  if pg_catalog.to_regprocedure('public.x_account_g4_verified(uuid,text)') is null then
    raise exception 'X_G4_BINDING_PRECONDITION_G4';
  end if;
  if v_fn is null
     or (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner
     or (select p.prorettype from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from 'pg_catalog.bool'::regtype
     or (select pg_catalog.regexp_replace(p.prosrc, '--[^\n]*', '', 'g') from pg_catalog.pg_proc p where p.oid = v_fn)
        !~ '^\s*select\s+false\s*$' then
    raise exception 'X_G4_BINDING_PRECONDITION_F3_DENY';
  end if;
end $$;

create or replace function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  -- G4 (Issue #131, F4 M1): the attested X owner IS this user and their POSTONA is active. See
  -- candidates/postona_x_identity_credential/001_x_identity_credential_candidate.sql.
  select public.x_account_g4_verified(p_user_id, p_social_account_id)
$$;
revoke all on function postona_x_resv.g4_x_account_verified(uuid, text) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_catalog.pg_roles r
             where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
               and pg_catalog.has_function_privilege(r.oid, 'postona_x_resv.g4_x_account_verified(uuid,text)', 'EXECUTE'))
     or not exists (select 1 from pg_catalog.pg_proc p
                    where p.oid = 'postona_x_resv.g4_x_account_verified(uuid,text)'::regprocedure
                      and p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']) then
    raise exception 'X_G4_BINDING_POSTCONDITION';
  end if;
end $$;

commit;
