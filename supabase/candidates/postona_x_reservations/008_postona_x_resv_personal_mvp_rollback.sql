-- G3 SOURCE CANDIDATE (2026-10-28, Issue #318 G3-39; refusals 2026-10-29, G3-42): rollback of 008_postona_x_resv_personal_mvp.sql. NOT applied anywhere.
-- Restores 001's FULL-profile adapters (g5oe / W1) verbatim and its pair rule under its own name. The pair rule comes back NOT VALID, so a row
-- bound under the MVP (a generation, no owner epoch) can stay only if nothing ever UPDATEs it again: every UPDATE of such a row breaks the
-- restored rule, and claim_due's sweeps / closes update rows of every person in one statement -- one such row would stop the whole dispatch
-- (G3-42, reproduced on PG17). So the rollback runs only when every MVP-bound row is finished (published / failed / cancelled); a planned,
-- claimed, uncertain or expired one (expired: single post re-arms it) refuses. Finish them first with the existing paths (the person
-- cancels a planned row; the worker records a claimed row's outcome). No path finishes an uncertain or expired row today: while one exists
-- the rollback stays refused (how to resolve them is PENDING_POLICY). Rows are never deleted or rewritten here.
-- Refuses (nothing changed) when: 008 is not applied, or only part of it is there; the caller is a superuser or does not own the schema and
-- the table; an unfinished MVP-bound row exists (checked under the table's ACCESS EXCLUSIVE lock, so none can appear before the commit).
begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_state boolean := coalesce((select p.prosrc ~ 'G3_G5_PROFILE_MVP' from pg_catalog.pg_proc p
                               where p.oid = pg_catalog.to_regprocedure('postona_x_resv.g5_bound_state(postona_x_resv.reservations)')), false);
  v_r1 boolean := coalesce((select p.prosrc ~ 'G3_G5_PROFILE_MVP' from pg_catalog.pg_proc p
                            where p.oid = pg_catalog.to_regprocedure('postona_x_resv.g5_r1_bound(text)')), false);
  v_pair boolean := exists (select 1 from pg_catalog.pg_constraint c
                            where c.conrelid = pg_catalog.to_regclass('postona_x_resv.reservations') and c.conname = 'reservations_personal_mvp_bound');
begin
  if not (v_state or v_r1 or v_pair) then
    raise exception 'G3_MVP_ROLLBACK_NOT_APPLIED';
  end if;
  if not (v_state and v_r1 and v_pair) then
    raise exception 'G3_MVP_ROLLBACK_PARTIAL_STATE';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from v_owner
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) is distinct from v_owner then
    raise exception 'G3_MVP_ROLLBACK_OWNER';
  end if;
end $$;

lock table postona_x_resv.reservations in access exclusive mode;

do $$
declare v_live text;
begin
  -- rows the restored pair rule refuses to UPDATE, in a state some path still updates
  select pg_catalog.string_agg(s.status || '=' || s.n, ',' order by s.status) into v_live
  from (select r.status, pg_catalog.count(*) as n from postona_x_resv.reservations r
        where (r.bound_owner_epoch is null) <> (r.bound_lifecycle_version is null)
          and r.status not in ('published', 'failed', 'cancelled')
        group by r.status) s;
  if v_live is not null then
    raise exception 'G3_MVP_ROLLBACK_LIVE_MVP_ROWS: %', v_live;
  end if;
  -- owners and ACLs of what this file replaces / alters, compared after the restore
  perform pg_catalog.set_config('postona_resv_mvp_rollback.acl', (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      where p.oid in ('postona_x_resv.g5_r1_bound(text)'::pg_catalog.regprocedure, 'postona_x_resv.g5_bound_state(postona_x_resv.reservations)'::pg_catalog.regprocedure)
      union all
      select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) a), true);
end $$;

do $$
declare v_name text := (select pg_catalog.obj_description(c.oid, 'pg_constraint') from pg_catalog.pg_constraint c
                        where c.conrelid = 'postona_x_resv.reservations'::pg_catalog.regclass and c.conname = 'reservations_personal_mvp_bound');
begin
  if v_name is null or v_name !~ '^[a-z0-9_]{1,63}$' then
    raise exception 'G3_MVP_ROLLBACK_PAIR_NAME_UNKNOWN';
  end if;
  alter table postona_x_resv.reservations drop constraint reservations_personal_mvp_bound;
  execute pg_catalog.format('alter table postona_x_resv.reservations add constraint %I check ((bound_owner_epoch is null) = (bound_lifecycle_version is null)) not valid', v_name);
end $$;

create or replace function postona_x_resv.g5_r1_bound(p_brand_id text, out owner_epoch bigint, out lifecycle_version bigint)
language plpgsql volatile security definer set search_path = '' as $$
-- G3_G5_PROFILE_FULL (g5oe / W1)
declare v_verdict jsonb;
begin
  if pg_catalog.to_regprocedure('public.common_account_authorization_verdict(text,text,text)') is null then
    raise exception 'POSTONA_RESV_SERVICE_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  v_verdict := public.common_account_authorization_verdict('postona', 'x_publish', p_brand_id);
  if v_verdict ->> 'decision' is distinct from 'allow' then
    raise exception 'POSTONA_RESV_SERVICE_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  select t.owner_epoch, t.lifecycle_version into owner_epoch, lifecycle_version
    from postona_x_resv.parse_owner_epoch_token(v_verdict ->> 'owner_epoch') t;
  if owner_epoch is null or lifecycle_version is null then
    raise exception 'POSTONA_RESV_SERVICE_NOT_ACTIVE' using errcode = 'P0001';
  end if;
end $$;

create or replace function postona_x_resv.g5_bound_state(p_row postona_x_resv.reservations) returns text
language plpgsql stable security definer set search_path = '' as $$
-- G3_G5_PROFILE_FULL (g5oe / W1)
begin
  if p_row.bound_owner_epoch is null or p_row.bound_lifecycle_version is null then return 'OWNER_EPOCH_UNBOUND'; end if;
  if pg_catalog.to_regprocedure('private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)') is null then
    return 'SERVICE_STATE_UNKNOWN';
  end if;
  return coalesce(private.account_lifecycle_worker_brand_verdict(p_row.brand_id, 'x_autopost', p_row.bound_owner_epoch, p_row.bound_lifecycle_version),
                  'SERVICE_STATE_UNKNOWN');
end $$;

-- Postconditions: the FULL adapters and the pair rule are back, owners and ACLs unchanged, and no MVP-bound row is left that a path updates.
do $$
declare v_acl text;
begin
  select pg_catalog.string_agg(x, '|' order by x) into v_acl from (
    select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
    where p.oid in ('postona_x_resv.g5_r1_bound(text)'::pg_catalog.regprocedure, 'postona_x_resv.g5_bound_state(postona_x_resv.reservations)'::pg_catalog.regprocedure)
    union all
    select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
    where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) a;
  if v_acl is distinct from pg_catalog.current_setting('postona_resv_mvp_rollback.acl', true) then
    raise exception 'G3_MVP_ROLLBACK_POSTCONDITION: an owner or ACL changed';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p
             where p.oid in ('postona_x_resv.g5_r1_bound(text)'::pg_catalog.regprocedure, 'postona_x_resv.g5_bound_state(postona_x_resv.reservations)'::pg_catalog.regprocedure)
               and p.prosrc !~ 'G3_G5_PROFILE_FULL')
     or exists (select 1 from pg_catalog.pg_constraint c
                where c.conrelid = 'postona_x_resv.reservations'::pg_catalog.regclass and c.conname = 'reservations_personal_mvp_bound')
     or not exists (select 1 from pg_catalog.pg_constraint c
                    where c.conrelid = 'postona_x_resv.reservations'::pg_catalog.regclass
                      and pg_catalog.pg_get_constraintdef(c.oid) = 'CHECK (((bound_owner_epoch IS NULL) = (bound_lifecycle_version IS NULL))) NOT VALID') then
    raise exception 'G3_MVP_ROLLBACK_POSTCONDITION: not the FULL profile';
  end if;
  if exists (select 1 from postona_x_resv.reservations r
             where (r.bound_owner_epoch is null) <> (r.bound_lifecycle_version is null) and r.status not in ('published', 'failed', 'cancelled')) then
    raise exception 'G3_MVP_ROLLBACK_POSTCONDITION: an unfinished MVP-bound row';
  end if;
end $$;

commit;
