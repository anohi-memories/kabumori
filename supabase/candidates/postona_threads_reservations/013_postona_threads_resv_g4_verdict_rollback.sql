-- G3 SOURCE CANDIDATE (2026-10-30, Issue #318 G3-48): rollback of 013_postona_threads_resv_g4_verdict.sql. NOT applied anywhere.
-- Restores 007's g4_threads_account_verified (DENY) and threads_credential_generation verbatim. Rows are not touched: a claimed row
-- whose bound_generation came from G4's verdict no longer matches 007's value, so its preflight fails it (CREDENTIAL_CHANGED, never sent).
-- Refuses (nothing changed) when: 013 is not applied, or only part of it is there; the caller is a superuser or does not own the schema,
-- the table and both functions. Postconditions: both bodies byte for byte (md5), owners and ACLs unchanged.

begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_a boolean := coalesce((select p.prosrc ~ 'G3_G4_VERDICT' from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_threads_resv.g4_threads_account_verified(uuid,text)')), false);
  v_b boolean := coalesce((select p.prosrc ~ 'G3_G4_VERDICT' from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_threads_resv.threads_credential_generation(text)')), false);
begin
  if not (v_a or v_b) then
    raise exception 'G3_THREADS_VERDICT_ROLLBACK_NOT_APPLIED';
  end if;
  if not (v_a and v_b) then
    raise exception 'G3_THREADS_VERDICT_ROLLBACK_PARTIAL_STATE';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_threads_resv') is distinct from v_owner
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'postona_threads_resv.reservations'::pg_catalog.regclass) is distinct from v_owner
     or exists (select 1 from pg_catalog.pg_proc p where p.oid in ('postona_threads_resv.g4_threads_account_verified(uuid,text)'::pg_catalog.regprocedure, 'postona_threads_resv.threads_credential_generation(text)'::pg_catalog.regprocedure) and p.proowner is distinct from v_owner) then
    raise exception 'G3_THREADS_VERDICT_ROLLBACK_OWNER';
  end if;
  perform pg_catalog.set_config('postona_threads_verdict.acl', (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      where p.oid in ('postona_threads_resv.g4_threads_account_verified(uuid,text)'::pg_catalog.regprocedure, 'postona_threads_resv.threads_credential_generation(text)'::pg_catalog.regprocedure)
      union all
      select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      where c.oid = 'postona_threads_resv.reservations'::pg_catalog.regclass) a), true);
end $$;

-- 007's g4_threads_account_verified, verbatim
create or replace function postona_threads_resv.g4_threads_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$ select false $$;

-- 007's threads_credential_generation, verbatim
create or replace function postona_threads_resv.threads_credential_generation(p_social_account_id text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_sa public.social_accounts%rowtype; v_custody jsonb; v_lease jsonb;
begin
  select sa.* into v_sa from public.social_accounts sa where sa.id = p_social_account_id and sa.platform = 'threads';
  if v_sa.id is null then
    return null;
  end if;
  if to_regclass('public.threads_account_credential_custody') is not null then
    execute 'select pg_catalog.jsonb_build_object(''secret'', c.vault_secret_id, ''expires'', c.expires_at, ''recorded'', c.recorded_at)
             from public.threads_account_credential_custody c where c.social_account_id = $1' into v_custody using p_social_account_id;
  end if;
  if to_regclass('public.threads_credential_refresh_leases') is not null then
    execute 'select pg_catalog.jsonb_build_object(''lease'', l.lease_id, ''secret'', l.vault_secret_id)
             from public.threads_credential_refresh_leases l where l.social_account_id = $1' into v_lease using p_social_account_id;
  end if;
  return pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'v', 1, 'provider', 'threads', 'account', v_sa.id, 'brand', v_sa.brand_id, 'owner', private.account_lifecycle_brand_owner(v_sa.brand_id),
    'platform_user_id', v_sa.platform_user_id, 'access', v_sa.vault_access_token_secret_id, 'connection', v_sa.connection_status,
    'verified_at', v_sa.verified_at, 'account_updated_at', v_sa.updated_at, 'custody', v_custody, 'refresh_lease', v_lease)::text, 'UTF8')), 'hex');
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
    raise exception 'G3_THREADS_VERDICT_ROLLBACK_POSTCONDITION: an owner or ACL changed';
  end if;
  if pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_threads_resv.g4_threads_account_verified(uuid,text)'))) <> '3ab0d7f01cf01c94c66d65befa4bd505' or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_threads_resv.threads_credential_generation(text)'))) <> 'b0ee9544c4e7118335478bf2c39e2e3f' then
    raise exception 'G3_THREADS_VERDICT_ROLLBACK_POSTCONDITION: not 007''s functions';
  end if;
end $$;

commit;
