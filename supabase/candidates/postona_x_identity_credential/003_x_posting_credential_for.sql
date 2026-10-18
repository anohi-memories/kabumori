-- SOURCE CANDIDATE ONLY. NOT a migration, NOT applied anywhere (F4 / G4,
-- postona-f4-pr276-j2-p2x2-provenance-owner-epoch-atomic-credential-fix-20261018). G4's side of F3's generation-bound
-- port (PR #278, x_credential_generation.ts: credentialFor(account) -> { token, generation } | null, G1-G5).
--
--   public.x_posting_credential_for(account) -> table (token text, generation text)   SERVER ONLY (owner EXECUTE only)
--       ONE statement, ONE snapshot: G4's whole decision and the token (public.x_posting_credential_row, STABLE) and
--       F3's generation (postona_x_resv.x_credential_generation, STABLE, F3's own SHA-256 algorithm -- 64 lowercase hex,
--       never a G4 re-implementation) are read together, so the generation is exactly the one the token belongs to (G3).
--       No row (not verified, not active, being refreshed, expiring, unknown) -> the caller answers null (G4).
--
-- Apply only AFTER G4's 001 and F3's 006 (PR #278), and only after F3 / G3 acknowledged the exact signature and
-- semantics (Issue #269). It grants nothing: giving it to the role F3's single-post server uses is a separate,
-- reviewed step owned by F3 (transport) with G4.
begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_owner oid;
  v_fn regprocedure := pg_catalog.to_regprocedure('postona_x_resv.x_credential_generation(text)');
begin
  if pg_catalog.to_regprocedure('public.x_posting_credential_for(text)') is not null then
    raise exception 'X_CREDENTIAL_FOR_PRECONDITION_ALREADY_APPLIED';
  end if;
  select c.relowner into v_owner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass;
  if v_owner is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
     or (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'X_CREDENTIAL_FOR_PRECONDITION_OWNER';
  end if;
  if pg_catalog.to_regprocedure('public.x_posting_credential_row(text)') is null then
    raise exception 'X_CREDENTIAL_FOR_PRECONDITION_G4';
  end if;
  -- F3's generation: text, STABLE (so it reads the caller's snapshot), definer of the same owner, no API role.
  if v_fn is null
     or (select p.prorettype from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from 'pg_catalog.text'::regtype
     or (select p.provolatile from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from 's'
     or (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner
     or exists (select 1 from pg_catalog.pg_roles r
                where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                  and pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE')) then
    raise exception 'X_CREDENTIAL_FOR_PRECONDITION_F3_GENERATION';
  end if;
end $$;

create function public.x_posting_credential_for(p_social_account_id text) returns table (token text, generation text)
language sql stable security definer set search_path = '' as $$
  select r.token, g.generation
  from public.x_posting_credential_row(p_social_account_id) r
  cross join lateral (select postona_x_resv.x_credential_generation(p_social_account_id) as generation) g
  where g.generation ~ '^[0-9a-f]{64}$'
$$;
revoke all on function public.x_posting_credential_for(text) from public, anon, authenticated, service_role;

do $$
declare
  v_owner oid := (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass);
begin
  if exists (select 1 from pg_catalog.pg_roles r
             where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
               and pg_catalog.has_function_privilege(r.oid, 'public.x_posting_credential_for(text)', 'EXECUTE'))
     or not exists (select 1 from pg_catalog.pg_proc p
                    where p.oid = 'public.x_posting_credential_for(text)'::regprocedure and p.prosecdef and p.provolatile = 's'
                      and p.proowner = v_owner and p.proconfig = array['search_path=""']) then
    raise exception 'X_CREDENTIAL_FOR_POSTCONDITION_ACL';
  end if;
end $$;

commit;
