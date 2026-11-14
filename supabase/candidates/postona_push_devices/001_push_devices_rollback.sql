-- G5 SOURCE CANDIDATE (2026-11-13, Issue #587 G5-02 task 9). NOT applied anywhere. The ROLLBACK of 001_push_devices.sql: drops the three
-- RPCs, the owner-only functions, private.postona_push_devices, the stop fence private.postona_push_control and the token claims
-- private.postona_push_token_claims. Refuses (nothing changed) while a device is active (run
-- 001_push_devices_stop.sql first: it erases every token) or while a function that is not ours names one of ours (e.g. a G3 delivery
-- function calling the targets: roll that back first). Idempotent. Run as the lifecycle owner with ON_ERROR_STOP.

begin;
set local lock_timeout = '5s';
set local search_path = '';

do $pre$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_txt text;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) then
    raise exception 'PUSH_SUPERUSER: run it as the lifecycle owner, not a superuser';
  end if;
  if pg_catalog.to_regclass('private.postona_push_devices') is not null then
    if (select c.relowner from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('private.postona_push_devices')) <> v_owner then
      raise exception 'PUSH_TAKEN: private.postona_push_devices is not owned by % (left alone)', current_user;
    end if;
    -- the table locks first: no registration lands between this check and the drop
    if pg_catalog.to_regclass('private.postona_push_control') is not null then
      lock table private.postona_push_control in access exclusive mode;
    end if;
    lock table private.postona_push_devices in access exclusive mode;
    if exists (select 1 from private.postona_push_devices d where d.status = 'active') then
      raise exception 'PUSH_ACTIVE_DEVICES: run 001_push_devices_stop.sql first (it erases every token)';
    end if;
  end if;
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::text, ', ') into v_txt from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.proname like 'postona\_push\_%' and p.proowner <> v_owner;
  if v_txt is not null then
    raise exception 'PUSH_TAKEN: % (left alone)', v_txt;
  end if;
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::text, ', ') into v_txt from pg_catalog.pg_proc p
   where p.proname not like 'postona\_push\_%'
     and (pg_catalog.strpos(pg_catalog.lower(p.prosrc), 'postona_push_delivery_targets') > 0 or pg_catalog.strpos(pg_catalog.lower(p.prosrc), 'postona_push_device_invalidate') > 0
          or pg_catalog.strpos(pg_catalog.lower(p.prosrc), 'postona_push_devices') > 0);
  if v_txt is not null then
    raise exception 'PUSH_IN_USE: % names the push devices (roll it back first)', v_txt;
  end if;
end;
$pre$;

drop function if exists public.postona_push_device_register(uuid, text, text, text, integer);
drop function if exists public.postona_push_device_unregister(uuid, text);
drop function if exists public.postona_push_device_list();
drop function if exists private.postona_push_delivery_targets(uuid, text);
drop function if exists private.postona_push_device_invalidate(uuid, integer);
drop function if exists private.postona_push_devices_purge();
drop function if exists private.postona_push_writer_gate();
drop function if exists private.postona_push_claims_session();
drop function if exists private.postona_push_session_live(uuid, uuid);
drop function if exists private.postona_push_lock_key(text, text);
do $drop$
begin
  if pg_catalog.to_regclass('private.postona_push_devices') is not null then
    execute 'drop function if exists private.postona_push_device_json(private.postona_push_devices, uuid, boolean)';
  end if;
end;
$drop$;
drop table if exists private.postona_push_devices;
drop table if exists private.postona_push_control;
drop table if exists private.postona_push_token_claims;

do $post$
begin
  if pg_catalog.to_regclass('private.postona_push_devices') is not null or pg_catalog.to_regclass('private.postona_push_control') is not null
     or pg_catalog.to_regclass('private.postona_push_token_claims') is not null
     or exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                 where n.nspname in ('public', 'private') and p.proname like 'postona\_push\_%') then
    raise exception 'PUSH_ROLLBACK_POSTCONDITION';
  end if;
end;
$post$;

commit;
