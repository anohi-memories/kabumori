-- G3 SOURCE CANDIDATE ROLLBACK (2026-10-20, Issue #318 TASK 8/50; rewritten in TASK 16/50 for H3 C3 R1; post-lock checks + row claim in TASK 17/50; ACL-free claim + column ACLs in TASK 18/50). NOT in supabase/migrations/.
-- Same review / GO / window / read-back as the candidate.
--
-- Puts back EXACTLY what one run of 001 took away, and nothing else. Its only input is the prestate line that run printed:
--   psql -X -v ON_ERROR_STOP=1 -v bm_prestate='v2|<database>|<table oid>|<ACL before the run>|<sha256>' -f 001_brand_memberships_api_privilege_revoke_rollback.sql
-- (the text after "BM_PRIV_PRESTATE " in 001's output, as kept in the mutation window's read-back). It does NOT infer from the current ACL what
-- 001 removed (a table that was already hardened before 001 looks the same as one 001 hardened): without the line it refuses.
-- It takes the same lock and the same ACL-free claim as 001 (see 001's header: what the claim serialises and what it does not).
--
-- Refused (nothing changes) when:
--   BM_PRIV_ROLLBACK_PRESTATE_REQUIRED          no prestate line given
--   BM_PRIV_ROLLBACK_PRESTATE_CORRUPT           malformed, the sha256 does not match the four fields, or not a v2 line (a v1 line of the TASK 16/17
--                                               builds does not say that the column ACLs were empty)
--   BM_PRIV_ROLLBACK_PRESTATE_OTHER_OBJECT      the line is of another database or another table (checked AFTER the lock, on the locked table)
--   BM_PRIV_ROLLBACK_TABLE_REPLACED             the name points at another relation after the lock than before it (renamed / replaced while waiting)
--   BM_PRIV_ROLLBACK_CLAIM_NOT_TAKEN            the claim did not rewrite the rows (an engine that skips no-op rewrites)
--   BM_PRIV_ROLLBACK_CLAIM_NOT_NEUTRAL          the claim changed the reloptions / a statistics target
--   BM_PRIV_ROLLBACK_CLAIM_UNSUPPORTED          fillfactor, autovacuum_enabled, parallel_workers and toast_tuple_target are all set (no unset option to reset)
--   BM_PRIV_ROLLBACK_COLUMN_ACL_UNSUPPORTED     a column of the table (user or system) carries an ACL: 001 left none, so something changed since
--   BM_PRIV_ROLLBACK_NOT_TABLE_OWNER            not run by the table owner
--   BM_PRIV_ROLLBACK_REFUSED_OWNER_EPOCH_INSTALLED  G5's owner epoch (PR #303) or anything built on it is installed: roll G5 back first
--   BM_PRIV_ROLLBACK_PRESTATE_MISMATCH          the current ACL is not what 001 would have left from that prestate (something changed since,
--                                               or the line is not the one of the last applied run)
--   BM_PRIV_ROLLBACK_GRANT_OPTION_UNSUPPORTED   an item to put back carried a grant option (not restored: decide by hand)
--   BM_PRIV_ROLLBACK_GRANTEE_UNSUPPORTED        an item to put back is for anon or PUBLIC (the membership migration revokes all from anon)
--   BM_PRIV_ROLLBACK_POSTCONDITION_NOT_PRESTATE the ACL after the GRANTs is not exactly the prestate
-- What it can put back: the items 001's REVOKE removes, granted by the owner -- TRIGGER / TRUNCATE / REFERENCES for authenticated, TRIGGER for
-- service_role -- one GRANT per item, by the owner (so the grantor is the same). A prestate that was already hardened gives nothing to put back.
\if :{?bm_prestate}
select pg_catalog.set_config('bm_priv.rollback_prestate', :'bm_prestate', false) is not null as bm_priv_prestate_given \gset
\else
select pg_catalog.set_config('bm_priv.rollback_prestate', '', false) is not null as bm_priv_prestate_given \gset
\endif
begin;

set local lock_timeout = '5s';

-- before the lock: only what the LOCK itself needs (the table, its owner); the name's OID is kept to be compared after the lock
do $$
declare
  v_me oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  if to_regclass('public.brand_memberships') is null then
    raise exception 'BM_PRIV_ROLLBACK_TABLE_MISSING';
  end if;
  if (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.brand_memberships'::regclass) is distinct from v_me then
    raise exception 'BM_PRIV_ROLLBACK_NOT_TABLE_OWNER';
  end if;
  perform pg_catalog.set_config('bm_priv.oid_before_lock', 'public.brand_memberships'::regclass::oid::text, true);
end $$;

lock table public.brand_memberships in share row exclusive mode;

-- AFTER the lock, on the relation the lock was taken on (TASK 17/50, H3 C3 R2): identity, owner, G5, the prestate line -- nothing checked before
-- the lock is trusted here. A rename / replacement / owner change / G5 install while this waited for the lock is refused.
do $$
declare
  v_me oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_table regclass := to_regclass('public.brand_memberships');
  v_raw text := pg_catalog.current_setting('bm_priv.rollback_prestate', true);
  v_parts text[];
begin
  if v_table is null or v_table::oid::text is distinct from pg_catalog.current_setting('bm_priv.oid_before_lock', true) then
    raise exception 'BM_PRIV_ROLLBACK_TABLE_REPLACED';
  end if;
  if (select c.relowner from pg_catalog.pg_class c where c.oid = v_table) is distinct from v_me then
    raise exception 'BM_PRIV_ROLLBACK_NOT_TABLE_OWNER';
  end if;
  if to_regprocedure('private.account_lifecycle_owner_epoch_exposure()') is not null
     or to_regprocedure('private.account_lifecycle_brand_owner_epoch(text)') is not null
     or exists (select 1 from pg_catalog.pg_trigger t
                 where t.tgrelid = v_table and t.tgname in ('account_lifecycle_owner_epoch_row', 'account_lifecycle_owner_epoch_truncate')) then
    raise exception 'BM_PRIV_ROLLBACK_REFUSED_OWNER_EPOCH_INSTALLED';
  end if;
  if v_raw is null or v_raw = '' then
    raise exception 'BM_PRIV_ROLLBACK_PRESTATE_REQUIRED';
  end if;
  v_parts := pg_catalog.string_to_array(v_raw, '|');
  if pg_catalog.cardinality(v_parts) <> 5 or v_parts[1] <> 'v2' or v_parts[5] !~ '^[0-9a-f]{64}$'
     or v_parts[5] <> pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.array_to_string(v_parts[1:4], '|'), 'UTF8')), 'hex') then
    raise exception 'BM_PRIV_ROLLBACK_PRESTATE_CORRUPT';
  end if;
  if v_parts[2] is distinct from pg_catalog.current_database() or v_parts[3] is distinct from v_table::oid::text then
    raise exception 'BM_PRIV_ROLLBACK_PRESTATE_OTHER_OBJECT';
  end if;
end $$;

-- the claim of the table's pg_class row and of every user column's pg_attribute row (TASK 18/50; the same statement as 001): rewritten with
-- their current values, no ACL is computed; from here to COMMIT no other table- or column-level GRANT / REVOKE of this table can commit, so the
-- ACL read below is the one the GRANTs apply to (a change that committed before the claim is in that ACL and is refused as MISMATCH)
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
    raise exception 'BM_PRIV_ROLLBACK_CLAIM_UNSUPPORTED';
  end if;
  execute pg_catalog.format('alter table public.brand_memberships %s', pg_catalog.concat_ws(', ', pg_catalog.format('reset (%I)', v_reset), v_cols));
  if (select c.xmin from pg_catalog.pg_class c where c.oid = v_table) is distinct from v_xid
     or exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = v_table and a.attnum > 0 and not a.attisdropped and a.xmin is distinct from v_xid) then
    raise exception 'BM_PRIV_ROLLBACK_CLAIM_NOT_TAKEN';
  end if;
  if (select c.reloptions from pg_catalog.pg_class c where c.oid = v_table) is distinct from v_opts
     or (select pg_catalog.string_agg(a.attnum || ':' || coalesce(a.attstattarget::text, '-1'), ',' order by a.attnum)
           from pg_catalog.pg_attribute a where a.attrelid = v_table and a.attnum > 0 and not a.attisdropped) is distinct from v_stats then
    raise exception 'BM_PRIV_ROLLBACK_CLAIM_NOT_NEUTRAL';
  end if;
end $$;
-- (claimed: the table's and its user columns' ACLs cannot change under this transaction)

do $$
declare
  v_table constant regclass := 'public.brand_memberships'::regclass;
  v_owner oid := (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.brand_memberships'::regclass);
  v_acl text := (pg_catalog.string_to_array(pg_catalog.current_setting('bm_priv.rollback_prestate'), '|'))[4];
  v_anon oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = 'anon');
  v_auth oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = 'authenticated');
  v_svc oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = 'service_role');
  v_pre aclitem[];
  v_cur aclitem[];
  v_item record;
begin
  -- 001 leaves no column ACL (v2 line); one now means something changed since, and column ACLs are not restored by this file
  if exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = v_table and a.attacl is not null) then
    raise exception 'BM_PRIV_ROLLBACK_COLUMN_ACL_UNSUPPORTED';
  end if;
  begin
    v_pre := case when v_acl = '' then pg_catalog.acldefault('r', v_owner) else ('{' || v_acl || '}')::aclitem[] end;
  exception when others then
    raise exception 'BM_PRIV_ROLLBACK_PRESTATE_CORRUPT';
  end;
  v_cur := coalesce((select c.relacl from pg_catalog.pg_class c where c.oid = v_table), pg_catalog.acldefault('r', v_owner));

  create temporary table bm_rb_pre on commit drop as select a.grantor, a.grantee, a.privilege_type, a.is_grantable from pg_catalog.aclexplode(v_pre) a;
  create temporary table bm_rb_cur on commit drop as select a.grantor, a.grantee, a.privilege_type, a.is_grantable from pg_catalog.aclexplode(v_cur) a;
  -- what 001's two REVOKEs remove from a prestate: the owner's grants of those privileges to those grantees (with their grant options)
  create temporary table bm_rb_removed on commit drop as
    select p.* from bm_rb_pre p
     where p.grantor = v_owner
       and ((p.grantee in (0, v_anon, v_auth) and p.privilege_type in ('TRIGGER', 'TRUNCATE', 'REFERENCES'))
         or (p.grantee = v_svc and p.privilege_type = 'TRIGGER'));
  -- the current ACL must be exactly what 001 would have left from this prestate
  if exists ((select * from bm_rb_pre except select * from bm_rb_removed) except select * from bm_rb_cur)
     or exists (select * from bm_rb_cur except (select * from bm_rb_pre except select * from bm_rb_removed)) then
    raise exception 'BM_PRIV_ROLLBACK_PRESTATE_MISMATCH';
  end if;
  if exists (select 1 from bm_rb_removed where is_grantable) then
    raise exception 'BM_PRIV_ROLLBACK_GRANT_OPTION_UNSUPPORTED';
  end if;
  if exists (select 1 from bm_rb_removed where grantee in (0, v_anon)) then
    raise exception 'BM_PRIV_ROLLBACK_GRANTEE_UNSUPPORTED';
  end if;
  for v_item in select r.privilege_type, (select ro.rolname from pg_catalog.pg_roles ro where ro.oid = r.grantee) as rolname
                  from bm_rb_removed r order by 2, 1 loop
    execute pg_catalog.format('grant %s on table public.brand_memberships to %I', v_item.privilege_type, v_item.rolname);
  end loop;
  -- exactly the prestate, nothing more
  if exists (select a.grantor, a.grantee, a.privilege_type, a.is_grantable
               from pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a where c.oid = v_table
             except select * from bm_rb_pre)
     or exists (select * from bm_rb_pre except select a.grantor, a.grantee, a.privilege_type, a.is_grantable
                  from pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a where c.oid = v_table)
     or exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = v_table and a.attacl is not null) then
    raise exception 'BM_PRIV_ROLLBACK_POSTCONDITION_NOT_PRESTATE';
  end if;
end $$;

commit;
