-- G3 SOURCE CANDIDATE (2026-10-29, Issue #318 G3-41): rollback of 001_postona_x_reservations.sql. NOT in supabase/migrations/, NOT applied
-- anywhere, not reviewed. Never run it against a managed project without the reviewed rollout and the user's approval.
--
-- Order: the LAST step of the reverse install. Roll back Threads 009 / 007, X 008, 006, 005, 004, 003 and 002 first; this file refuses while
-- any of them is still there. Stop the reservation API and the delivery worker first.
--
-- What it removes: the schema postona_x_resv with exactly 001's objects (3 tables, their indexes / sequence / row types, the view type and
-- 001's 22 functions), dropped one by one WITHOUT CASCADE -- an unexpected dependent makes the whole transaction refuse (nothing changed).
-- Rows: it never drops a reservation that is planned, claimed (a worker may be sending it) or uncertain (it may have been sent). Finished rows
-- (published / failed / cancelled / expired), their batches and the audit are dropped only when the operator states the exact counts first
-- (export them before, if they must be kept), in the same session:
--   set postona_resv_rollback.discard_rows = '<reservations>:<batches>:<audit>';
-- Consumers: a function OUTSIDE the schema whose body names postona_x_resv (for example the F3 publish_enabled T13 guard, which calls
-- postona_x_resv.g4_x_account_verified, or the entitlement guard / X saga stop, which look the tables up) is not tracked by PostgreSQL. This
-- file refuses while there is one, unless the operator lists exactly those functions (schema-qualified regprocedure text, sorted, comma-separated):
--   set postona_resv_rollback.ack_consumers = '<schema.fn(args)>,<...>';
-- An acknowledged consumer is NOT changed: one that calls a dropped function fails from then on (fail closed, never an allow).
-- Refuses (nothing changed) when: 001 is not applied; the caller is a superuser or not the schema owner; a later layer is present; the schema
-- holds anything 001 did not create, or anything owned by another role; any role other than the owner holds a privilege in it; live rows;
-- the finished-row counts or the consumer list are not stated exactly; anything outside the schema depends on it.
begin;
set local lock_timeout = '3s';
set local search_path = '';  -- regprocedure text below is always schema-qualified

do $$
declare v_later text[] := array[]::text[]; v_bad text; v_owner oid; v_counts text; v_consumers text;
begin
  if pg_catalog.to_regnamespace('postona_x_resv') is null then
    raise exception 'POSTONA_RESV_ROLLBACK_NOT_APPLIED';
  end if;
  select n.nspowner into v_owner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv';
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false
     or v_owner is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'POSTONA_RESV_ROLLBACK_OWNER';
  end if;

  -- later layers (each one's own marker)
  if pg_catalog.to_regrole('postona_resv_api') is not null or pg_catalog.to_regprocedure('postona_x_resv.get_reservation(uuid)') is not null then
    v_later := v_later || '002'::text;
  end if;
  if pg_catalog.to_regprocedure('postona_x_resv.g5_x_autopost_allowed(uuid)') is not null
     and (select p.prosrc ~ 'G5_BINDING' from pg_catalog.pg_proc p where p.oid = 'postona_x_resv.g5_x_autopost_allowed(uuid)'::regprocedure) then
    v_later := v_later || '003'::text;
  end if;
  if pg_catalog.to_regrole('postona_resv_worker') is not null or pg_catalog.to_regprocedure('postona_x_resv.release_unsent(uuid,uuid)') is not null then
    v_later := v_later || '004'::text;
  end if;
  if pg_catalog.to_regprocedure('postona_x_resv.post_now_begin(text,uuid,text,text)') is not null then
    v_later := v_later || '005'::text;
  end if;
  if pg_catalog.to_regprocedure('postona_x_resv.post_now_preflight(uuid,uuid)') is not null or pg_catalog.to_regclass('postona_x_resv.single_post_bindings') is not null then
    v_later := v_later || '006'::text;
  end if;
  if exists (select 1 from pg_catalog.pg_constraint c where c.connamespace = 'postona_x_resv'::regnamespace and c.conname = 'reservations_personal_mvp_bound') then
    v_later := v_later || '008'::text;
  end if;
  if pg_catalog.to_regnamespace('postona_threads_resv') is not null then
    v_later := v_later || 'threads_007'::text;
  end if;
  if pg_catalog.cardinality(v_later) > 0 then
    raise exception 'POSTONA_RESV_ROLLBACK_LATER_LAYER_PRESENT: %', pg_catalog.array_to_string(v_later, ',');
  end if;

  -- exactly 001's objects, all owned by the schema owner
  select pg_catalog.string_agg(x, ',' order by x) into v_bad from (
    select p.oid::regprocedure::text as x from pg_catalog.pg_proc p
    where p.pronamespace = 'postona_x_resv'::regnamespace
      and (p.proowner <> v_owner or p.oid::regprocedure::text not in (
        'postona_x_resv.assert_account_access(uuid,text)', 'postona_x_resv.assert_interval(jsonb,jsonb)',
        'postona_x_resv.assert_slots_free(text,timestamp with time zone[],uuid[])', 'postona_x_resv.caller()', 'postona_x_resv.cancel(uuid,integer)',
        'postona_x_resv.claim_due(text,integer,integer)', 'postona_x_resv.create_batch(text,uuid,integer,text,jsonb,jsonb)',
        'postona_x_resv.finish(uuid,uuid,text,text,text)', 'postona_x_resv.g4_x_account_verified(uuid,text)',
        'postona_x_resv.g5_bound_state(postona_x_resv.reservations)', 'postona_x_resv.g5_r1_bound(text)', 'postona_x_resv.g5_x_autopost_allowed(uuid)',
        'postona_x_resv.in_band(timestamp with time zone,jsonb)', 'postona_x_resv.list_reservations(text)', 'postona_x_resv.lock_own(uuid,integer)',
        'postona_x_resv.parse_owner_epoch_token(text)', 'postona_x_resv.pre_publish_check(uuid,uuid)', 'postona_x_resv.reconfirm(uuid,integer,text)',
        'postona_x_resv.reschedule(uuid,integer,timestamp with time zone)', 'postona_x_resv.row_publishable(postona_x_resv.reservations)',
        'postona_x_resv.sha256_hex(text)', 'postona_x_resv.x_weighted_length(text)'))
    union all
    select c.relname || '/' || c.relkind::text from pg_catalog.pg_class c
    where c.relnamespace = 'postona_x_resv'::regnamespace
      and (c.relowner <> v_owner or (c.relname, c.relkind::text) not in (
        ('audit', 'r'), ('audit_id_seq', 'S'), ('audit_pkey', 'i'), ('batches', 'r'), ('batches_pkey', 'i'),
        ('batches_user_id_social_account_id_client_batch_id_revision_key', 'i'), ('reservation_view', 'c'), ('reservations', 'r'),
        ('reservations_account', 'i'), ('reservations_batch_id_draft_id_key', 'i'), ('reservations_batch_id_position_key', 'i'),
        ('reservations_due', 'i'), ('reservations_pkey', 'i')))
    union all
    select 'type ' || t.typname from pg_catalog.pg_type t
    where t.typnamespace = 'postona_x_resv'::regnamespace
      and (t.typowner <> v_owner or t.typname not in ('audit', 'batches', 'reservations', 'reservation_view', '_audit', '_batches', '_reservations', '_reservation_view'))
    union all
    select 'other ' || x.k from (
      select 'operator' as k from pg_catalog.pg_operator o where o.oprnamespace = 'postona_x_resv'::regnamespace
      union all select 'collation' from pg_catalog.pg_collation co where co.collnamespace = 'postona_x_resv'::regnamespace
      union all select 'conversion' from pg_catalog.pg_conversion cv where cv.connamespace = 'postona_x_resv'::regnamespace
      union all select 'statistics' from pg_catalog.pg_statistic_ext se where se.stxnamespace = 'postona_x_resv'::regnamespace
      union all select 'opfamily' from pg_catalog.pg_opfamily f where f.opfnamespace = 'postona_x_resv'::regnamespace
      union all select 'ts_config' from pg_catalog.pg_ts_config tc where tc.cfgnamespace = 'postona_x_resv'::regnamespace
      union all select 'trigger ' || tg.tgname from pg_catalog.pg_trigger tg join pg_catalog.pg_class c on c.oid = tg.tgrelid
        where c.relnamespace = 'postona_x_resv'::regnamespace and not tg.tgisinternal
      union all select 'policy ' || po.polname from pg_catalog.pg_policy po join pg_catalog.pg_class c on c.oid = po.polrelid
        where c.relnamespace = 'postona_x_resv'::regnamespace
      union all select 'rule ' || ru.rulename from pg_catalog.pg_rewrite ru join pg_catalog.pg_class c on c.oid = ru.ev_class
        where c.relnamespace = 'postona_x_resv'::regnamespace) x
  ) s;
  if v_bad is not null then
    raise exception 'POSTONA_RESV_ROLLBACK_FOREIGN_OBJECTS: %', v_bad;
  end if;

  -- no role but the owner holds a privilege on the schema or anything in it (PUBLIC included)
  select pg_catalog.string_agg(distinct a.grantee::text, ',') into v_bad from (
    select (pg_catalog.aclexplode(n.nspacl)).grantee from pg_catalog.pg_namespace n where n.oid = 'postona_x_resv'::regnamespace
    union all select (pg_catalog.aclexplode(c.relacl)).grantee from pg_catalog.pg_class c where c.relnamespace = 'postona_x_resv'::regnamespace
    union all select (pg_catalog.aclexplode(p.proacl)).grantee from pg_catalog.pg_proc p where p.pronamespace = 'postona_x_resv'::regnamespace
    union all select (pg_catalog.aclexplode(t.typacl)).grantee from pg_catalog.pg_type t where t.typnamespace = 'postona_x_resv'::regnamespace
    union all select (pg_catalog.aclexplode(at.attacl)).grantee from pg_catalog.pg_attribute at join pg_catalog.pg_class c on c.oid = at.attrelid
      where c.relnamespace = 'postona_x_resv'::regnamespace and at.attacl is not null
  ) a where a.grantee <> v_owner;
  if v_bad is not null then
    raise exception 'POSTONA_RESV_ROLLBACK_FOREIGN_GRANTS: %', v_bad;
  end if;

  -- consumers outside the schema that name it in their body: refuse unless the operator listed exactly them
  select pg_catalog.string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text) into v_bad
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where p.pronamespace <> 'postona_x_resv'::regnamespace and n.nspname !~ '^(pg_catalog|information_schema|pg_toast|pg_temp_|pg_toast_temp_)'
    and p.prosrc ~* 'postona_x_resv';
  v_consumers := pg_catalog.current_setting('postona_resv_rollback.ack_consumers', true);
  if v_bad is not null and v_consumers is distinct from v_bad then
    raise exception 'POSTONA_RESV_ROLLBACK_CONSUMERS_PRESENT: %', v_bad;
  end if;
  if v_bad is null and coalesce(v_consumers, '') <> '' then
    raise exception 'POSTONA_RESV_ROLLBACK_CONSUMERS_ACK_MISMATCH';
  end if;

  -- rows: nothing live; finished rows only at the stated counts (the tables are locked first, so the counts cannot move)
  lock table postona_x_resv.batches, postona_x_resv.reservations, postona_x_resv.audit in access exclusive mode;
  if exists (select 1 from postona_x_resv.reservations r where r.status not in ('published', 'failed', 'cancelled', 'expired')) then
    raise exception 'POSTONA_RESV_ROLLBACK_LIVE_ROWS';
  end if;
  v_counts := (select pg_catalog.count(*) from postona_x_resv.reservations)::text || ':' || (select pg_catalog.count(*) from postona_x_resv.batches)::text
              || ':' || (select pg_catalog.count(*) from postona_x_resv.audit)::text;
  if v_counts <> '0:0:0' and pg_catalog.current_setting('postona_resv_rollback.discard_rows', true) is distinct from v_counts then
    raise exception 'POSTONA_RESV_ROLLBACK_ROWS_NOT_ACKNOWLEDGED: %', v_counts;
  end if;
end $$;

-- one by one, no CASCADE: anything outside the schema that depends on it makes this refuse (nothing changed)
do $$
begin
  drop function postona_x_resv.assert_account_access(uuid, text), postona_x_resv.assert_interval(jsonb, jsonb),
    postona_x_resv.assert_slots_free(text, timestamptz[], uuid[]), postona_x_resv.caller(), postona_x_resv.cancel(uuid, integer),
    postona_x_resv.claim_due(text, integer, integer), postona_x_resv.create_batch(text, uuid, integer, text, jsonb, jsonb),
    postona_x_resv.finish(uuid, uuid, text, text, text), postona_x_resv.g4_x_account_verified(uuid, text),
    postona_x_resv.g5_bound_state(postona_x_resv.reservations), postona_x_resv.g5_r1_bound(text), postona_x_resv.g5_x_autopost_allowed(uuid),
    postona_x_resv.in_band(timestamptz, jsonb), postona_x_resv.list_reservations(text), postona_x_resv.lock_own(uuid, integer),
    postona_x_resv.parse_owner_epoch_token(text), postona_x_resv.pre_publish_check(uuid, uuid), postona_x_resv.reconfirm(uuid, integer, text),
    postona_x_resv.reschedule(uuid, integer, timestamptz), postona_x_resv.row_publishable(postona_x_resv.reservations),
    postona_x_resv.sha256_hex(text), postona_x_resv.x_weighted_length(text);
  drop type postona_x_resv.reservation_view;
  drop table postona_x_resv.audit;
  drop table postona_x_resv.reservations;
  drop table postona_x_resv.batches;
  drop schema postona_x_resv;
exception when dependent_objects_still_exist then
  raise exception 'POSTONA_RESV_ROLLBACK_FOREIGN_DEPENDENTS: %', sqlerrm;
end $$;

do $$
begin
  if pg_catalog.to_regnamespace('postona_x_resv') is not null then
    raise exception 'POSTONA_RESV_ROLLBACK_POSTCONDITION: schema still present';
  end if;
end $$;

commit;
