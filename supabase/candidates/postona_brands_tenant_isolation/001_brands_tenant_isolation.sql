-- G5 SOURCE CANDIDATE (2026-10-30, Issue #587 G5-02 task 3). NOT applied anywhere. Production NO_GO: running it on a managed project needs
-- the owner's explicit approval, the Codex Sol (high) review of this candidate and a read of that project's state with
-- MVP_RELEASE_PREFLIGHT.sql first (its state is not known: never connected).
--
-- What it fixes (G5-02 task 2, measured on the real local Supabase with real JWTs through PostgREST): no migration enables row security on
-- public.brands (the member read policy of 20260918120000 does nothing without it) and the image's default privileges let anon / authenticated
-- write it. A person read every brand, set another person's workspace active / live, deleted it (its membership went with it by cascade) and
-- inserted brands; anon inserted brands.
--
-- What it does, in ONE transaction, as the owner of public.brands (not a superuser):
--   1. refuses unless the world is the one this fix is for (every refusal below changes nothing);
--   2. records the API roles' privileges and the row security flag of public.brands as they are now in
--      private.postona_brands_isolation_prestate (owner-only; the rollback restores exactly that; a re-run keeps the first record);
--   3. revokes every privilege of PUBLIC and anon on brands, and every write of authenticated (INSERT / UPDATE / DELETE / TRUNCATE /
--      REFERENCES / TRIGGER / MAINTAIN, table and column level); authenticated keeps SELECT, read through the member policy only;
--   4. enables (does not force) row security on brands;
--   5. checks the result through every role anon / authenticated can reach (membership, PUBLIC, column grants), else refuses as a whole.
-- It creates no policy, function, role or grant, and changes no row. service_role (BYPASSRLS on Supabase) and the SECURITY DEFINER writers
-- (the X OAuth begin RPC, the POSTONA deletion functions, G5's W0) keep working: they run as an owner that row security does not filter,
-- which the install checks for every definer function that names brands. brand_memberships is checked, not changed (its ACL is G3 #370's).
--
-- Refusals (SQLSTATE P0001, message prefix):
--   BRANDS_ISOLATION_PREREQUISITE_MISSING  public.brands / public.brand_memberships / anon / authenticated / schema private is missing
--   BRANDS_ISOLATION_SUPERUSER             run by a superuser (run it as the owner of public.brands)
--   BRANDS_ISOLATION_NOT_OWNER             the caller cannot act as the owner of public.brands
--   BRANDS_FORCE_ROW_SECURITY              brands forces row security (the definer writers owned by the table owner would be filtered)
--   BRANDS_MEMBERSHIPS_NOT_ISOLATED        brand_memberships: row security off, its self read policy missing / changed, or an API write on it
--   BRANDS_MEMBER_POLICY                   the member read policy of brands is missing or is not 20260918120000's (authenticated, SELECT,
--                                          permissive, own memberships by auth.uid())
--   BRANDS_UNREVIEWED_POLICY               another permissive policy on brands reaches PUBLIC / anon / authenticated (it would widen reads)
--   BRANDS_VIEW_BYPASS                     a view / materialized view reads brands as its owner and anon / authenticated may select it
--   BRANDS_INVOKER_WRITER                  a SECURITY INVOKER function anon / authenticated may execute writes brands (it would break)
--   BRANDS_DEFINER_FILTERED                a SECURITY DEFINER function naming brands is owned by a role row security would filter
--   BRANDS_MEMBER_READ_MISSING             authenticated cannot read the columns G1's snapshot reads (granting them is not this file's job)
--   BRANDS_POSTCONDITION_*                 the result is not the one described above (nothing is kept)
-- Rollback: 001_brands_tenant_isolation_rollback.sql (restores the recorded state: the cross-tenant write paths come back and
-- MVP_RELEASE_PREFLIGHT.sql reports PF_BRANDS FAIL again).

begin;
set local lock_timeout = '5s';
set local search_path = '';

do $install$
declare
  v_brands regclass := pg_catalog.to_regclass('public.brands');
  v_members regclass := pg_catalog.to_regclass('public.brand_memberships');
  v_anon oid := pg_catalog.to_regrole('anon');
  v_auth oid := pg_catalog.to_regrole('authenticated');
  v_owner oid;
  v_writes text[] := array['DELETE', 'TRUNCATE', 'TRIGGER'];
  v_txt text;
begin
  if v_brands is null or v_members is null or v_anon is null or v_auth is null or pg_catalog.to_regnamespace('private') is null then
    raise exception 'BRANDS_ISOLATION_PREREQUISITE_MISSING: public.brands, public.brand_memberships, anon, authenticated and schema private are required';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'BRANDS_ISOLATION_SUPERUSER: run it as the owner of public.brands, not a superuser';
  end if;
  select c.relowner into v_owner from pg_catalog.pg_class c where c.oid = v_brands;
  if not pg_catalog.pg_has_role(current_user, v_owner, 'USAGE') then
    raise exception 'BRANDS_ISOLATION_NOT_OWNER: % cannot act as %, the owner of public.brands', current_user, v_owner::regrole;
  end if;
  -- the same order as every writer (brands, then its memberships): no lock cycle with W0, the X OAuth begin or the deletion
  lock table public.brands in access exclusive mode;
  lock table public.brand_memberships in access share mode;
  if pg_catalog.current_setting('server_version_num')::int >= 170000 then
    v_writes := v_writes || 'MAINTAIN'::text;
  end if;

  if (select c.relforcerowsecurity from pg_catalog.pg_class c where c.oid = v_brands) then
    raise exception 'BRANDS_FORCE_ROW_SECURITY: public.brands forces row security; the definer writers owned by its owner would be filtered';
  end if;

  -- the membership rows the brands policy trusts: row security on, the self read policy as 20260918120000 made it, no API row write
  select pg_catalog.concat_ws('; ',
    case when not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = v_members) then 'row security off' end,
    case when not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = v_members and p.polname = 'social_mobile_membership_self_select'
                            and p.polcmd = 'r' and p.polpermissive and p.polroles = array[v_auth]) then 'social_mobile_membership_self_select missing or changed' end,
    (select 'writable by ' || pg_catalog.string_agg(distinct x.rolname || ':' || k, ', ' order by x.rolname || ':' || k)
       from pg_catalog.pg_roles x, pg_catalog.unnest(array['INSERT', 'UPDATE', 'DELETE']) k
      where (pg_catalog.pg_has_role(v_anon, x.oid, 'MEMBER') or pg_catalog.pg_has_role(v_auth, x.oid, 'MEMBER'))
        and case when k = 'DELETE' then pg_catalog.has_table_privilege(x.oid, v_members, k) else pg_catalog.has_any_column_privilege(x.oid, v_members, k) end))
    into v_txt;
  if v_txt <> '' then
    raise exception 'BRANDS_MEMBERSHIPS_NOT_ISOLATED: brand_memberships %', v_txt;
  end if;

  -- the member read policy of brands, exactly 20260918120000's (by name, command, role, and a condition on the person's own memberships)
  if not exists (select 1 from pg_catalog.pg_policy p
                  where p.polrelid = v_brands and p.polname = 'social_mobile_member_select_brands' and p.polcmd = 'r' and p.polpermissive
                    and p.polroles = array[v_auth] and p.polwithcheck is null
                    and pg_catalog.pg_get_expr(p.polqual, p.polrelid) ~ 'public\.brand_memberships'
                    and pg_catalog.pg_get_expr(p.polqual, p.polrelid) ~ 'bm\.user_id = \( SELECT auth\.uid\(\)')
  then
    raise exception 'BRANDS_MEMBER_POLICY: social_mobile_member_select_brands on public.brands is missing or is not 20260918120000''s';
  end if;

  -- any other permissive policy reaching an API role widens what a person reads once row security is on (restrictive ones only narrow)
  select pg_catalog.string_agg(p.polname::text, ', ' order by p.polname) into v_txt from pg_catalog.pg_policy p
   where p.polrelid = v_brands and p.polpermissive and p.polname <> 'social_mobile_member_select_brands'
     and exists (select 1 from pg_catalog.unnest(p.polroles) u
                  where u = 0 or pg_catalog.pg_has_role(v_anon, u, 'MEMBER') or pg_catalog.pg_has_role(v_auth, u, 'MEMBER'));
  if v_txt is not null then
    raise exception 'BRANDS_UNREVIEWED_POLICY: %', v_txt;
  end if;

  -- a view runs as its owner (unless security_invoker), so row security on brands would not bind a person reading it
  select pg_catalog.string_agg(distinct v.oid::regclass::text, ', ') into v_txt
    from pg_catalog.pg_depend d
    join pg_catalog.pg_rewrite w on d.classid = 'pg_catalog.pg_rewrite'::regclass and d.objid = w.oid
    join pg_catalog.pg_class v on v.oid = w.ev_class
   where d.refclassid = 'pg_catalog.pg_class'::regclass and d.refobjid = v_brands and v.oid <> v_brands
     and (v.relkind = 'm' or (v.relkind = 'v' and not exists (select 1 from pg_catalog.unnest(v.reloptions) o
                                                               where pg_catalog.lower(o) in ('security_invoker=true', 'security_invoker=on', 'security_invoker=1', 'security_invoker=yes'))))
     and (pg_catalog.has_any_column_privilege(v_anon, v.oid, 'SELECT') or pg_catalog.has_any_column_privilege(v_auth, v.oid, 'SELECT'));
  if v_txt is not null then
    raise exception 'BRANDS_VIEW_BYPASS: %', v_txt;
  end if;

  -- writers: an invoker function a person may run that writes brands relies on the grants revoked below; a definer function naming brands
  -- must be owned by a role row security does not filter (superuser, BYPASSRLS, or able to act as the table owner)
  select pg_catalog.string_agg(f.oid::regprocedure::text, ', ' order by f.oid::regprocedure::text) into v_txt
    from pg_catalog.pg_proc f join pg_catalog.pg_namespace n on n.oid = f.pronamespace
   where n.nspname not in ('pg_catalog', 'information_schema') and f.prokind in ('f', 'p') and not f.prosecdef
     and (case when f.prosqlbody is not null then pg_catalog.pg_get_functiondef(f.oid) else f.prosrc end)
         ~* '(insert\s+into|update|delete\s+from|merge\s+into)\s+(only\s+)?("?public"?\s*\.\s*)?"?brands"?([^a-z0-9_]|$)'
     and (pg_catalog.has_function_privilege(v_anon, f.oid, 'EXECUTE') or pg_catalog.has_function_privilege(v_auth, f.oid, 'EXECUTE'));
  if v_txt is not null then
    raise exception 'BRANDS_INVOKER_WRITER: %', v_txt;
  end if;
  select pg_catalog.string_agg(f.oid::regprocedure::text, ', ' order by f.oid::regprocedure::text) into v_txt
    from pg_catalog.pg_proc f join pg_catalog.pg_namespace n on n.oid = f.pronamespace join pg_catalog.pg_roles o on o.oid = f.proowner
   where n.nspname not in ('pg_catalog', 'information_schema') and f.prokind in ('f', 'p') and f.prosecdef
     and (case when f.prosqlbody is not null then pg_catalog.pg_get_functiondef(f.oid) else f.prosrc end) ~* '(^|[^a-z0-9_])brands([^a-z0-9_]|$)'
     and not (o.rolsuper or o.rolbypassrls or pg_catalog.pg_has_role(o.oid, v_owner, 'USAGE'));
  if v_txt is not null then
    raise exception 'BRANDS_DEFINER_FILTERED: %', v_txt;
  end if;

  -- what G1's snapshot reads with the person's JWT (PF_APP_READ): kept, never granted here
  select pg_catalog.string_agg(c, ', ' order by c) into v_txt
    from pg_catalog.unnest(array['id', 'display_name', 'is_active', 'publish_mode', 'code_profile_key']) c
    left join pg_catalog.pg_attribute a on a.attrelid = v_brands and a.attname = c and a.attnum > 0 and not a.attisdropped
   where a.attnum is null or not pg_catalog.has_column_privilege(v_auth, v_brands, a.attnum, 'SELECT');
  if v_txt is not null then
    raise exception 'BRANDS_MEMBER_READ_MISSING: authenticated cannot read brands.%', v_txt;
  end if;

  -- the record the rollback restores (the first install's; a re-run keeps it)
  create table if not exists private.postona_brands_isolation_prestate (
    id smallint primary key default 1 check (id = 1),
    row_security boolean not null,
    table_acl jsonb not null,
    column_acl jsonb not null,
    recorded_at timestamptz not null default pg_catalog.now()
  );
  revoke all on table private.postona_brands_isolation_prestate from public, anon, authenticated, service_role;
  insert into private.postona_brands_isolation_prestate (id, row_security, table_acl, column_acl)
  select 1, c.relrowsecurity,
         coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('grantee', case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end,
                                                                                'privilege', a.privilege_type, 'grantable', a.is_grantable)
                                               order by a.grantee, a.privilege_type)
                     from pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
                    where a.grantee in (0, v_anon, v_auth)), '[]'::jsonb),
         coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('column', t.attname, 'grantee', case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end,
                                                                                'privilege', a.privilege_type, 'grantable', a.is_grantable)
                                               order by t.attnum, a.grantee, a.privilege_type)
                     from pg_catalog.pg_attribute t, pg_catalog.aclexplode(t.attacl) a
                    where t.attrelid = v_brands and t.attnum > 0 and not t.attisdropped and t.attacl is not null and a.grantee in (0, v_anon, v_auth)), '[]'::jsonb)
    from pg_catalog.pg_class c where c.oid = v_brands
  on conflict (id) do nothing;

  -- the change
  revoke all on table public.brands from public, anon;
  revoke insert, update, delete, truncate, references, trigger on table public.brands from authenticated;
  if 'MAINTAIN' = any (v_writes) then
    execute 'revoke maintain on table public.brands from authenticated';
  end if;
  alter table public.brands enable row level security;

  -- postconditions, through every role an API role can reach (membership, PUBLIC, column grants)
  if not (select c.relrowsecurity and not c.relforcerowsecurity from pg_catalog.pg_class c where c.oid = v_brands) then
    raise exception 'BRANDS_POSTCONDITION_ROW_SECURITY';
  end if;
  select pg_catalog.string_agg(distinct x.rolname || ':' || k, ', ' order by x.rolname || ':' || k) into v_txt
    from pg_catalog.pg_roles x, pg_catalog.unnest(array['INSERT', 'UPDATE', 'REFERENCES'] || v_writes) k
   where (pg_catalog.pg_has_role(v_anon, x.oid, 'MEMBER') or pg_catalog.pg_has_role(v_auth, x.oid, 'MEMBER'))
     and case when k in ('INSERT', 'UPDATE', 'REFERENCES') then pg_catalog.has_any_column_privilege(x.oid, v_brands, k)
              else pg_catalog.has_table_privilege(x.oid, v_brands, k) end;
  if v_txt is not null then
    raise exception 'BRANDS_POSTCONDITION_WRITE: %', v_txt;
  end if;
  select pg_catalog.string_agg(x.rolname::text, ', ' order by x.rolname) into v_txt
    from pg_catalog.pg_roles x
   where pg_catalog.pg_has_role(v_anon, x.oid, 'MEMBER') and pg_catalog.has_any_column_privilege(x.oid, v_brands, 'SELECT');
  if v_txt is not null then
    raise exception 'BRANDS_POSTCONDITION_ANON_READ: %', v_txt;
  end if;
  if not exists (select 1 from private.postona_brands_isolation_prestate where id = 1)
     or exists (select 1 from pg_catalog.pg_class c, pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
                 where c.oid = 'private.postona_brands_isolation_prestate'::regclass and a.grantee <> c.relowner) then
    raise exception 'BRANDS_POSTCONDITION_PRESTATE: the record is missing or readable by another role';
  end if;
end;
$install$;

commit;
