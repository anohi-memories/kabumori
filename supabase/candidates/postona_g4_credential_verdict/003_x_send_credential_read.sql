-- NOT A MIGRATION. G4 SOURCE CANDIDATE ONLY (G4-02 #19, Issue #561). Applies ON TOP OF 002 (same schema owner).
-- Kept outside supabase/migrations: no tool applies it.
--
-- G3's X send paths (the manual "send now" and the reservation worker, PR #699) take ONE G4 credential source:
--   credentialFor(social_account_id) -> { token, generation } | null      (x_credential_generation.ts, G3-owned port)
-- and G3's adapter xGenerationSourceFromG4Raw turns G4's raw answer { token, g4Generation: 'g4x1:<connection_epoch>' } into G3's
-- generation (sha256 'g3x1|' || g4Generation, the same definition as the database's postona_x_resv.x_credential_generation). Until
-- now G4 answered nothing (X_GENERATION_CREDENTIALS_NOT_CONNECTED). This file is the database half of that source:
--
--   public.postona_x_send_credential_v1(p_social_account_id text)
--     returns table (code text, credential_generation text, access_token text)   -- exactly one row, always
--
-- code = 'VERIFIED' with the generation and the access token ONLY when, in one transaction, after the account row is locked
-- FOR SHARE (a connect / reconnect / disconnect of this account waits for the read, or the read waits for it and sees its result):
--   * the account exists and is X; its workspace's single owner (G5's private.account_lifecycle_brand_owner) is a person;
--   * G4's reviewed X verdict (002, body pinned below) answers VERIFIED for (that owner, that account): own personal workspace
--     ('u_' || md5(owner)[1:24]), x_autopost service active, G4's X lineage, no begin pending, identity_verified, no connection
--     error, both credentials set, the refresh core not 'refreshing' / 'uncertain' / 'reauth_required';
--   * the access token read from Vault in the same transaction is printable ASCII, 16..4096 characters (G3's X_ACCESS_TOKEN_RE).
-- Anything else: (code, null, null) -- no generation, no token. Codes: INPUT_INVALID | NOT_CONNECTED | NOT_OWN_WORKSPACE |
-- the verdict's codes | CREDENTIAL_UNREADABLE. No code, message or error carries a token or a Vault id.
--
-- What it does NOT decide (and must not): the CALLER. G3 checks the person, their session (G5 S2-2 / T13), the publish switch and
-- the reservation lease in its own begin / preflight, and sends only when the generation answered here equals the generation its
-- preflight answers right before the X call. The owner here is derived from the account, so a send for another person's account
-- is never released by this function alone: G3's begin already refused it (POSTONA_RESV_ACCOUNT_NOT_FOUND / BRAND_NOT_ELIGIBLE).
-- A refresh between this read and the X call keeps the generation (G4's epoch only moves on connect / disconnect); the token read
-- is then the previous one: X refuses it (401 -> G3 records failed, never resent). Not hidden: see the G4 doc for this TASK.
--
-- New DB object, least privilege: one SECURITY DEFINER function, empty search_path, lock_timeout 3 s, owned by the verdict's
-- owner; EXECUTE for service_role ONLY (the Edge server's key), revoked from PUBLIC / anon / authenticated. No table, column, RLS
-- policy, Vault object, G3 or G5 object is created or changed. The grant to service_role is NEW: independent H review required
-- before any hosted use. Rollback: 003_x_send_credential_read_rollback.sql.

begin;
set local lock_timeout = '2s';
set local search_path = '';

do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  v_verdict regprocedure := to_regprocedure('postona_g4_credential.x_publish_credential_verdict(uuid,text)');
begin
  if (select rolsuper from pg_catalog.pg_roles where oid = v_me) then
    raise exception 'G4XS_PRECONDITION_OWNER';
  end if;
  if v_verdict is null or (select proowner from pg_catalog.pg_proc where oid = v_verdict) <> v_me then
    raise exception 'G4XS_PRECONDITION_VERDICT_002';
  end if;
  -- the reviewed 002 body (the same md5 the G4-02 #4 runner prints)
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = v_verdict) <> '46643d50a4a6c6a82867061328de05bf' then
    raise exception 'G4XS_PRECONDITION_VERDICT_BODY';
  end if;
  if to_regprocedure('private.account_lifecycle_brand_owner(text)') is null then
    raise exception 'G4XS_PRECONDITION_OWNER_FUNCTION';
  end if;
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'G4XS_PRECONDITION_VAULT';
  end if;
  if to_regclass('public.social_accounts') is null
     or (select relowner from pg_catalog.pg_class where oid = to_regclass('public.social_accounts')) <> v_me then
    raise exception 'G4XS_PRECONDITION_TABLE public.social_accounts';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'postona_x_send_credential_v1') then
    raise exception 'G4XS_ALREADY_APPLIED';
  end if;
end $$;

create function public.postona_x_send_credential_v1(p_social_account_id text)
returns table (code text, credential_generation text, access_token text)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s'
as $$
declare
  v_account public.social_accounts;
  v_owner uuid;
  v_verified boolean;
  v_generation text;
  v_code text;
  v_token text;
begin
  if p_social_account_id is null or p_social_account_id !~ '^[a-z][a-z0-9_]{1,80}$' then
    return query select 'INPUT_INVALID'::text, null::text, null::text;
    return;
  end if;
  -- the connection writers (begin / complete / disconnect, the reconnect reset) all update this row: serialize with them
  select sa.* into v_account from public.social_accounts sa where sa.id = p_social_account_id and sa.platform = 'x' for share;
  if not found then
    return query select 'NOT_CONNECTED'::text, null::text, null::text;
    return;
  end if;
  v_owner := private.account_lifecycle_brand_owner(v_account.brand_id);
  if v_owner is null then
    return query select 'NOT_OWN_WORKSPACE'::text, null::text, null::text;
    return;
  end if;
  select r.verified, r.credential_generation, r.code into v_verified, v_generation, v_code
    from postona_g4_credential.x_publish_credential_verdict(v_owner, v_account.id) r;
  if v_verified is not true or v_code is distinct from 'VERIFIED' or v_generation is null or v_generation !~ '^g4x1:[0-9]{1,19}$' then
    return query select coalesce(v_code, 'NOT_VERIFIED'), null::text, null::text;
    return;
  end if;
  select ds.decrypted_secret into v_token from vault.decrypted_secrets ds where ds.id = v_account.vault_access_token_secret_id;
  if v_token is null or v_token !~ '^[!-~]+$' or pg_catalog.length(v_token) not between 16 and 4096 then
    return query select 'CREDENTIAL_UNREADABLE'::text, null::text, null::text;
    return;
  end if;
  return query select 'VERIFIED'::text, v_generation, v_token;
end $$;

revoke all on function public.postona_x_send_credential_v1(text) from public, anon, authenticated, service_role;
grant execute on function public.postona_x_send_credential_v1(text) to service_role;

do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  v_fn regprocedure := to_regprocedure('public.postona_x_send_credential_v1(text)');
  v_sr oid := (select oid from pg_catalog.pg_roles where rolname = 'service_role');
  v_api text;
begin
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.proowner = v_me and p.prosecdef and p.provolatile = 'v'
                   and coalesce(p.proconfig @> array['search_path=""'], false)) then
    raise exception 'G4XS_POSTCONDITION_FUNCTION';
  end if;
  if v_sr is null or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
                               where p.oid = v_fn and a.grantee not in (v_me, v_sr)) then
    raise exception 'G4XS_POSTCONDITION_ACL';
  end if;
  if not pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception 'G4XS_POSTCONDITION_SERVICE_ROLE';
  end if;
  foreach v_api in array array['anon', 'authenticated', 'authenticator'] loop
    if exists (select 1 from pg_catalog.pg_roles r where r.rolname = v_api) and pg_catalog.has_function_privilege(v_api, v_fn, 'EXECUTE') then
      raise exception 'G4XS_POSTCONDITION_API_ROLE_REACHES %', v_api;
    end if;
  end loop;
end $$;

commit;
