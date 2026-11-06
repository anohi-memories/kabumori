-- G5 SOURCE CANDIDATE (2026-11-05, Issue #587 G5-02 task 8). NOT applied anywhere. Production NO_GO.
-- A SHARED-TABLE TRIGGER on public.brand_memberships: it needs the central room's explicit gate (and the review it decides) before any
-- adoption; this file is the candidate and its local proof, nothing more.
--
-- The contract (docs/common-account/g5-02-08-workspace-ownership-lock-contract.md): every write that can change a person's personal-workspace
-- eligibility (G5's S2-3, private.postona_personal_workspace_eligibility) first holds that person's public.common_accounts row FOR UPDATE,
-- before the workspace's brands row and before any brand_memberships row (the order G3 PR #644's notify() takes FOR SHARE: account ->
-- brand -> owner row; P1's lifecycle lock, T13 and G4's personal provisioner already start with the account row FOR UPDATE).
--
-- What was open (G3 PR #644 says so itself): notify() locks the existing rows, so a DELETE / UPDATE of them waits; but an INSERT -- another
-- member or owner joining the personal workspace, the person becoming the owner of another brand -- locks nothing notify() holds, so a
-- notification could be written for a workspace that stopped being the person's own personal one while it was being written (measured:
-- G5-02 #8 local tests, BEFORE). service_role and the tables' owner may INSERT brand_memberships directly (no RPC is needed to do it).
--
-- What this file does: one BEFORE INSERT OR UPDATE FOR EACH ROW trigger on public.brand_memberships. For each row it locks, FOR UPDATE and in
-- user_id order, the common_accounts rows of every person whose eligibility the row can change: the row's person (their "owns another
-- brand" fact; before and after an UPDATE) and every owner of the row's workspace (its member / owner counts; before and after). A writer
-- that already holds them (T13, the provisioner) takes nothing new; any other writer -- an RPC, service_role through the Data API, SQL --
-- now waits for a notification being written, and a notification waits for it (notify()'s FOR SHARE meets this FOR UPDATE).
-- DELETE is not triggered: deleting the person's own owner row is G3's FOR SHARE already; deleting another member only makes the workspace
-- personal again (a notification for an own workspace is correct either way); a workspace deletion locks the brands row G3 holds.
-- Not covered (documented): session_replication_role = replica (a superuser's way around every trigger); TRUNCATE (ACCESS EXCLUSIVE: it
-- waits for and blocks notify()'s row locks anyway).
-- Lock order for writers: account -> brand -> membership. A writer that locks the brands row FOR UPDATE and then inserts a membership while
-- a notification holds the account FOR SHARE deadlocks; PostgreSQL aborts one of the two (nothing inconsistent is committed; measured).
--
-- Refusals (P0001, nothing changed): WO_SUPERUSER, WO_PREREQUISITE_MISSING, WO_NOT_OWNER (CREATE TRIGGER needs the table's owner; the
-- account lock needs UPDATE on public.common_accounts), WO_TAKEN (a trigger / function of this name that is not this one),
-- WO_POSTCONDITION_*. Re-running it changes nothing. Rollback: 001_workspace_ownership_lock_rollback.sql.

begin;
set local lock_timeout = '5s';
set local search_path = '';

do $pre$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) then
    raise exception 'WO_SUPERUSER: run it as the owner of public.brand_memberships, not a superuser';
  end if;
  if pg_catalog.to_regclass('public.brand_memberships') is null or pg_catalog.to_regclass('public.common_accounts') is null
     or pg_catalog.to_regnamespace('private') is null then
    raise exception 'WO_PREREQUISITE_MISSING: public.brand_memberships, public.common_accounts and schema private are required';
  end if;
  if not pg_catalog.pg_has_role(v_owner, (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.brand_memberships'::pg_catalog.regclass), 'USAGE')
     or not pg_catalog.has_table_privilege(v_owner, 'public.common_accounts', 'UPDATE') then
    raise exception 'WO_NOT_OWNER: % must own public.brand_memberships and may UPDATE public.common_accounts', current_user;
  end if;
  if exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'public.brand_memberships'::pg_catalog.regclass and t.tgname = 'postona_workspace_ownership_lock'
              and t.tgfoid is distinct from pg_catalog.to_regprocedure('private.postona_workspace_ownership_lock()'))
     or exists (select 1 from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('private.postona_workspace_ownership_lock()') and p.proowner <> v_owner) then
    raise exception 'WO_TAKEN: postona_workspace_ownership_lock exists and is not this candidate''s';
  end if;
end;
$pre$;

create or replace function private.postona_workspace_ownership_lock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old_user uuid;
  v_old_brand text;
  v_users uuid[];
begin
  if tg_op = 'UPDATE' then
    v_old_user := old.user_id;
    v_old_brand := old.brand_id;
  end if;
  -- the people whose eligibility this row can change: the row's person (before / after), and every owner of the row's workspace (before / after)
  select pg_catalog.array_agg(distinct x.u order by x.u) into v_users
    from (select new.user_id as u
          union all select v_old_user
          union all select m.user_id from public.brand_memberships m where m.brand_id in (new.brand_id, v_old_brand) and m.role = 'owner') x
   where x.u is not null;
  -- FOR UPDATE, in user_id order (two such writers never wait on each other in a cycle): notify() (FOR SHARE) waits for this, and this for it
  perform 1 from public.common_accounts a where a.user_id = any (v_users) order by a.user_id for update;
  return new;
end $$;
revoke all on function private.postona_workspace_ownership_lock() from public, anon, authenticated, service_role;

drop trigger if exists postona_workspace_ownership_lock on public.brand_memberships;
create trigger postona_workspace_ownership_lock before insert or update on public.brand_memberships
  for each row execute function private.postona_workspace_ownership_lock();

do $post$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn oid := pg_catalog.to_regprocedure('private.postona_workspace_ownership_lock()');
begin
  -- exactly one trigger of this name: BEFORE, FOR EACH ROW, INSERT OR UPDATE (tgtype 1 + 2 + 4 + 16 = 23), enabled, no WHEN, no column list,
  -- not a constraint trigger, bound to this function
  if (select pg_catalog.count(*) from pg_catalog.pg_trigger t
       where t.tgrelid = 'public.brand_memberships'::pg_catalog.regclass and t.tgname = 'postona_workspace_ownership_lock' and t.tgfoid = v_fn
         and t.tgtype = 23 and t.tgenabled = 'O' and t.tgqual is null and pg_catalog.cardinality(t.tgattr::int2[]) = 0
         and t.tgconstraint = 0 and t.tgnargs = 0) <> 1 then
    raise exception 'WO_POSTCONDITION_TRIGGER';
  end if;
  -- the function: definer, owned here, empty search path, EXECUTE for the owner alone
  if (select p.proowner = v_owner and p.prosecdef and p.proconfig = array['search_path=""']
             and pg_catalog.array_to_string(p.proacl::text[], ',') = pg_catalog.format('%s=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user))
        from pg_catalog.pg_proc p where p.oid = v_fn) is not true then
    raise exception 'WO_POSTCONDITION_FUNCTION';
  end if;
end;
$post$;

commit;
