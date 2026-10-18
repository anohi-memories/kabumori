-- SOURCE CANDIDATE ONLY. NOT a migration, NOT applied anywhere (F4 / G4,
-- postona-f4-m1-x-identity-verified-credential-port-source-20261018; Issue #131 minimal source, Issue #269 directive).
-- Apply as a single reviewed file only AFTER: the live X onboarding (20260919120000 + 20260922003101), the X refresh
-- core (20260925140000), G5/F5's lifecycle (Phase 3b T13 guard, Phase 4, the F5 workspace service state 20261012230000),
-- PR #124's provisioner (T9) and G4's X v2 candidate with its attestation record (postona_x_oauth_hardening_candidate.sql).
-- It changes none of them and grants nothing to any API role.
--
-- POSTONA X, M1 (the first manual single X text post): what G4 owns between "the person may post" (F5 / F3) and the
-- one POST /2/tweets (F3's publisher) -- whose X identity this is, and whose token it is.
--
--   public.x_account_attested_owner(account) -> uuid       the person an X account is verified for, or null
--       An account counts only while its row still equals the attested connection G4's complete_v2 recorded
--       (public.x_account_identity_attestations): same person, workspace, X user id, both Vault references and the
--       verified_at that transaction wrote. A live (v1) complete takes the X id and the tokens from the client as
--       given and always rewrites verified_at, so after one the account is NOT verified until the next attested
--       connect. Also: an X row of a self-service workspace whose single owner (F5's rule,
--       private.account_lifecycle_brand_owner) is that person; identity_verified, no connection error, two distinct
--       references that are this row's alone and still name secrets; no deletion of the workspace in progress.
--   public.x_account_g4_verified(user, account) -> boolean  PR #257's K1-K6: the attested owner IS this user, and
--       that person's POSTONA (x_autopost) is active by F5's read-only decision. Never true for anyone else.
--   public.x_account_credential_generation(account) -> text  opaque; null when not verified. Changes on a reconnect
--       (a new attestation), a token refresh (the refresh core's generation), an owner change. F5 PR #275 asks F3 to
--       read it at authorize time and again just before the send, and to refuse on any change.
--   public.x_posting_access_token_for(account) -> text      SERVER ONLY (EXECUTE for the owner; granting it to the
--       worker's role is a separate, coordinated step). The current access token of exactly this account, or null --
--       never an error for "not connected" (PR #257 C3). Decided in ONE statement (one snapshot) right before the
--       handoff: everything x_account_attested_owner checks, the owner's POSTONA active (F5 read-only), the refresh
--       state idle, and the token not within 2 minutes of its expiry. The expiry is the refresh core's
--       access_expires_at when a refresh happened after the attestation, otherwise the attestation time + 2 hours
--       (ASSUMPTION: X's documented 2-hour access-token lifetime; NOT verified against real X; conservative: past it
--       the answer is null and nothing is sent).
--
-- Not here: no refresh is performed (the refresh core is unchanged); no lock spans the call to X (F5 M1-F3); the
-- binding of postona_x_resv.g4_x_account_verified to this predicate is a separate file (002, after F3's ACK); the
-- Edge code exchange that signs the attestation is PR #126's contract. Nothing reads a token except
-- x_posting_access_token_for, and nothing here returns or logs one otherwise.
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
  -- G4's attested connect (PR #126 with the F4 M1 record): the record, owned by the owner, and complete_v2.
  if pg_catalog.to_regclass('public.x_account_identity_attestations') is null
     or (select c.relowner from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('public.x_account_identity_attestations')) is distinct from v_owner
     or (select pg_catalog.count(*) from pg_catalog.pg_attribute a
         where a.attrelid = pg_catalog.to_regclass('public.x_account_identity_attestations') and not a.attisdropped
           and a.attname in ('social_account_id', 'attestation_id', 'user_id', 'brand_id', 'platform_user_id',
                             'vault_access_token_secret_id', 'vault_refresh_token_secret_id', 'verified_at', 'attested_at')) <> 9
     or pg_catalog.to_regprocedure('public.complete_social_mobile_x_oauth_connection_v2(uuid,text,text,text,text,text)') is null
     or (select p.prosrc from pg_catalog.pg_proc p
         where p.oid = pg_catalog.to_regprocedure('public.complete_social_mobile_x_oauth_connection_v2(uuid,text,text,text,text,text)'))
        !~ 'insert into public\.x_account_identity_attestations' then
    raise exception 'X_IDENTITY_CREDENTIAL_PRECONDITION_ATTESTATION';
  end if;
  -- F5: the owner rule and the read-only state decision, owner-only definer functions no API role reaches.
  foreach v_fn in array array[pg_catalog.to_regprocedure('private.account_lifecycle_brand_owner(text)'),
                              pg_catalog.to_regprocedure('private.account_lifecycle_service_state_readonly(uuid,text)')] loop
    if v_fn is null
       or (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner
       or not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_fn)
       or exists (select 1 from pg_catalog.pg_roles r
                  where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                    and (pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE') or pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER'))) then
      raise exception 'X_IDENTITY_CREDENTIAL_PRECONDITION_F5';
    end if;
  end loop;
  -- The refresh core's state (read only here), the deletion tombstone, Vault.
  if pg_catalog.to_regclass('public.x_account_refresh_state_v2') is null
     or (select pg_catalog.count(*) from pg_catalog.pg_attribute a
         where a.attrelid = pg_catalog.to_regclass('public.x_account_refresh_state_v2') and not a.attisdropped
           and a.attname in ('social_account_id', 'status', 'generation', 'access_expires_at', 'last_refreshed_at')) <> 5
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
    -- The attested connection, unchanged since (a live complete rewrites verified_at and the tokens).
    and a.brand_id = sa.brand_id and a.platform_user_id = sa.platform_user_id
    and a.vault_access_token_secret_id = sa.vault_access_token_secret_id
    and a.vault_refresh_token_secret_id = sa.vault_refresh_token_secret_id
    and a.verified_at = sa.verified_at
    -- Still the self-service workspace's single owner (F5's rule: social_mobile_user_v1, exactly one owner).
    and private.account_lifecycle_brand_owner(sa.brand_id) = a.user_id
    -- The references are this row's alone and still name secrets.
    and not exists (select 1 from public.social_accounts o
                    where o.id <> sa.id
                      and (o.vault_access_token_secret_id in (sa.vault_access_token_secret_id, sa.vault_refresh_token_secret_id)
                           or o.vault_refresh_token_secret_id in (sa.vault_access_token_secret_id, sa.vault_refresh_token_secret_id)))
    and (select pg_catalog.count(*) from vault.decrypted_secrets d
         where d.id in (sa.vault_access_token_secret_id, sa.vault_refresh_token_secret_id)) = 2
    -- No deletion of the workspace in progress (the X deletion saga's tombstone).
    and not exists (select 1 from public.social_mobile_account_deletions d where d.workspace_id = sa.brand_id)
$$;

create function public.x_account_g4_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_user_id is not null
                  and public.x_account_attested_owner(p_social_account_id) = p_user_id
                  and private.account_lifecycle_service_state_readonly(p_user_id, 'x_autopost') is null, false)
$$;

create function public.x_account_credential_generation(p_social_account_id text) returns text
language sql stable security definer set search_path = '' as $$
  select pg_catalog.md5(pg_catalog.concat_ws('|', 'x-credential-generation-v1', a.attestation_id::text, a.user_id::text,
                                             a.verified_at::text, a.vault_access_token_secret_id::text,
                                             a.vault_refresh_token_secret_id::text, coalesce(st.generation, -1)::text))
  from public.x_account_identity_attestations a
  left join public.x_account_refresh_state_v2 st on st.social_account_id = a.social_account_id
  where a.social_account_id = p_social_account_id
    and public.x_account_attested_owner(p_social_account_id) = a.user_id
$$;

create function public.x_posting_access_token_for(p_social_account_id text) returns text
language sql volatile security definer set search_path = '' as $$
  -- One statement, one snapshot: the binding, the person's POSTONA, the refresh state, the expiry and the token
  -- are read together, so a live complete or a refresh committing in between can never mix with the decision.
  select d.decrypted_secret
  from public.social_accounts sa
  join public.x_account_identity_attestations a on a.social_account_id = sa.id
  join vault.decrypted_secrets d on d.id = sa.vault_access_token_secret_id
  left join public.x_account_refresh_state_v2 st on st.social_account_id = sa.id
  where p_social_account_id ~ '^[a-z][a-z0-9_]{1,80}$'
    and sa.id = p_social_account_id
    and public.x_account_attested_owner(sa.id) = a.user_id
    and private.account_lifecycle_service_state_readonly(a.user_id, 'x_autopost') is null
    and coalesce(st.status, 'idle') = 'idle'
    and case when st.last_refreshed_at > a.attested_at and st.access_expires_at is not null then st.access_expires_at
             else a.attested_at + interval '2 hours' end > pg_catalog.clock_timestamp() + interval '2 minutes'
    and d.decrypted_secret ~ '^[!-~]+$' and pg_catalog.length(d.decrypted_secret) between 16 and 4096
$$;

revoke all on function public.x_account_attested_owner(text), public.x_account_g4_verified(uuid, text),
                       public.x_account_credential_generation(text), public.x_posting_access_token_for(text)
  from public, anon, authenticated, service_role;

-- Postcondition: four definer functions of the owner, empty search_path, EXECUTE for the owner only, no API role
-- reaching them directly or through a membership.
do $$
declare
  v_owner oid := (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass);
begin
  if exists (select 1 from pg_catalog.pg_proc p
             where p.oid in ('public.x_account_attested_owner(text)'::regprocedure, 'public.x_account_g4_verified(uuid,text)'::regprocedure,
                             'public.x_account_credential_generation(text)'::regprocedure, 'public.x_posting_access_token_for(text)'::regprocedure)
               and (not p.prosecdef or p.proowner is distinct from v_owner or p.proconfig is distinct from array['search_path=""']))
     or exists (select 1 from pg_catalog.pg_roles r,
                              (values ('public.x_account_attested_owner(text)'), ('public.x_account_g4_verified(uuid,text)'),
                                      ('public.x_account_credential_generation(text)'), ('public.x_posting_access_token_for(text)')) f(fn)
                where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                  and (pg_catalog.has_function_privilege(r.oid, f.fn::regprocedure, 'EXECUTE') or pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER'))) then
    raise exception 'X_IDENTITY_CREDENTIAL_POSTCONDITION_ACL';
  end if;
end $$;

commit;
