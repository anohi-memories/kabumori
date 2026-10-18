-- SOURCE CANDIDATE ONLY. NOT a migration, NOT applied anywhere (F4 / G4,
-- postona-f4-m1-x-identity-verified-credential-port-source-20261018; J2 V2 P2x2 fix by F4,
-- postona-f4-pr276-j2-p2x2-provenance-owner-epoch-atomic-credential-fix-20261018; Issue #131 minimal source, Issue #269).
-- Apply as a single reviewed file only AFTER: the live X onboarding (20260919120000 + 20260922003101), the X refresh
-- core's state (20260925140000), G5/F5's lifecycle (Phase 3b T13 guard, Phase 4, the F5 workspace service state
-- 20261012230000) AND F5's workspace owner epoch (PROPOSED F5 interface, not yet delivered -- see the doc, section 7),
-- PR #124's provisioner (T9) and G4's X v2 candidate with its attestation record (postona_x_oauth_hardening_candidate.sql).
-- It changes none of them and grants nothing to any API role.
--
-- POSTONA X, M1 (the first manual single X text post): what G4 owns between "the person may post" (F5 / F3) and the
-- one POST /2/tweets (F3's sender) -- whose X identity this is, and whose token it is.
--
--   public.x_account_attested_owner(account) -> uuid       the person an X account is verified for, or null
--       Only while the account still holds EXACTLY the credential G4's attested connect recorded
--       (public.x_account_identity_attestations): the SHA-256 of the access and refresh tokens in Vault equal the
--       digests the Edge signed (or that G4 re-attested after a server refresh) -- content, never a timestamp, so a
--       live (v1) complete or any other credential write, even inside the very transaction of the attested connect,
--       unverifies the account (J2 V2 R1); F5's workspace owner epoch still equals the one read when attested, so any
--       owner change, A -> B -> A included, unverifies it for good (J2 V2 R2); same person, workspace, X user id, both
--       Vault references and verified_at; a self-service workspace whose single owner (F5's rule) is that person;
--       identity_verified, no connection error; references that are this row's alone; no deletion in progress.
--   public.x_account_g4_verified(user, account) -> boolean  PR #257's K1-K6: the attested owner IS this user and that
--       person's POSTONA (x_autopost) is active by F5's read-only decision. Never true for anyone else.
--   public.x_posting_credential_row(account) -> (token, user)  internal, STABLE: everything above, F5 active, the
--       refresh state idle and the access token more than 2 minutes from its recorded expiry -- with the token read in
--       the SAME snapshot as the decision (STABLE: it runs in the caller's statement snapshot).
--   public.x_posting_access_token_for(account) -> text      SERVER ONLY (owner EXECUTE only): that row's token or null
--       -- never an error for "not connected" (PR #257 C3).
--   public.x_account_attest_refreshed_credential(account, access_sha256, refresh_sha256) -> boolean   SERVER ONLY.
--       The refresh writer (the refresh core's owner; integration not done here) calls it in the transaction that
--       committed a refresh, with the digests of the tokens X returned: it re-attests only when the stored tokens are
--       exactly those (a write slipped in between makes it refuse), the refresh state is idle with a newer generation,
--       and everything else is still the attested connection. Without it a refreshed token is never handed over.
-- F3's generation-bound port (PR #278 credentialFor -> {token, generation}) is 003, after F3's 006.
begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_owner oid;
  v_fn regprocedure;
begin
  if pg_catalog.to_regprocedure('public.x_posting_access_token_for(text)') is not null
     or pg_catalog.to_regprocedure('public.x_account_attested_owner(text)') is not null then
    raise exception 'X_IDENTITY_CREDENTIAL_PRECONDITION_ALREADY_APPLIED';
  end if;
  select c.relowner into v_owner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass;
  if v_owner is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
     or (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'X_IDENTITY_CREDENTIAL_PRECONDITION_OWNER';
  end if;
  -- G4's attested connect (PR #126 with the F4 record): the record with its content digests and owner epoch, complete_v2.
  if pg_catalog.to_regclass('public.x_account_identity_attestations') is null
     or (select c.relowner from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('public.x_account_identity_attestations')) is distinct from v_owner
     or (select pg_catalog.count(*) from pg_catalog.pg_attribute a
         where a.attrelid = pg_catalog.to_regclass('public.x_account_identity_attestations') and not a.attisdropped
           and a.attname in ('social_account_id', 'attestation_id', 'user_id', 'brand_id', 'platform_user_id',
                             'vault_access_token_secret_id', 'vault_refresh_token_secret_id', 'verified_at', 'attested_at',
                             'access_token_sha256', 'refresh_token_sha256', 'owner_epoch', 'refresh_generation', 'access_expires_at')) <> 14
     or pg_catalog.to_regprocedure('public.complete_social_mobile_x_oauth_connection_v2(uuid,text,text,text,text,text)') is null
     or (select p.prosrc from pg_catalog.pg_proc p
         where p.oid = pg_catalog.to_regprocedure('public.complete_social_mobile_x_oauth_connection_v2(uuid,text,text,text,text,text)'))
        !~ 'insert into public\.x_account_identity_attestations' then
    raise exception 'X_IDENTITY_CREDENTIAL_PRECONDITION_ATTESTATION';
  end if;
  -- F5: the owner rule, the read-only state decision and the owner epoch, owner-only definer functions no API role reaches.
  foreach v_fn in array array[pg_catalog.to_regprocedure('private.account_lifecycle_brand_owner(text)'),
                              pg_catalog.to_regprocedure('private.account_lifecycle_service_state_readonly(uuid,text)'),
                              pg_catalog.to_regprocedure('private.account_lifecycle_brand_owner_epoch(text)')] loop
    if v_fn is null
       or (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner
       or not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_fn)
       or exists (select 1 from pg_catalog.pg_roles r
                  where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                    and (pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE') or pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER'))) then
      raise exception 'X_IDENTITY_CREDENTIAL_PRECONDITION_F5';
    end if;
  end loop;
  -- The refresh core's state (read; the refresh itself is not done here), the deletion tombstone, Vault.
  if pg_catalog.to_regclass('public.x_account_refresh_state_v2') is null
     or (select pg_catalog.count(*) from pg_catalog.pg_attribute a
         where a.attrelid = pg_catalog.to_regclass('public.x_account_refresh_state_v2') and not a.attisdropped
           and a.attname in ('social_account_id', 'status', 'generation', 'access_expires_at')) <> 4
     or pg_catalog.to_regclass('public.social_mobile_account_deletions') is null
     or (select pg_catalog.count(*) from pg_catalog.pg_attribute a
         where a.attrelid = pg_catalog.to_regclass('vault.decrypted_secrets') and a.attname in ('id', 'decrypted_secret')) <> 2 then
    raise exception 'X_IDENTITY_CREDENTIAL_PRECONDITION_SHAPE';
  end if;
end $$;

create function public.x_account_attested_owner(p_social_account_id text) returns uuid
language sql stable security definer set search_path = '' as $$
  select a.user_id
  from public.social_accounts sa
  join public.x_account_identity_attestations a on a.social_account_id = sa.id
  where sa.id = p_social_account_id and sa.platform = 'x'
    and sa.connection_status = 'identity_verified' and sa.last_connection_error_code is null
    and sa.platform_user_id is not null and sa.verified_at is not null
    and sa.vault_access_token_secret_id is not null and sa.vault_refresh_token_secret_id is not null
    and sa.vault_access_token_secret_id <> sa.vault_refresh_token_secret_id
    and a.brand_id = sa.brand_id and a.platform_user_id = sa.platform_user_id
    and a.vault_access_token_secret_id = sa.vault_access_token_secret_id
    and a.vault_refresh_token_secret_id = sa.vault_refresh_token_secret_id
    and a.verified_at = sa.verified_at
    -- R1: exactly the credential that was signed (or re-attested): the stored tokens' content, not a timestamp.
    and (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(d.decrypted_secret, 'UTF8')), 'hex')
         from vault.decrypted_secrets d where d.id = sa.vault_access_token_secret_id) = a.access_token_sha256
    and (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(d.decrypted_secret, 'UTF8')), 'hex')
         from vault.decrypted_secrets d where d.id = sa.vault_refresh_token_secret_id) = a.refresh_token_sha256
    -- R2: no owner write since the attestation (F5's monotonic epoch), and still the single owner (F5's rule).
    and private.account_lifecycle_brand_owner_epoch(sa.brand_id) = a.owner_epoch
    and private.account_lifecycle_brand_owner(sa.brand_id) = a.user_id
    -- The references are this row's alone.
    and not exists (select 1 from public.social_accounts o
                    where o.id <> sa.id
                      and (o.vault_access_token_secret_id in (sa.vault_access_token_secret_id, sa.vault_refresh_token_secret_id)
                           or o.vault_refresh_token_secret_id in (sa.vault_access_token_secret_id, sa.vault_refresh_token_secret_id)))
    -- No deletion of the workspace in progress (the X deletion saga's tombstone).
    and not exists (select 1 from public.social_mobile_account_deletions d where d.workspace_id = sa.brand_id)
$$;

create function public.x_account_g4_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_user_id is not null
                  and public.x_account_attested_owner(p_social_account_id) = p_user_id
                  and private.account_lifecycle_service_state_readonly(p_user_id, 'x_autopost') is null, false)
$$;

-- STABLE on purpose: it runs in the snapshot of the statement that calls it, so the decision and the token it returns
-- (and, in 003, F3's generation) are read together. clock_timestamp() is only the expiry bound.
create function public.x_posting_credential_row(p_social_account_id text) returns table (token text, user_id uuid)
language sql stable security definer set search_path = '' as $$
  select d.decrypted_secret, a.user_id
  from public.social_accounts sa
  join public.x_account_identity_attestations a on a.social_account_id = sa.id
  join vault.decrypted_secrets d on d.id = sa.vault_access_token_secret_id
  left join public.x_account_refresh_state_v2 st on st.social_account_id = sa.id
  where p_social_account_id ~ '^[a-z][a-z0-9_]{1,80}$'
    and sa.id = p_social_account_id
    and public.x_account_attested_owner(sa.id) = a.user_id
    and private.account_lifecycle_service_state_readonly(a.user_id, 'x_autopost') is null
    and coalesce(st.status, 'idle') = 'idle'
    and a.access_expires_at > pg_catalog.clock_timestamp() + interval '2 minutes'
    and d.decrypted_secret ~ '^[!-~]+$' and pg_catalog.length(d.decrypted_secret) between 16 and 4096
$$;

create function public.x_posting_access_token_for(p_social_account_id text) returns text
language sql stable security definer set search_path = '' as $$
  select r.token from public.x_posting_credential_row(p_social_account_id) r
$$;

create function public.x_account_attest_refreshed_credential(p_social_account_id text, p_access_token_sha256 text,
                                                            p_refresh_token_sha256 text) returns boolean
language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_sa public.social_accounts%rowtype;
  v_a public.x_account_identity_attestations%rowtype;
  v_status text;
  v_generation bigint;
  v_expires timestamptz;
begin
  if p_social_account_id is null or p_social_account_id !~ '^[a-z][a-z0-9_]{1,80}$'
     or p_access_token_sha256 is null or p_access_token_sha256 !~ '^[0-9a-f]{64}$'
     or p_refresh_token_sha256 is null or p_refresh_token_sha256 !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  select sa.* into v_sa from public.social_accounts sa where sa.id = p_social_account_id for share;
  select a.* into v_a from public.x_account_identity_attestations a where a.social_account_id = p_social_account_id for update;
  select st.status, st.generation, st.access_expires_at into v_status, v_generation, v_expires
    from public.x_account_refresh_state_v2 st where st.social_account_id = p_social_account_id;
  if v_sa.id is null or v_a.social_account_id is null or v_generation is null
     or v_status is distinct from 'idle' or v_generation <= v_a.refresh_generation
     or v_expires is null or v_expires <= pg_catalog.clock_timestamp() or v_expires > pg_catalog.clock_timestamp() + interval '1 day'
     -- Still the attested connection in everything but the token content.
     or v_sa.platform is distinct from 'x' or v_sa.connection_status is distinct from 'identity_verified'
     or v_sa.last_connection_error_code is not null
     or v_sa.brand_id is distinct from v_a.brand_id or v_sa.platform_user_id is distinct from v_a.platform_user_id
     or v_sa.vault_access_token_secret_id is distinct from v_a.vault_access_token_secret_id
     or v_sa.vault_refresh_token_secret_id is distinct from v_a.vault_refresh_token_secret_id
     or v_sa.verified_at is distinct from v_a.verified_at
     or private.account_lifecycle_brand_owner_epoch(v_sa.brand_id) is distinct from v_a.owner_epoch
     or private.account_lifecycle_brand_owner(v_sa.brand_id) is distinct from v_a.user_id
     -- The stored tokens are exactly the ones the refresh writer got from X (nothing slipped in between).
     or (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(d.decrypted_secret, 'UTF8')), 'hex')
         from vault.decrypted_secrets d where d.id = v_sa.vault_access_token_secret_id) is distinct from p_access_token_sha256
     or (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(d.decrypted_secret, 'UTF8')), 'hex')
         from vault.decrypted_secrets d where d.id = v_sa.vault_refresh_token_secret_id) is distinct from p_refresh_token_sha256 then
    return false;
  end if;
  update public.x_account_identity_attestations a
     set access_token_sha256 = p_access_token_sha256, refresh_token_sha256 = p_refresh_token_sha256,
         refresh_generation = v_generation, access_expires_at = v_expires
   where a.social_account_id = p_social_account_id;
  return true;
exception
  when lock_not_available or deadlock_detected then
    return false;
end;
$$;

revoke all on function public.x_account_attested_owner(text), public.x_account_g4_verified(uuid, text),
                       public.x_posting_credential_row(text), public.x_posting_access_token_for(text),
                       public.x_account_attest_refreshed_credential(text, text, text)
  from public, anon, authenticated, service_role;

-- Postcondition: five definer functions of the owner, empty search_path, EXECUTE for the owner only, no API role
-- reaching them directly or through a membership.
do $$
declare
  v_owner oid := (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass);
begin
  if exists (select 1 from pg_catalog.pg_proc p
             where p.oid in ('public.x_account_attested_owner(text)'::regprocedure, 'public.x_account_g4_verified(uuid,text)'::regprocedure,
                             'public.x_posting_credential_row(text)'::regprocedure, 'public.x_posting_access_token_for(text)'::regprocedure,
                             'public.x_account_attest_refreshed_credential(text,text,text)'::regprocedure)
               and (not p.prosecdef or p.proowner is distinct from v_owner or not coalesce(p.proconfig @> array['search_path=""'], false)))
     or exists (select 1 from pg_catalog.pg_roles r,
                              (values ('public.x_account_attested_owner(text)'), ('public.x_account_g4_verified(uuid,text)'),
                                      ('public.x_posting_credential_row(text)'), ('public.x_posting_access_token_for(text)'),
                                      ('public.x_account_attest_refreshed_credential(text,text,text)')) f(fn)
                where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                  and (pg_catalog.has_function_privilege(r.oid, f.fn::regprocedure, 'EXECUTE') or pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER'))) then
    raise exception 'X_IDENTITY_CREDENTIAL_POSTCONDITION_ACL';
  end if;
end $$;

commit;
