-- G5 SOURCE CANDIDATE (2026-11-13, Issue #587 G5-02 task 9). NOT applied anywhere. The STOP of 001_push_devices.sql: no new registration
-- (EXECUTE on the three RPCs taken from authenticated) and every active device revoked 'stopped' with its token erased, so the delivery side
-- answers no target for anyone. Keeps the table and the functions (the install, run again, starts it again; devices register again).
-- Idempotent. Run as the lifecycle owner with ON_ERROR_STOP.

begin;
set local lock_timeout = '5s';
set local search_path = '';

do $pre$
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'PUSH_SUPERUSER: run it as the lifecycle owner, not a superuser';
  end if;
  if pg_catalog.to_regclass('private.postona_push_devices') is null
     or (select c.relowner from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('private.postona_push_devices'))
          <> (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'PUSH_NOT_INSTALLED: private.postona_push_devices is absent or not owned by %', current_user;
  end if;
end;
$pre$;

do $revoke$
declare v_fn text;
begin
  foreach v_fn in array array['public.postona_push_device_register(uuid,text,text,integer)', 'public.postona_push_device_unregister(uuid)', 'public.postona_push_device_list()'] loop
    if pg_catalog.to_regprocedure(v_fn) is not null then
      execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', pg_catalog.to_regprocedure(v_fn));
    end if;
  end loop;
end;
$revoke$;

update private.postona_push_devices d
   set status = 'revoked', revoked_reason = 'stopped', revoked_at = pg_catalog.clock_timestamp(), push_token = null, token_sha256 = null,
       registration_version = d.registration_version + 1, updated_at = pg_catalog.clock_timestamp()
 where d.status = 'active';

do $post$
begin
  if exists (select 1 from private.postona_push_devices d where d.status = 'active' or d.push_token is not null or d.token_sha256 is not null) then
    raise exception 'PUSH_STOP_POSTCONDITION_TOKENS';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like 'postona\_push\_%'
                and pg_catalog.array_to_string(p.proacl::text[], ',') is distinct from pg_catalog.format('%s=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user))) then
    raise exception 'PUSH_STOP_POSTCONDITION_EXECUTE';
  end if;
end;
$post$;

commit;
