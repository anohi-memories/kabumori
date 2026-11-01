-- G3-40 M: Threads reservations WITH 009 on G5's personal MVP world (R1-MVP + MV, no W1). Fake data; the "send" is a recorded outcome
-- (transport 'simulated', no SNS call).
\ir helpers.sql

create schema t40;
create table t40.ids (name text primary key, id uuid);
create function pg_temp.keep(p_name text, p_id uuid) returns uuid language sql as $$ insert into t40.ids values (p_name, p_id) returning id $$;
create function pg_temp.id(p_name text) returns uuid language sql stable as $$ select id from t40.ids where name = p_name $$;
create function pg_temp.receipt(p_name text) returns text language sql as $$
  select pg_temp.api(format('select state || ''/'' || coalesce(provider_post_id, ''-'') || ''/'' || after_freeze::text from postona_threads_resv.receipt(%L, %L)',
    r.social_account_id, r.client_request_id), r.user_id) from postona_threads_resv.reservations r where r.id = pg_temp.id(p_name) $$;

-- M0: what 009 left: the MVP adapters, owner-only; the named bound rule; G5's gates untouched (owner-only); no W1
select pg_temp.expect((select p.prosrc ~ 'G3_G5_PROFILE_MVP' from pg_proc p where p.oid = 'postona_threads_resv.g5_r1_bound(text)'::regprocedure), 'M0 r1 adapter MVP');
select pg_temp.expect((select p.prosrc ~ 'G3_G5_PROFILE_MVP' from pg_proc p
  where p.oid = 'postona_threads_resv.g5_bound_state(postona_threads_resv.reservations)'::regprocedure), 'M0 state adapter MVP');
select pg_temp.expect(not has_function_privilege(r, f::regprocedure, 'EXECUTE'), 'M0 ACL ' || r || ' ' || f)
from unnest(array['anon', 'authenticated', 'service_role', 'postona_resv_api', 'postona_resv_worker']) r,
     unnest(array['postona_threads_resv.g5_r1_bound(text)', 'postona_threads_resv.g5_bound_state(postona_threads_resv.reservations)',
                  'private.postona_personal_worker_verdict(uuid,text,text,bigint)', 'public.common_account_authorization_verdict(text,text,text)']) f;
select pg_temp.expect(exists (select 1 from pg_constraint where conname = 'reservations_personal_mvp_bound' and convalidated
  and conrelid = 'postona_threads_resv.reservations'::regclass), 'M0 bound rule');
select pg_temp.expect(to_regprocedure('private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)') is null, 'M0 no W1');

-- M1: create -> claim -> pre-send OK -> published; the row carries the person's generation V and no owner epoch; no second send
select pg_temp.keep('m1', pg_temp.reserve(pg_temp.uid(1), 'm1', 30));
select pg_temp.expect(pg_temp.bound_of(pg_temp.id('m1')) = 'null/' || pg_temp.lv(pg_temp.uid(1)), 'M1 bound null/V ' || pg_temp.bound_of(pg_temp.id('m1')));
select pg_temp.make_due(pg_temp.id('m1'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('m1') || '=%', 'M1 claimed');
select pg_temp.expect(pg_temp.check_send(pg_temp.id('m1')) = 'OK', 'M1 pre-send OK');
select pg_temp.expect(pg_temp.record(pg_temp.id('m1'), 'published', '18040000000000001', null) = 'published', 'M1 recorded');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m1')) = 'published/PUBLISHED', 'M1 row ' || pg_temp.row_of(pg_temp.id('m1')));
select pg_temp.expect(pg_temp.receipt('m1') = 'sent/18040000000000001/false', 'M1 receipt ' || pg_temp.receipt('m1'));
select pg_temp.expect(pg_temp.worker(format('select postona_threads_resv.record(%L, null, ''published'', ''18040000000000001'', null, ''simulated'')', pg_temp.id('m1')))
  = 'published', 'M1 identical replay is idempotent');
select pg_temp.expect(pg_temp.claim() = '', 'M1 never claimed again');

-- M2: made in generation V, the service ends and is started again (V2 > V): never claimed (failed with MV's reason);
-- a reservation made in V2 is claimed and passes the pre-send check
select pg_temp.keep('m2', pg_temp.reserve(pg_temp.uid(1), 'm2', 31));
create table t40.lv (name text primary key, v bigint);
insert into t40.lv values ('v2', pg_temp.restart(pg_temp.uid(1)));
select pg_temp.make_due(pg_temp.id('m2'));
select pg_temp.expect(pg_temp.claim() = '', 'M2 old generation not claimed');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m2')) = 'failed/SERVICE_GENERATION_CHANGED', 'M2 row ' || pg_temp.row_of(pg_temp.id('m2')));
select pg_temp.keep('m2n', pg_temp.reserve(pg_temp.uid(1), 'm2n', 32));
select pg_temp.expect(pg_temp.bound_of(pg_temp.id('m2n')) = 'null/' || (select v from t40.lv where name = 'v2'), 'M2 new row bound to V2');
select pg_temp.make_due(pg_temp.id('m2n'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('m2n') || '=%', 'M2 new generation claimed');
select pg_temp.expect(pg_temp.check_send(pg_temp.id('m2n')) = 'OK', 'M2 new generation pre-send OK');
select pg_temp.expect(pg_temp.record(pg_temp.id('m2n'), 'failed_before_send', null, 'TEST_STOP') = 'failed_before_send', 'M2 finished');

-- M3: claimed, the generation moves before the send: the pre-send check refuses (no send), the row fails with MV's reason
select pg_temp.keep('m3', pg_temp.reserve(pg_temp.uid(1), 'm3', 33));
select pg_temp.make_due(pg_temp.id('m3'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('m3') || '=%', 'M3 claimed');
insert into t40.lv values ('v3', pg_temp.restart(pg_temp.uid(1)));
select pg_temp.expect(pg_temp.check_send(pg_temp.id('m3')) = 'NOT_PUBLISHABLE', 'M3 pre-send refused');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m3')) = 'failed/SERVICE_GENERATION_CHANGED', 'M3 row ' || pg_temp.row_of(pg_temp.id('m3')));

-- M4: the Threads connection generation (G3's credential fingerprint over G4's columns; G4's formal generation is not decided):
-- a credential change between claim and send refuses; a live refresh lease hands the row back unsent, and it runs once the refresh ends
select pg_temp.keep('m4', pg_temp.reserve(pg_temp.uid(1), 'm4', 34));
select pg_temp.make_due(pg_temp.id('m4'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('m4') || '=%', 'M4 claimed');
update public.threads_account_credential_custody set vault_secret_id = gen_random_uuid() where social_account_id = pg_temp.tacct(pg_temp.uid(1));
select pg_temp.expect(pg_temp.check_send(pg_temp.id('m4')) = 'NOT_PUBLISHABLE', 'M4 credential changed: refused');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m4')) = 'failed/CREDENTIAL_CHANGED', 'M4 row ' || pg_temp.row_of(pg_temp.id('m4')));
select pg_temp.keep('m4b', pg_temp.reserve(pg_temp.uid(1), 'm4b', 35));
select pg_temp.make_due(pg_temp.id('m4b'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('m4b') || '=%', 'M4b claimed');
insert into public.threads_credential_refresh_leases (social_account_id, lease_id, vault_secret_id, lease_expires_at)
values (pg_temp.tacct(pg_temp.uid(1)), gen_random_uuid(), gen_random_uuid(), clock_timestamp() + interval '5 minutes');
select pg_temp.expect(pg_temp.check_send(pg_temp.id('m4b')) = 'RELEASED', 'M4b refresh in progress: released');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m4b')) = 'planned/-', 'M4b row ' || pg_temp.row_of(pg_temp.id('m4b')));
delete from public.threads_credential_refresh_leases where social_account_id = pg_temp.tacct(pg_temp.uid(1));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('m4b') || '=%', 'M4b claimed again after the refresh');
select pg_temp.expect(pg_temp.check_send(pg_temp.id('m4b')) = 'OK', 'M4b pre-send OK');
select pg_temp.expect(pg_temp.record(pg_temp.id('m4b'), 'failed_before_send', null, 'TEST_STOP') = 'failed_before_send', 'M4b finished');

-- M5: lease / outcome unknown: an expired lease is fenced to uncertain and never claimed again; an expired lease at finish is
-- lease_lost (uncertain); an 'uncertain' outcome is never re-sent
select pg_temp.keep('m5', pg_temp.reserve(pg_temp.uid(1), 'm5', 36));
select pg_temp.make_due(pg_temp.id('m5'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('m5') || '=%', 'M5 claimed');
update postona_threads_resv.reservations set lease_expires_at = clock_timestamp() - interval '1 second' where id = pg_temp.id('m5');
select pg_temp.expect(pg_temp.claim() = '', 'M5 expired lease not re-claimed');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m5')) = 'uncertain/LEASE_EXPIRED', 'M5 row ' || pg_temp.row_of(pg_temp.id('m5')));
select pg_temp.keep('m5b', pg_temp.reserve(pg_temp.uid(1), 'm5b', 37));
select pg_temp.make_due(pg_temp.id('m5b'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('m5b') || '=%', 'M5b claimed');
select pg_temp.expect(pg_temp.check_send(pg_temp.id('m5b')) = 'OK', 'M5b pre-send OK');
update postona_threads_resv.reservations set lease_expires_at = clock_timestamp() - interval '1 second' where id = pg_temp.id('m5b');
select pg_temp.expect(pg_temp.record(pg_temp.id('m5b'), 'published', '18040000000000005', null) = 'lease_lost', 'M5b lease lost at finish');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m5b')) = 'uncertain/LEASE_EXPIRED_AT_FINISH', 'M5b row ' || pg_temp.row_of(pg_temp.id('m5b')));
select pg_temp.keep('m5c', pg_temp.reserve(pg_temp.uid(1), 'm5c', 38));
select pg_temp.make_due(pg_temp.id('m5c'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('m5c') || '=%', 'M5c claimed');
select pg_temp.expect(pg_temp.check_send(pg_temp.id('m5c')) = 'OK', 'M5c pre-send OK');
select pg_temp.expect(pg_temp.record(pg_temp.id('m5c'), 'uncertain', null, 'TIMEOUT') = 'uncertain', 'M5c uncertain recorded');
select pg_temp.expect(pg_temp.claim() = '', 'M5c uncertain never re-claimed');

-- M6: a row without a generation (written before this rule) is never claimed; nor a row carrying a FULL-profile owner epoch (no mixing);
-- an owner epoch without a generation is refused by the table
select pg_temp.keep('m6', pg_temp.reserve(pg_temp.uid(1), 'm6', 39));
update postona_threads_resv.reservations set bound_lifecycle_version = null where id = pg_temp.id('m6');
select pg_temp.make_due(pg_temp.id('m6'));
select pg_temp.expect(pg_temp.claim() = '', 'M6 unbound not claimed');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m6')) = 'failed/PERSONAL_GENERATION_UNBOUND', 'M6 row ' || pg_temp.row_of(pg_temp.id('m6')));
select pg_temp.keep('m6b', pg_temp.reserve(pg_temp.uid(1), 'm6b', 40));
update postona_threads_resv.reservations set bound_owner_epoch = 2 where id = pg_temp.id('m6b');
select pg_temp.make_due(pg_temp.id('m6b'));
select pg_temp.expect(pg_temp.claim() = '', 'M6b g5oe-bound not claimed');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m6b')) = 'failed/PERSONAL_GENERATION_UNBOUND', 'M6b row ' || pg_temp.row_of(pg_temp.id('m6b')));
select pg_temp.expect(pg_temp.as_role(format('update postona_threads_resv.reservations set bound_owner_epoch = 2, bound_lifecycle_version = null where id = %L returning 1',
  pg_temp.id('m6b')), current_user) like 'ERR:%reservations_personal_mvp_bound%', 'M6c bound rule');

-- M7: the workspace stops being the person's own: a second owner (B) -> not claimed (MV: WORKSPACE_OWNER_UNKNOWN); a second member -> OWN_WORKSPACE_CONFLICT
select pg_temp.keep('m7', pg_temp.reserve(pg_temp.uid(1), 'm7', 41));
select pg_temp.keep('m7b', pg_temp.reserve(pg_temp.uid(1), 'm7b', 42));
select pg_temp.make_due(pg_temp.id('m7'));
insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.ws(pg_temp.uid(1)), pg_temp.uid(2), 'owner');
select pg_temp.expect(pg_temp.claim() = '', 'M7 second owner: not claimed');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m7')) = 'failed/WORKSPACE_OWNER_UNKNOWN', 'M7 row ' || pg_temp.row_of(pg_temp.id('m7')));
update public.brand_memberships set role = 'member' where brand_id = pg_temp.ws(pg_temp.uid(1)) and user_id = pg_temp.uid(2);
select pg_temp.make_due(pg_temp.id('m7b'));
select pg_temp.expect(pg_temp.claim() = '', 'M7b second member: not claimed');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m7b')) = 'failed/OWN_WORKSPACE_CONFLICT', 'M7b row ' || pg_temp.row_of(pg_temp.id('m7b')));
delete from public.brand_memberships where brand_id = pg_temp.ws(pg_temp.uid(1)) and user_id = pg_temp.uid(2);

-- M8: RESIDUAL (G5's, stated): an owner change UNDONE before the run (A -> B -> A; only the owner / service_role write memberships) is invisible
select pg_temp.keep('m8', pg_temp.reserve(pg_temp.uid(1), 'm8', 43));
insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.ws(pg_temp.uid(1)), pg_temp.uid(2), 'owner');
delete from public.brand_memberships where brand_id = pg_temp.ws(pg_temp.uid(1)) and user_id = pg_temp.uid(2);
select pg_temp.make_due(pg_temp.id('m8'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('m8') || '=%', 'M8 RESIDUAL: A -> B -> A is claimed');
select pg_temp.expect(pg_temp.record(pg_temp.id('m8'), 'failed_before_send', null, 'TEST_STOP') = 'failed_before_send', 'M8 finished');

-- M9: R1 answers other than 'g5pv:<V>' bind nothing (an R1 stand-in inside a rolled-back transaction; G5's R1 is not changed)
begin;
create or replace function public.common_account_authorization_verdict(p_app text, p_feature text, p_brand_id text) returns jsonb
language sql stable security definer set search_path = '' as $f$ select pg_catalog.current_setting('t40.r1')::jsonb $f$;
select set_config('t40.r1', v, true), pg_temp.expect(pg_temp.create_raw(pg_temp.uid(1), 'm9', 44) = 'ERR:POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE', 'M9 refused ' || v)
from unnest(array['{"decision":"allow","owner_epoch":"g5oe:3:1"}', '{"decision":"allow","owner_epoch":"g5pv:0"}', '{"decision":"allow","owner_epoch":"g5pv:99999999999999999999"}',
  '{"decision":"allow","owner_epoch":"g5pv:12 "}', '{"decision":"allow"}', '{"decision":"deny","owner_epoch":"g5pv:5"}', '{"decision":"unknown","owner_epoch":"g5pv:5"}']) v;
select pg_temp.expect((select count(*) from postona_threads_resv.reservations r where r.body = 'G3-40 本文 m9') = 0, 'M9 nothing written');
rollback;

-- M10: create refusals: service suspended; another person's account; G4 says not verified. A verified account that G4 stops
-- verifying between claim and send is refused at the pre-send check
update public.service_entitlements set status = 'suspended' where user_id = pg_temp.uid(1) and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.create_raw(pg_temp.uid(1), 'm10', 45) = 'ERR:POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE', 'M10 suspended refused');
update public.service_entitlements set status = 'active' where user_id = pg_temp.uid(1) and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.create_raw(pg_temp.uid(1), 'm10b', 46, pg_temp.tacct(pg_temp.uid(4))) = 'ERR:POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND', 'M10b another person''s account');
select pg_temp.expect(pg_temp.create_raw(pg_temp.uid(2), 'm10c', 46, pg_temp.tacct(pg_temp.uid(1))) = 'ERR:POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND', 'M10c B on A''s account');
delete from t_threads.verified where social_account_id = pg_temp.tacct(pg_temp.uid(1));
select pg_temp.expect(pg_temp.create_raw(pg_temp.uid(1), 'm10d', 47) = 'ERR:POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED', 'M10d G4 not verified');
insert into t_threads.verified values (pg_temp.tacct(pg_temp.uid(1)));
select pg_temp.keep('m10e', pg_temp.reserve(pg_temp.uid(1), 'm10e', 48));
select pg_temp.make_due(pg_temp.id('m10e'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('m10e') || '=%', 'M10e claimed');
delete from t_threads.verified where social_account_id = pg_temp.tacct(pg_temp.uid(1));
select pg_temp.expect(pg_temp.check_send(pg_temp.id('m10e')) = 'NOT_PUBLISHABLE', 'M10e G4 stopped verifying: refused');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m10e')) = 'failed/NOT_PUBLISHABLE_AT_SEND', 'M10e row ' || pg_temp.row_of(pg_temp.id('m10e')));
insert into t_threads.verified values (pg_temp.tacct(pg_temp.uid(1)));

-- M11: sent, then the generation moved before the outcome was written: recorded, and marked after_freeze for the person
select pg_temp.keep('m11', pg_temp.reserve(pg_temp.uid(1), 'm11', 49));
select pg_temp.make_due(pg_temp.id('m11'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('m11') || '=%', 'M11 claimed');
select pg_temp.expect(pg_temp.check_send(pg_temp.id('m11')) = 'OK', 'M11 pre-send OK');
insert into t40.lv values ('v4', pg_temp.restart(pg_temp.uid(1)));
select pg_temp.expect(pg_temp.record(pg_temp.id('m11'), 'published', '18040000000000011', null) = 'published', 'M11 recorded');
select pg_temp.expect(pg_temp.receipt('m11') = 'sent/18040000000000011/true', 'M11 receipt after_freeze ' || pg_temp.receipt('m11'));

-- M12: another person is untouched by A's generation moves: D's reservation runs
select pg_temp.keep('m12', pg_temp.reserve(pg_temp.uid(4), 'm12', 50));
select pg_temp.make_due(pg_temp.id('m12'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('m12') || '=%', 'M12 D claimed');
select pg_temp.expect(pg_temp.check_send(pg_temp.id('m12')) = 'OK', 'M12 D pre-send OK');
select pg_temp.expect(pg_temp.record(pg_temp.id('m12'), 'failed_before_send', null, 'TEST_STOP') = 'failed_before_send', 'M12 finished');

-- M13: D's service is being ended: D's due reservation is never claimed (MV's reason); D cannot create
select pg_temp.keep('m13', pg_temp.reserve(pg_temp.uid(4), 'm13', 51));
select pg_temp.make_due(pg_temp.id('m13'));
select pg_temp.expect(pg_temp.as_role(format('select public.begin_service_deletion(%L::uuid, ''x_autopost'')::text', pg_temp.uid(4)), 'service_role') !~ '^ERR', 'setup: D end begins');
select pg_temp.expect(pg_temp.claim() = '', 'M13 not claimed');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('m13')) = 'failed/SERVICE_DELETION_IN_PROGRESS', 'M13 row ' || pg_temp.row_of(pg_temp.id('m13')));
select pg_temp.expect(pg_temp.create_raw(pg_temp.uid(4), 'm13b', 52) like 'ERR:POSTONA_THREADS_RESV_%', 'M13 create refused');

select 'G3_THREADS_PERSONAL_MVP_BEHAVIOR_PASS';
