-- G3 SOURCE CANDIDATE (2026-10-20, Issue #318 TASK 8/50; prestate artifact TASK 16/50; row claim + post-lock checks TASK 17/50; ACL-free claim + column ACLs TASK 18/50). NOT in supabase/migrations/. Never apply to a managed or production database without the
-- limited Codex Sol (high) review of this file, the user's separate GO, a production mutation window and a read-back.
--
-- public.brand_memberships: take TRIGGER away from every API role and TRUNCATE / REFERENCES away from the end-user roles (and from PUBLIC).
-- This is the install dependency G5 PR #303 lists as L-1 (its owner-epoch install refuses while an API role still holds these):
--   revoke trigger on public.brand_memberships from anon, authenticated, service_role;
--   revoke truncate, references on public.brand_memberships from anon, authenticated;
-- The table's own migration (20260918120000) revokes only insert / update / delete from anon / authenticated, so the default grants of a new table
-- leave the other privileges in place. The real grants of the managed database are UNKNOWN; this file decides only from the catalog it runs on.
--
-- What it keeps: authenticated SELECT (the RLS self-select policy decides the rows), service_role SELECT / INSERT / UPDATE / DELETE, the table owner
-- (definer RPCs such as the X onboarding RPC and the deletion saga write as the owner). It creates no object, grants nothing, edits no row, no RLS
-- policy, no function and no file of another slot. Its only other write is the claim below, which resets a storage option that is not set and
-- sets its columns' statistics targets to the values they already have (reloptions and statistics stay exactly as they were). It is idempotent: a second run revokes nothing new and re-checks the same postconditions.
--
-- PRESTATE ARTIFACT (2026-10-20, Issue #318 TASK 16/50, H3 C3 R1): the run prints ONE line
--   BM_PRIV_PRESTATE v2|<database>|<table oid>|<the table's exact ACL before this run>|<sha256 of the four fields>
-- taken under the lock, before the REVOKE. "v2" (TASK 18/50) also means: every column ACL of the table was empty at that point (checked under the
-- claim; see COLUMN ACLs). v1 lines (TASK 16/17 builds) do not say that and the rollback refuses them. It is the only input the rollback file accepts: the rollback puts back exactly what THIS run took
-- away (owner-granted items only, no grant option, never to anon / PUBLIC) and refuses anything else. The line is recorded in the production
-- mutation window's read-back; nothing is stored in the database (no new table, no comment).
--
-- SERIALISATION (2026-10-20, TASK 17/50, H3 C3 R1 / R2; the claim statement replaced in TASK 18/50, H3 C3 TASK 7 R1 / R2): a table lock does
-- NOT serialise GRANT / REVOKE (measured on PG17: another session's REVOKE commits while this one holds even ACCESS EXCLUSIVE). A table-level
-- GRANT / REVOKE rewrites the table's pg_class row; a column-level one rewrites that column's pg_attribute row instead (the pg_class row is not
-- touched). A second writer of a row this transaction has rewritten waits for it, then fails ("tuple concurrently updated") or hits its
-- lock_timeout. So right after the table lock this file CLAIMS those rows, and only then takes the prestate:
--   ALTER TABLE ... RESET (<a storage option that is not set: fillfactor, else autovacuum_enabled, ...>), ALTER COLUMN <each column> SET STATISTICS
--   <its current value>   (when all four candidate options are set the file refuses: BM_PRIV_PRECONDITION_CLAIM_UNSUPPORTED)
-- These statements do not compute an ACL at all: they rewrite the row with its ACL as the catalog holds it, whatever that is (TASK 17's claim,
-- the owner granting itself SELECT, re-added a SELECT another session had revoked between the check and the claim: H3 R1). Their own values
-- cannot change between reading and rewriting them, because every other writer of reloptions / statistics needs a lock this one's table lock
-- excludes. The claim then checks that it rewrote the rows (their xmin is this transaction: an engine that skipped a no-op rewrite is refused)
-- and that reloptions / statistics are unchanged. The claim takes SHARE UPDATE EXCLUSIVE on top of the table lock: readers are not blocked.
-- What the claim serialises, and what it does not:
--   pg_class row of the table (relacl: every table-level GRANT / REVOKE, DROP OWNED, REASSIGN OWNED) -- serialised from the claim to COMMIT;
--   pg_attribute rows of the user columns (attacl: every column GRANT / REVOKE, DROP OWNED) -- serialised from the claim to COMMIT;
--   ADD / DROP / RENAME COLUMN, OWNER TO, RLS / policies, CREATE TRIGGER, reloptions -- excluded by the table lock;
--   pg_attribute rows of the SYSTEM columns (ctid, xmin, ...) -- NOT serialised: the owner cannot rewrite them without changing them (ALTER
--     COLUMN refuses system columns). They are checked like user columns (fail-closed whenever seen), but a system-column GRANT can still commit
--     between the last check and COMMIT. Of what this file revokes only REFERENCES is a column privilege, and a system column cannot be the
--     target of a foreign key (no unique index on a system column);
--   the role graph (pg_auth_members), default privileges, functions, other tables -- NOT serialised and NOT claimed to be.
-- Every precondition is checked again AFTER the lock, on the relation the lock was taken on (its OID must be the one the name gave before).
--
-- COLUMN ACLs (TASK 18/50, H3 C3 TASK 7 R2): a column ACL is a separate grant path (has_table_privilege does not see it). This file does not
-- snapshot or restore column ACLs: when ANY column of the table (user or system) carries an ACL at the prestate it refuses
-- (BM_PRIV_PRECONDITION_COLUMN_ACL_UNSUPPORTED) -- whatever the privilege, grantee, grantor or grant option -- and leaves the decision to a human.
-- After the REVOKE every column ACL must still be empty and no API role may reach INSERT / UPDATE / REFERENCES through a column
-- (has_any_column_privilege).
--
-- Fail-closed: any precondition or postcondition that does not hold raises and the whole transaction rolls back (nothing changes).
-- The postconditions are read from the catalog with has_table_privilege / pg_has_role, so a privilege left by another grantor, by PUBLIC or through
-- a role membership (direct or indirect, INHERIT or SET or ADMIN-only: pg_has_role MEMBER) is caught even though this REVOKE could not remove it.
begin;

set local lock_timeout = '5s';

do $$
declare
  v_me oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  if to_regclass('public.brand_memberships') is null then
    raise exception 'BM_PRIV_PRECONDITION_TABLE_MISSING';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_me) is distinct from false then
    raise exception 'BM_PRIV_PRECONDITION_RUN_AS_SUPERUSER';
  end if;
  -- only the owner's REVOKE removes the owner's (and the default-privilege) grants; any other role would revoke nothing and only warn
  if (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.brand_memberships'::regclass) is distinct from v_me then
    raise exception 'BM_PRIV_PRECONDITION_NOT_TABLE_OWNER';
  end if;
  if (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.brand_memberships'::regclass) is distinct from true then
    raise exception 'BM_PRIV_PRECONDITION_RLS_DISABLED';
  end if;
  if not exists (select 1 from pg_catalog.pg_policy p
                  where p.polrelid = 'public.brand_memberships'::regclass and p.polname = 'social_mobile_membership_self_select') then
    raise exception 'BM_PRIV_PRECONDITION_SELF_SELECT_POLICY_MISSING';
  end if;
  if exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) n(rolname)
              where not exists (select 1 from pg_catalog.pg_roles r where r.rolname = n.rolname)) then
    raise exception 'BM_PRIV_PRECONDITION_API_ROLE_MISSING';
  end if;
  perform pg_catalog.set_config('bm_priv.oid_before_lock', 'public.brand_memberships'::regclass::oid::text, true);
end $$;

-- Same lock as G5 PR #303's install (writers wait, readers do not); it also keeps a concurrent CREATE TRIGGER / ADD FOREIGN KEY out until commit.
lock table public.brand_memberships in share row exclusive mode;

-- every precondition again, on the relation that is now locked (a rename / replacement while this waited for the lock is refused)
do $$
declare
  v_me oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_table regclass := to_regclass('public.brand_memberships');
begin
  if v_table is null or v_table::oid::text is distinct from pg_catalog.current_setting('bm_priv.oid_before_lock', true) then
    raise exception 'BM_PRIV_PRECONDITION_TABLE_REPLACED';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_me) is distinct from false then
    raise exception 'BM_PRIV_PRECONDITION_RUN_AS_SUPERUSER';
  end if;
  if (select c.relowner from pg_catalog.pg_class c where c.oid = v_table) is distinct from v_me then
    raise exception 'BM_PRIV_PRECONDITION_NOT_TABLE_OWNER';
  end if;
  if (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = v_table) is distinct from true then
    raise exception 'BM_PRIV_PRECONDITION_RLS_DISABLED';
  end if;
  if not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = v_table and p.polname = 'social_mobile_membership_self_select') then
    raise exception 'BM_PRIV_PRECONDITION_SELF_SELECT_POLICY_MISSING';
  end if;
end $$;

-- the claim of the table's pg_class row and of every user column's pg_attribute row (TASK 18/50): rewritten with their current values, no ACL
-- is computed; from here to COMMIT no other table- or column-level GRANT / REVOKE of this table can commit (system columns: see the header)
do $$
declare
  v_table constant regclass := 'public.brand_memberships'::regclass;
  v_xid xid := pg_catalog.pg_current_xact_id()::xid;
  v_opts text[] := (select c.reloptions from pg_catalog.pg_class c where c.oid = v_table);
  -- the first of these (all SHARE UPDATE EXCLUSIVE) that is NOT set: RESET of an unset option leaves reloptions exactly as they are
  v_reset text := (select n.o from pg_catalog.unnest(array['fillfactor', 'autovacuum_enabled', 'parallel_workers', 'toast_tuple_target']) with ordinality n(o, i)
                    where not exists (select 1 from pg_catalog.pg_options_to_table(v_opts) t where t.option_name = n.o) order by n.i limit 1);
  v_stats text := (select pg_catalog.string_agg(a.attnum || ':' || coalesce(a.attstattarget::text, '-1'), ',' order by a.attnum)
                     from pg_catalog.pg_attribute a where a.attrelid = v_table and a.attnum > 0 and not a.attisdropped);
  v_cols text := (select pg_catalog.string_agg(pg_catalog.format('alter column %I set statistics %s', a.attname, coalesce(a.attstattarget::int, -1)), ', ' order by a.attnum)
                    from pg_catalog.pg_attribute a where a.attrelid = v_table and a.attnum > 0 and not a.attisdropped);
begin
  if v_reset is null then
    raise exception 'BM_PRIV_PRECONDITION_CLAIM_UNSUPPORTED';
  end if;
  execute pg_catalog.format('alter table public.brand_memberships %s', pg_catalog.concat_ws(', ', pg_catalog.format('reset (%I)', v_reset), v_cols));
  if (select c.xmin from pg_catalog.pg_class c where c.oid = v_table) is distinct from v_xid
     or exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = v_table and a.attnum > 0 and not a.attisdropped and a.xmin is distinct from v_xid) then
    raise exception 'BM_PRIV_PRECONDITION_CLAIM_NOT_TAKEN';
  end if;
  if (select c.reloptions from pg_catalog.pg_class c where c.oid = v_table) is distinct from v_opts
     or (select pg_catalog.string_agg(a.attnum || ':' || coalesce(a.attstattarget::text, '-1'), ',' order by a.attnum)
           from pg_catalog.pg_attribute a where a.attrelid = v_table and a.attnum > 0 and not a.attisdropped) is distinct from v_stats then
    raise exception 'BM_PRIV_PRECONDITION_CLAIM_NOT_NEUTRAL';
  end if;
end $$;
-- (claimed: the table's and its user columns' ACLs cannot change under this transaction)

-- the prestate, under the lock and the claim, before the REVOKE (printed after the postconditions); no column ACL may be there (see the header)
do $$
declare
  v_body text := 'v2|' || pg_catalog.current_database() || '|' || 'public.brand_memberships'::regclass::oid::text || '|'
    || coalesce(pg_catalog.array_to_string((select c.relacl from pg_catalog.pg_class c where c.oid = 'public.brand_memberships'::regclass), ','), '');
begin
  if exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = 'public.brand_memberships'::regclass and a.attacl is not null) then
    raise exception 'BM_PRIV_PRECONDITION_COLUMN_ACL_UNSUPPORTED';
  end if;
  perform pg_catalog.set_config('bm_priv.prestate', v_body || '|' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_body, 'UTF8')), 'hex'), true);
end $$;
-- (prestate taken: from here to COMMIT no other table- or user-column-level ACL change of this table can commit)

revoke trigger, truncate, references on table public.brand_memberships from public, anon, authenticated;
revoke trigger on table public.brand_memberships from service_role;

do $$
declare
  v_table constant regclass := 'public.brand_memberships'::regclass;
begin
  -- every role an API role is a member of (itself included), each with its own effective privileges (G5 PR #303's MEMBER reach)
  create temporary table bm_priv_reach on commit drop as
    select a.rolname as api, r.oid as role_oid, r.rolname, r.rolsuper, r.rolbypassrls
      from pg_catalog.pg_roles a
      join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
     where a.rolname in ('anon', 'authenticated', 'service_role', 'authenticator');

  if exists (select 1 from bm_priv_reach x where x.rolsuper) then
    raise exception 'BM_PRIV_POSTCONDITION_API_ROLE_CAN_BECOME_SUPERUSER';
  end if;
  if exists (select 1 from bm_priv_reach x join pg_catalog.pg_class c on c.oid = v_table and c.relowner = x.role_oid) then
    raise exception 'BM_PRIV_POSTCONDITION_API_ROLE_CAN_BECOME_OWNER';
  end if;
  if exists (select 1 from bm_priv_reach x where pg_catalog.has_parameter_privilege(x.role_oid, 'session_replication_role', 'SET')) then
    raise exception 'BM_PRIV_POSTCONDITION_API_ROLE_CAN_SKIP_TRIGGERS';
  end if;
  if exists (select 1 from bm_priv_reach x where pg_catalog.has_table_privilege(x.role_oid, v_table, 'TRIGGER')) then
    raise exception 'BM_PRIV_POSTCONDITION_API_ROLE_HAS_TRIGGER';
  end if;
  if exists (select 1 from bm_priv_reach x
              where x.api in ('anon', 'authenticated')
                and (pg_catalog.has_any_column_privilege(x.role_oid, v_table, 'INSERT')
                  or pg_catalog.has_any_column_privilege(x.role_oid, v_table, 'UPDATE')
                  or pg_catalog.has_table_privilege(x.role_oid, v_table, 'DELETE')
                  or pg_catalog.has_table_privilege(x.role_oid, v_table, 'TRUNCATE')
                  or pg_catalog.has_any_column_privilege(x.role_oid, v_table, 'REFERENCES'))) then
    raise exception 'BM_PRIV_POSTCONDITION_END_USER_ROLE_CAN_WRITE';
  end if;
  if exists (select 1 from bm_priv_reach x where x.api in ('anon', 'authenticated') and x.rolbypassrls) then
    raise exception 'BM_PRIV_POSTCONDITION_END_USER_ROLE_BYPASSES_RLS';
  end if;
  -- PUBLIC holds nothing on the table at all (a PUBLIC grant reaches every role, present and future)
  if exists (select 1 from pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) e
              where c.oid = v_table and e.grantee = 0) then
    raise exception 'BM_PRIV_POSTCONDITION_PUBLIC_HAS_PRIVILEGE';
  end if;
  -- no column ACL (user or system column) appeared: the REVOKE creates none, and the claim keeps user columns from changing
  if exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = v_table and a.attacl is not null) then
    raise exception 'BM_PRIV_POSTCONDITION_COLUMN_ACL_PRESENT';
  end if;
  -- the legitimate paths stay
  if not pg_catalog.has_table_privilege('authenticated', v_table, 'SELECT') then
    raise exception 'BM_PRIV_POSTCONDITION_AUTHENTICATED_SELECT_LOST';
  end if;
  if not (pg_catalog.has_table_privilege('service_role', v_table, 'SELECT')
          and pg_catalog.has_table_privilege('service_role', v_table, 'INSERT')
          and pg_catalog.has_table_privilege('service_role', v_table, 'UPDATE')
          and pg_catalog.has_table_privilege('service_role', v_table, 'DELETE')) then
    raise exception 'BM_PRIV_POSTCONDITION_SERVICE_ROLE_DML_LOST';
  end if;
  if (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = v_table) is distinct from true then
    raise exception 'BM_PRIV_POSTCONDITION_RLS_DISABLED';
  end if;
end $$;

select 'BM_PRIV_PRESTATE ' || pg_catalog.current_setting('bm_priv.prestate') as bm_priv_prestate;

commit;
