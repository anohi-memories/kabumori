-- SQL-level behaviour of 006 (M1-F1 live pre-send fence, M1-F3 record) that the HTTP end to end does not reach directly.
-- Run by single_post_live_fence_run.sh as the schema owner after people.sql and 006.
-- People 83-99. Fake data only.
\ir ../../postona_x_oauth_t13_guard/helpers.sql
create function pg_temp.api(p_sql text, p_user uuid, p_session uuid) returns text language sql as $$ select pg_temp.as_person(p_sql, p_user, p_session, 'postona_resv_api') $$;
create function pg_temp.begin_sp(p_account text, p_req uuid, p_text text) returns text language sql as $$
  select format('select state || coalesce(''/'' || lease_token::text, '''') || ''/'' || reservation_id from postona_x_resv.post_now_begin(%L, %L::uuid, %L, %L)',
                p_account, p_req, p_text, encode(sha256(convert_to(p_text, 'UTF8')), 'hex')) $$;
create function pg_temp.preflight(p_rid text, p_lease text) returns text language sql as $$
  select format('select verdict || ''/'' || coalesce(credential_generation, '''') from postona_x_resv.post_now_preflight(%L, %L)', p_rid, p_lease) $$;
create function pg_temp.record(p_rid text, p_lease text, p_outcome text, p_id text, p_code text, p_transport text) returns text language sql as $$
  select format('select postona_x_resv.post_now_record(%L, %L, %L, %L, %L, %L)', p_rid, p_lease, p_outcome, p_id, p_code, p_transport) $$;
create function pg_temp.readback(p_rid text) returns text language sql as $$
  select format('select concat_ws(''/'', state, coalesce(provider_post_id, ''-''), coalesce(outcome_code, ''-''), after_freeze::text, simulated::text) from postona_x_resv.post_now_readback(%L)', p_rid) $$;
create function pg_temp.person(p_n integer) returns uuid language sql as $$ select user_id from t_ids.people where n = p_n $$;
create function pg_temp.account(p_n integer) returns text language sql as $$ select account from t_ids.people where n = p_n $$;
create function pg_temp.brand(p_n integer) returns text language sql as $$ select brand from t_ids.people where n = p_n $$;
create function pg_temp.row_of(p_rid text) returns text language sql as $$ select status || '/' || coalesce(outcome_code, '-') from postona_x_resv.reservations where id = p_rid::uuid $$;
update public.social_accounts set publish_enabled = true where id in (select account from t_ids.people where n between 83 and 99);
select pg_temp.session(pg_temp.person(83)) as s83, pg_temp.session(pg_temp.person(84)) as s84, pg_temp.session(pg_temp.person(85)) as s85,
       pg_temp.session(pg_temp.person(86)) as s86, pg_temp.session(pg_temp.person(87)) as s87, pg_temp.session(pg_temp.person(88)) as s88,
       pg_temp.session(pg_temp.person(89)) as s89, pg_temp.session(pg_temp.person(90)) as s90, pg_temp.session(pg_temp.person(91)) as s91 \gset

-- L1: ACL. The API role reaches begin / preflight / record / readback; 005's check / finish / get, the generation function
-- and the bindings table are closed to it (and to every other API role).
select pg_temp.expect(pg_temp.api(q, pg_temp.person(83), :'s83') like 'ERR:permission denied%', 'L1 closed: ' || q) from unnest(array[
  format('select postona_x_resv.post_now_check(%L, %L)', gen_random_uuid(), gen_random_uuid()),
  format('select postona_x_resv.post_now_finish(%L, %L, ''published'', ''1'', null)', gen_random_uuid(), gen_random_uuid()),
  format('select state from postona_x_resv.post_now_get(%L)', gen_random_uuid()),
  format('select postona_x_resv.x_credential_generation(%L)', pg_temp.account(83)),
  'select count(*)::text from postona_x_resv.single_post_bindings']) q;
select pg_temp.expect(pg_temp.as_person(format('select verdict from postona_x_resv.post_now_preflight(%L, %L)', gen_random_uuid(), gen_random_uuid()), pg_temp.person(83), :'s83', r) like 'ERR:permission denied%', 'L1 preflight closed to ' || r)
  from unnest(array['anon', 'authenticated', 'service_role', 'postona_resv_worker']) r;
select pg_temp.expect(pg_temp.api(pg_temp.preflight(gen_random_uuid()::text, gen_random_uuid()::text), pg_temp.person(83), :'s83') = 'LEASE_LOST/', 'L1 api reaches preflight');
select 'L1_ACL_PASS' as result;

-- RD (G3-37): readiness is read only and says nothing begin would not: READY for the person's own enabled account; begin's own
-- refusal codes otherwise (switch OFF, another person's account); no reservation row, no binding; closed to every other role.
select pg_temp.session(pg_temp.person(97)) as s97, pg_temp.session(pg_temp.person(98)) as s98 \gset
select count(*) as rdrows, (select count(*) from postona_x_resv.single_post_bindings) as rdbind from postona_x_resv.reservations \gset
select (select publish_enabled from public.social_accounts where id = pg_temp.account(97)) as rd97, (select publish_enabled from public.social_accounts where id = pg_temp.account(98)) as rd98 \gset
update public.social_accounts set publish_enabled = true where id = pg_temp.account(98);
update public.social_accounts set publish_enabled = false where id = pg_temp.account(97);
select pg_temp.expect(pg_temp.api(format('select postona_x_resv.post_now_readiness(%L)', pg_temp.account(98)), pg_temp.person(98), :'s98') = 'READY', 'RD ready');
select pg_temp.api(format('select postona_x_resv.post_now_readiness(%L)', pg_temp.account(97)), pg_temp.person(97), :'s97') as rdoff \gset
select pg_temp.expect(:'rdoff' = 'ERR:POSTONA_RESV_PUBLISH_DISABLED', 'RD switch OFF: ' || :'rdoff');
select pg_temp.expect(pg_temp.api(format('select postona_x_resv.post_now_readiness(%L)', pg_temp.account(98)), pg_temp.person(97), :'s97')
  = pg_temp.api(format('select postona_x_resv.post_now_readiness(%L)', 'x_no_such_account'), pg_temp.person(97), :'s97'), 'RD another person''s account answers as an unknown one');
select pg_temp.expect(pg_temp.api(format('select postona_x_resv.post_now_readiness(%L)', pg_temp.account(98)), pg_temp.person(97), :'s97') = 'ERR:POSTONA_RESV_ACCOUNT_NOT_FOUND', 'RD another person''s account');
select pg_temp.expect(pg_temp.api('select postona_x_resv.post_now_readiness(''bad id!'')', pg_temp.person(98), :'s98') = 'ERR:POSTONA_RESV_REQUEST_INVALID', 'RD bad id');
select pg_temp.expect(pg_temp.as_person(format('select postona_x_resv.post_now_readiness(%L)', pg_temp.account(98)), pg_temp.person(98), :'s98', r) like 'ERR:permission denied%', 'RD closed to ' || r)
  from unnest(array['anon', 'authenticated', 'service_role', 'postona_resv_worker']) r;
select pg_temp.expect((select count(*) from postona_x_resv.reservations) = :rdrows and (select count(*) from postona_x_resv.single_post_bindings) = :rdbind, 'RD nothing written');
update public.social_accounts set publish_enabled = :'rd97'::boolean where id = pg_temp.account(97);
update public.social_accounts set publish_enabled = :'rd98'::boolean where id = pg_temp.account(98);
select 'RD_READINESS_READ_ONLY_PASS' as result;

-- L2: begin refuses on the live fence (nothing recorded): publish switch OFF, a second workspace owner (F5: owner unknown),
-- F5 brand state not active, refresh in progress (busy), credential degraded (uncertain / reauth_required).
select count(*) as l2rows from postona_x_resv.reservations \gset
update public.social_accounts set publish_enabled = false where id = pg_temp.account(83);
select pg_temp.expect(pg_temp.api(pg_temp.begin_sp(pg_temp.account(83), gen_random_uuid(), 'off'), pg_temp.person(83), :'s83') = 'ERR:POSTONA_RESV_PUBLISH_DISABLED', 'L2 switch OFF');
update public.social_accounts set publish_enabled = true where id = pg_temp.account(83);
insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.brand(84), pg_temp.person(85), 'owner');
select pg_temp.expect(pg_temp.api(pg_temp.begin_sp(pg_temp.account(84), gen_random_uuid(), 'two owners'), pg_temp.person(84), :'s84') = 'ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE', 'L2 two owners (F5 owner unknown)');
delete from public.brand_memberships where brand_id = pg_temp.brand(84) and user_id = pg_temp.person(85);
insert into public.x_account_refresh_state_v2 (social_account_id, status, generation) values (pg_temp.account(85), 'refreshing', 1);
select pg_temp.expect(pg_temp.api(pg_temp.begin_sp(pg_temp.account(85), gen_random_uuid(), 'refreshing'), pg_temp.person(85), :'s85') = 'ERR:POSTONA_RESV_SERVICE_BUSY', 'L2 refreshing');
update public.x_account_refresh_state_v2 set status = 'uncertain' where social_account_id = pg_temp.account(85);
select pg_temp.expect(pg_temp.api(pg_temp.begin_sp(pg_temp.account(85), gen_random_uuid(), 'uncertain'), pg_temp.person(85), :'s85') = 'ERR:POSTONA_RESV_CREDENTIAL_DEGRADED', 'L2 uncertain');
update public.x_account_refresh_state_v2 set status = 'reauth_required' where social_account_id = pg_temp.account(85);
select pg_temp.expect(pg_temp.api(pg_temp.begin_sp(pg_temp.account(85), gen_random_uuid(), 'reauth'), pg_temp.person(85), :'s85') = 'ERR:POSTONA_RESV_CREDENTIAL_DEGRADED', 'L2 reauth_required');
update public.x_account_refresh_state_v2 set status = 'idle' where social_account_id = pg_temp.account(85);
update public.common_accounts set status = 'locked' where user_id = pg_temp.person(86);
select pg_temp.expect(pg_temp.api(pg_temp.begin_sp(pg_temp.account(86), gen_random_uuid(), 'locked'), pg_temp.person(86), :'s86') = 'ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE', 'L2 account locked');
update public.common_accounts set status = 'active' where user_id = pg_temp.person(86);
select pg_temp.expect((select count(*) from postona_x_resv.reservations) = :'l2rows', 'L2 nothing recorded');
select 'L2_BEGIN_LIVE_FENCE_REFUSALS_PASS' as result;

-- L3: begin binds owner / workspace / generation; preflight answers OK with exactly that generation.
select gen_random_uuid() as req3 \gset
select pg_temp.api(pg_temp.begin_sp(pg_temp.account(83), :'req3', 'bound'), pg_temp.person(83), :'s83') as b3 \gset
select split_part(:'b3', '/', 2) as l3lease, split_part(:'b3', '/', 3) as l3id \gset
select pg_temp.expect((select b.owner_user_id = pg_temp.person(83) and b.brand_id = pg_temp.brand(83)
  and b.credential_generation = postona_x_resv.x_credential_generation(pg_temp.account(83)) and b.transport is null and b.after_freeze is null
  from postona_x_resv.single_post_bindings b where b.reservation_id = :'l3id'::uuid), 'L3 binding');
select pg_temp.expect(pg_temp.api(pg_temp.preflight(:'l3id', :'l3lease'), pg_temp.person(83), :'s83') = 'OK/' || postona_x_resv.x_credential_generation(pg_temp.account(83)), 'L3 preflight OK + generation');
select pg_temp.expect(pg_temp.api(pg_temp.preflight(:'l3id', :'l3lease'), pg_temp.person(84), :'s84') = 'LEASE_LOST/', 'L3 another person: LEASE_LOST');
select 'L3_BIND_PREFLIGHT_GENERATION_PASS' as result;

-- L4: a change between begin and preflight refuses (never sent): every generation input, and the live fence.
create function pg_temp.l4(p_n integer, p_session uuid, p_label text, p_change text, p_undo text, p_expect text) returns void language plpgsql as $$
declare v text; v_rid text; v_lease text;
begin
  v := pg_temp.api(pg_temp.begin_sp(pg_temp.account(p_n), gen_random_uuid(), 'L4 ' || p_label), pg_temp.person(p_n), p_session);
  perform pg_temp.expect(v like 'claimed/%', 'L4 begin ' || p_label || ' ' || v);
  v_lease := split_part(v, '/', 2); v_rid := split_part(v, '/', 3);
  execute format(p_change, pg_temp.account(p_n), pg_temp.person(p_n), pg_temp.brand(p_n));
  v := pg_temp.api(pg_temp.preflight(v_rid, v_lease), pg_temp.person(p_n), p_session);
  if p_undo is not null then execute format(p_undo, pg_temp.account(p_n), pg_temp.person(p_n), pg_temp.brand(p_n)); end if;
  perform pg_temp.expect(v || ' ' || pg_temp.row_of(v_rid) = p_expect, 'L4 ' || p_label || ': ' || v || ' ' || pg_temp.row_of(v_rid));
end $$;
select pg_temp.l4(87, :'s87', 'vault swap',
  'update public.social_accounts set vault_access_token_secret_id = vault_refresh_token_secret_id, vault_refresh_token_secret_id = vault_access_token_secret_id where id = %1$L',
  'update public.social_accounts set vault_access_token_secret_id = vault_refresh_token_secret_id, vault_refresh_token_secret_id = vault_access_token_secret_id where id = %1$L',
  'NOT_PUBLISHABLE/ failed/CREDENTIAL_CHANGED');
select pg_temp.l4(87, :'s87', 'account row written', 'update public.social_accounts set updated_at = updated_at + interval ''1 second'' where id = %1$L', null,
  'NOT_PUBLISHABLE/ failed/CREDENTIAL_CHANGED');
select pg_temp.l4(87, :'s87', 'refresh generation', 'insert into public.x_account_refresh_state_v2 (social_account_id, status, generation) values (%1$L, ''idle'', 7)', null,
  'NOT_PUBLISHABLE/ failed/CREDENTIAL_CHANGED');
select pg_temp.l4(87, :'s87', 'refresh generation bump', 'update public.x_account_refresh_state_v2 set generation = generation + 1 where social_account_id = %1$L', null,
  'NOT_PUBLISHABLE/ failed/CREDENTIAL_CHANGED');
select pg_temp.l4(87, :'s87', 'reconnected X user', 'update public.social_accounts set platform_user_id = platform_user_id || ''0'' where id = %1$L',
  'update public.social_accounts set platform_user_id = left(platform_user_id, -1) where id = %1$L', 'NOT_PUBLISHABLE/ failed/CREDENTIAL_CHANGED');
select pg_temp.l4(88, :'s88', 'publish OFF', 'update public.social_accounts set publish_enabled = false where id = %1$L',
  'update public.social_accounts set publish_enabled = true where id = %1$L', 'NOT_PUBLISHABLE/ failed/NOT_PUBLISHABLE_AT_SEND');
select pg_temp.l4(88, :'s88', 'authority revoked', 'insert into public.x_account_publish_authority (social_account_id, state, reason_code) values (%1$L, ''revoked'', ''SOCIAL_MOBILE_DELETION'')',
  'delete from public.x_account_publish_authority where social_account_id = %1$L', 'NOT_PUBLISHABLE/ failed/NOT_PUBLISHABLE_AT_SEND');
select pg_temp.l4(88, :'s88', 'second owner', format('insert into public.brand_memberships (brand_id, user_id, role) values (%%3$L, %L, ''owner'')', pg_temp.person(89)),
  'delete from public.brand_memberships where brand_id = %3$L and user_id <> %2$L', 'NOT_PUBLISHABLE/ failed/NOT_PUBLISHABLE_AT_SEND');
select pg_temp.l4(88, :'s88', 'entitlement ended', 'update public.service_entitlements set status = ''ended'', ended_at = now() where user_id = %2$L and service_key = ''x_autopost''',
  'update public.service_entitlements set status = ''active'', ended_at = null where user_id = %2$L and service_key = ''x_autopost''', 'NOT_PUBLISHABLE/ failed/NOT_PUBLISHABLE_AT_SEND');
select pg_temp.l4(88, :'s88', 'account deleting', 'update public.common_accounts set status = ''deleting'' where user_id = %2$L',
  'update public.common_accounts set status = ''active'' where user_id = %2$L', 'NOT_PUBLISHABLE/ failed/NOT_PUBLISHABLE_AT_SEND');
select pg_temp.l4(88, :'s88', 'not verified (G4)', 'update public.social_accounts set last_connection_error_code = ''X_ACCOUNT_ALREADY_CONNECTED'' where id = %1$L',
  'update public.social_accounts set last_connection_error_code = null where id = %1$L', 'NOT_PUBLISHABLE/ failed/NOT_PUBLISHABLE_AT_SEND');
select pg_temp.l4(88, :'s88', 'credential degraded', 'insert into public.x_account_refresh_state_v2 (social_account_id, status, generation) values (%1$L, ''reauth_required'', 0)',
  'delete from public.x_account_refresh_state_v2 where social_account_id = %1$L', 'NOT_PUBLISHABLE/ failed/NOT_PUBLISHABLE_AT_SEND');
select pg_temp.l4(88, :'s88', 'refresh in progress', 'insert into public.x_account_refresh_state_v2 (social_account_id, status, generation) values (%1$L, ''refreshing'', 0)',
  'delete from public.x_account_refresh_state_v2 where social_account_id = %1$L', 'RELEASED/ planned/-');
-- the binding itself altered (defence in depth: own_single_post and the generation already pin owner and workspace).
select pg_temp.l4(87, :'s87', 'binding workspace altered', 'update postona_x_resv.single_post_bindings b set brand_id = b.brand_id || ''_moved'' from postona_x_resv.reservations r
  where r.id = b.reservation_id and r.social_account_id = %1$L and r.status = ''claimed''', null, 'NOT_PUBLISHABLE/ failed/CREDENTIAL_CHANGED');
select pg_temp.l4(87, :'s87', 'binding owner altered', format('update postona_x_resv.single_post_bindings b set owner_user_id = %L from postona_x_resv.reservations r
  where r.id = b.reservation_id and r.social_account_id = %%1$L and r.status = ''claimed''', pg_temp.person(89)), null, 'NOT_PUBLISHABLE/ failed/CREDENTIAL_CHANGED');
-- the lease ran out before the preflight: the existing pre_publish_check (004) hands the row back (RELEASED, never OK).
select pg_temp.l4(87, :'s87', 'lease ran out', 'update postona_x_resv.reservations set lease_expires_at = clock_timestamp() - interval ''1 second'' where social_account_id = %1$L and status = ''claimed''',
  null, 'RELEASED/ planned/-');
select 'L4_CHANGE_BETWEEN_BEGIN_AND_SEND_REFUSED_PASS' as result;

-- L5: the binding is re-taken when a never-sent row is re-armed (the generation of the new attempt, not the old one).
select gen_random_uuid() as req5 \gset
select pg_temp.api(pg_temp.begin_sp(pg_temp.account(89), :'req5', 'rearm'), pg_temp.person(89), :'s89') as b5 \gset
select split_part(:'b5', '/', 2) as l5lease, split_part(:'b5', '/', 3) as l5id \gset
select pg_temp.expect(postona_x_resv.release_claim(:'l5id', :'l5lease', 'SERVICE_BUSY'), 'L5 setup release');
update public.social_accounts set updated_at = updated_at + interval '1 second' where id = pg_temp.account(89);
select pg_temp.api(pg_temp.begin_sp(pg_temp.account(89), :'req5', 'rearm'), pg_temp.person(89), :'s89') as b5b \gset
select pg_temp.expect(:'b5b' like 'claimed/%' and split_part(:'b5b', '/', 3) = :'l5id', 'L5 re-armed');
select pg_temp.expect(pg_temp.api(pg_temp.preflight(:'l5id', split_part(:'b5b', '/', 2)), pg_temp.person(89), :'s89') = 'OK/' || postona_x_resv.x_credential_generation(pg_temp.account(89)), 'L5 new generation bound');
select 'L5_REARM_REBINDS_PASS' as result;

-- L6: record: transport required; outcome + transport stored; after_freeze from a fresh F5 read at record time (a post in
-- flight when the service ended is recorded as published, flagged, never hidden); readback answers the marks; only the
-- first record counts; another person can neither record nor read.
select pg_temp.expect(pg_temp.api(pg_temp.record(:'l5id', split_part(:'b5b', '/', 2), 'published', '1790000000000000901', null, t), pg_temp.person(89), :'s89') = 'ERR:POSTONA_RESV_REQUEST_INVALID', 'L6 transport ' || coalesce(t, 'null'))
  from unnest(array[null, 'X', 'mock']) t;
select pg_temp.expect(pg_temp.api(pg_temp.record(:'l5id', split_part(:'b5b', '/', 2), 'published', '1790000000000000901', null, 'x'), pg_temp.person(90), :'s90') = 'ERR:POSTONA_RESV_LEASE_LOST', 'L6 another person cannot record');
select pg_temp.expect(pg_temp.api(pg_temp.record(:'l5id', split_part(:'b5b', '/', 2), 'published', '1790000000000000901', null, 'x'), pg_temp.person(89), :'s89') = 'published', 'L6 record (active)');
select pg_temp.expect(pg_temp.api(pg_temp.readback(:'l5id'), pg_temp.person(89), :'s89') = 'sent/1790000000000000901/PUBLISHED/false/false', 'L6 readback real transport, not after freeze');
select pg_temp.expect(pg_temp.api(pg_temp.record(:'l5id', split_part(:'b5b', '/', 2), 'published', '1790000000000000902', null, 'simulated'), pg_temp.person(89), :'s89') <> 'published'
  or (select provider_post_id from postona_x_resv.reservations where id = :'l5id'::uuid) = '1790000000000000901', 'L6 second record changes nothing');
select pg_temp.expect(pg_temp.api(pg_temp.record(:'l5id', split_part(:'b5b', '/', 2), 'published', '1790000000000000901', null, 'simulated'), pg_temp.person(89), :'s89') = 'published', 'L6 identical replay answers published');
select pg_temp.expect((select transport = 'x' and after_freeze = false from postona_x_resv.single_post_bindings where reservation_id = :'l5id'::uuid), 'L6 marks kept from the first record');
select pg_temp.expect(pg_temp.api(pg_temp.readback(:'l5id'), pg_temp.person(90), :'s90') = 'ERR:POSTONA_RESV_NOT_FOUND', 'L6 another person cannot read');
-- in flight: preflight OK, then the service ends while X answers, then the record.
select pg_temp.api(pg_temp.begin_sp(pg_temp.account(90), gen_random_uuid(), 'in flight'), pg_temp.person(90), :'s90') as b6 \gset
select split_part(:'b6', '/', 2) as l6lease, split_part(:'b6', '/', 3) as l6id \gset
select pg_temp.expect(pg_temp.api(pg_temp.preflight(:'l6id', :'l6lease'), pg_temp.person(90), :'s90') like 'OK/%', 'L6 preflight');
select pg_temp.end_service(pg_temp.person(90));
select pg_temp.expect(pg_temp.api(pg_temp.record(:'l6id', :'l6lease', 'published', '1790000000000000903', null, 'simulated'), pg_temp.person(90), :'s90') = 'published', 'L6 in-flight post recorded as it happened');
select pg_temp.expect(pg_temp.api(pg_temp.readback(:'l6id'), pg_temp.person(90), :'s90') = 'sent/1790000000000000903/PUBLISHED/true/true', 'L6 readback after_freeze + simulated');
-- a row the handler never recorded (released) has no transport: never reported as a real post.
select pg_temp.expect(pg_temp.api(pg_temp.readback(r.id::text), pg_temp.person(88), :'s88') like 'pending/-/%/false/true', 'L6 unrecorded row is simulated')
  from postona_x_resv.reservations r where r.user_id = pg_temp.person(88) and r.status = 'planned';
-- G3-33 X5: a claimed single post whose lease ran out (no sweep yet) reads 'uncertain', not 'pending'; the read changes nothing.
select pg_temp.api(pg_temp.begin_sp(pg_temp.account(89), gen_random_uuid(), 'X5 lease'), pg_temp.person(89), :'s89') as bx5 \gset
select split_part(:'bx5', '/', 3) as x5id \gset
select pg_temp.expect(pg_temp.api(pg_temp.readback(:'x5id'), pg_temp.person(89), :'s89') like 'pending/%', 'X5 live lease reads pending');
update postona_x_resv.reservations set lease_expires_at = clock_timestamp() - interval '1 second' where id = :'x5id';
select pg_temp.expect(pg_temp.api(pg_temp.readback(:'x5id'), pg_temp.person(89), :'s89') = 'uncertain/-/-/false/true', 'X5 lease ran out reads uncertain');
select pg_temp.expect((select status from postona_x_resv.reservations where id = :'x5id') = 'claimed', 'X5 the readback changes nothing');
select pg_temp.expect(pg_temp.api(pg_temp.readback(:'x5id'), pg_temp.person(90), :'s90') = 'ERR:POSTONA_RESV_NOT_FOUND', 'X5 another person still cannot read');
select 'L6_RECORD_AFTER_FREEZE_SIMULATED_READBACK_PASS' as result;

-- EP (G3-38): a single post begun by A, then A -> B -> A on the workspace before the pre-send check: refused (failed, never sent);
-- a new single post after the change goes through to OK. People 99 (A) and 93 (B).
select pg_temp.session(pg_temp.person(99)) as s99 \gset
select (select publish_enabled from public.social_accounts where id = pg_temp.account(99)) as ep99 \gset
update public.social_accounts set publish_enabled = true where id = pg_temp.account(99);
select pg_temp.api(pg_temp.begin_sp(pg_temp.account(99), gen_random_uuid(), 'EP before'), pg_temp.person(99), :'s99') as bep \gset
select pg_temp.expect(:'bep' like 'claimed/%', 'EP begin ' || :'bep');
delete from public.brand_memberships where brand_id = pg_temp.brand(99) and role = 'owner';
insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.brand(99), pg_temp.person(93), 'owner');
delete from public.brand_memberships where brand_id = pg_temp.brand(99) and role = 'owner';
insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.brand(99), pg_temp.person(99), 'owner');
select pg_temp.expect(pg_temp.api(pg_temp.preflight(split_part(:'bep', '/', 3), split_part(:'bep', '/', 2)), pg_temp.person(99), :'s99') = 'NOT_PUBLISHABLE/', 'EP A -> B -> A refused at the check');
select pg_temp.expect((select status || '/' || outcome_code from postona_x_resv.reservations where id = split_part(:'bep', '/', 3)::uuid) = 'failed/NOT_PUBLISHABLE_AT_SEND', 'EP failed, never sent');
select pg_temp.api(pg_temp.begin_sp(pg_temp.account(99), gen_random_uuid(), 'EP after'), pg_temp.person(99), :'s99') as aep \gset
select pg_temp.expect(pg_temp.api(pg_temp.preflight(split_part(:'aep', '/', 3), split_part(:'aep', '/', 2)), pg_temp.person(99), :'s99') like 'OK/%', 'EP a post begun after the change passes the check');
update postona_x_resv.reservations set status = 'cancelled', lease_token = null, lease_expires_at = null where id = split_part(:'aep', '/', 3)::uuid;
update public.social_accounts set publish_enabled = :'ep99'::boolean where id = pg_temp.account(99);
select 'EP_SINGLE_POST_OWNER_EPOCH_PASS' as result;

-- L7: the delivery worker still never claims a single post and its four functions are unchanged.
begin;
set local role postona_resv_worker;
select coalesce(array_agg(c.reservation_id), '{}')::text as l7ids from postona_x_resv.claim_due('w1', 120, 50) c \gset
commit;
select pg_temp.expect(not exists (select 1 from postona_x_resv.reservations r where r.id = any (:'l7ids'::uuid[]) and r.draft_id like 'single:%'), 'L7 worker never claims a single post');
select pg_temp.expect(exists (select 1 from postona_x_resv.reservations r where r.draft_id like 'single:%' and r.status in ('planned', 'claimed')), 'L7 there were single posts to (not) claim');
select 'L7_WORKER_UNCHANGED_PASS' as result;

-- L8: defence in depth -- should F5's brand state ever answer 'active' for a workspace with two owners, the fence's own
-- owner check (F5's brand owner = the caller) still refuses. TEST-ONLY stand-in of F5's function inside a rolled-back
-- transaction on this disposable database; F5's real function is unchanged afterwards.
select md5(prosrc) as l8src from pg_proc where oid = 'public.common_account_brand_service_state(text,text)'::regprocedure \gset
select pg_temp.session(pg_temp.person(94)) as s94 \gset
begin;
create or replace function public.common_account_brand_service_state(p_brand_id text, p_service_key text default 'x_autopost')
returns text language sql stable security definer set search_path = '' as $$ select 'active'::text $$;
insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.brand(94), pg_temp.person(95), 'owner');
select pg_temp.expect(pg_temp.api(pg_temp.begin_sp(pg_temp.account(94), gen_random_uuid(), 'two owners, lenient F5'), pg_temp.person(94), :'s94') = 'ERR:POSTONA_RESV_ACCOUNT_NOT_FOUND', 'L8 owner check');
rollback;
select pg_temp.expect((select md5(prosrc) from pg_proc where oid = 'public.common_account_brand_service_state(text,text)'::regprocedure) = :'l8src', 'L8 F5 function restored');
select 'L8_OWNER_CHECK_DEFENCE_IN_DEPTH_PASS' as result;

select 'POSTONA_X_SINGLE_POST_LIVE_FENCE_BEHAVIOR_PASS' as result;
