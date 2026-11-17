-- NOT A MIGRATION. G4 SOURCE CANDIDATE ONLY (G4-02 #19, #20, Issue #561). Applies ON TOP OF 002 (same schema owner) and G3's X
-- reservation schema (postona_x_resv: reservations + 006's single_post_bindings + 014's claim_credential_generation; same owner).
-- Kept outside supabase/migrations: no tool applies it.
--
-- G3's X send paths (the manual "send now" and the reservation worker, PR #699) read the token they send with from G4. Since G4-02 #20
-- (H1 #50 P2-1) the read is bound to the SEND ATTEMPT, not to the account alone:
--
--   public.postona_x_send_credential_for_claim_v1(p_reservation_id uuid, p_lease_token uuid, p_social_account_id text, p_session_id uuid)
--     returns table (code text, credential_generation text, access_token text, refresh_generation bigint)   -- exactly one row, always
--
-- The attempt is G3's claimed reservation row: the manual send's post_now_begin and the worker's claim_due both create it as 'claimed'
-- with a fresh lease_token that only the claimer receives (postona_x_resv is revoked from service_role / API roles: the lease cannot be
-- read back). code = 'VERIFIED' with the generation and the access token ONLY when, in one transaction:
--   * the attempt: the row exists, its lease_token is p_lease_token, it is for p_social_account_id, status 'claimed' (not published /
--     failed / uncertain / cancelled / expired: a used or stopped attempt never reads again), the lease has not run out, the text is
--     the user-authored one consented to (G3's row_publishable consent rule);
--   * manual send (claimed_by 'single_post', draft 'single:...'): p_session_id is a live auth session (not_after unset or ahead) of
--     the attempt's person, and G3's binding row (006) is for that person and workspace and has no recorded result yet;
--     worker: p_session_id is null and the claim pinned a generation (014);
--   * the account row is locked FOR SHARE (G4's begin / complete / disconnect and the reconnect reset wait for the read, or the read
--     waits for them and sees their result), it is X, in the attempt's workspace, whose single owner (G5) is the attempt's person;
--   * publishing is on (social_accounts.publish_enabled) and no stop is recorded (public.x_account_publish_authority 'revoked',
--     where that table exists -- the same stop G3's single_post_fence honours);
--   * G4's reviewed X verdict (002, body pinned below) answers VERIFIED for (that person, that account), and where G4's 007 refresh
--     precheck exists (personal profile) it answers 'allow' (G5's service generation of this connection is still the current one);
--   * G3's derivation of the verdict's generation (sha256 hex of 'g3x1|' || 'g4x1:<epoch>', 014) equals the generation the attempt
--     bound (manual: binding row; worker: claim pin): a reconnect / disconnect / A->B->A since the claim refuses;
--   * Vault references (H1 #50 P2-2, the refresh core's rule and more): both set, not the same secret, used by no other account row
--     (either column), each secret present with the name G4's connect gives it (<account>_access_token / <account>_refresh_token);
--   * the access token read from Vault in the same transaction is printable ASCII, 16..4096 characters (G3's X_ACCESS_TOKEN_RE).
-- Anything else: (code, null, null, null). Codes: INPUT_INVALID | CLAIM_INVALID | CLAIM_NOT_ACTIVE | CLAIM_EXPIRED |
-- CLAIM_NOT_PUBLISHABLE | SESSION_REQUIRED | SESSION_NOT_ACTIVE | NOT_CONNECTED | NOT_OWN_WORKSPACE | PUBLISH_DISABLED |
-- PUBLISH_AUTHORITY_REVOKED | the verdict's codes | the precheck's codes | CREDENTIAL_GENERATION_CHANGED | CREDENTIAL_REF_ALIASED |
-- CREDENTIAL_REF_SHARED | CREDENTIAL_REF_PURPOSE | CREDENTIAL_UNREADABLE | CREDENTIAL_BUSY (a lock wait ran out) |
-- CREDENTIAL_UNAVAILABLE (any other error: no database text, reference or value is passed on). Nothing is logged.
-- refresh_generation: the refresh core's counter for the account (0 without a row), answered with VERIFIED only. G4's generation does
-- not move on a refresh; a caller that wants to tell "this token was replaced since I read it" compares this value (contract, G4 doc).
--
-- What it does NOT decide: G3's own pre-send check (post_now_preflight / pre_publish_check_bound) still runs after this read and before
-- the X call; G3 sends only when its generation equals the one answered here. This read does not change any row.
--
-- New DB object, least privilege: one SECURITY DEFINER function, empty search_path, lock_timeout 3 s, owned by the verdict's and the
-- reservations' owner; EXECUTE for service_role ONLY (the Edge server's key), revoked from PUBLIC / anon / authenticated. No table,
-- column, RLS policy, Vault object, G3 or G5 object is created or changed. The account-only read of G4-02 #19
-- (public.postona_x_send_credential_v1(text)) must not exist: install refuses while it does. Independent H review required before any
-- hosted use. Rollback: 003_x_send_credential_read_rollback.sql.

begin;
set local lock_timeout = '2s';
set local search_path = '';

do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  v_verdict regprocedure := to_regprocedure('postona_g4_credential.x_publish_credential_verdict(uuid,text)');
  v_name text;
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
  -- Vault as Supabase shapes it: decrypted_secrets for the value, secrets.name for the purpose binding
  if to_regclass('vault.decrypted_secrets') is null or to_regclass('vault.secrets') is null
     or not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = 'vault.secrets'::regclass and a.attname = 'name' and not a.attisdropped) then
    raise exception 'G4XS_PRECONDITION_VAULT';
  end if;
  if to_regclass('auth.sessions') is null
     or (select count(*) from pg_catalog.pg_attribute a where a.attrelid = 'auth.sessions'::regclass and not a.attisdropped
           and a.attname in ('id', 'user_id', 'not_after')) <> 3 then
    raise exception 'G4XS_PRECONDITION_AUTH_SESSIONS';
  end if;
  foreach v_name in array array['public.social_accounts', 'postona_x_resv.reservations', 'postona_x_resv.single_post_bindings'] loop
    if to_regclass(v_name) is null or (select relowner from pg_catalog.pg_class where oid = to_regclass(v_name)) <> v_me then
      raise exception 'G4XS_PRECONDITION_TABLE %', v_name;
    end if;
  end loop;
  -- G3's claim (001 / 005), binding (006) and claim pin (014) columns this read relies on
  if (select count(*) from pg_catalog.pg_attribute a where a.attrelid = 'postona_x_resv.reservations'::regclass and not a.attisdropped
        and a.attname in ('id', 'user_id', 'brand_id', 'social_account_id', 'draft_id', 'origin', 'status', 'revision', 'content_sha256',
                          'scheduled_at', 'consent_state', 'consent_sha256', 'consent_scheduled_at', 'consent_revision', 'lease_token',
                          'lease_expires_at', 'claimed_by', 'claim_credential_generation')) <> 18
     or (select count(*) from pg_catalog.pg_attribute a where a.attrelid = 'postona_x_resv.single_post_bindings'::regclass and not a.attisdropped
           and a.attname in ('reservation_id', 'owner_user_id', 'brand_id', 'credential_generation', 'transport')) <> 5 then
    raise exception 'G4XS_PRECONDITION_G3_CLAIM_SHAPE';
  end if;
  if to_regprocedure('public.postona_x_send_credential_v1(text)') is not null then
    raise exception 'G4XS_PRECONDITION_UNBOUND_READ_PRESENT';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'postona_x_send_credential_for_claim_v1') then
    raise exception 'G4XS_ALREADY_APPLIED';
  end if;
end $$;

create function public.postona_x_send_credential_for_claim_v1(p_reservation_id uuid, p_lease_token uuid, p_social_account_id text, p_session_id uuid)
returns table (code text, credential_generation text, access_token text, refresh_generation bigint)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s'
as $$
declare
  v_claim postona_x_resv.reservations;
  v_bound text;
  v_single boolean;
  v_account public.social_accounts;
  v_owner uuid;
  v_text text;
  v_verified boolean;
  v_generation text;
  v_code text;
  v_access_name text;
  v_refresh_name text;
  v_token text;
  v_refresh_generation bigint;
begin
  if p_reservation_id is null or p_lease_token is null
     or p_social_account_id is null or p_social_account_id !~ '^[a-z][a-z0-9_]{1,80}$' then
    return query select 'INPUT_INVALID'::text, null::text, null::text, null::bigint;
    return;
  end if;
  -- 1. the send attempt. FOR SHARE: G3's finish / release / cancel / sweep wait for the read, or the read sees what they committed.
  --    A wrong lease or another account answers the same code as an unknown id (no oracle).
  select r.* into v_claim from postona_x_resv.reservations r where r.id = p_reservation_id for share;
  if not found or v_claim.lease_token is distinct from p_lease_token or v_claim.social_account_id is distinct from p_social_account_id then
    return query select 'CLAIM_INVALID'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if v_claim.status is distinct from 'claimed' then
    return query select 'CLAIM_NOT_ACTIVE'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if v_claim.lease_expires_at is null or v_claim.lease_expires_at <= pg_catalog.clock_timestamp() then
    return query select 'CLAIM_EXPIRED'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if v_claim.origin is distinct from 'user_authored' or v_claim.consent_state is distinct from 'confirmed'
     or v_claim.consent_sha256 is distinct from v_claim.content_sha256 or v_claim.consent_scheduled_at is distinct from v_claim.scheduled_at
     or v_claim.consent_revision is distinct from v_claim.revision then
    return query select 'CLAIM_NOT_PUBLISHABLE'::text, null::text, null::text, null::bigint;
    return;
  end if;
  v_single := v_claim.claimed_by is not distinct from 'single_post';
  if v_single <> (v_claim.draft_id ~ '^single:') then
    return query select 'CLAIM_INVALID'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if v_single then
    -- the manual send: the person's live session, and G3's binding of this attempt (owner, workspace, generation at begin)
    if p_session_id is null then
      return query select 'SESSION_REQUIRED'::text, null::text, null::text, null::bigint;
      return;
    end if;
    if not exists (select 1 from auth.sessions s where s.id = p_session_id and s.user_id = v_claim.user_id
                     and (s.not_after is null or s.not_after > pg_catalog.now())) then
      return query select 'SESSION_NOT_ACTIVE'::text, null::text, null::text, null::bigint;
      return;
    end if;
    select b.credential_generation into v_bound from postona_x_resv.single_post_bindings b
     where b.reservation_id = v_claim.id and b.owner_user_id = v_claim.user_id and b.brand_id = v_claim.brand_id and b.transport is null;
  else
    -- the worker: no person session; the generation pinned at claim (014)
    if p_session_id is not null then
      return query select 'INPUT_INVALID'::text, null::text, null::text, null::bigint;
      return;
    end if;
    v_bound := v_claim.claim_credential_generation;
  end if;
  if v_bound is null or v_bound !~ '^[0-9a-f]{64}$' then
    return query select 'CLAIM_INVALID'::text, null::text, null::text, null::bigint;
    return;
  end if;
  -- 2. the account, serialized with G4's connection writers
  select sa.* into v_account from public.social_accounts sa where sa.id = v_claim.social_account_id and sa.platform = 'x' for share;
  if not found then
    return query select 'NOT_CONNECTED'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if v_account.brand_id is distinct from v_claim.brand_id then
    return query select 'CLAIM_INVALID'::text, null::text, null::text, null::bigint;
    return;
  end if;
  v_owner := private.account_lifecycle_brand_owner(v_account.brand_id);
  if v_owner is null or v_owner is distinct from v_claim.user_id then
    return query select 'NOT_OWN_WORKSPACE'::text, null::text, null::text, null::bigint;
    return;
  end if;
  -- 3. G4's verdict for the attempt's person, G5's service generation (personal profile), publishing on / no stop, the generation
  --    bound by the attempt
  select r.verified, r.credential_generation, r.code into v_verified, v_generation, v_code
    from postona_g4_credential.x_publish_credential_verdict(v_owner, v_account.id) r;
  if v_verified is not true or v_code is distinct from 'VERIFIED' or v_generation is null or v_generation !~ '^g4x1:[0-9]{1,19}$' then
    return query select coalesce(v_code, 'NOT_VERIFIED'), null::text, null::text, null::bigint;
    return;
  end if;
  if to_regprocedure('public.postona_x_refresh_precheck_v1(text)') is not null then
    execute 'select public.postona_x_refresh_precheck_v1($1)' into v_text using v_account.id;
    if v_text is distinct from 'allow' then
      return query select case when v_text ~ '^[A-Z][A-Z0-9_]{1,63}$' then v_text else 'SERVICE_GENERATION_UNKNOWN' end, null::text, null::text, null::bigint;
      return;
    end if;
  end if;
  if v_account.publish_enabled is distinct from true then
    return query select 'PUBLISH_DISABLED'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if to_regclass('public.x_account_publish_authority') is not null then
    execute 'select pa.state from public.x_account_publish_authority pa where pa.social_account_id = $1' into v_text using v_account.id;
    if v_text = 'revoked' then
      return query select 'PUBLISH_AUTHORITY_REVOKED'::text, null::text, null::text, null::bigint;
      return;
    end if;
  end if;
  if pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('g3x1|' || v_generation, 'UTF8')), 'hex') is distinct from v_bound then
    return query select 'CREDENTIAL_GENERATION_CHANGED'::text, null::text, null::text, null::bigint;
    return;
  end if;
  -- 4. the Vault references: this account's own, one per purpose (the refresh core's rule: not aliased, not shared) and named as G4's
  --    connect names them. Only names are read here; no refresh token is decrypted.
  if v_account.vault_access_token_secret_id is null or v_account.vault_refresh_token_secret_id is null then
    return query select 'CREDENTIAL_MISSING'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if v_account.vault_access_token_secret_id = v_account.vault_refresh_token_secret_id then
    return query select 'CREDENTIAL_REF_ALIASED'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if exists (select 1 from public.social_accounts o
              where o.id <> v_account.id
                and (o.vault_access_token_secret_id in (v_account.vault_access_token_secret_id, v_account.vault_refresh_token_secret_id)
                  or o.vault_refresh_token_secret_id in (v_account.vault_access_token_secret_id, v_account.vault_refresh_token_secret_id))) then
    return query select 'CREDENTIAL_REF_SHARED'::text, null::text, null::text, null::bigint;
    return;
  end if;
  begin
    select s.name into v_access_name from vault.secrets s where s.id = v_account.vault_access_token_secret_id;
    select s.name into v_refresh_name from vault.secrets s where s.id = v_account.vault_refresh_token_secret_id;
  exception when others then
    return query select 'CREDENTIAL_UNAVAILABLE'::text, null::text, null::text, null::bigint;
    return;
  end;
  if v_access_name is null or v_refresh_name is null then
    return query select 'CREDENTIAL_UNREADABLE'::text, null::text, null::text, null::bigint;  -- a dangling reference
    return;
  end if;
  if v_access_name is distinct from v_account.id || '_access_token' or v_refresh_name is distinct from v_account.id || '_refresh_token' then
    return query select 'CREDENTIAL_REF_PURPOSE'::text, null::text, null::text, null::bigint;
    return;
  end if;
  -- Vault is a separate trust boundary: nothing it raises is passed on
  begin
    select ds.decrypted_secret into v_token from vault.decrypted_secrets ds where ds.id = v_account.vault_access_token_secret_id;
  exception when others then
    return query select 'CREDENTIAL_UNAVAILABLE'::text, null::text, null::text, null::bigint;
    return;
  end;
  if v_token is null or v_token !~ '^[!-~]+$' or pg_catalog.length(v_token) not between 16 and 4096 then
    return query select 'CREDENTIAL_UNREADABLE'::text, null::text, null::text, null::bigint;
    return;
  end if;
  select coalesce((select r.generation from public.x_account_refresh_state_v2 r where r.social_account_id = v_account.id), 0)
    into v_refresh_generation;
  return query select 'VERIFIED'::text, v_generation, v_token, v_refresh_generation;
exception
  when lock_not_available then
    return query select 'CREDENTIAL_BUSY'::text, null::text, null::text, null::bigint;
  when others then
    -- never a database text, a reference or a value
    return query select 'CREDENTIAL_UNAVAILABLE'::text, null::text, null::text, null::bigint;
end $$;

revoke all on function public.postona_x_send_credential_for_claim_v1(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.postona_x_send_credential_for_claim_v1(uuid, uuid, text, uuid) to service_role;

do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  v_fn regprocedure := to_regprocedure('public.postona_x_send_credential_for_claim_v1(uuid,uuid,text,uuid)');
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
  -- the lease is a capability only while no API role can read G3's claims
  foreach v_api in array array['anon', 'authenticated', 'authenticator', 'service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles r where r.rolname = v_api)
       and (pg_catalog.has_table_privilege(v_api, 'postona_x_resv.reservations', 'SELECT')
            or pg_catalog.has_column_privilege(v_api, 'postona_x_resv.reservations', 'lease_token', 'SELECT')) then
      raise exception 'G4XS_POSTCONDITION_LEASE_READABLE %', v_api;
    end if;
  end loop;
end $$;

commit;
