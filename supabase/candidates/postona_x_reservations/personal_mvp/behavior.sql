-- G3-39 M: behaviour WITH 008 on G5's personal MVP world (R1-MVP + MV, no W1). Fake data; the "send" is a recorded outcome (no SNS call).
\ir helpers.sql

create schema t39;
create table t39.ids (name text primary key, id uuid);
create function pg_temp.keep(p_name text, p_id uuid) returns uuid language sql as $$ insert into t39.ids values (p_name, p_id) returning id $$;
create function pg_temp.id(p_name text) returns uuid language sql stable as $$ select id from t39.ids where name = p_name $$;

-- M0: what 008 left: the MVP adapters, owner-only; the named bound rule; G5's gates untouched (owner-only)
select pg_temp.expect((select p.prosrc ~ 'G3_G5_PROFILE_MVP' from pg_proc p where p.oid = 'postona_x_resv.g5_r1_bound(text)'::regprocedure), 'M0 r1 adapter MVP');
select pg_temp.expect((select p.prosrc ~ 'G3_G5_PROFILE_MVP' from pg_proc p where p.oid = 'postona_x_resv.g5_bound_state(postona_x_resv.reservations)'::regprocedure), 'M0 state adapter MVP');
select pg_temp.expect(not has_function_privilege(r, f::regprocedure, 'EXECUTE'), 'M0 ACL ' || r || ' ' || f)
from unnest(array['anon', 'authenticated', 'service_role', 'postona_resv_api', 'postona_resv_worker']) r,
     unnest(array['postona_x_resv.g5_r1_bound(text)', 'postona_x_resv.g5_bound_state(postona_x_resv.reservations)',
                  'private.postona_personal_worker_verdict(uuid,text,text,bigint)', 'public.common_account_authorization_verdict(text,text,text)']) f;
select pg_temp.expect(exists (select 1 from pg_constraint where conname = 'reservations_personal_mvp_bound' and convalidated), 'M0 bound rule');
select pg_temp.expect(to_regprocedure('private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)') is null, 'M0 no W1');

-- M1: create -> claim -> pre-send OK -> published. The row carries the person's generation V and no owner epoch.
select pg_temp.keep('m1', pg_temp.reserve(pg_temp.uid(1), 'm1', 30));
select pg_temp.expect(pg_temp.bound_of(pg_temp.id('m1')) = 'null/' || pg_temp.lv(pg_temp.uid(1)), 'M1 bound null/V ' || pg_temp.bound_of(pg_temp.id('m1')));
select pg_temp.make_due(pg_temp.id('m1'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('m1') || '=%', 'M1 claimed');
select pg_temp.expect(pg_temp.check_send(pg_temp.id('m1')) = 'OK', 'M1 pre-send OK');
select pg_temp.expect(pg_temp.worker(format('select postona_x_resv.finish(%L, %L, ''published'', ''1039000000000000001'', null)', pg_temp.id('m1'), pg_temp.lease_of(pg_temp.id('m1')))) = 'published', 'M1 recorded');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m1')) = 'published/PUBLISHED' or pg_temp.row_of(pg_temp.id('m1')) like 'published/%', 'M1 row ' || pg_temp.row_of(pg_temp.id('m1')));

-- M2: made in generation V, the service ends and is started again (V2 > V): never claimed (failed with MV's reason, audited);
-- a reservation made in V2 is claimed and passes the pre-send check
select pg_temp.keep('m2', pg_temp.reserve(pg_temp.uid(1), 'm2', 31));
create table t39.lv (name text primary key, v bigint);
insert into t39.lv values ('v1', pg_temp.lv(pg_temp.uid(1)));
insert into t39.lv values ('v2', pg_temp.restart(pg_temp.uid(1)));
select pg_temp.make_due(pg_temp.id('m2'));
select pg_temp.expect(pg_temp.claim() = '', 'M2 old generation not claimed');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m2')) = 'failed/SERVICE_GENERATION_CHANGED', 'M2 row ' || pg_temp.row_of(pg_temp.id('m2')));
select pg_temp.expect((select a.detail ->> 'g5_bound_state' from postona_x_resv.audit a where a.reservation_id = pg_temp.id('m2') and a.action = 'claim_refused')
  = 'SERVICE_GENERATION_CHANGED', 'M2 audited');
select pg_temp.keep('m2n', pg_temp.reserve(pg_temp.uid(1), 'm2n', 32));
select pg_temp.expect(pg_temp.bound_of(pg_temp.id('m2n')) = 'null/' || (select v from t39.lv where name = 'v2'), 'M2 new row bound to V2');
select pg_temp.make_due(pg_temp.id('m2n'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('m2n') || '=%', 'M2 new generation claimed');
select pg_temp.expect(pg_temp.check_send(pg_temp.id('m2n')) = 'OK', 'M2 new generation pre-send OK');
select pg_temp.worker(format('select postona_x_resv.finish(%L, %L, ''failed_before_send'', null, ''TEST_STOP'')', pg_temp.id('m2n'), pg_temp.lease_of(pg_temp.id('m2n'))));

-- M3: claimed in V2, the generation moves before the send: the pre-send check refuses (no send) and the row fails
select pg_temp.keep('m3', pg_temp.reserve(pg_temp.uid(1), 'm3', 33));
select pg_temp.make_due(pg_temp.id('m3'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('m3') || '=%', 'M3 claimed');
insert into t39.lv values ('v3', pg_temp.restart(pg_temp.uid(1)));
select pg_temp.expect(pg_temp.check_send(pg_temp.id('m3')) = 'NOT_PUBLISHABLE', 'M3 pre-send refused ' || pg_temp.check_send(pg_temp.id('m3')));
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m3')) like 'failed/%', 'M3 row ' || pg_temp.row_of(pg_temp.id('m3')));

-- M4: a row without a generation (written before this rule) is never claimed
select pg_temp.keep('m4', pg_temp.reserve(pg_temp.uid(1), 'm4', 34));
update postona_x_resv.reservations set bound_lifecycle_version = null where id = pg_temp.id('m4');
select pg_temp.make_due(pg_temp.id('m4'));
select pg_temp.expect(pg_temp.claim() = '', 'M4 unbound not claimed');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m4')) = 'failed/PERSONAL_GENERATION_UNBOUND', 'M4 row ' || pg_temp.row_of(pg_temp.id('m4')));
-- ... nor a row carrying a FULL-profile owner epoch (no mixing)
select pg_temp.keep('m4b', pg_temp.reserve(pg_temp.uid(1), 'm4b', 35));
update postona_x_resv.reservations set bound_owner_epoch = 2 where id = pg_temp.id('m4b');
select pg_temp.make_due(pg_temp.id('m4b'));
select pg_temp.expect(pg_temp.claim() = '', 'M4b g5oe-bound not claimed');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m4b')) = 'failed/PERSONAL_GENERATION_UNBOUND', 'M4b row ' || pg_temp.row_of(pg_temp.id('m4b')));
-- an owner epoch without a generation is refused by the table
select pg_temp.expect(pg_temp.as_role(format('update postona_x_resv.reservations set bound_owner_epoch = 2, bound_lifecycle_version = null where id = %L returning 1', pg_temp.id('m4b')),
  current_user) like 'ERR:%reservations_personal_mvp_bound%', 'M4c bound rule');

-- M5: the workspace stops being the person's own: a second owner (B) -> not claimed (MV: WORKSPACE_OWNER_UNKNOWN); a second member -> OWN_WORKSPACE_CONFLICT
select pg_temp.keep('m5', pg_temp.reserve(pg_temp.uid(1), 'm5', 36));
select pg_temp.keep('m5b', pg_temp.reserve(pg_temp.uid(1), 'm5b', 37));
select pg_temp.make_due(pg_temp.id('m5'));
insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.ws(pg_temp.uid(1)), pg_temp.uid(2), 'owner');
select pg_temp.expect(pg_temp.claim() = '', 'M5 second owner: not claimed');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m5')) = 'failed/WORKSPACE_OWNER_UNKNOWN', 'M5 row ' || pg_temp.row_of(pg_temp.id('m5')));
update public.brand_memberships set role = 'member' where brand_id = pg_temp.ws(pg_temp.uid(1)) and user_id = pg_temp.uid(2);
select pg_temp.make_due(pg_temp.id('m5b'));
select pg_temp.expect(pg_temp.claim() = '', 'M5b second member: not claimed');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m5b')) = 'failed/OWN_WORKSPACE_CONFLICT', 'M5b row ' || pg_temp.row_of(pg_temp.id('m5b')));
delete from public.brand_memberships where brand_id = pg_temp.ws(pg_temp.uid(1)) and user_id = pg_temp.uid(2);

-- M6: RESIDUAL (G5's, stated): an owner change UNDONE before the run (A -> B -> A; only the owner / service_role write memberships) is invisible
select pg_temp.keep('m6', pg_temp.reserve(pg_temp.uid(1), 'm6', 38));
insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.ws(pg_temp.uid(1)), pg_temp.uid(2), 'owner');
delete from public.brand_memberships where brand_id = pg_temp.ws(pg_temp.uid(1)) and user_id = pg_temp.uid(2);
select pg_temp.make_due(pg_temp.id('m6'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('m6') || '=%', 'M6 RESIDUAL: A -> B -> A is claimed');
select pg_temp.worker(format('select postona_x_resv.finish(%L, %L, ''failed_before_send'', null, ''TEST_STOP'')', pg_temp.id('m6'), pg_temp.lease_of(pg_temp.id('m6'))));

-- M7: R1 answers other than 'g5pv:<V>' bind nothing (an R1 stand-in inside a rolled-back transaction; G5's R1 is not changed)
begin;
create or replace function public.common_account_authorization_verdict(p_app text, p_feature text, p_brand_id text) returns jsonb
language sql stable security definer set search_path = '' as $f$ select pg_catalog.current_setting('t39.r1')::jsonb $f$;
select set_config('t39.r1', v, true), pg_temp.expect(pg_temp.create_raw(pg_temp.uid(1), 'm7', 39) = 'ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE', 'M7 refused ' || v)
from unnest(array['{"decision":"allow","owner_epoch":"g5oe:3:1"}', '{"decision":"allow","owner_epoch":"g5pv:0"}', '{"decision":"allow","owner_epoch":"g5pv:99999999999999999999"}',
  '{"decision":"allow","owner_epoch":"g5pv:12 "}', '{"decision":"allow"}', '{"decision":"deny","owner_epoch":"g5pv:5"}', '{"decision":"unknown","owner_epoch":"g5pv:5"}']) v;
rollback;

-- M8: create refusals in the MVP world: service suspended, an ended session (S2-2), another person's account
update public.service_entitlements set status = 'suspended' where user_id = pg_temp.uid(1) and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.create_raw(pg_temp.uid(1), 'm8', 40) = 'ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE', 'M8 suspended refused');
update public.service_entitlements set status = 'active' where user_id = pg_temp.uid(1) and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.api(format('select count(*) from postona_x_resv.list_reservations(%L)', pg_temp.acct(pg_temp.uid(1))), pg_temp.uid(4))
  = 'ERR:POSTONA_RESV_ACCOUNT_NOT_FOUND', 'M8 another person''s account');

-- M9: single post: begin binds V, the pre-send check passes, the outcome is recorded; a generation move between begin and the send
-- refuses (no send); a new request in the new generation passes
create table t39.sp (name text primary key, rid uuid, lease uuid);
create function pg_temp.begin_sp(p_name text, p_text text) returns text language plpgsql as $$
declare v text;
begin
  v := pg_temp.api(format('select reservation_id || '','' || coalesce(lease_token::text, '''') || '','' || state from postona_x_resv.post_now_begin(%L, gen_random_uuid(), %L, %L)',
    pg_temp.acct(pg_temp.uid(1)), p_text, pg_temp.body_sha(p_text)), pg_temp.uid(1));
  if v !~ '^ERR' then insert into t39.sp values (p_name, split_part(v, ',', 1)::uuid, nullif(split_part(v, ',', 2), '')::uuid); end if;
  return v;
end $$;
create function pg_temp.preflight(p_name text) returns text language sql as $$
  select pg_temp.api(format('select verdict from postona_x_resv.post_now_preflight(%L, %L)', s.rid, s.lease), pg_temp.uid(1)) from t39.sp s where s.name = p_name $$;
select pg_temp.expect(pg_temp.api(format('select postona_x_resv.post_now_readiness(%L)', pg_temp.acct(pg_temp.uid(1))), pg_temp.uid(1)) = 'READY', 'M9 ready');
select pg_temp.expect(pg_temp.begin_sp('s1', 'G3-39 単発 1') like '%,claimed', 'M9 begin');
select pg_temp.expect(pg_temp.bound_of((select rid from t39.sp where name = 's1')) = 'null/' || pg_temp.lv(pg_temp.uid(1)), 'M9 bound null/V');
select pg_temp.expect(pg_temp.preflight('s1') = 'OK', 'M9 preflight OK');
select pg_temp.expect(pg_temp.api(format('select postona_x_resv.post_now_record(%L, %L, ''published'', ''1039000000000000009'', null, ''simulated'')', s.rid, s.lease), pg_temp.uid(1)) = 'published', 'M9 recorded')
from t39.sp s where s.name = 's1';
select pg_temp.expect(pg_temp.row_of((select rid from t39.sp where name = 's1')) like 'published/%', 'M9 row');
select pg_temp.expect(pg_temp.begin_sp('s2', 'G3-39 単発 2') like '%,claimed', 'M9 begin s2');
insert into t39.lv values ('v4', pg_temp.restart(pg_temp.uid(1)));
select pg_temp.expect(pg_temp.preflight('s2') = 'NOT_PUBLISHABLE', 'M9 generation moved: refused ' || pg_temp.preflight('s2'));
select pg_temp.expect(pg_temp.row_of((select rid from t39.sp where name = 's2')) like 'failed/%', 'M9 s2 row');
select pg_temp.expect(pg_temp.begin_sp('s3', 'G3-39 単発 3') like '%,claimed', 'M9 begin s3');
select pg_temp.expect(pg_temp.preflight('s3') = 'OK', 'M9 new generation preflight OK');

-- M10: D's service is being ended: D's due reservation is never claimed; D cannot create
select pg_temp.keep('m10', pg_temp.reserve(pg_temp.uid(4), 'm10', 41));
select pg_temp.make_due(pg_temp.id('m10'));
select pg_temp.expect(pg_temp.as_role(format('select public.begin_service_deletion(%L::uuid, ''x_autopost'')::text', pg_temp.uid(4)), 'service_role') !~ '^ERR', 'setup: D end begins');
select pg_temp.expect(pg_temp.claim() = '', 'M10 not claimed');
-- the owner's fence (T13, 004) skips the person before the row is read: it stays planned (never claimed); MV answers the end for it too
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m10')) = 'planned/-', 'M10 row ' || pg_temp.row_of(pg_temp.id('m10')));
select pg_temp.expect((select postona_x_resv.g5_bound_state(r) from postona_x_resv.reservations r where r.id = pg_temp.id('m10')) = 'SERVICE_DELETION_IN_PROGRESS', 'M10 MV');
select pg_temp.expect(pg_temp.create_raw(pg_temp.uid(4), 'm10b', 42) like 'ERR:POSTONA_RESV_%', 'M10 create refused');

select 'G3_PERSONAL_MVP_BEHAVIOR_PASS';
