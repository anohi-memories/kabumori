-- SOURCE CANDIDATE ONLY. NOT a migration, NOT applied anywhere (F4,
-- postona-f4-threads-credential-rotate-cas-sql-contract-20261017; checked-owner binding by F4,
-- postona-f4-pr258-credential-claim-owner-fence-race-p2-fix-20261017). A PROPOSAL pending H5 (Vault replacement, owner
-- transport, store port) and F5 (lifecycle decision) agreement, and an independent review. Apply as a single reviewed
-- file only AFTER the G4 publish stack (threads_credential_custody_candidate.sql -> threads_manual_publish_candidate.sql
-- -> threads_publish_release_candidate.sql) and F5's workspace service state (20261012230000). It changes NONE of
-- those files, tables or functions.
--
-- POSTONA Threads: the long-lived token refresh (docs/postona/threads-token-refresh-design.md, Draft PR #255) needs
-- to replace the expiry record of the stored credential after Meta answered with a refreshed token. The existing
-- writer (record_threads_credential_custody) accepts only inside the connect transaction. This file adds the
-- refresh path as a LEASE + COMPARE-AND-SET, server side only (docs/postona/threads-credential-rotation-cas.md):
--
--   TABLE public.threads_credential_refresh_leases   at most one refresh lease per Threads account, bound to the
--       workspace, its owner, the Vault secret id and the custody version it was claimed for; 60 s by the wall
--       clock. It holds no secret material and cascades with the account (disconnect, deletion cleanup).
--   public.claim_threads_credential_refresh(account) -> jsonb
--   public.rotate_threads_credential_custody(account, lease, expected_secret_id, expected_recorded_at, new_expires_at)
--       -> jsonb: the compare-and-set. Consumes the lease (single use).
--   public.release_threads_credential_refresh(account, lease) -> jsonb   idempotent
--
-- Caller: H5's owner transport only (EXECUTE for the owner, no API role), never a person: a call that carries a
-- person's JWT claims is refused (SERVER_ONLY). The intended use, per account:
--   tx 1  claim -> (H5) read the token from Vault by the returned secret id -> COMMIT
--   no transaction open: Meta GET /refresh_access_token (PR #255's coordinator, 10 s bound)
--   tx 2  rotate(...) = 'rotated' -> (H5) vault.update_secret(<the same secret id>, <new token>) -> COMMIT
--         one transaction: if the Vault write fails, the custody record and the lease roll back with it
--   always: release (a rotate already consumed the lease; a refused or abandoned refresh frees it)
--
-- Lock order (the order of connect, disconnect, cleanup and the publish release): the workspace OWNER's lifecycle
-- (F5's decision for ONE explicit person, private.account_lifecycle_service_state_refusal: its I1 locks held to COMMIT
-- when it allows) -> workspace advisory lock ->
-- workspace FOR SHARE -> owner membership FOR SHARE -> Threads account FOR UPDATE (waits for a publish release that
-- holds it FOR SHARE and for a disconnect / cleanup / reconnect that holds it FOR UPDATE, then reads the committed
-- row) -> custody FOR UPDATE -> lease FOR UPDATE. Every decision is taken after those waits, by the wall clock.
--
-- Checked-owner binding (J2 V2 R1): the person whose lifecycle F5 decided on is chosen BEFORE the decision and passed
-- to it explicitly -- claim: the workspace owner by F5's own rule (private.account_lifecycle_brand_owner); rotate: the
-- person the lease was claimed for, never re-resolved. After the workspace locks, the owner membership (held FOR
-- SHARE, so it cannot change before COMMIT) must be that same person, else OWNER_CHANGED. An owner that changed while
-- the decision waited, or changed and changed back (ABA), is therefore either refused or is exactly the person
-- whose lifecycle rows this transaction holds: a lease or a rotation is never given for a person F5 did not decide on.
--
-- Answers: {status: claimed | rotated | released | not_held} or {status: refused, code}; a refusal changes nothing.
--   SERVER_ONLY, REQUEST_INVALID, EXPIRY_INVALID (not in (now, now + 61 days]), EXPIRY_NOT_EXTENDED (not later than
--   the recorded expiry), ACCOUNT_NOT_FOUND (disconnected, removed by the deletion cleanup, not Threads),
--   CONNECTION_NOT_VERIFIED, CUSTODY_UNKNOWN (the reader would answer NULL), CREDENTIAL_EXPIRED, PUBLISH_IN_FLIGHT
--   (a released token may be in use: creating_container / publishing, or a grant that has not ended), LEASE_HELD
--   (claim: another live lease), LEASE_NOT_HELD (rotate: no lease, another lease, an ended lease, or one already
--   consumed = a replay), WORKSPACE_CHANGED, OWNER_CHANGED, STALE_CREDENTIAL (the secret or the custody row is not
--   the version claimed: a reconnect, an earlier rotation, other expected values), and F5's decision as
--   SERVICE_NOT_ACTIVE / WORKSPACE_INACTIVE / ACCOUNT_LIFECYCLE_BLOCKED / BUSY.
--
-- Not closed here (and not claimed):
--   * This file cannot see the Vault write. That the secret is replaced in the same transaction as the rotate is
--     H5's part (proposal in the doc); a rotate without it would record a later expiry for the old token, which
--     then fails at Meta as an invalid token (no other account, user or secret is reachable).
--   * The publish release does not wait for a refresh lease yet. A post released between claim and rotate makes
--     the rotate answer PUBLISH_IN_FLIGHT, and the refreshed token is dropped (post-V2 integration step in the doc).
--   * Whether Meta's refresh changes the token string or ends the old one is not documented (T7).
begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_owner oid;
  v_fn regprocedure;
begin
  if pg_catalog.to_regclass('public.threads_credential_refresh_leases') is not null
     or pg_catalog.to_regprocedure('public.rotate_threads_credential_custody(text,uuid,uuid,timestamptz,timestamptz)') is not null then
    raise exception 'THREADS_ROTATION_PRECONDITION_ALREADY_APPLIED';
  end if;
  select c.relowner into v_owner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass;
  if v_owner is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
     or (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'THREADS_ROTATION_PRECONDITION_OWNER';
  end if;
  -- G4 custody exactly as its candidate created it: the table's columns, its writer, and the reader whose rule
  -- (same secret id, recorded no earlier than the latest verification) this file keeps true. Pinned.
  if pg_catalog.to_regclass('public.threads_account_credential_custody') is null
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.threads_account_credential_custody'::regclass) is distinct from v_owner
     or (select pg_catalog.string_agg(a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull::text, ', ' order by a.attnum)
         from pg_catalog.pg_attribute a
         where a.attrelid = 'public.threads_account_credential_custody'::regclass and a.attnum > 0 and not a.attisdropped)
       is distinct from 'social_account_id text true, vault_secret_id uuid true, expires_at timestamp with time zone true, '
                        'recorded_at timestamp with time zone true, recorded_by uuid true'
     or pg_catalog.to_regprocedure('public.record_threads_credential_custody(text,timestamptz)') is null
     or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
         where p.oid = pg_catalog.to_regprocedure('public.threads_account_credential_expires_at(text)'))
       is distinct from '0d63f9e609f4bc4380c8afa1b86d0916' then
    raise exception 'THREADS_ROTATION_PRECONDITION_CUSTODY';
  end if;
  -- The publish attempts this file reads to see a post in flight.
  if pg_catalog.to_regclass('public.threads_manual_publish_attempts') is null
     or (select pg_catalog.count(*) from pg_catalog.pg_attribute a
         where a.attrelid = 'public.threads_manual_publish_attempts'::regclass and not a.attisdropped
           and a.attname in ('social_account_id', 'status', 'grant_state', 'grant_expires_at')) <> 4 then
    raise exception 'THREADS_ROTATION_PRECONDITION_PUBLISH_STACK';
  end if;
  -- F5's owner rule and its state decision for one explicit person: owned by the table owner, definer functions
  -- reachable by no API role, directly or through a membership.
  foreach v_fn in array array[pg_catalog.to_regprocedure('private.account_lifecycle_brand_owner(text)'),
                              pg_catalog.to_regprocedure('private.account_lifecycle_service_state_refusal(uuid,text)')] loop
    if v_fn is null
       or (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner
       or not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_fn)
       or exists (select 1 from pg_catalog.pg_roles r
                  where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                    and (pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE') or pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER'))) then
      raise exception 'THREADS_ROTATION_PRECONDITION_F5';
    end if;
  end loop;
  if pg_catalog.to_regprocedure('public.social_mobile_account_deletion_workspace_lock(text)') is null
     or pg_catalog.to_regprocedure('public.social_mobile_account_deletion_guard()') is null
     or pg_catalog.to_regprocedure('auth.uid()') is null then
    raise exception 'THREADS_ROTATION_PRECONDITION_DELETION';
  end if;
end $$;

create table public.threads_credential_refresh_leases (
  social_account_id text primary key references public.social_accounts (id) on delete cascade,
  lease_id uuid not null unique,
  brand_id text not null references public.brands (id) on delete cascade,
  owner_user_id uuid not null,
  vault_secret_id uuid not null,
  custody_recorded_at timestamptz not null,
  claimed_at timestamptz not null,
  lease_expires_at timestamptz not null,
  check (lease_expires_at > claimed_at and lease_expires_at <= claimed_at + interval '60 seconds')
);
alter table public.threads_credential_refresh_leases enable row level security;
revoke all on table public.threads_credential_refresh_leases from public, anon, authenticated, service_role;
create trigger social_mobile_deletion_guard before insert or update on public.threads_credential_refresh_leases
  for each row execute function public.social_mobile_account_deletion_guard();

create function public.threads_credential_rotation_refused(p_code text) returns jsonb
language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_build_object('status', 'refused', 'code', p_code)
$$;

-- The workspace's single owner, the membership row held FOR SHARE to COMMIT; null for none or more than one.
create function public.threads_credential_refresh_owner(p_brand_id text) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_owners uuid[];
begin
  select pg_catalog.array_agg(o.user_id) into v_owners
  from (select m.user_id from public.brand_memberships m where m.brand_id = p_brand_id and m.role = 'owner' for share) o;
  if pg_catalog.cardinality(v_owners) is distinct from 1 then return null; end if;
  return v_owners[1];
end;
$$;

-- A released token may be in use: a provider call is running (creating_container / publishing) or a grant has not
-- ended yet (every step's release hands the token out with a grant of at most 5 minutes).
create function public.threads_credential_publish_in_flight(p_social_account_id text) returns boolean
language sql volatile security invoker set search_path = '' as $$
  select exists (
    select 1 from public.threads_manual_publish_attempts t
    where t.social_account_id = p_social_account_id
      and (t.status in ('creating_container', 'publishing')
           or (t.grant_state is not null and t.grant_expires_at > pg_catalog.clock_timestamp())))
$$;

-- F5's state decision for ONE explicit person (the I1 lifecycle locks, kept to COMMIT when it allows), as this file's
-- fixed codes, or null. Same mapping as the publish owner fence.
create function public.threads_credential_refresh_lifecycle(p_user_id uuid) returns text
language plpgsql security invoker set search_path = '' as $$
declare
  v_refusal text := private.account_lifecycle_service_state_refusal(p_user_id, 'x_autopost');
begin
  return case
    when v_refusal is null then null
    when v_refusal = 'ACCOUNT_LIFECYCLE_BUSY' then 'BUSY'
    when v_refusal in ('SERVICE_NOT_REGISTERED', 'SERVICE_NOT_ACTIVE', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND') then 'SERVICE_NOT_ACTIVE'
    else 'ACCOUNT_LIFECYCLE_BLOCKED' end;
end;
$$;

create function public.claim_threads_credential_refresh(p_social_account_id text) returns jsonb
language plpgsql security invoker set search_path = '' set lock_timeout = '3s' as $$
declare
  v_brand_id text;
  v_code text;
  v_checked uuid;
  v_owner uuid;
  v_account public.social_accounts%rowtype;
  v_custody public.threads_account_credential_custody%rowtype;
  v_lease public.threads_credential_refresh_leases%rowtype;
  v_now timestamptz;
begin
  if auth.uid() is not null then return public.threads_credential_rotation_refused('SERVER_ONLY'); end if;
  if p_social_account_id is null or p_social_account_id !~ '^[a-z][a-z0-9_]{1,80}$' then
    return public.threads_credential_rotation_refused('REQUEST_INVALID');
  end if;
  select a.brand_id into v_brand_id from public.social_accounts a where a.id = p_social_account_id and a.platform = 'threads';
  if v_brand_id is null then return public.threads_credential_rotation_refused('ACCOUNT_NOT_FOUND'); end if;
  -- F5 first, for an EXPLICIT person: the workspace owner by F5's own rule, whose lifecycle locks are taken before
  -- any workspace or account lock and kept to COMMIT.
  v_checked := private.account_lifecycle_brand_owner(v_brand_id);
  if v_checked is null then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;
  v_code := public.threads_credential_refresh_lifecycle(v_checked);
  if v_code is not null then return public.threads_credential_rotation_refused(v_code); end if;
  perform public.social_mobile_account_deletion_workspace_lock(v_brand_id);
  perform 1 from public.brands b where b.id = v_brand_id and b.code_profile_key = 'social_mobile_user_v1' for share;
  if not found then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;
  v_owner := public.threads_credential_refresh_owner(v_brand_id);
  if v_owner is null then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;
  -- J2 R1: the owner may have changed while the decision waited. A lease is only for the person decided on.
  if v_owner is distinct from v_checked then return public.threads_credential_rotation_refused('OWNER_CHANGED'); end if;
  select a.* into v_account from public.social_accounts a where a.id = p_social_account_id for update;
  if v_account.id is null or v_account.platform is distinct from 'threads' then
    return public.threads_credential_rotation_refused('ACCOUNT_NOT_FOUND');
  end if;
  if v_account.brand_id is distinct from v_brand_id then return public.threads_credential_rotation_refused('WORKSPACE_CHANGED'); end if;
  if v_account.connection_status is distinct from 'identity_verified' or v_account.verified_at is null
     or v_account.vault_access_token_secret_id is null then
    return public.threads_credential_rotation_refused('CONNECTION_NOT_VERIFIED');
  end if;
  select c.* into v_custody from public.threads_account_credential_custody c where c.social_account_id = p_social_account_id for update;
  if v_custody.social_account_id is null or v_custody.vault_secret_id is distinct from v_account.vault_access_token_secret_id
     or v_custody.recorded_at < v_account.verified_at then
    return public.threads_credential_rotation_refused('CUSTODY_UNKNOWN');
  end if;
  v_now := pg_catalog.clock_timestamp();
  if v_custody.expires_at <= v_now then return public.threads_credential_rotation_refused('CREDENTIAL_EXPIRED'); end if;
  if public.threads_credential_publish_in_flight(p_social_account_id) then
    return public.threads_credential_rotation_refused('PUBLISH_IN_FLIGHT');
  end if;
  select l.* into v_lease from public.threads_credential_refresh_leases l where l.social_account_id = p_social_account_id for update;
  if v_lease.social_account_id is not null then
    if v_lease.lease_expires_at > v_now then return public.threads_credential_rotation_refused('LEASE_HELD'); end if;
    -- An ended lease is taken over: its holder's rotate can no longer match.
    delete from public.threads_credential_refresh_leases l where l.social_account_id = p_social_account_id;
  end if;
  insert into public.threads_credential_refresh_leases
    (social_account_id, lease_id, brand_id, owner_user_id, vault_secret_id, custody_recorded_at, claimed_at, lease_expires_at)
  values (p_social_account_id, gen_random_uuid(), v_brand_id, v_owner, v_custody.vault_secret_id, v_custody.recorded_at,
          v_now, v_now + interval '60 seconds')
  returning * into v_lease;
  -- No token: H5 reads it from Vault by this secret id in the same transaction. custody_recorded_at is the
  -- conservative issue time for Meta's 24-hour rule (the token was exchanged before it was recorded).
  return pg_catalog.jsonb_build_object(
    'status', 'claimed', 'lease', v_lease.lease_id, 'social_account_id', p_social_account_id,
    'vault_secret_id', v_custody.vault_secret_id, 'custody_recorded_at', v_custody.recorded_at,
    'expires_at', v_custody.expires_at, 'lease_expires_at', v_lease.lease_expires_at);
exception
  when lock_not_available or deadlock_detected or unique_violation then
    return public.threads_credential_rotation_refused('BUSY');
  when raise_exception then
    -- The deletion guard (SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS) or another reviewed guard.
    return public.threads_credential_rotation_refused('ACCOUNT_LIFECYCLE_BLOCKED');
end;
$$;

create function public.rotate_threads_credential_custody(p_social_account_id text, p_lease uuid, p_expected_secret_id uuid,
                                                         p_expected_recorded_at timestamptz, p_new_expires_at timestamptz)
returns jsonb language plpgsql security invoker set search_path = '' set lock_timeout = '3s' as $$
declare
  v_brand_id text;
  v_code text;
  v_checked uuid;
  v_owner uuid;
  v_account public.social_accounts%rowtype;
  v_custody public.threads_account_credential_custody%rowtype;
  v_lease public.threads_credential_refresh_leases%rowtype;
  v_now timestamptz;
begin
  if auth.uid() is not null then return public.threads_credential_rotation_refused('SERVER_ONLY'); end if;
  if p_social_account_id is null or p_social_account_id !~ '^[a-z][a-z0-9_]{1,80}$' or p_lease is null
     or p_expected_secret_id is null or p_expected_recorded_at is null or p_new_expires_at is null
     or not pg_catalog.isfinite(p_expected_recorded_at) or not pg_catalog.isfinite(p_new_expires_at) then
    return public.threads_credential_rotation_refused('REQUEST_INVALID');
  end if;
  v_now := pg_catalog.clock_timestamp();
  if p_new_expires_at <= v_now or p_new_expires_at > v_now + interval '61 days' then
    return public.threads_credential_rotation_refused('EXPIRY_INVALID');
  end if;
  select a.brand_id into v_brand_id from public.social_accounts a where a.id = p_social_account_id and a.platform = 'threads';
  if v_brand_id is null then return public.threads_credential_rotation_refused('ACCOUNT_NOT_FOUND'); end if;
  -- No lease of this account under this id: refused before any lock, so a stray or replayed call never queues on
  -- the workspace owner's lifecycle rows. Decided again below after the locks. A lease id names one claim, so its
  -- owner is the person that claim was for.
  select l.owner_user_id into v_checked from public.threads_credential_refresh_leases l
   where l.social_account_id = p_social_account_id and l.lease_id = p_lease;
  if v_checked is null then return public.threads_credential_rotation_refused('LEASE_NOT_HELD'); end if;
  -- F5 for THAT person, explicitly (never the owner of the moment, which may have changed and changed back).
  v_code := public.threads_credential_refresh_lifecycle(v_checked);
  if v_code is not null then return public.threads_credential_rotation_refused(v_code); end if;
  perform public.social_mobile_account_deletion_workspace_lock(v_brand_id);
  perform 1 from public.brands b where b.id = v_brand_id and b.code_profile_key = 'social_mobile_user_v1' for share;
  if not found then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;
  v_owner := public.threads_credential_refresh_owner(v_brand_id);
  if v_owner is null then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;
  select a.* into v_account from public.social_accounts a where a.id = p_social_account_id for update;
  if v_account.id is null or v_account.platform is distinct from 'threads' then
    return public.threads_credential_rotation_refused('ACCOUNT_NOT_FOUND');
  end if;
  if v_account.brand_id is distinct from v_brand_id then return public.threads_credential_rotation_refused('WORKSPACE_CHANGED'); end if;
  if v_account.connection_status is distinct from 'identity_verified' or v_account.verified_at is null
     or v_account.vault_access_token_secret_id is null then
    return public.threads_credential_rotation_refused('CONNECTION_NOT_VERIFIED');
  end if;
  select c.* into v_custody from public.threads_account_credential_custody c where c.social_account_id = p_social_account_id for update;
  select l.* into v_lease from public.threads_credential_refresh_leases l where l.social_account_id = p_social_account_id for update;
  -- Every decision below uses the clock after the waits.
  v_now := pg_catalog.clock_timestamp();
  if v_lease.lease_id is distinct from p_lease or v_lease.lease_expires_at <= v_now then
    return public.threads_credential_rotation_refused('LEASE_NOT_HELD');
  end if;
  if v_lease.brand_id is distinct from v_account.brand_id then return public.threads_credential_rotation_refused('WORKSPACE_CHANGED'); end if;
  if v_lease.owner_user_id is distinct from v_owner or v_checked is distinct from v_owner then
    return public.threads_credential_rotation_refused('OWNER_CHANGED');
  end if;
  -- The compare-and-set: the account, the custody row and the lease all name the version the caller refreshed.
  if v_custody.social_account_id is null
     or v_account.vault_access_token_secret_id is distinct from p_expected_secret_id
     or v_custody.vault_secret_id is distinct from p_expected_secret_id
     or v_custody.recorded_at is distinct from p_expected_recorded_at
     or v_lease.vault_secret_id is distinct from p_expected_secret_id
     or v_lease.custody_recorded_at is distinct from p_expected_recorded_at
     or v_custody.recorded_at < v_account.verified_at then
    return public.threads_credential_rotation_refused('STALE_CREDENTIAL');
  end if;
  if v_custody.expires_at <= v_now then return public.threads_credential_rotation_refused('CREDENTIAL_EXPIRED'); end if;
  if p_new_expires_at <= v_now or p_new_expires_at > v_now + interval '61 days' then
    return public.threads_credential_rotation_refused('EXPIRY_INVALID');
  end if;
  if p_new_expires_at <= v_custody.expires_at then return public.threads_credential_rotation_refused('EXPIRY_NOT_EXTENDED'); end if;
  if public.threads_credential_publish_in_flight(p_social_account_id) then
    return public.threads_credential_rotation_refused('PUBLISH_IN_FLIGHT');
  end if;
  update public.threads_account_credential_custody c
     set expires_at = p_new_expires_at, recorded_at = pg_catalog.now(), recorded_by = v_owner
   where c.social_account_id = p_social_account_id;
  -- Single use: the same lease can never rotate again (a replay answers LEASE_NOT_HELD).
  delete from public.threads_credential_refresh_leases l where l.social_account_id = p_social_account_id and l.lease_id = p_lease;
  return pg_catalog.jsonb_build_object(
    'status', 'rotated', 'social_account_id', p_social_account_id, 'vault_secret_id', p_expected_secret_id,
    'recorded_at', pg_catalog.now(), 'expires_at', p_new_expires_at);
exception
  when lock_not_available or deadlock_detected then
    return public.threads_credential_rotation_refused('BUSY');
  when raise_exception then
    return public.threads_credential_rotation_refused('ACCOUNT_LIFECYCLE_BLOCKED');
end;
$$;

create function public.release_threads_credential_refresh(p_social_account_id text, p_lease uuid) returns jsonb
language plpgsql security invoker set search_path = '' set lock_timeout = '3s' as $$
begin
  if auth.uid() is not null then return public.threads_credential_rotation_refused('SERVER_ONLY'); end if;
  if p_social_account_id is null or p_social_account_id !~ '^[a-z][a-z0-9_]{1,80}$' or p_lease is null then
    return public.threads_credential_rotation_refused('REQUEST_INVALID');
  end if;
  -- Only this lease; releasing grants nothing, so no lifecycle decision is needed.
  delete from public.threads_credential_refresh_leases l where l.social_account_id = p_social_account_id and l.lease_id = p_lease;
  return pg_catalog.jsonb_build_object('status', case when found then 'released' else 'not_held' end);
exception
  when lock_not_available or deadlock_detected then
    return public.threads_credential_rotation_refused('BUSY');
end;
$$;

revoke all on function public.threads_credential_rotation_refused(text),
                       public.threads_credential_refresh_owner(text),
                       public.threads_credential_publish_in_flight(text),
                       public.threads_credential_refresh_lifecycle(uuid),
                       public.claim_threads_credential_refresh(text),
                       public.rotate_threads_credential_custody(text, uuid, uuid, timestamptz, timestamptz),
                       public.release_threads_credential_refresh(text, uuid)
  from public, anon, authenticated, service_role;

-- Postcondition: the lease table and every new function are the owner's alone (no API role, no membership of the
-- owner); the functions run as the caller (invoker) with an empty search_path.
do $$
declare
  v_owner oid := (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass);
begin
  if exists (select 1 from pg_catalog.pg_roles r,
                           (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
             where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
               and (pg_catalog.has_table_privilege(r.oid, 'public.threads_credential_refresh_leases', p.priv)
                    or pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER')))
     or exists (select 1 from pg_catalog.pg_roles r,
                              (values ('public.threads_credential_rotation_refused(text)'),
                                      ('public.threads_credential_refresh_owner(text)'),
                                      ('public.threads_credential_publish_in_flight(text)'),
                                      ('public.threads_credential_refresh_lifecycle(uuid)'),
                                      ('public.claim_threads_credential_refresh(text)'),
                                      ('public.rotate_threads_credential_custody(text,uuid,uuid,timestamptz,timestamptz)'),
                                      ('public.release_threads_credential_refresh(text,uuid)')) f(fn)
                where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                  and pg_catalog.has_function_privilege(r.oid, f.fn::regprocedure, 'EXECUTE'))
     or exists (select 1 from pg_catalog.pg_proc p
                where p.oid in ('public.threads_credential_refresh_owner(text)'::regprocedure,
                                'public.threads_credential_publish_in_flight(text)'::regprocedure,
                                'public.threads_credential_refresh_lifecycle(uuid)'::regprocedure,
                                'public.claim_threads_credential_refresh(text)'::regprocedure,
                                'public.rotate_threads_credential_custody(text,uuid,uuid,timestamptz,timestamptz)'::regprocedure,
                                'public.release_threads_credential_refresh(text,uuid)'::regprocedure)
                  and (p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'], false) or p.proowner is distinct from v_owner)) then
    raise exception 'THREADS_ROTATION_POSTCONDITION_ACL';
  end if;
end $$;

commit;
