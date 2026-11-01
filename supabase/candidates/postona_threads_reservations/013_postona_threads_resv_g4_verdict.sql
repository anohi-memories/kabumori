-- G3 SOURCE CANDIDATE (2026-10-30, Issue #318 G3-48): Threads reservations consume G4's real publish-credential verdict. NOT applied
-- anywhere. Applied after 007 (+ 009 / 011 when in use) and after G4's verdict 001 (supabase/candidates/postona_g4_credential_verdict/,
-- G4 head c6df19cc612ad586126e80b009589ef3456b215f, PR #579 / #580); rolled back with 013_..._rollback.sql (before G4's verdict rollback).
--   g4_threads_account_verified(user, account): G4's verdict `verified` for exactly this person and account; anything else (false, no row,
--     an error is not caught) -> false. Only `verified` is acted on (G4: the codes are for diagnosis only).
--   threads_credential_generation(account): for the account's workspace owner (G5's private.account_lifecycle_brand_owner, both profiles),
--     sha256 hex of 'g3t1|' || G4's credential_generation (g4t1:<binding.oauth_state_id>) when `verified`, else NULL. 64 hex, so 007's
--     bound_generation stays as it is: claim_due stores it, preflight compares it with a fresh one and fails the row (CREDENTIAL_CHANGED,
--     never sent) when it moved or is NULL. A reconnect, a re-bind, a disconnect -> another value or NULL; a token refresh that keeps the
--     person and the Threads user keeps it (G4's contract). G5's lifecycle stays G3's own check (009 / MV), never mixed with this value.
-- No GRANT: G4's function is owner-only and is called as the owner of these SECURITY DEFINER functions, which must be the same
-- non-superuser lifecycle owner (checked). The fence (create, preflight) and claim_due keep every other check they had.
-- Refuses (nothing changed) when: 007's two functions are not there byte for byte (already applied, another version, a test double);
-- G4's verdict is not the reviewed one (signature, shape, owner, md5, owner-only ACL); the caller is a superuser or does not own the
-- schema, the table and both functions. Postconditions: owners and ACLs unchanged.

begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user); v_g4 oid;
begin
  if pg_catalog.to_regprocedure('postona_threads_resv.g4_threads_account_verified(uuid,text)') is null or pg_catalog.to_regprocedure('postona_threads_resv.threads_credential_generation(text)') is null
     or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_threads_resv.g4_threads_account_verified(uuid,text)'))) <> '3ab0d7f01cf01c94c66d65befa4bd505'
     or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_threads_resv.threads_credential_generation(text)'))) <> 'b0ee9544c4e7118335478bf2c39e2e3f' then
    raise exception 'G3_THREADS_VERDICT_BASE_UNKNOWN';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_threads_resv') is distinct from v_owner
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'postona_threads_resv.reservations'::pg_catalog.regclass) is distinct from v_owner
     or exists (select 1 from pg_catalog.pg_proc p where p.oid in ('postona_threads_resv.g4_threads_account_verified(uuid,text)'::pg_catalog.regprocedure, 'postona_threads_resv.threads_credential_generation(text)'::pg_catalog.regprocedure) and p.proowner is distinct from v_owner) then
    raise exception 'G3_THREADS_VERDICT_OWNER';
  end if;
  -- G4's verdict: the exact signature, return shape, owner (this role), SECURITY DEFINER, md5 (G4 head c6df19cc, PR #579 / #580),
  -- owner-only ACL. Anything else: not the reviewed function -> refuse (no GRANT is made here).
  v_g4 := pg_catalog.to_regprocedure('postona_g4_credential.threads_publish_credential_verdict(uuid,text)');
  if v_g4 is null
     or (select p.proowner from pg_catalog.pg_proc p where p.oid = v_g4) is distinct from v_owner
     or not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_g4)
     or pg_catalog.pg_get_function_result(v_g4) is distinct from 'TABLE(verified boolean, credential_generation text, code text)'
     or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = v_g4)) is distinct from 'fb93a0ad84c44c6781521eec4618fff4'
     or (select p.proacl from pg_catalog.pg_proc p where p.oid = v_g4) is null
     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a where p.oid = v_g4 and a.grantee <> v_owner) then
    raise exception 'G3_THREADS_VERDICT_G4_VERDICT_UNKNOWN';
  end if;
  perform pg_catalog.set_config('postona_threads_verdict.acl', (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      where p.oid in ('postona_threads_resv.g4_threads_account_verified(uuid,text)'::pg_catalog.regprocedure, 'postona_threads_resv.threads_credential_generation(text)'::pg_catalog.regprocedure)
      union all
      select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      where c.oid = 'postona_threads_resv.reservations'::pg_catalog.regclass) a), true);
end $$;

/** G4's verdict for exactly this person and Threads account (G3-48): true only when G4 answers verified. */
create or replace function postona_threads_resv.g4_threads_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  -- G3_G4_VERDICT (G3-48)
  select coalesce((select v.verified from postona_g4_credential.threads_publish_credential_verdict(p_user_id, p_social_account_id) v), false) is true
$$;

/** The credential generation of one Threads account (64 lowercase hex) from G4's verdict, or NULL when it is not verified. Internal. */
create or replace function postona_threads_resv.threads_credential_generation(p_social_account_id text) returns text
language plpgsql stable security definer set search_path = '' as $$
-- G3_G4_VERDICT (G3-48)
declare v_brand text; v_owner uuid; v_verified boolean; v_generation text;
begin
  select sa.brand_id into v_brand from public.social_accounts sa where sa.id = p_social_account_id and sa.platform = 'threads';
  if v_brand is null then
    return null;
  end if;
  v_owner := private.account_lifecycle_brand_owner(v_brand);
  if v_owner is null then
    return null;
  end if;
  select v.verified, v.credential_generation into v_verified, v_generation
    from postona_g4_credential.threads_publish_credential_verdict(v_owner, p_social_account_id) v;
  if v_verified is not true or v_generation is null then
    return null;
  end if;
  return pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('g3t1|' || v_generation, 'UTF8')), 'hex');
end $$;

do $$
begin
  if (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      where p.oid in ('postona_threads_resv.g4_threads_account_verified(uuid,text)'::pg_catalog.regprocedure, 'postona_threads_resv.threads_credential_generation(text)'::pg_catalog.regprocedure)
      union all
      select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      where c.oid = 'postona_threads_resv.reservations'::pg_catalog.regclass) a) is distinct from pg_catalog.current_setting('postona_threads_verdict.acl', true) then
    raise exception 'G3_THREADS_VERDICT_POSTCONDITION: an owner or ACL changed';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p where p.oid in ('postona_threads_resv.g4_threads_account_verified(uuid,text)'::pg_catalog.regprocedure, 'postona_threads_resv.threads_credential_generation(text)'::pg_catalog.regprocedure)
             and (p.prosrc !~ 'G3_G4_VERDICT' or not p.prosecdef or p.provolatile <> 's')) then
    raise exception 'G3_THREADS_VERDICT_POSTCONDITION: not applied';
  end if;
end $$;

commit;
