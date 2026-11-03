-- G3-02 #15 (TEST ONLY, fake data): 017's connection_generation in the world behavior.sql left behind (g4_verdict_run.sh, phase VG): G5's
-- real MV and G4's real connect / disconnect / precheck. SYNTHETIC (labelled): the service end, an unbound row, a missing or failing
-- G4 / G5 function (each inside a transaction that is rolled back). No provider is called.
\set ON_ERROR_STOP 1
set timezone = 'UTC';
delete from g48.results;
create function g48.cg_get(p int, p_name text) returns text language sql as $$
  select g48.as_role('postona_resv_api', p, format('select connection_generation from postona_x_resv.get_reservation(%L::uuid)', g48.id(p_name))) $$;
create function g48.cg_list(p int, p_name text) returns text language sql as $$
  select g48.as_role('postona_resv_api', p, format('select connection_generation from postona_x_resv.list_reservations(%L) where reservation_id = %L::uuid', g48.xacct(p), g48.id(p_name))) $$;
create function g48.cg_both(p int, p_name text) returns text language sql as $$ select g48.cg_list(p, p_name) || '|' || g48.cg_get(p, p_name) $$;
create function g48.cg_rev(p_name text) returns int language sql stable as $$ select revision from postona_x_resv.reservations where id = g48.id(p_name) $$;
create function g48.cg_write(p int, p_sql text, p_name text) returns text language sql as $$
  select g48.as_role('postona_resv_api', p, format(p_sql, g48.id(p_name), g48.cg_rev(p_name))) $$;
create function g48.cg_end(p int) returns void language sql as $$
  update public.service_entitlements set status = 'ended', ended_at = now() where user_id = g48.u(p) and service_key = 'x_autopost' $$;
create function g48.cg_restart(p int) returns text language plpgsql as $$
declare v jsonb;
begin
  perform g48.as_person(p);
  v := public.start_x_autopost_service();
  return public.reactivate_x_autopost_service((v ->> 'lifecycle_version')::bigint) ->> 'status';
end $$;

select g48.person(4831);
select g48.xconnect(4831, 'cg1', '48310');
select g48.person(4832);
select g48.xconnect(4832, 'cg2', '48320');
select g48.nobody();

-- CG1 a new row on a live connection: current, in list and get
select g48.xreserve(4831, 'cg_a', 500);
select g48.xreserve(4831, 'cg_b', 510);
select g48.xreserve(4831, 'cg_c', 520);
select g48.check_('CG1 new row', 'current|current', g48.cg_both(4831, 'cg_a'));
-- CG2 another person: nothing comes back
select g48.check_('CG2 get', 'ERR:POSTONA_RESV_NOT_FOUND', g48.cg_get(4832, 'cg_a'));
select g48.check_('CG2 list', '0', g48.as_role('postona_resv_api', 4832, format('select count(*)::text from postona_x_resv.list_reservations(%L)', g48.xacct(4831))));
-- CG3 the boundary: list / get stay the API role's; the helper is nobody's; write answers keep their type
select g48.check_('CG3 authenticated list', 'denied', case when g48.as_role('authenticated', 4831, format('select count(*)::text from postona_x_resv.list_reservations(%L)', g48.xacct(4831))) ~ 'permission denied' then 'denied' else 'reached' end);
select g48.check_('CG3 anon get', 'denied', case when g48.as_role('anon', 4831, format('select count(*)::text from postona_x_resv.get_reservation(%L::uuid)', g48.id('cg_a'))) ~ 'permission denied' then 'denied' else 'reached' end);
select g48.check_('CG3 API role, helper', 'denied', case when g48.as_role('postona_resv_api', 4831, format('select postona_x_resv.connection_generation_of(r) from postona_x_resv.reservations r where r.id = %L::uuid', g48.id('cg_a'))) ~ 'permission denied' then 'denied' else 'reached' end);
select g48.check_('CG3 worker, helper', 'denied', case when g48.as_role('postona_resv_worker', 4831, format('select postona_x_resv.connection_generation_of(r) from postona_x_resv.reservations r where r.id = %L::uuid', g48.id('cg_a'))) ~ 'permission denied' then 'denied' else 'reached' end);
select g48.check_('CG3 write answers', 'SETOF postona_x_resv.reservation_view', pg_get_function_result('postona_x_resv.cancel(uuid,integer)'::regprocedure));
select g48.check_('CG3 one field', 'connection_generation', (select string_agg(attname, ',') from pg_attribute where attrelid = 'postona_x_resv.reservation_read_view'::regclass and attnum > 0 and attname not in (select attname from pg_attribute where attrelid = 'postona_x_resv.reservation_view'::regclass)));
-- CG4 unbound (SYNTHETIC): unknown, and only that row
update postona_x_resv.reservations set bound_lifecycle_version = null where id = g48.id('cg_c');
select g48.check_('CG4 unbound', 'unknown|unknown', g48.cg_both(4831, 'cg_c'));
select g48.check_('CG4 the others', 'current|current', g48.cg_both(4831, 'cg_a'));
-- CG5 G4's precheck missing / G5's MV missing / G4 raising (SYNTHETIC, rolled back): unknown, and the read still answers
begin;
alter function public.postona_x_refresh_precheck_v1(text) rename to g3cg_hidden;
select g48.cg_both(4831, 'cg_a') as v \gset
rollback;
select g48.check_('CG5 G4 precheck missing', 'unknown|unknown', :'v');
begin;
alter function private.postona_personal_worker_verdict(uuid, text, text, bigint) rename to g3cg_hidden;
select g48.cg_both(4831, 'cg_a') as v \gset
rollback;
select g48.check_('CG5 G5 MV missing', 'unknown|unknown', :'v');
begin;
create or replace function public.postona_x_refresh_precheck_v1(p_social_account_id text) returns text language plpgsql stable security definer set search_path = '' as $f$ begin raise exception 'g3cg boom'; end $f$;
select g48.cg_both(4831, 'cg_a') as v \gset
rollback;
select g48.check_('CG5 G4 raises', 'unknown|unknown', :'v');
begin;
create or replace function private.postona_personal_worker_verdict(p_user_id uuid, p_brand_id text, p_service_key text, p_expected_lifecycle_version bigint) returns text language plpgsql stable security definer set search_path = '' set row_security = off as $f$ begin raise exception 'g3cg boom'; end $f$;
select g48.cg_both(4831, 'cg_a') as v \gset
rollback;
select g48.check_('CG5 G5 raises', 'unknown|unknown', :'v');
begin;
create or replace function private.postona_personal_worker_verdict(p_user_id uuid, p_brand_id text, p_service_key text, p_expected_lifecycle_version bigint) returns text language plpgsql stable security definer set search_path = '' set row_security = off as $f$ begin return null; end $f$;
select g48.cg_both(4831, 'cg_a') as v \gset
rollback;
select g48.check_('CG5 G5 answers NULL', 'unknown|unknown', :'v');
select g48.check_('CG5 restored', 'current|current', g48.cg_both(4831, 'cg_a'));
-- CG6 disconnected (G4's real SQL): unknown; a reconnect without a restart is the same generation: current
select g48.xdisconnect(4831);
select g48.check_('CG6 disconnected', 'unknown|unknown', g48.cg_both(4831, 'cg_a'));
select g48.xconnect(4831, 'cg3', '48310');
select g48.nobody();
select g48.check_('CG6 reconnected', 'current|current', g48.cg_both(4831, 'cg_a'));
-- CG7 service ended, not restarted (SYNTHETIC end): unknown, never earlier; read and cancel go on
select g48.cg_end(4831);
select g48.check_('CG7 ended', 'unknown|unknown', g48.cg_both(4831, 'cg_a'));
select g48.check_('CG7 cancel', 'cancelled', g48.cg_write(4831, 'select status from postona_x_resv.cancel(%L::uuid, %s)', 'cg_c'));
-- CG8 restarted, old connection: earlier; every write refused, nothing changed
select g48.check_('CG8 restart', 'active', g48.cg_restart(4831));
select g48.nobody();
select g48.check_('CG8 earlier', 'earlier|earlier', g48.cg_both(4831, 'cg_a'));
select g48.check_('CG8 create', 'ERR:POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED', g48.xreserve(4831, 'cg_x', 530));
select g48.check_('CG8 reschedule', 'ERR:POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED', g48.cg_write(4831, 'select status from postona_x_resv.reschedule(%L::uuid, %s, now() + interval ''540 hours'')', 'cg_a'));
select g48.check_('CG8 reconfirm', 'ERR:POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED', g48.cg_write(4831, 'select status from postona_x_resv.reconfirm(%L::uuid, %s, repeat(''a'', 64))', 'cg_a'));
select g48.xdue('cg_a');
select g48.check_('CG8 never claimed', 'no', case when g48.xclaim() like '%' || g48.id('cg_a') || '%' then 'yes' else 'no' end);
select g48.check_('CG8 closed, not sent', 'failed/SERVICE_GENERATION_CHANGED', g48.xrow('cg_a'));
select g48.check_('CG8 still earlier when read', 'earlier|earlier', g48.cg_both(4831, 'cg_a'));
-- CG9 reconnected: the old row stays earlier and unmovable, cancel still works; a new row is current and claimable
select g48.xconnect(4831, 'cg4', '48310');
select g48.nobody();
select g48.check_('CG9 old stays earlier', 'earlier|earlier', g48.cg_both(4831, 'cg_b'));
select g48.check_('CG9 old reschedule', 'ERR:POSTONA_RESV_NOT_PLANNED', g48.cg_write(4831, 'select status from postona_x_resv.reschedule(%L::uuid, %s, now() + interval ''540 hours'')', 'cg_b'));
select g48.xreserve(4831, 'cg_n', 550);
select g48.check_('CG9 new row', 'current|current', g48.cg_both(4831, 'cg_n'));
select g48.xdue('cg_n');
select g48.check_('CG9 new row claimed', 'yes', case when g48.xclaim() like '%' || g48.id('cg_n') || '%' then 'yes' else 'no' end);
select g48.check_('CG9 old cancel', 'cancelled', g48.cg_write(4831, 'select status from postona_x_resv.cancel(%L::uuid, %s)', 'cg_b'));
-- CG10 a restart between the claim and the send (SYNTHETIC end): the pre-send check refuses, nothing is sent, and the row reads earlier
select g48.check_('CG10 before', 'OK', g48.xcheck('cg_n'));
select g48.cg_end(4831);
select g48.check_('CG10 restart', 'active', g48.cg_restart(4831));
select g48.nobody();
select g48.check_('CG10 pre-send', 'NOT_PUBLISHABLE', g48.xcheck('cg_n'));
select g48.check_('CG10 earlier', 'earlier|earlier', g48.cg_both(4831, 'cg_n'));

select n, case_id, case when expected = actual then 'ok' else 'FAIL expected ' || coalesce(expected, '<null>') || ' got ' || coalesce(actual, '<null>') end from g48.results order by n;
do $$ begin
  if exists (select 1 from g48.results where expected is distinct from actual) then raise exception 'G3_CONNECTION_GENERATION_BEHAVIOR_FAIL'; end if;
  if (select count(*) from g48.results) < 28 then raise exception 'G3_CONNECTION_GENERATION_BEHAVIOR_INCOMPLETE %', (select count(*) from g48.results); end if;
end $$;
select 'G3_CONNECTION_GENERATION_BEHAVIOR_PASS';
