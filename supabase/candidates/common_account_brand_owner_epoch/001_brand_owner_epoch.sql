-- F5 SOURCE CANDIDATE (2026-10-19). NOT in supabase/migrations/. Never apply to a managed or production database without an independent
-- focused Codex Sol (high) review of this file, the owner's explicit approval, and the PR #233 limited recheck.
--
-- Common account: the BRAND OWNER EPOCH — a durable, per-workspace number that changes on EVERY committed write that touches an OWNER membership
-- row of public.brand_memberships (insert, update, delete, cascade, truncate), and never goes back. It lets a credential or an attestation say
-- "I was made while the owner was A, at epoch N" and be refused later even when the owner went A -> B -> A, or owner -> admin -> owner.
--
--   private.account_lifecycle_brand_owner_epoch(p_brand_id text) -> bigint      STABLE, SECURITY DEFINER, empty search_path, owner-only EXECUTE
--        the epoch (>= 1) of a workspace that has EXACTLY ONE owner, whose recorded owner equals the actual owner, and while the write triggers
--        exist and are enabled; NULL ("unknown, refuse") for no workspace, no owner, two or more owners, a missing / disabled trigger, a session
--        that does not honour triggers, a row whose recorded owner differs from the actual one (a write got past the trigger), or a NULL argument.
--   private.account_lifecycle_brand_owner_epoch_covered() -> boolean           the coverage check the getter uses
--   private.account_lifecycle_brand_owner_epoch_resync(p_brand_id text) -> bigint
--        operator-only: treats "unknown" as a change (epoch + 1) and records the actual owner again; the way out after a trigger was disabled.
--
-- Storage: private.account_lifecycle_brand_owner_epochs(brand_id, epoch, owner_user_id, owner_count). No foreign key to brands: the row of a deleted
-- workspace stays, so a re-created workspace of the same id continues from its old number and can never repeat an earlier one. The number only
-- moves up (a guard trigger refuses a decrease, a delete and a truncate of the table).
--
-- What it changes: it ADDS two triggers on public.brand_memberships (AFTER row insert/update/delete, AFTER statement truncate) and private objects.
-- It edits no writer of the table (the X onboarding RPC, F4's Threads workspace provisioner, the account-deletion saga all keep working unchanged:
-- their inserts, updates and cascade deletes fire the row trigger). It grants nothing to an API role.
--
-- Install is a RE-START FENCE (J1 V1 R1): every workspace that has an owner row and every workspace already recorded is bumped UNCONDITIONALLY (a
-- new one starts at 1). The triggers were absent before the install (or since the rollback file), so whatever happened meanwhile -- including an
-- A -> B -> A that ends with the recorded owner -- can never make an earlier number valid again. The rollback file bumps every recorded workspace too.
--
-- Coverage (J1 V1 R2, R3): the getter answers only while BOTH write triggers are exactly the ones this file creates (same function OID, exact event
-- and timing bits, no WHEN clause, no column list, not a constraint trigger, enabled), the session honours triggers, and no API role can reach --
-- through any direct or indirect membership, INHERIT or SET -- the table owner, a superuser, SET on
-- session_replication_role, the TRIGGER privilege on public.brand_memberships, or (anon / authenticated) any write, TRUNCATE or REFERENCES on it.
-- The install refuses under the same conditions.
--
-- G5-20 REVISION (2026-10-22, Issue #320 task 20; G5-19 Q1 / Q2, PR #441): has_table_privilege does not see column ACLs, so the exposure check also
-- refuses while (a) anon / authenticated reach a COLUMN-level INSERT / UPDATE / REFERENCES on public.brand_memberships, (b) PUBLIC or any role an
-- API role reaches holds ANY column ACL item on it -- user or system column (the table's column-ACL allowlist is empty), and (c) PUBLIC or any role an
-- API role reaches holds ANY privilege on the history table private.account_lifecycle_brand_owner_epochs (table, column, TRIGGER, REFERENCES,
-- MAINTAIN; a global or schema default privilege that granted one is caught at the install's postcondition). It is evaluated on every read, like
-- the rest of the coverage. Not covered (and not claimed): MAINTAIN on public.brand_memberships, other tables, the role graph between two reads.
--
-- G5-21 REVISION (2026-10-22, Issue #320 task 21; H3 proxy review R1 on PR #446, Issue #330 comment 6332954454): a trigger made on the history while
-- a role held TRIGGER on it survives the revoke and the rollback, runs as the owner inside every bump, and a BEFORE UPDATE one held the number still
-- while the getter answered again. Now (1) the history's non-internal triggers must be EXACTLY its two guards
-- (private.account_lifecycle_owner_epoch_history_triggers(): HISTORY_FOREIGN_TRIGGER / HISTORY_GUARD_TRIGGER_NOT_EXACT / HISTORY_MISSING), checked by
-- the coverage on every read, by every bump BEFORE it writes (OWNER_EPOCH_HISTORY_TRIGGERS_NOT_EXACT: the owner-membership write is refused, no
-- foreign code runs), by the install before and after (OWNER_EPOCH_PRECONDITION_HISTORY_*, OWNER_EPOCH_POSTCONDITION_HISTORY_TRIGGERS) and by the
-- rollback file; (2) every bump checks the row as stored is exactly the one it wrote (OWNER_EPOCH_BUMP_NOT_RECORDED: a trigger committed while the
-- bump waited for the history lock cannot hold the number still). No file here drops a trigger it did not create. The triggers of
-- public.brand_memberships other than this file's two are NOT checked (other features own some; see the document, section 13).
--
-- Lock order: the writer's own rows first, then ONE row of the epoch table (inside the AFTER trigger); the owner set is read AFTER that row lock,
-- so a concurrent owner change of another membership row of the same workspace is always recorded by whichever bump commits last.
-- Readers take no lock. The one new
-- cycle this can create is two transactions that each touch two owner rows of the SAME workspace in opposite orders; PostgreSQL then aborts one of
-- them (40P01): nothing is written, nothing regresses.
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'OWNER_EPOCH_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if to_regclass('public.brand_memberships') is null or to_regnamespace('private') is null then
    raise exception 'OWNER_EPOCH_PRECONDITION_MEMBERSHIP_TABLE_MISSING';
  end if;
  -- the table, its columns and its key are exactly what the trigger reads
  if (select count(*) from pg_catalog.pg_attribute a
       where a.attrelid = 'public.brand_memberships'::regclass and not a.attisdropped
         and ((a.attname = 'brand_id' and a.atttypid = 'text'::regtype)
           or (a.attname = 'user_id' and a.atttypid = 'uuid'::regtype)
           or (a.attname = 'role' and a.atttypid = 'text'::regtype))) <> 3 then
    raise exception 'OWNER_EPOCH_PRECONDITION_MEMBERSHIP_SHAPE';
  end if;
  if (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.brand_memberships'::regclass) is distinct from v_owner then
    raise exception 'OWNER_EPOCH_PRECONDITION_MEMBERSHIP_OWNER';
  end if;
  if exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'public.brand_memberships'::regclass
              and t.tgname in ('account_lifecycle_owner_epoch_row', 'account_lifecycle_owner_epoch_truncate'))
     or to_regprocedure('private.account_lifecycle_brand_owner_epoch(text)') is not null
     or to_regprocedure('private.account_lifecycle_owner_epoch_exposure()') is not null
     or to_regprocedure('private.account_lifecycle_owner_epoch_history_triggers()') is not null then
    raise exception 'OWNER_EPOCH_ALREADY_APPLIED';
  end if;
end $$;

-- No writer between the reconciliation and the triggers.
lock table public.brand_memberships in share row exclusive mode;

-- What an API role can reach (J1 V1 R2, R3). Every role an API role is a MEMBER of -- directly or through other roles, with or without INHERIT, with
-- or without SET (pg_has_role MEMBER ignores both) -- is examined with ITS OWN effective privileges. Null = nothing unsafe; otherwise a fixed code.
create function private.account_lifecycle_owner_epoch_exposure()
returns text language sql stable security definer set search_path = '' as $$
  with api as (
    select r.oid, r.rolname from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
  ), reach as (
    select a.rolname as api, r.oid as role_oid, r.rolsuper as super
      from api a join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
  ), owner_role as (
    select c.relowner as oid from pg_catalog.pg_class c where c.oid = 'public.brand_memberships'::regclass
  ), history as (
    select pg_catalog.to_regclass('private.account_lifecycle_brand_owner_epochs') as oid
  )
  select case
    when exists (select 1 from reach x where x.super) then 'API_ROLE_CAN_BECOME_SUPERUSER'
    -- (a grant WITH ADMIN OPTION is a membership edge too, so an API role that can administer the owner is caught here)
    when exists (select 1 from reach x, owner_role o where x.role_oid = o.oid) then 'API_ROLE_CAN_BECOME_OWNER'
    -- session_replication_role = replica silences both write triggers for that session
    when exists (select 1 from reach x where pg_catalog.has_parameter_privilege(x.role_oid, 'session_replication_role', 'SET')) then 'API_ROLE_CAN_SKIP_TRIGGERS'
    when exists (select 1 from reach x where pg_catalog.has_table_privilege(x.role_oid, 'public.brand_memberships', 'TRIGGER')) then 'API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS'
    when exists (select 1 from reach x
                  where x.api in ('anon', 'authenticated')
                    and (pg_catalog.has_table_privilege(x.role_oid, 'public.brand_memberships', 'INSERT')
                      or pg_catalog.has_table_privilege(x.role_oid, 'public.brand_memberships', 'UPDATE')
                      or pg_catalog.has_table_privilege(x.role_oid, 'public.brand_memberships', 'DELETE')
                      or pg_catalog.has_table_privilege(x.role_oid, 'public.brand_memberships', 'TRUNCATE')
                      or pg_catalog.has_table_privilege(x.role_oid, 'public.brand_memberships', 'REFERENCES'))) then 'API_ROLE_CAN_WRITE_MEMBERSHIPS'
    -- (G5-20) a COLUMN-level INSERT / UPDATE / REFERENCES is a write path has_table_privilege does not see; a REFERENCES on the key columns alone
    -- lets an FK probe memberships past RLS and block the deletion cascade (G5-19 Q2)
    when exists (select 1 from reach x
                  where x.api in ('anon', 'authenticated')
                    and (pg_catalog.has_any_column_privilege(x.role_oid, 'public.brand_memberships', 'INSERT')
                      or pg_catalog.has_any_column_privilege(x.role_oid, 'public.brand_memberships', 'UPDATE')
                      or pg_catalog.has_any_column_privilege(x.role_oid, 'public.brand_memberships', 'REFERENCES'))) then 'API_ROLE_CAN_WRITE_MEMBERSHIPS_BY_COLUMN'
    -- (G5-20) the column-ACL allowlist of the table is EMPTY (G5-19 Q1): no column ACL item -- user or SYSTEM column (ctid, xmin, ...: has_any_column_privilege
    -- ignores those), any privilege, any grantor -- for PUBLIC or for any role an API role reaches
    when exists (select 1 from pg_catalog.pg_attribute a, pg_catalog.aclexplode(a.attacl) e
                  where a.attrelid = 'public.brand_memberships'::regclass and a.attacl is not null
                    and (e.grantee = 0 or e.grantee in (select x.role_oid from reach x))) then 'API_ROLE_HAS_MEMBERSHIP_COLUMN_ACL'
    -- (G5-20) the history the getter vouches for is server-only: no privilege at all -- table, column, TRIGGER (a trigger on it would run as the owner
    -- inside every bump), REFERENCES, MAINTAIN -- for PUBLIC or any role an API role reaches, whoever granted it (a global default privilege included).
    -- Before the first install the table does not exist and this is not evaluated. (A column privilege of a reached role is an attacl item of that
    -- role, of PUBLIC or of a role it inherits from -- all in reach -- so the second test covers every column path, system columns included.)
    when exists (select 1 from reach x, history h
                  where h.oid is not null
                    and pg_catalog.has_table_privilege(x.role_oid, h.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'))
      or exists (select 1 from history h, pg_catalog.pg_attribute a, pg_catalog.aclexplode(a.attacl) e
                  where h.oid is not null and a.attrelid = h.oid and a.attacl is not null
                    and (e.grantee = 0 or e.grantee in (select x.role_oid from reach x))) then 'API_ROLE_CAN_REACH_OWNER_EPOCH_HISTORY'
    else null
  end
$$;
revoke all on function private.account_lifecycle_owner_epoch_exposure() from public, anon, authenticated, service_role;

-- (G5-21, H3 proxy review R1 on PR #446) The history's own triggers must be EXACTLY the two guards this file creates. A trigger made on the history
-- while some role held TRIGGER on it SURVIVES the revoke and the rollback (the table and its guards are kept on purpose); it runs inside every bump
-- as the owner, and a BEFORE UPDATE one can hold the number still (owner -> admin -> owner leaving it unchanged). Null = exact; otherwise a fixed
-- code. Internal (foreign-key) triggers are not counted: an FK onto the history needs REFERENCES, which the exposure check refuses, and the history
-- key never changes. This file never drops a trigger it did not create: it refuses instead.
create function private.account_lifecycle_owner_epoch_history_triggers()
returns text language sql stable security definer set search_path = '' as $$
  with h as (
    select pg_catalog.to_regclass('private.account_lifecycle_brand_owner_epochs') as oid
  ), t as (
    select t.* from pg_catalog.pg_trigger t, h where t.tgrelid = h.oid and not t.tgisinternal
  ), exact as (
    select t.oid from t
      join pg_catalog.pg_proc f on f.oid = t.tgfoid
     where t.tgfoid = pg_catalog.to_regprocedure('private.account_lifecycle_owner_epoch_history_guard()')
       and t.tgenabled in ('O', 'A') and t.tgqual is null and pg_catalog.cardinality(t.tgattr::int2[]) = 0 and t.tgconstraint = 0 and t.tgnargs = 0
       and t.tgoldtable is null and t.tgnewtable is null
       and f.proowner = (select c.relowner from pg_catalog.pg_class c, h where c.oid = h.oid)
       and f.prosecdef and f.proconfig @> array['search_path=""']
       -- row, BEFORE, UPDATE + DELETE = 27; statement, BEFORE, TRUNCATE = 34
       and ((t.tgname = 'account_lifecycle_owner_epoch_history_row' and t.tgtype = 27)
         or (t.tgname = 'account_lifecycle_owner_epoch_history_truncate' and t.tgtype = 34))
  )
  select case
    when (select h.oid from h) is null then 'HISTORY_MISSING'
    when exists (select 1 from t where t.tgname not in ('account_lifecycle_owner_epoch_history_row', 'account_lifecycle_owner_epoch_history_truncate'))
      then 'HISTORY_FOREIGN_TRIGGER'
    -- (trigger names are unique per table, so with no foreign name at most the two guards are left: both must be exact)
    when (select pg_catalog.count(*) from exact) <> 2 then 'HISTORY_GUARD_TRIGGER_NOT_EXACT'
    else null
  end
$$;
revoke all on function private.account_lifecycle_owner_epoch_history_triggers() from public, anon, authenticated, service_role;

do $$
declare
  v_code text := private.account_lifecycle_owner_epoch_exposure();
begin
  -- the TRIGGER / TRUNCATE / REFERENCES grants of public.brand_memberships belong to that table's migration (F3 / G3): this file does not change them,
  -- it refuses to install while they are there
  if v_code is not null then
    raise exception 'OWNER_EPOCH_PRECONDITION_%', v_code;
  end if;
  -- (G5-21) a re-install over a kept history: any trigger that is not one of its two exact guards refuses the install (it is not dropped)
  if to_regclass('private.account_lifecycle_brand_owner_epochs') is not null then
    v_code := private.account_lifecycle_owner_epoch_history_triggers();
    if v_code is not null then
      raise exception 'OWNER_EPOCH_PRECONDITION_%', v_code;
    end if;
  end if;
end $$;

-- The history. Kept on purpose when the rollback file runs: dropping it would let a number repeat.
create table if not exists private.account_lifecycle_brand_owner_epochs (
  brand_id text primary key check (brand_id <> ''),
  epoch bigint not null check (epoch >= 1),
  owner_user_id uuid,
  owner_count integer not null check (owner_count >= 0),
  check ((owner_count = 1) = (owner_user_id is not null))
);
alter table private.account_lifecycle_brand_owner_epochs enable row level security;
revoke all on table private.account_lifecycle_brand_owner_epochs from public, anon, authenticated, service_role;

-- The history never goes back: no decrease, no re-keying, no delete, no truncate.
create or replace function private.account_lifecycle_owner_epoch_history_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.brand_id = old.brand_id and new.epoch > old.epoch then
      return new;
    end if;
  end if;
  raise exception 'OWNER_EPOCH_HISTORY_IS_APPEND_ONLY' using errcode = '42501';
end $$;
drop trigger if exists account_lifecycle_owner_epoch_history_row on private.account_lifecycle_brand_owner_epochs;
create trigger account_lifecycle_owner_epoch_history_row before update or delete on private.account_lifecycle_brand_owner_epochs
  for each row execute function private.account_lifecycle_owner_epoch_history_guard();
drop trigger if exists account_lifecycle_owner_epoch_history_truncate on private.account_lifecycle_brand_owner_epochs;
create trigger account_lifecycle_owner_epoch_history_truncate before truncate on private.account_lifecycle_brand_owner_epochs
  for each statement execute function private.account_lifecycle_owner_epoch_history_guard();

-- One bump: moves the number up by one (creating it at 1) and records the owner state of the workspace as seen AFTER the row lock is held, so a
-- concurrent owner change of another membership row that committed while this waited is the one recorded.
create function private.account_lifecycle_owner_epoch_bump(p_brand_id text)
returns bigint language plpgsql volatile security definer set search_path = '' as $$
declare
  v_owners uuid[];
  v_epoch bigint;
  v_got_epoch bigint;
  v_got_owner uuid;
  v_got_count integer;
begin
  -- (G5-21) no foreign trigger may run inside a bump: refuse BEFORE writing the history, so its code never runs as the owner
  if private.account_lifecycle_owner_epoch_history_triggers() is not null then
    raise exception 'OWNER_EPOCH_HISTORY_TRIGGERS_NOT_EXACT' using errcode = '42501';
  end if;
  -- a new workspace: no one else can hold its row yet (a concurrent creator waits on the key, then takes the update path below)
  select coalesce(pg_catalog.array_agg(m.user_id order by m.user_id), '{}'::uuid[]) into v_owners
    from public.brand_memberships m where m.brand_id = p_brand_id and m.role = 'owner';
  insert into private.account_lifecycle_brand_owner_epochs (brand_id, epoch, owner_user_id, owner_count)
  values (p_brand_id, 1, case when pg_catalog.cardinality(v_owners) = 1 then v_owners[1] end, pg_catalog.cardinality(v_owners))
  on conflict (brand_id) do nothing
  returning epoch, owner_user_id, owner_count into v_got_epoch, v_got_owner, v_got_count;
  if found then
    -- (G5-21) the row as stored (after any BEFORE trigger) is exactly the one written
    if v_got_epoch is distinct from 1 or v_got_owner is distinct from (case when pg_catalog.cardinality(v_owners) = 1 then v_owners[1] end)
       or v_got_count is distinct from pg_catalog.cardinality(v_owners) then
      raise exception 'OWNER_EPOCH_BUMP_NOT_RECORDED' using errcode = '42501';
    end if;
    return 1;
  end if;
  -- an existing workspace: lock its row FIRST, then read the owners with a fresh snapshot
  select e.epoch into v_epoch from private.account_lifecycle_brand_owner_epochs e where e.brand_id = p_brand_id for update;
  select coalesce(pg_catalog.array_agg(m.user_id order by m.user_id), '{}'::uuid[]) into v_owners
    from public.brand_memberships m where m.brand_id = p_brand_id and m.role = 'owner';
  update private.account_lifecycle_brand_owner_epochs
     set epoch = v_epoch + 1, owner_user_id = case when pg_catalog.cardinality(v_owners) = 1 then v_owners[1] end, owner_count = pg_catalog.cardinality(v_owners)
   where brand_id = p_brand_id
  returning epoch, owner_user_id, owner_count into v_got_epoch, v_got_owner, v_got_count;
  -- (G5-21) a trigger committed while this bump waited for the history lock (after the check above) cannot hold the number still or skip the row;
  -- "not found" also covers a new workspace whose row a BEFORE INSERT trigger dropped (then no row was locked above either)
  if not found or v_got_epoch is distinct from v_epoch + 1
     or v_got_owner is distinct from (case when pg_catalog.cardinality(v_owners) = 1 then v_owners[1] end)
     or v_got_count is distinct from pg_catalog.cardinality(v_owners) then
    raise exception 'OWNER_EPOCH_BUMP_NOT_RECORDED' using errcode = '42501';
  end if;
  return v_epoch + 1;
end $$;

-- The write events: every change that adds, removes or alters an OWNER row moves the number of each workspace it touches.
create function private.account_lifecycle_owner_epoch_record()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
declare
  v_brands text[] := '{}';
  v_brand text;
begin
  if tg_op = 'INSERT' then
    if new.role = 'owner' then v_brands := array[new.brand_id]; end if;
  elsif tg_op = 'DELETE' then
    if old.role = 'owner' then v_brands := array[old.brand_id]; end if;
  elsif (old.brand_id, old.user_id, old.role) is distinct from (new.brand_id, new.user_id, new.role) then
    if old.role = 'owner' then v_brands := array[old.brand_id]; end if;
    if new.role = 'owner' and not (new.brand_id = any (v_brands)) then v_brands := v_brands || new.brand_id; end if;
  end if;
  foreach v_brand in array v_brands loop
    perform private.account_lifecycle_owner_epoch_bump(v_brand);
  end loop;
  return null;
end $$;

-- TRUNCATE has no row events: treat it as a change of every recorded workspace.
create function private.account_lifecycle_owner_epoch_truncated()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
declare
  v_row record;
  v_got bigint;
begin
  -- (G5-21) the same refusal and the same written-exactly check as the bump, row by row
  if private.account_lifecycle_owner_epoch_history_triggers() is not null then
    raise exception 'OWNER_EPOCH_HISTORY_TRIGGERS_NOT_EXACT' using errcode = '42501';
  end if;
  for v_row in select e.brand_id, e.epoch from private.account_lifecycle_brand_owner_epochs e order by e.brand_id for update loop
    update private.account_lifecycle_brand_owner_epochs set epoch = v_row.epoch + 1, owner_user_id = null, owner_count = 0
     where brand_id = v_row.brand_id
    returning epoch into v_got;
    if not found or v_got is distinct from v_row.epoch + 1 then
      raise exception 'OWNER_EPOCH_BUMP_NOT_RECORDED' using errcode = '42501';
    end if;
  end loop;
  return null;
end $$;

-- Coverage: the two write triggers are EXACTLY the ones this file creates, THIS session honours triggers, and no API role can reach anything that
-- would let it replace them or write around them. A same-named trigger with another function, a WHEN clause, a column list or other event / timing
-- bits does not count (J1 V1 R2).
create function private.account_lifecycle_brand_owner_epoch_covered()
returns boolean language sql stable security definer set search_path = '' as $$
  select pg_catalog.current_setting('session_replication_role') = 'origin'
     and private.account_lifecycle_owner_epoch_exposure() is null
     -- (G5-21) and the history's own triggers are exactly its two guards (a foreign one survives any revoke)
     and private.account_lifecycle_owner_epoch_history_triggers() is null
     and (select pg_catalog.count(*) from pg_catalog.pg_trigger t
           join pg_catalog.pg_proc f on f.oid = t.tgfoid
           where t.tgrelid = 'public.brand_memberships'::regclass and not t.tgisinternal and t.tgenabled in ('O', 'A')
             and t.tgqual is null and pg_catalog.cardinality(t.tgattr::int2[]) = 0 and t.tgconstraint = 0 and t.tgnargs = 0
             and t.tgoldtable is null and t.tgnewtable is null
             and f.proowner = (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.brand_memberships'::regclass)
             and f.prosecdef and f.proconfig @> array['search_path=""']
             and ((t.tgname = 'account_lifecycle_owner_epoch_row' and t.tgtype = 29
                   and t.tgfoid = 'private.account_lifecycle_owner_epoch_record()'::regprocedure)
               or (t.tgname = 'account_lifecycle_owner_epoch_truncate' and t.tgtype = 32
                   and t.tgfoid = 'private.account_lifecycle_owner_epoch_truncated()'::regprocedure))) = 2
$$;

-- The getter.
create function private.account_lifecycle_brand_owner_epoch(p_brand_id text)
returns bigint language plpgsql stable security definer set search_path = '' as $$
declare
  v_row private.account_lifecycle_brand_owner_epochs;
  v_owners uuid[];
begin
  if p_brand_id is null or not private.account_lifecycle_brand_owner_epoch_covered() then
    return null;
  end if;
  select * into v_row from private.account_lifecycle_brand_owner_epochs e where e.brand_id = p_brand_id;
  if not found then
    return null;
  end if;
  select coalesce(pg_catalog.array_agg(m.user_id), '{}'::uuid[]) into v_owners
    from public.brand_memberships m where m.brand_id = p_brand_id and m.role = 'owner';
  -- exactly one owner, and it is the owner the last bump recorded (otherwise a write got past the trigger)
  if pg_catalog.cardinality(v_owners) <> 1 or v_row.owner_count <> 1 or v_row.owner_user_id is distinct from v_owners[1] then
    return null;
  end if;
  return v_row.epoch;
end $$;

-- The way out after the coverage was broken: the unknown becomes a change.
create function private.account_lifecycle_brand_owner_epoch_resync(p_brand_id text)
returns bigint language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_brand_id is null or p_brand_id = '' then
    raise exception 'OWNER_EPOCH_BRAND_REQUIRED' using errcode = '22023';
  end if;
  if not private.account_lifecycle_brand_owner_epoch_covered() then
    raise exception 'OWNER_EPOCH_COVERAGE_BROKEN' using errcode = '42501';
  end if;
  return private.account_lifecycle_owner_epoch_bump(p_brand_id);
end $$;

-- The re-start fence (the first install and every re-install): EVERY workspace with an owner row and EVERY recorded workspace moves on, whatever its
-- owner state now -- a number issued before the triggers were absent can never be valid again (J1 V1 R1). A first install creates them at 1.
do $$
declare
  v_brand text;
begin
  for v_brand in
    select m.brand_id from public.brand_memberships m where m.role = 'owner'
    union
    select e.brand_id from private.account_lifecycle_brand_owner_epochs e
    order by 1
  loop
    perform private.account_lifecycle_owner_epoch_bump(v_brand);
  end loop;
end $$;

create trigger account_lifecycle_owner_epoch_row after insert or update or delete on public.brand_memberships
  for each row execute function private.account_lifecycle_owner_epoch_record();
create trigger account_lifecycle_owner_epoch_truncate after truncate on public.brand_memberships
  for each statement execute function private.account_lifecycle_owner_epoch_truncated();

revoke all on function private.account_lifecycle_owner_epoch_history_guard(), private.account_lifecycle_owner_epoch_bump(text),
  private.account_lifecycle_owner_epoch_record(), private.account_lifecycle_owner_epoch_truncated(),
  private.account_lifecycle_brand_owner_epoch_covered(), private.account_lifecycle_brand_owner_epoch(text),
  private.account_lifecycle_brand_owner_epoch_resync(text), private.account_lifecycle_owner_epoch_exposure() from public, anon, authenticated, service_role;

-- Postconditions: every function is the owner's alone (no role an API role can reach -- through any membership, INHERIT or SET -- may execute it),
-- definer with an empty search path; the table has no grant to any such role; both write triggers are exactly right; the covered check is true;
-- every owner workspace has an epoch >= 1.
do $$
declare
  v_fn regprocedure;
begin
  foreach v_fn in array array[
    'private.account_lifecycle_owner_epoch_history_guard()'::regprocedure, 'private.account_lifecycle_owner_epoch_bump(text)'::regprocedure,
    'private.account_lifecycle_owner_epoch_record()'::regprocedure, 'private.account_lifecycle_owner_epoch_truncated()'::regprocedure,
    'private.account_lifecycle_brand_owner_epoch_covered()'::regprocedure, 'private.account_lifecycle_brand_owner_epoch(text)'::regprocedure,
    'private.account_lifecycle_brand_owner_epoch_resync(text)'::regprocedure, 'private.account_lifecycle_owner_epoch_exposure()'::regprocedure,
    'private.account_lifecycle_owner_epoch_history_triggers()'::regprocedure] loop
    if (select array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn)
         is distinct from format('%s=X/%s', quote_ident(current_user), quote_ident(current_user))
       or not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.prosecdef and p.proconfig @> array['search_path=""']) then
      raise exception 'OWNER_EPOCH_POSTCONDITION_FUNCTION_ACL %', v_fn;
    end if;
    if exists (select 1 from pg_catalog.pg_roles a join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
                where a.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                  and pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE')) then
      raise exception 'OWNER_EPOCH_POSTCONDITION_API_ROLE_REACHES %', v_fn;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_roles a join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
              where a.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                and (pg_catalog.has_table_privilege(r.oid, 'private.account_lifecycle_brand_owner_epochs', 'SELECT')
                  or pg_catalog.has_table_privilege(r.oid, 'private.account_lifecycle_brand_owner_epochs', 'INSERT')
                  or pg_catalog.has_table_privilege(r.oid, 'private.account_lifecycle_brand_owner_epochs', 'UPDATE')
                  or pg_catalog.has_table_privilege(r.oid, 'private.account_lifecycle_brand_owner_epochs', 'DELETE')
                  or pg_catalog.has_table_privilege(r.oid, 'private.account_lifecycle_brand_owner_epochs', 'TRUNCATE'))) then
    raise exception 'OWNER_EPOCH_POSTCONDITION_TABLE_ACL';
  end if;
  if private.account_lifecycle_owner_epoch_exposure() is not null then
    raise exception 'OWNER_EPOCH_POSTCONDITION_EXPOSURE';
  end if;
  if private.account_lifecycle_owner_epoch_history_triggers() is not null then
    raise exception 'OWNER_EPOCH_POSTCONDITION_HISTORY_TRIGGERS';
  end if;
  if not private.account_lifecycle_brand_owner_epoch_covered() then
    raise exception 'OWNER_EPOCH_POSTCONDITION_COVERAGE';
  end if;
  if exists (select 1 from public.brand_memberships m where m.role = 'owner'
              and not exists (select 1 from private.account_lifecycle_brand_owner_epochs e where e.brand_id = m.brand_id and e.epoch >= 1)) then
    raise exception 'OWNER_EPOCH_POSTCONDITION_RECONCILIATION';
  end if;
end $$;

commit;
