-- G3 SOURCE CANDIDATE (2026-10-30, Issue #318 G3-48): rollback of 014_postona_x_resv_g4_verdict.sql. NOT applied anywhere.
-- Restores 001's g4_x_account_verified (DENY) and row_publishable and 006's x_credential_generation verbatim, drops the pin trigger, its
-- function and the claim_credential_generation column. With 001's DENY back nothing is publishable, so a row claimed under 014 is failed
-- at its pre-publish check (never sent). Rows are otherwise not touched.
-- Refuses (nothing changed) when: 014 is not applied, or only part of it is there; the caller is a superuser or does not own the schema,
-- the table and the functions. Postconditions: the three bodies byte for byte (md5), no trigger / column, owners and ACLs unchanged.

begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_n integer := (select pg_catalog.count(*) from pg_catalog.pg_proc p
                  where p.oid in (pg_catalog.to_regprocedure('postona_x_resv.g4_x_account_verified(uuid,text)'), pg_catalog.to_regprocedure('postona_x_resv.x_credential_generation(text)'), pg_catalog.to_regprocedure('postona_x_resv.row_publishable(postona_x_resv.reservations)'))
                    and p.prosrc ~ 'G3_G4_VERDICT')::integer
               + (pg_catalog.to_regprocedure('postona_x_resv.pin_claim_credential()') is not null)::integer
               + (exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = pg_catalog.to_regclass('postona_x_resv.reservations')
                          and t.tgname = 'reservations_claim_credential_pin'))::integer
               + (exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = pg_catalog.to_regclass('postona_x_resv.reservations')
                          and a.attname = 'claim_credential_generation' and not a.attisdropped))::integer;
begin
  if v_n = 0 then
    raise exception 'G3_X_VERDICT_ROLLBACK_NOT_APPLIED';
  end if;
  if v_n <> 6 then
    raise exception 'G3_X_VERDICT_ROLLBACK_PARTIAL_STATE';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from v_owner
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) is distinct from v_owner
     or exists (select 1 from pg_catalog.pg_proc p where p.oid in ('postona_x_resv.g4_x_account_verified(uuid,text)'::pg_catalog.regprocedure, 'postona_x_resv.x_credential_generation(text)'::pg_catalog.regprocedure, 'postona_x_resv.row_publishable(postona_x_resv.reservations)'::pg_catalog.regprocedure) and p.proowner is distinct from v_owner) then
    raise exception 'G3_X_VERDICT_ROLLBACK_OWNER';
  end if;
  perform pg_catalog.set_config('postona_x_verdict.acl', (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      where p.oid in ('postona_x_resv.g4_x_account_verified(uuid,text)'::pg_catalog.regprocedure, 'postona_x_resv.x_credential_generation(text)'::pg_catalog.regprocedure, 'postona_x_resv.row_publishable(postona_x_resv.reservations)'::pg_catalog.regprocedure)
      union all
      select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) a), true);
end $$;

lock table postona_x_resv.reservations in share row exclusive mode;

drop trigger reservations_claim_credential_pin on postona_x_resv.reservations;
drop function postona_x_resv.pin_claim_credential();

-- 001's g4_x_account_verified, verbatim
create or replace function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  -- G4 contract (Issue #131): true only for an X account whose platform identity was proven by the reviewed
  -- OAuth flow for exactly this user and whose publish permission is on. Not implemented in G3: always false.
  select false
$$;

-- 001's row_publishable, verbatim
create or replace function postona_x_resv.row_publishable(p_row postona_x_resv.reservations) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_approval text;
begin
  if p_row.origin <> 'user_authored' then
    return false;  -- AI text generation is not available in V1: AI slots are never claimed
  end if;
  if p_row.consent_state <> 'confirmed' or p_row.consent_sha256 is distinct from p_row.content_sha256
     or p_row.consent_scheduled_at is distinct from p_row.scheduled_at or p_row.consent_revision is distinct from p_row.revision then
    return false;
  end if;
  if not exists (select 1 from public.brand_memberships bm
                 where bm.brand_id = p_row.brand_id and bm.user_id = p_row.user_id and bm.role = 'owner') then
    return false;
  end if;
  if not exists (select 1 from public.social_accounts sa where sa.id = p_row.social_account_id and sa.brand_id = p_row.brand_id and sa.platform = 'x') then
    return false;
  end if;
  -- G3-38: still the owner epoch / lifecycle version the row was made under (G5 W1); unbound or changed -> not publishable.
  if postona_x_resv.g5_bound_state(p_row) is distinct from 'active' then
    return false;
  end if;
  return postona_x_resv.g5_x_autopost_allowed(p_row.user_id) is true
     and postona_x_resv.g4_x_account_verified(p_row.user_id, p_row.social_account_id) is true;
end $$;

-- 006's x_credential_generation, verbatim
create or replace function postona_x_resv.x_credential_generation(p_social_account_id text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_sa public.social_accounts%rowtype; v_refresh_generation bigint; v_refresh_status text;
begin
  select sa.* into v_sa from public.social_accounts sa where sa.id = p_social_account_id;
  if v_sa.id is null then
    return null;
  end if;
  if to_regclass('public.x_account_refresh_state_v2') is not null then
    execute 'select st.generation, st.status from public.x_account_refresh_state_v2 st where st.social_account_id = $1'
      into v_refresh_generation, v_refresh_status using p_social_account_id;
  end if;
  return pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'v', 1, 'account', v_sa.id, 'brand', v_sa.brand_id, 'owner', private.account_lifecycle_brand_owner(v_sa.brand_id),
    'platform_user_id', v_sa.platform_user_id, 'access', v_sa.vault_access_token_secret_id, 'refresh', v_sa.vault_refresh_token_secret_id,
    'connection', v_sa.connection_status, 'verified_at', v_sa.verified_at, 'account_updated_at', v_sa.updated_at,
    'refresh_generation', v_refresh_generation, 'refresh_status', v_refresh_status)::text, 'UTF8')), 'hex');
end $$;

alter table postona_x_resv.reservations drop column claim_credential_generation;

do $$
begin
  if (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      where p.oid in ('postona_x_resv.g4_x_account_verified(uuid,text)'::pg_catalog.regprocedure, 'postona_x_resv.x_credential_generation(text)'::pg_catalog.regprocedure, 'postona_x_resv.row_publishable(postona_x_resv.reservations)'::pg_catalog.regprocedure)
      union all
      select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) a) is distinct from pg_catalog.current_setting('postona_x_verdict.acl', true) then
    raise exception 'G3_X_VERDICT_ROLLBACK_POSTCONDITION: an owner or ACL changed';
  end if;
  if pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.g4_x_account_verified(uuid,text)'))) <> 'bda0085cca4760fc2e2fe42613271c09' or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.x_credential_generation(text)'))) <> '9120b307b47a3677cac7030997ce7fcb' or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.row_publishable(postona_x_resv.reservations)'))) <> 'ad72a6f540c1a2850abcb17ff4bcc90f' then
    raise exception 'G3_X_VERDICT_ROLLBACK_POSTCONDITION: not 001''s / 006''s functions';
  end if;
end $$;

commit;
