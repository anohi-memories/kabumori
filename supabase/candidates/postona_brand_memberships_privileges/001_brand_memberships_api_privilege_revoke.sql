-- G3 SOURCE CANDIDATE (2026-10-20, Issue #318 TASK 8/50; prestate artifact TASK 16/50; row claim + post-lock checks TASK 17/50). NOT in supabase/migrations/. Never apply to a managed or production database without the
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
-- policy, no function and no file of another slot. It is idempotent: a second run revokes nothing new and re-checks the same postconditions.
--
-- PRESTATE ARTIFACT (2026-10-20, Issue #318 TASK 16/50, H3 C3 R1): the run prints ONE line
--   BM_PRIV_PRESTATE v1|<database>|<table oid>|<the table's exact ACL before this run>|<sha256 of the four fields>
-- taken under the lock, before the REVOKE. It is the only input the rollback file accepts: the rollback puts back exactly what THIS run took
-- away (owner-granted items only, no grant option, never to anon / PUBLIC) and refuses anything else. The line is recorded in the production
-- mutation window's read-back; nothing is stored in the database (no new table, no comment).
--
-- SERIALISATION (2026-10-20, TASK 17/50, H3 C3 R1 / R2): a table lock does NOT serialise GRANT / REVOKE (measured on PG17: another session's
-- REVOKE commits while this one holds even ACCESS EXCLUSIVE), but every GRANT / REVOKE / ALTER of the table rewrites the table's pg_class
-- row, and a second writer of that row waits for the first transaction and then fails ("tuple concurrently updated") or hits its lock_timeout.
-- So right after the table lock this file CLAIMS the row with an ACL-neutral statement -- the owner grants itself SELECT, which it already
-- holds (checked first; the ACL does not change) -- and only then takes the prestate. From the claim to COMMIT no other ACL change of this
-- table can commit; table readers and writers are not blocked by the claim (the table lock still holds writers, as before).
-- Every precondition is checked again AFTER the lock, on the relation the lock was taken on (its OID must be the one the name gave before).
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
  -- the claim below must not change the ACL: the owner's own SELECT must already be there
  if not exists (select 1 from pg_catalog.pg_class c,
                   pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
                  where c.oid = v_table and a.grantor = v_me and a.grantee = v_me and a.privilege_type = 'SELECT') then
    raise exception 'BM_PRIV_PRECONDITION_OWNER_ACL_INCOMPLETE';
  end if;
end $$;

-- the claim of the table's pg_class row (ACL-neutral: the owner already holds SELECT); other GRANT / REVOKE / ALTER of this table now wait
do $$
begin
  execute pg_catalog.format('grant select on table public.brand_memberships to %I', current_user);
end $$;

-- the prestate, under the lock and the claim, before the REVOKE (printed after the postconditions)
do $$
declare
  v_body text := 'v1|' || pg_catalog.current_database() || '|' || 'public.brand_memberships'::regclass::oid::text || '|'
    || coalesce(pg_catalog.array_to_string((select c.relacl from pg_catalog.pg_class c where c.oid = 'public.brand_memberships'::regclass), ','), '');
begin
  perform pg_catalog.set_config('bm_priv.prestate', v_body || '|' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_body, 'UTF8')), 'hex'), true);
end $$;
-- (prestate taken: from here to COMMIT no other ACL change of this table can commit)

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
                and (pg_catalog.has_table_privilege(x.role_oid, v_table, 'INSERT')
                  or pg_catalog.has_table_privilege(x.role_oid, v_table, 'UPDATE')
                  or pg_catalog.has_table_privilege(x.role_oid, v_table, 'DELETE')
                  or pg_catalog.has_table_privilege(x.role_oid, v_table, 'TRUNCATE')
                  or pg_catalog.has_table_privilege(x.role_oid, v_table, 'REFERENCES'))) then
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
