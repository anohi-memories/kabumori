-- G3 SOURCE CANDIDATE (2026-10-30, Issue #318 G3-48): X reservations / single post consume G4's real publish-credential verdict. NOT
-- applied anywhere. Applied after 001-006 (+ 008 / 010 / 012 when in use) and after G4's verdict 001 + 002
-- (supabase/candidates/postona_g4_credential_verdict/, G4 head c6df19cc612ad586126e80b009589ef3456b215f, PR #579 / #580); rolled back with
-- 014_..._rollback.sql (before G4's verdict rollback and before 006's / 001's rollbacks).
--   g4_x_account_verified(user, account): G4's X verdict `verified` for exactly this person and account; anything else -> false. Only
--     `verified` is acted on.
--   x_credential_generation(account): for the account's workspace owner, sha256 hex of 'g3x1|' || G4's credential_generation
--     (g4x1:<connection_epoch>: +1 on every completed connect and every disconnect) when `verified`, else NULL. 64 hex, so single post's
--     binding (006) stays as it is: bound at begin, compared in post_now_preflight (CREDENTIAL_CHANGED, never sent).
--   reservations.claim_credential_generation (new column) + trigger reservations_claim_credential_pin: when the dispatcher claims a row
--     (planned -> claimed, not single post) the generation is pinned; back to planned clears it.
--   row_publishable (001's body + one check): a dispatcher-claimed row is publishable only while its pinned generation equals the current
--     one, so pre_publish_check (004, unchanged) fails it (NOT_PUBLISHABLE_AT_SEND, never sent) after a disconnect / reconnect / A->B->A
--     between claim and send. G5's lifecycle stays G3's own check (g5_bound_state / MV), never mixed with this value.
-- No GRANT: G4's function is owner-only and is called as the owner of these SECURITY DEFINER functions (the same non-superuser
-- lifecycle owner, checked).
-- Refuses (nothing changed) when: 001's / 006's three functions are not there byte for byte (already applied, another version, a test
-- double); G4's verdict is not the reviewed one; the caller is a superuser or does not own the schema, the table and the functions.
-- Postconditions: owners and ACLs unchanged; the trigger function reachable by no API / worker role.

begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user); v_g4 oid;
begin
  if pg_catalog.to_regprocedure('postona_x_resv.g4_x_account_verified(uuid,text)') is null or pg_catalog.to_regprocedure('postona_x_resv.x_credential_generation(text)') is null or pg_catalog.to_regprocedure('postona_x_resv.row_publishable(postona_x_resv.reservations)') is null
     or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.g4_x_account_verified(uuid,text)'))) <> 'bda0085cca4760fc2e2fe42613271c09'
     or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.x_credential_generation(text)'))) <> '9120b307b47a3677cac7030997ce7fcb'
     or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.row_publishable(postona_x_resv.reservations)'))) <> 'ad72a6f540c1a2850abcb17ff4bcc90f'
     or exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = 'postona_x_resv.reservations'::pg_catalog.regclass
                and a.attname = 'claim_credential_generation' and not a.attisdropped)
     or pg_catalog.to_regprocedure('postona_x_resv.pin_claim_credential()') is not null then
    raise exception 'G3_X_VERDICT_BASE_UNKNOWN';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from v_owner
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) is distinct from v_owner
     or exists (select 1 from pg_catalog.pg_proc p where p.oid in ('postona_x_resv.g4_x_account_verified(uuid,text)'::pg_catalog.regprocedure, 'postona_x_resv.x_credential_generation(text)'::pg_catalog.regprocedure, 'postona_x_resv.row_publishable(postona_x_resv.reservations)'::pg_catalog.regprocedure) and p.proowner is distinct from v_owner) then
    raise exception 'G3_X_VERDICT_OWNER';
  end if;
  -- G4's verdict: the exact signature, return shape, owner (this role), SECURITY DEFINER, md5 (G4 head c6df19cc, PR #579 / #580),
  -- owner-only ACL. Anything else: not the reviewed function -> refuse (no GRANT is made here).
  v_g4 := pg_catalog.to_regprocedure('postona_g4_credential.x_publish_credential_verdict(uuid,text)');
  if v_g4 is null
     or (select p.proowner from pg_catalog.pg_proc p where p.oid = v_g4) is distinct from v_owner
     or not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_g4)
     or pg_catalog.pg_get_function_result(v_g4) is distinct from 'TABLE(verified boolean, credential_generation text, code text)'
     or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = v_g4)) is distinct from '46643d50a4a6c6a82867061328de05bf'
     or (select p.proacl from pg_catalog.pg_proc p where p.oid = v_g4) is null
     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a where p.oid = v_g4 and a.grantee <> v_owner) then
    raise exception 'G3_X_VERDICT_G4_VERDICT_UNKNOWN';
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

alter table postona_x_resv.reservations add column claim_credential_generation text
  check (claim_credential_generation is null or claim_credential_generation ~ '^[0-9a-f]{64}$');

/** G4's X verdict for exactly this person and account (G3-48): true only when G4 answers verified. */
create or replace function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  -- G3_G4_VERDICT (G3-48)
  select coalesce((select v.verified from postona_g4_credential.x_publish_credential_verdict(p_user_id, p_social_account_id) v), false) is true
$$;

/** The credential generation of one X account (64 lowercase hex) from G4's verdict, or NULL when it is not verified. Internal. */
create or replace function postona_x_resv.x_credential_generation(p_social_account_id text) returns text
language plpgsql stable security definer set search_path = '' as $$
-- G3_G4_VERDICT (G3-48)
declare v_brand text; v_owner uuid; v_verified boolean; v_generation text;
begin
  select sa.brand_id into v_brand from public.social_accounts sa where sa.id = p_social_account_id and sa.platform = 'x';
  if v_brand is null then
    return null;
  end if;
  v_owner := private.account_lifecycle_brand_owner(v_brand);
  if v_owner is null then
    return null;
  end if;
  select v.verified, v.credential_generation into v_verified, v_generation
    from postona_g4_credential.x_publish_credential_verdict(v_owner, p_social_account_id) v;
  if v_verified is not true or v_generation is null then
    return null;
  end if;
  return pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('g3x1|' || v_generation, 'UTF8')), 'hex');
end $$;

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
  -- G3_G4_VERDICT (G3-48): a reservation claimed by the dispatcher is sent only with the credential generation pinned at its claim.
  if p_row.status = 'claimed' and p_row.claimed_by is distinct from 'single_post'
     and (p_row.claim_credential_generation is null
          or p_row.claim_credential_generation is distinct from postona_x_resv.x_credential_generation(p_row.social_account_id)) then
    return false;
  end if;
  return postona_x_resv.g5_x_autopost_allowed(p_row.user_id) is true
     and postona_x_resv.g4_x_account_verified(p_row.user_id, p_row.social_account_id) is true;
end $$;

/** Pins the credential generation when the dispatcher claims a row; clears it when the row goes back to planned. */
create function postona_x_resv.pin_claim_credential() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
-- G3_G4_VERDICT (G3-48)
begin
  if new.status = 'claimed' and old.status is distinct from 'claimed' and new.claimed_by is distinct from 'single_post' then
    new.claim_credential_generation := postona_x_resv.x_credential_generation(new.social_account_id);
  elsif new.status = 'planned' then
    new.claim_credential_generation := null;
  end if;
  return new;
end $$;
revoke all on function postona_x_resv.pin_claim_credential() from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;

create trigger reservations_claim_credential_pin before update of status on postona_x_resv.reservations
for each row execute function postona_x_resv.pin_claim_credential();

do $$
declare v_role text;
begin
  if (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      where p.oid in ('postona_x_resv.g4_x_account_verified(uuid,text)'::pg_catalog.regprocedure, 'postona_x_resv.x_credential_generation(text)'::pg_catalog.regprocedure, 'postona_x_resv.row_publishable(postona_x_resv.reservations)'::pg_catalog.regprocedure)
      union all
      select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) a) is distinct from pg_catalog.current_setting('postona_x_verdict.acl', true) then
    raise exception 'G3_X_VERDICT_POSTCONDITION: an owner or ACL changed';
  end if;
  foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'postona_resv_api', 'postona_resv_worker'] loop
    if pg_catalog.has_function_privilege(v_role, 'postona_x_resv.pin_claim_credential()', 'EXECUTE') then
      raise exception 'G3_X_VERDICT_POSTCONDITION: % executes the pin trigger function', v_role;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_proc p where p.oid in ('postona_x_resv.g4_x_account_verified(uuid,text)'::pg_catalog.regprocedure, 'postona_x_resv.x_credential_generation(text)'::pg_catalog.regprocedure, 'postona_x_resv.row_publishable(postona_x_resv.reservations)'::pg_catalog.regprocedure)
             and (p.prosrc !~ 'G3_G4_VERDICT' or not p.prosecdef or p.provolatile <> 's'))
     or not exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'postona_x_resv.reservations'::pg_catalog.regclass
                    and t.tgname = 'reservations_claim_credential_pin' and t.tgenabled = 'O') then
    raise exception 'G3_X_VERDICT_POSTCONDITION: not applied';
  end if;
end $$;

commit;
