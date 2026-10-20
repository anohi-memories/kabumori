-- NOT A MIGRATION. SOURCE CANDIDATE ONLY (G4-09, Issue #319). Kept outside supabase/migrations: no tool applies it; it
-- needs PR #124's Threads OAuth candidate, F5's brand owner epoch candidate (PR #303) and G5's brand owner function
-- (PR #178) to exist first, owned by the role applying it. A Codex Sol (high) review and an explicit approval come before
-- any real database.
--
-- What it adds (owner-only; NO grant to anon / authenticated / service_role, so nothing here is reachable by an API role):
--   schema postona_threads_binding
--     state_generations  one row per Threads OAuth state: who began it, the workspace and account, and the owner epoch
--                        and the owner's lifecycle_version (G5's service generation) that the begin was allowed under
--     bindings           one row per Threads account: who bound it, from which state, the Threads user id, the two
--                        numbers it was bound under, and bound_at (AUDIT ONLY: never compared)
--     record_state_generation(actor, state, owner_epoch, lifecycle_version)   right after PR #124's begin, same transaction
--     attest_binding(actor, state, threads_user_id)                          right after PR #124's complete, same transaction
--     binding_row(social_account_id)                                         the G4-03 ThreadsAccountRow, numbers as text
--
-- The two numbers are those of G5's R1 allow token "g5oe:<owner_epoch>:<lifecycle_version>" (G5-03 PR #351 / G5-04
-- PR #358, candidates); both functions that take them compare them, in ONE statement, with what the database holds now:
-- F5's private.account_lifecycle_brand_owner_epoch(brand) and the brand owner's common_accounts.lifecycle_version. So:
--   * owner A -> B -> A between begin and callback: the epoch moved -> refused (the old allow does not come back);
--   * service ended and restarted (or any account / entitlement change) between them: lifecycle_version moved -> refused;
--   * an unknown epoch (F5 answers NULL), a state never recorded (begun before this candidate), another actor, another
--     workspace, another Threads user, a replay of the same state: refused with a fixed code.
-- Every refusal raises, so the caller's transaction (PR #124's begin / complete and this call together) rolls back: no
-- consumed state, no stored credential, no binding. Nothing decides by time; bound_at is for the audit trail only.
--
-- G4-13 (H2 #329 review of PR #367, P2 R1 + the S1 -> S2 -> S1 gap):
--   * R1: the install refuses while any API role (anon, authenticated, service_role, authenticator) can become this owner
--     (MEMBER / SET / USAGE: NOINHERIT and SET-only memberships included), and the postconditions enumerate the ACLs of the
--     schema, both tables and the three functions: ANY grantee other than the owner -- a delegate role that a default ACL
--     of the owner granted, whoever can SET ROLE to it -- refuses the whole install. Nothing is silently revoked.
--   * S1 -> S2 -> S1: a state can be attested at most ONCE, ever (state_generations.attested_at), and only in the very
--     transaction whose PR #124 complete consumed it (consumed_at = now()). An old state re-attested later -- directly
--     through the helper, after a reconnect replaced the binding -- is refused; it can no longer bring an old state back.
--
-- Not done here (named, not assumed):
--   * the caller. H5's owner transport must call record_state_generation right after begin and attest_binding right after
--     complete, in the same transaction, with the numbers of a fresh R1 allow (G4-06 adapter). BLOCKER: R1 needs the
--     workspace, and a first connect's begin creates it; G5 has not decided how begin is authorized (Issue #320 comments
--     6279536652 / 6279934094). Until then nothing calls this.
--   * the service key: no entitlement is named here; G5's W1 / W2 judge it at use time with the stored numbers.
--   * PR #124 itself is not changed.

begin;
set local lock_timeout = '2s';
set local search_path = '';

do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  v_fn text;
begin
  if (select rolsuper from pg_catalog.pg_roles where oid = v_me) then
    raise exception 'THREADS_BINDING_PRECONDITION_OWNER';
  end if;
  -- No API role may become this owner (SET ROLE), directly or through any membership, inherited or not.
  foreach v_fn in array array['anon', 'authenticated', 'service_role', 'authenticator'] loop
    if exists (select 1 from pg_catalog.pg_roles r where r.rolname = v_fn)
       and (pg_catalog.pg_has_role(v_fn, v_me, 'MEMBER') or pg_catalog.pg_has_role(v_fn, v_me, 'SET')
            or pg_catalog.pg_has_role(v_fn, v_me, 'USAGE')) then
      raise exception 'THREADS_BINDING_PRECONDITION_OWNER_REACHABLE %', v_fn;
    end if;
  end loop;
  if to_regclass('public.social_accounts') is null or to_regclass('public.social_account_oauth_states') is null
     or to_regclass('public.common_accounts') is null or to_regclass('public.brand_memberships') is null
     or (select relowner from pg_catalog.pg_class where oid = to_regclass('public.social_accounts')) <> v_me
     or (select relowner from pg_catalog.pg_class where oid = to_regclass('public.social_account_oauth_states')) <> v_me then
    raise exception 'THREADS_BINDING_PRECONDITION_TABLES';
  end if;
  if not exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = to_regclass('public.common_accounts') and a.attname = 'lifecycle_version'
                    and a.atttypid = 'bigint'::regtype and not a.attisdropped)
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = to_regclass('public.social_accounts') and a.attname = 'platform' and not a.attisdropped) then
    raise exception 'THREADS_BINDING_PRECONDITION_SHAPE';
  end if;
  -- PR #124's three RPCs, and F5's / G5's read-only facts, all owned by this role.
  foreach v_fn in array array[
    'public.begin_social_mobile_threads_oauth_connection(text,text,timestamptz)',
    'public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text)',
    'private.account_lifecycle_brand_owner(text)',
    'private.account_lifecycle_brand_owner_epoch(text)',
    'private.account_lifecycle_brand_owner_epoch_covered()'] loop
    if to_regprocedure(v_fn) is null or (select proowner from pg_catalog.pg_proc where oid = to_regprocedure(v_fn)) <> v_me then
      raise exception 'THREADS_BINDING_PRECONDITION_DEPENDENCY %', v_fn;
    end if;
  end loop;
  if private.account_lifecycle_brand_owner_epoch_covered() is not true then
    raise exception 'THREADS_BINDING_PRECONDITION_EPOCH_COVERAGE';
  end if;
  if to_regnamespace('postona_threads_binding') is not null then
    raise exception 'THREADS_BINDING_ALREADY_APPLIED';
  end if;
end $$;

create schema postona_threads_binding;
revoke all on schema postona_threads_binding from public, anon, authenticated, service_role;

create table postona_threads_binding.state_generations (
  oauth_state_id uuid primary key references public.social_account_oauth_states (id) on delete cascade,
  initiated_by uuid not null,
  brand_id text not null,
  social_account_id text not null,
  owner_epoch bigint not null check (owner_epoch >= 1),
  lifecycle_version bigint not null check (lifecycle_version >= 1),
  recorded_at timestamptz not null default now(), -- audit only
  attested_at timestamptz -- set once by attest_binding; a state is never attested twice (G4-13)
);

create table postona_threads_binding.bindings (
  social_account_id text primary key references public.social_accounts (id) on delete cascade,
  brand_id text not null,
  threads_user_id text not null check (threads_user_id ~ '^[1-9][0-9]{0,31}$'),
  bound_by uuid not null,
  oauth_state_id uuid not null unique,
  owner_epoch bigint not null check (owner_epoch >= 1),
  lifecycle_version bigint not null check (lifecycle_version >= 1),
  bound_at timestamptz not null default now() -- audit only: never compared
);

revoke all on all tables in schema postona_threads_binding from public, anon, authenticated, service_role;

-- Right after PR #124's begin, in the same transaction: the state this actor just began, unconsumed and unexpired, for a
-- Threads account of the same workspace; the actor is that workspace's single owner; the numbers equal the database's.
create function postona_threads_binding.record_state_generation(
  p_actor uuid, p_oauth_state_id uuid, p_owner_epoch bigint, p_lifecycle_version bigint
) returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_state public.social_account_oauth_states;
  v_owner uuid;
  v_epoch bigint;
  v_lifecycle bigint;
begin
  if p_actor is null or p_oauth_state_id is null or p_owner_epoch is null or p_owner_epoch < 1
     or p_lifecycle_version is null or p_lifecycle_version < 1 then
    raise exception 'THREADS_BINDING_INPUT_INVALID' using errcode = 'P0001';
  end if;
  select s.* into v_state from public.social_account_oauth_states s
   where s.id = p_oauth_state_id and s.initiated_by_user_id = p_actor and s.consumed_at is null and s.expires_at > now()
     and exists (select 1 from public.social_accounts sa
                  where sa.id = s.social_account_id and sa.brand_id = s.brand_id and sa.platform = 'threads')
   for update;
  if not found then
    raise exception 'THREADS_BINDING_STATE_INVALID' using errcode = 'P0001';
  end if;
  -- One statement: the owner, the owner epoch and the owner's lifecycle_version.
  select o.owner, private.account_lifecycle_brand_owner_epoch(v_state.brand_id),
         (select a.lifecycle_version from public.common_accounts a where a.user_id = o.owner)
    into v_owner, v_epoch, v_lifecycle
    from (select private.account_lifecycle_brand_owner(v_state.brand_id) as owner) o;
  if v_owner is distinct from p_actor then
    raise exception 'THREADS_BINDING_NOT_OWNER' using errcode = 'P0001';
  end if;
  if v_epoch is null or v_epoch < 1 then
    raise exception 'THREADS_BINDING_OWNER_EPOCH_UNKNOWN' using errcode = 'P0001';
  end if;
  if v_epoch <> p_owner_epoch then
    raise exception 'THREADS_BINDING_OWNER_EPOCH_CHANGED' using errcode = 'P0001';
  end if;
  if v_lifecycle is distinct from p_lifecycle_version then
    raise exception 'THREADS_BINDING_SERVICE_GENERATION_CHANGED' using errcode = 'P0001';
  end if;
  begin
    insert into postona_threads_binding.state_generations
      (oauth_state_id, initiated_by, brand_id, social_account_id, owner_epoch, lifecycle_version)
    values (v_state.id, p_actor, v_state.brand_id, v_state.social_account_id, p_owner_epoch, p_lifecycle_version);
  exception when unique_violation then
    raise exception 'THREADS_BINDING_STATE_ALREADY_RECORDED' using errcode = 'P0001';
  end;
end $$;

-- Right after PR #124's complete, in the same transaction: the state was recorded at begin, consumed by complete, begun by
-- this actor; the account is that state's Threads account, identity_verified with a credential and this Threads user id;
-- the actor is still the single owner, and the owner epoch and lifecycle_version are STILL those recorded at begin.
create function postona_threads_binding.attest_binding(
  p_actor uuid, p_oauth_state_id uuid, p_threads_user_id text
) returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gen postona_threads_binding.state_generations;
  v_account public.social_accounts;
  v_owner uuid;
  v_epoch bigint;
  v_lifecycle bigint;
begin
  if p_actor is null or p_oauth_state_id is null or p_threads_user_id is null or p_threads_user_id !~ '^[1-9][0-9]{0,31}$' then
    raise exception 'THREADS_BINDING_INPUT_INVALID' using errcode = 'P0001';
  end if;
  select g.* into v_gen from postona_threads_binding.state_generations g where g.oauth_state_id = p_oauth_state_id for update;
  if not found then
    raise exception 'THREADS_BINDING_GENERATION_UNRECORDED' using errcode = 'P0001';
  end if;
  if v_gen.initiated_by is distinct from p_actor then
    raise exception 'THREADS_BINDING_NOT_INITIATOR' using errcode = 'P0001';
  end if;
  -- Once per state, ever (G4-13): even after a reconnect replaced the binding, an old state is never attested again.
  if v_gen.attested_at is not null
     or exists (select 1 from postona_threads_binding.bindings b where b.oauth_state_id = p_oauth_state_id) then
    raise exception 'THREADS_BINDING_ALREADY_ATTESTED' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.social_account_oauth_states s
                  where s.id = p_oauth_state_id and s.initiated_by_user_id = p_actor and s.consumed_at is not null
                    and s.brand_id = v_gen.brand_id and s.social_account_id = v_gen.social_account_id) then
    raise exception 'THREADS_BINDING_STATE_NOT_COMPLETED' using errcode = 'P0001';
  end if;
  -- Only in the transaction whose PR #124 complete consumed this state (complete sets consumed_at = now()).
  if not exists (select 1 from public.social_account_oauth_states s where s.id = p_oauth_state_id and s.consumed_at = now()) then
    raise exception 'THREADS_BINDING_NOT_IN_COMPLETE_TRANSACTION' using errcode = 'P0001';
  end if;
  select sa.* into v_account from public.social_accounts sa where sa.id = v_gen.social_account_id for update;
  if not found or v_account.platform is distinct from 'threads' or v_account.brand_id is distinct from v_gen.brand_id
     or v_account.connection_status is distinct from 'identity_verified' or v_account.vault_access_token_secret_id is null
     or v_account.platform_user_id is distinct from p_threads_user_id then
    raise exception 'THREADS_BINDING_ACCOUNT_MISMATCH' using errcode = 'P0001';
  end if;
  select o.owner, private.account_lifecycle_brand_owner_epoch(v_gen.brand_id),
         (select a.lifecycle_version from public.common_accounts a where a.user_id = o.owner)
    into v_owner, v_epoch, v_lifecycle
    from (select private.account_lifecycle_brand_owner(v_gen.brand_id) as owner) o;
  if v_owner is distinct from p_actor then
    raise exception 'THREADS_BINDING_NOT_OWNER' using errcode = 'P0001';
  end if;
  if v_epoch is null or v_epoch < 1 then
    raise exception 'THREADS_BINDING_OWNER_EPOCH_UNKNOWN' using errcode = 'P0001';
  end if;
  if v_epoch <> v_gen.owner_epoch then
    raise exception 'THREADS_BINDING_OWNER_EPOCH_CHANGED' using errcode = 'P0001';
  end if;
  if v_lifecycle is distinct from v_gen.lifecycle_version then
    raise exception 'THREADS_BINDING_SERVICE_GENERATION_CHANGED' using errcode = 'P0001';
  end if;
  update postona_threads_binding.state_generations set attested_at = now() where oauth_state_id = p_oauth_state_id;
  -- A reconnect replaces the account's binding with this one (a new state, the numbers it was begun under).
  insert into postona_threads_binding.bindings
    (social_account_id, brand_id, threads_user_id, bound_by, oauth_state_id, owner_epoch, lifecycle_version)
  values (v_account.id, v_gen.brand_id, p_threads_user_id, p_actor, p_oauth_state_id, v_gen.owner_epoch, v_gen.lifecycle_version)
  on conflict (social_account_id) do update
    set brand_id = excluded.brand_id, threads_user_id = excluded.threads_user_id, bound_by = excluded.bound_by,
        oauth_state_id = excluded.oauth_state_id, owner_epoch = excluded.owner_epoch,
        lifecycle_version = excluded.lifecycle_version, bound_at = now();
end $$;

-- The G4-03 ThreadsAccountRow for one account; the two numbers as decimal text (never a JSON number). The binding's
-- columns are null when there is none, or when the account no longer carries the bound Threads user / workspace.
create function postona_threads_binding.binding_row(p_social_account_id text)
returns table (social_account_id text, brand_id text, platform text, platform_user_id text, connection_status text,
               has_access_credential boolean, bound_by uuid, bind_owner_epoch text, bind_lifecycle_version text)
language sql stable security definer set search_path = ''
as $$
  select sa.id, sa.brand_id, sa.platform, sa.platform_user_id, sa.connection_status,
         sa.vault_access_token_secret_id is not null,
         b.bound_by, b.owner_epoch::text, b.lifecycle_version::text
    from public.social_accounts sa
    left join postona_threads_binding.bindings b
      on b.social_account_id = sa.id and b.brand_id = sa.brand_id and b.threads_user_id is not distinct from sa.platform_user_id
   where sa.id = p_social_account_id and sa.platform = 'threads'
$$;

revoke all on function postona_threads_binding.record_state_generation(uuid, uuid, bigint, bigint),
                    postona_threads_binding.attest_binding(uuid, uuid, text),
                    postona_threads_binding.binding_row(text)
  from public, anon, authenticated, service_role;

-- Postconditions (G4-13, H2 #329 R1): owner / definer / empty search_path, and every ACL of what 001 created names ONLY this
-- owner: any other grantee (a default-ACL grant to some delegate role, whoever can SET ROLE to it) refuses the install.
-- A function's NULL proacl means PUBLIC may execute it: refused too. API roles must not be able to become the owner.
do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  v_fn text;
  v_rel text;
  v_api text;
begin
  foreach v_fn in array array[
    'postona_threads_binding.record_state_generation(uuid,uuid,bigint,bigint)',
    'postona_threads_binding.attest_binding(uuid,uuid,text)',
    'postona_threads_binding.binding_row(text)'] loop
    if not exists (select 1 from pg_catalog.pg_proc p where p.oid = to_regprocedure(v_fn) and p.proowner = v_me and p.prosecdef
                     and coalesce(p.proconfig @> array['search_path=""'], false)) then
      raise exception 'THREADS_BINDING_POSTCONDITION_FUNCTION %', v_fn;
    end if;
    if (select p.proacl from pg_catalog.pg_proc p where p.oid = to_regprocedure(v_fn)) is null
       or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
                   where p.oid = to_regprocedure(v_fn) and a.grantee <> v_me) then
      raise exception 'THREADS_BINDING_POSTCONDITION_FUNCTION_ACL %', v_fn;
    end if;
  end loop;
  foreach v_rel in array array['postona_threads_binding.state_generations', 'postona_threads_binding.bindings'] loop
    if exists (select 1 from pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
                where c.oid = to_regclass(v_rel) and a.grantee <> v_me) then
      raise exception 'THREADS_BINDING_POSTCONDITION_TABLE_ACL %', v_rel;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
              where n.nspname = 'postona_threads_binding' and a.grantee <> v_me) then
    raise exception 'THREADS_BINDING_POSTCONDITION_SCHEMA_ACL';
  end if;
  foreach v_api in array array['anon', 'authenticated', 'service_role', 'authenticator'] loop
    if exists (select 1 from pg_catalog.pg_roles r where r.rolname = v_api)
       and (pg_catalog.pg_has_role(v_api, v_me, 'MEMBER') or pg_catalog.pg_has_role(v_api, v_me, 'SET')
            or pg_catalog.pg_has_role(v_api, v_me, 'USAGE')) then
      raise exception 'THREADS_BINDING_POSTCONDITION_OWNER_REACHABLE %', v_api;
    end if;
  end loop;
end $$;

commit;
