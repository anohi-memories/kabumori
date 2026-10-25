-- SQL behaviour of candidate 007 (Threads reservations). Run by postona_threads_reservations_run.sh as the schema owner
-- after 007 and the G4/G5 test doubles. People 61-80. Fake data only.
\ir ../../postona_x_oauth_t13_guard/helpers.sql
create function pg_temp.api(p_sql text, p_user uuid, p_session uuid) returns text language sql as $$ select pg_temp.as_person(p_sql, p_user, p_session, 'postona_resv_api') $$;
create function pg_temp.wk(p_sql text) returns text language sql as $$ select pg_temp.as_person(p_sql, null, null, 'postona_resv_worker') $$;
create function pg_temp.p(p_n integer) returns uuid language sql as $$ select user_id from t_ids.people where n = p_n $$;
create function pg_temp.th(p_n integer) returns text language sql as $$ select threads_account from t_ids.people where n = p_n $$;
create function pg_temp.br(p_n integer) returns text language sql as $$ select brand from t_ids.people where n = p_n $$;
create function pg_temp.sess(p_n integer) returns uuid language sql as $$ select pg_temp.session(pg_temp.p(p_n)) $$;
create function pg_temp.create_sql(p_account text, p_req uuid, p_text text, p_in text default '10 minutes', p_sha text default null) returns text language sql as $$
  select format('select status || ''/'' || reservation_id || ''/'' || created from postona_threads_resv.create_reservation(%L, %L::uuid, %L, %L, now() + %L::interval)',
                p_account, p_req, p_text, coalesce(p_sha, encode(sha256(convert_to(p_text, 'UTF8')), 'hex')), p_in) $$;
create function pg_temp.create_at(p_account text, p_req uuid, p_text text, p_at timestamptz) returns text language sql as $$
  select format('select status || ''/'' || reservation_id || ''/'' || created from postona_threads_resv.create_reservation(%L, %L::uuid, %L, %L, %L::timestamptz)',
                p_account, p_req, p_text, encode(sha256(convert_to(p_text, 'UTF8')), 'hex'), p_at) $$;
create function pg_temp.mk(p_n integer, p_text text) returns uuid language plpgsql as $$
declare v text := pg_temp.api(pg_temp.create_sql(pg_temp.th(p_n), gen_random_uuid(), p_text), pg_temp.p(p_n), pg_temp.sess(p_n));
begin
  perform pg_temp.expect(v like 'planned/%/true', 'mk ' || p_n || ' ' || v);
  return split_part(v, '/', 2)::uuid;
end $$;
/** Make exactly this row due and claim it as the dispatcher; returns its lease. */
create function pg_temp.claim(p_rid uuid) returns uuid language plpgsql as $$
declare v text;
begin
  update postona_threads_resv.reservations set scheduled_at = now() - interval '1 second' where id = p_rid;
  v := pg_temp.wk('select string_agg(reservation_id || '' '' || lease_token, '','') from postona_threads_resv.claim_due(''w1'', 60, 50)');
  perform pg_temp.expect(v like p_rid || ' %' and v !~ ',', 'claim exactly ' || p_rid || ': ' || v);
  return split_part(v, ' ', 2)::uuid;
end $$;
create function pg_temp.pre(p_rid uuid, p_lease uuid) returns text language sql as $$
  select pg_temp.wk(format('select verdict || ''/'' || coalesce(credential_generation, '''') from postona_threads_resv.preflight(%L, %L)', p_rid, p_lease)) $$;
create function pg_temp.rec(p_rid uuid, p_lease uuid, p_outcome text, p_id text, p_code text, p_transport text) returns text language sql as $$
  select pg_temp.wk(format('select postona_threads_resv.record(%L, %L, %L, %L, %L, %L)', p_rid, p_lease, p_outcome, p_id, p_code, p_transport)) $$;
create function pg_temp.st(p_rid uuid) returns text language sql as $$
  select status || '/' || coalesce(outcome_code, '-') from postona_threads_resv.reservations where id = p_rid $$;
create function pg_temp.receipt(p_n integer, p_req uuid) returns text language sql as $$
  select pg_temp.api(format('select concat_ws(''/'', state, coalesce(provider_post_id, ''-''), coalesce(outcome_code, ''-''), after_freeze::text, simulated::text) from postona_threads_resv.receipt(%L, %L)',
                            pg_temp.th(p_n), p_req), pg_temp.p(p_n), pg_temp.sess(p_n)) $$;

-- L1: ACL. The person reaches create / cancel / receipt only; the dispatcher claim / preflight / record / release only;
-- internal functions and the table reach nobody; other API roles reach nothing.
select pg_temp.expect(pg_temp.as_person(pg_temp.create_sql(pg_temp.th(61), gen_random_uuid(), 'x'), pg_temp.p(61), pg_temp.sess(61), r) like 'ERR:permission denied%', 'L1 create closed to ' || r)
  from unnest(array['anon', 'authenticated', 'service_role', 'postona_resv_worker']) r;
select pg_temp.expect(pg_temp.api(q, pg_temp.p(61), pg_temp.sess(61)) like 'ERR:permission denied%', 'L1 api closed: ' || q) from unnest(array[
  'select count(*)::text from postona_threads_resv.claim_due(''w1'', 60, 1)',
  format('select verdict from postona_threads_resv.preflight(%L, %L)', gen_random_uuid(), gen_random_uuid()),
  format('select postona_threads_resv.record(%L, %L, ''uncertain'', null, null, ''simulated'')', gen_random_uuid(), gen_random_uuid()),
  format('select postona_threads_resv.threads_credential_generation(%L)', pg_temp.th(61)),
  format('select postona_threads_resv.fence(%L, %L)', pg_temp.p(61), pg_temp.th(61)),
  'select count(*)::text from postona_threads_resv.reservations']) q;
select pg_temp.expect(pg_temp.wk(q) like 'ERR:permission denied%', 'L1 worker closed: ' || q) from unnest(array[
  pg_temp.create_sql(pg_temp.th(61), gen_random_uuid(), 'x'), format('select state from postona_threads_resv.receipt(%L, %L)', pg_temp.th(61), gen_random_uuid()),
  format('select postona_threads_resv.g5_bound_state(%L, 1, 1)', pg_temp.br(61)), format('select postona_threads_resv.parse_owner_epoch_token(%L)', 'g5oe:1:1'),
  'select count(*)::text from postona_threads_resv.reservations']) q;
select 'L1_ACL_PASS' as result;

-- L2: create refuses (nothing recorded): another person's / an X / an unknown account, a second owner, not verified (G4),
-- not identity_verified, publish switch OFF, entitlement ended, account deleting / locked (G5), consent, text, schedule.
select count(*) as l2rows from postona_threads_resv.reservations \gset
create function pg_temp.l2(p_n integer, p_label text, p_change text, p_undo text, p_expect text, p_account text default null, p_text text default 'L2 本文',
  p_in text default '10 minutes', p_sha text default null) returns void language plpgsql as $$
declare v text;
begin
  if p_change is not null then execute format(p_change, pg_temp.th(p_n), pg_temp.p(p_n), pg_temp.br(p_n)); end if;
  v := pg_temp.api(pg_temp.create_sql(coalesce(p_account, pg_temp.th(p_n)), gen_random_uuid(), p_text, p_in, p_sha), pg_temp.p(p_n), pg_temp.sess(p_n));
  if p_undo is not null then execute format(p_undo, pg_temp.th(p_n), pg_temp.p(p_n), pg_temp.br(p_n)); end if;
  perform pg_temp.expect(v = p_expect, 'L2 ' || p_label || ': ' || v);
end $$;
select pg_temp.l2(61, 'other person', null, null, 'ERR:POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND', pg_temp.th(62));
select pg_temp.l2(61, 'X account', null, null, 'ERR:POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND', (select x_account from t_ids.people where n = 61));
select pg_temp.l2(61, 'unknown', null, null, 'ERR:POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND', 'th_nobody');
select pg_temp.l2(61, 'second owner', format('insert into public.brand_memberships (brand_id, user_id, role) values (%%3$L, %L, ''owner'')', pg_temp.p(80)),
  format('delete from public.brand_memberships where brand_id = %%3$L and user_id = %L', pg_temp.p(80)), 'ERR:POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND');
select pg_temp.l2(61, 'G4 not verified', 'delete from t_threads.verified where social_account_id = %1$L', 'insert into t_threads.verified values (%1$L)', 'ERR:POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED');
select pg_temp.l2(61, 'connection failed', 'update public.social_accounts set connection_status = ''failed'' where id = %1$L',
  'update public.social_accounts set connection_status = ''identity_verified'' where id = %1$L', 'ERR:POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED');
select pg_temp.l2(61, 'connection error', 'update public.social_accounts set last_connection_error_code = ''THREADS_TOKEN_INVALID'' where id = %1$L',
  'update public.social_accounts set last_connection_error_code = null where id = %1$L', 'ERR:POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED');
select pg_temp.l2(61, 'switch OFF', 'update public.social_accounts set publish_enabled = false where id = %1$L',
  'update public.social_accounts set publish_enabled = true where id = %1$L', 'ERR:POSTONA_THREADS_RESV_PUBLISH_DISABLED');
select pg_temp.l2(61, 'entitlement ended', 'update public.service_entitlements set status = ''ended'', ended_at = now() where user_id = %2$L and service_key = ''x_autopost''',
  'update public.service_entitlements set status = ''active'', ended_at = null where user_id = %2$L and service_key = ''x_autopost''', 'ERR:POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE');
select pg_temp.l2(61, 'deleting', 'update public.common_accounts set status = ''deleting'' where user_id = %2$L',
  'update public.common_accounts set status = ''active'' where user_id = %2$L', 'ERR:POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE');
select pg_temp.l2(61, 'locked', 'update public.common_accounts set status = ''locked'' where user_id = %2$L',
  'update public.common_accounts set status = ''active'' where user_id = %2$L', 'ERR:POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE');
select pg_temp.l2(61, 'consent', null, null, 'ERR:POSTONA_THREADS_RESV_CONSENT_REQUIRED', null, 'L2 本文', '10 minutes', repeat('a', 64));
select pg_temp.l2(61, 'too long', null, null, 'ERR:POSTONA_THREADS_RESV_TEXT_INVALID', null, repeat('あ', 501));
select pg_temp.l2(61, 'control char', null, null, 'ERR:POSTONA_THREADS_RESV_TEXT_INVALID', null, 'bell' || chr(7));
select pg_temp.l2(61, 'blank', null, null, 'ERR:POSTONA_THREADS_RESV_TEXT_INVALID', null, '   ');
select pg_temp.l2(61, 'past', null, null, 'ERR:POSTONA_THREADS_RESV_SCHEDULE_INVALID', null, 'L2 本文', '-1 minute');
select pg_temp.l2(61, 'too far', null, null, 'ERR:POSTONA_THREADS_RESV_SCHEDULE_INVALID', null, 'L2 本文', '61 days');
select pg_temp.expect((select count(*) from postona_threads_resv.reservations) = :'l2rows', 'L2 nothing recorded');
select 'L2_CREATE_REFUSALS_PASS' as result;

-- L3: idempotent per (person, account, client_request_id); the same id with another text / time is a conflict; the
-- same id of another person is independent; a 500-character text is accepted.
select gen_random_uuid() as req3, now() + interval '2 hours' as at3 \gset
select pg_temp.api(pg_temp.create_at(pg_temp.th(63), :'req3', 'L3 本文', :'at3'), pg_temp.p(63), pg_temp.sess(63)) as c3 \gset
select pg_temp.expect(:'c3' like 'planned/%/true', 'L3 created ' || :'c3');
select pg_temp.expect((select r.created::text from (select 1) x, lateral (select split_part(pg_temp.api(pg_temp.create_at(pg_temp.th(63), :'req3', 'L3 本文', :'at3'), pg_temp.p(63), pg_temp.sess(63)), '/', 3) as created) r) = 'false', 'L3 repeat');
select pg_temp.expect(pg_temp.api(pg_temp.create_at(pg_temp.th(63), :'req3', 'L3 本文', (:'at3'::timestamptz + interval '1 minute')), pg_temp.p(63), pg_temp.sess(63)) = 'ERR:POSTONA_THREADS_RESV_IDEMPOTENCY_CONFLICT', 'L3 same id, other time');
select pg_temp.expect(pg_temp.api(pg_temp.create_at(pg_temp.th(63), :'req3', 'L3 別の本文', :'at3'), pg_temp.p(63), pg_temp.sess(63)) = 'ERR:POSTONA_THREADS_RESV_IDEMPOTENCY_CONFLICT', 'L3 conflict');
select pg_temp.expect(pg_temp.api(pg_temp.create_at(pg_temp.th(64), :'req3', 'L3 本文', :'at3'), pg_temp.p(64), pg_temp.sess(64)) like 'planned/%/true', 'L3 another person, same id');
select pg_temp.expect(pg_temp.api(pg_temp.create_sql(pg_temp.th(64), gen_random_uuid(), repeat('あ', 500)), pg_temp.p(64), pg_temp.sess(64)) like 'planned/%/true', 'L3 500 chars');
select pg_temp.expect((select count(*) from postona_threads_resv.reservations where client_request_id = :'req3') = 2, 'L3 two rows');
select pg_temp.expect(pg_temp.receipt(63, :'req3') = 'pending/-/-/false/true', 'L3 receipt of a planned row: pending, never a real post');
select 'L3_IDEMPOTENCY_PASS' as result;

-- L4: claim -> preflight OK with the bound generation -> record published (simulated) -> receipt (text-free); replay is
-- idempotent; a finished row is never claimed again; X rows are never claimed by the Threads dispatcher.
select pg_temp.mk(65, 'L4 本文') as r4 \gset
select pg_temp.claim(:'r4') as l4 \gset
select pg_temp.expect((select bound_generation from postona_threads_resv.reservations where id = :'r4') = postona_threads_resv.threads_credential_generation(pg_temp.th(65)), 'L4 bound');
select pg_temp.expect(pg_temp.pre(:'r4', :'l4') = 'OK/' || postona_threads_resv.threads_credential_generation(pg_temp.th(65)), 'L4 preflight');
select pg_temp.expect(pg_temp.pre(:'r4', gen_random_uuid()) = 'LEASE_LOST/', 'L4 another lease');
select pg_temp.expect(pg_temp.rec(:'r4', gen_random_uuid(), 'published', '18000000000000065', null, 'simulated') = 'ERR:POSTONA_THREADS_RESV_LEASE_LOST', 'L4 record with another lease');
select pg_temp.expect(pg_temp.st(:'r4') = 'claimed/-', 'L4 still claimed');
select pg_temp.expect(pg_temp.rec(:'r4', :'l4', 'published', '18000000000000065', null, 'simulated') = 'published', 'L4 record');
select pg_temp.expect(pg_temp.rec(:'r4', :'l4', 'published', '18000000000000065', null, 'threads') = 'published', 'L4 identical replay');
select pg_temp.expect((select transport from postona_threads_resv.reservations where id = :'r4') = 'simulated', 'L4 replay changes nothing');
select pg_temp.expect(pg_temp.rec(:'r4', :'l4', 'published', '18000000000000066', null, 'simulated') = 'ERR:POSTONA_THREADS_RESV_LEASE_LOST', 'L4 different replay refused');
select pg_temp.expect(pg_temp.receipt(65, (select client_request_id from postona_threads_resv.reservations where id = :'r4')) = 'sent/18000000000000065/PUBLISHED/false/true', 'L4 receipt');
select pg_temp.expect((select array_agg(a.attname::text order by a.attnum) from pg_proc p, unnest(p.proargnames) with ordinality a(attname, attnum)
  where p.oid = 'postona_threads_resv.receipt(text,uuid)'::regprocedure and a.attnum > 2) = array['reservation_id', 'state', 'provider_post_id', 'outcome_code', 'after_freeze', 'simulated'], 'L4 receipt has no text');
select pg_temp.expect(pg_temp.wk('select count(*)::text from postona_threads_resv.claim_due(''w1'', 60, 50)') = '0', 'L4 nothing to claim');
select pg_temp.expect(not exists (select 1 from postona_threads_resv.reservations r join public.social_accounts sa on sa.id = r.social_account_id where sa.platform <> 'threads'), 'L4 Threads rows only');
select 'L4_CLAIM_PREFLIGHT_RECORD_RECEIPT_PASS' as result;

-- L5: a change after the claim, before the send: refused at the preflight (never sent).
create function pg_temp.l5(p_n integer, p_label text, p_change text, p_undo text, p_expect text) returns void language plpgsql as $$
declare v_rid uuid := pg_temp.mk(p_n, 'L5 ' || p_label); v_lease uuid; v text;
begin
  v_lease := pg_temp.claim(v_rid);
  execute format(p_change, pg_temp.th(p_n), pg_temp.p(p_n), pg_temp.br(p_n), v_rid);
  v := split_part(pg_temp.pre(v_rid, v_lease), '/', 1) || ' ' || pg_temp.st(v_rid);
  if p_undo is not null then execute format(p_undo, pg_temp.th(p_n), pg_temp.p(p_n), pg_temp.br(p_n), v_rid); end if;
  update postona_threads_resv.reservations set status = 'cancelled' where id = v_rid and status = 'planned';  -- keep the due set empty
  perform pg_temp.expect(v = p_expect, 'L5 ' || p_label || ': ' || v);
end $$;
select pg_temp.l5(66, 'second owner', format('insert into public.brand_memberships (brand_id, user_id, role) values (%%3$L, %L, ''owner'')', pg_temp.p(80)),
  format('delete from public.brand_memberships where brand_id = %%3$L and user_id = %L', pg_temp.p(80)), 'NOT_PUBLISHABLE failed/NOT_PUBLISHABLE_AT_SEND');
select pg_temp.l5(66, 'G4 verification removed', 'delete from t_threads.verified where social_account_id = %1$L', 'insert into t_threads.verified values (%1$L)', 'NOT_PUBLISHABLE failed/NOT_PUBLISHABLE_AT_SEND');
select pg_temp.l5(66, 'switch OFF', 'update public.social_accounts set publish_enabled = false where id = %1$L',
  'update public.social_accounts set publish_enabled = true where id = %1$L', 'NOT_PUBLISHABLE failed/NOT_PUBLISHABLE_AT_SEND');
select pg_temp.l5(66, 'disconnected', 'update public.social_accounts set connection_status = ''unconnected'' where id = %1$L',
  'update public.social_accounts set connection_status = ''identity_verified'' where id = %1$L', 'NOT_PUBLISHABLE failed/NOT_PUBLISHABLE_AT_SEND');
select pg_temp.l5(66, 'entitlement ended', 'update public.service_entitlements set status = ''ended'', ended_at = now() where user_id = %2$L and service_key = ''x_autopost''',
  'update public.service_entitlements set status = ''active'', ended_at = null where user_id = %2$L and service_key = ''x_autopost''', 'NOT_PUBLISHABLE failed/SERVICE_NOT_ACTIVE');
select pg_temp.l5(66, 'deleting', 'update public.common_accounts set status = ''deleting'' where user_id = %2$L',
  'update public.common_accounts set status = ''active'' where user_id = %2$L', 'NOT_PUBLISHABLE failed/ACCOUNT_DELETION_IN_PROGRESS');
select pg_temp.l5(67, 'credential rotated (custody)', 'update public.threads_account_credential_custody set vault_secret_id = gen_random_uuid(), recorded_at = now() where social_account_id = %1$L',
  null, 'NOT_PUBLISHABLE failed/CREDENTIAL_CHANGED');
select pg_temp.l5(67, 'Threads user changed', 'update public.social_accounts set platform_user_id = platform_user_id || ''0'' where id = %1$L',
  'update public.social_accounts set platform_user_id = left(platform_user_id, -1) where id = %1$L', 'NOT_PUBLISHABLE failed/CREDENTIAL_CHANGED');
select pg_temp.l5(67, 'access reference changed', 'update public.social_accounts set vault_access_token_secret_id = gen_random_uuid() where id = %1$L', null,
  'NOT_PUBLISHABLE failed/CREDENTIAL_CHANGED');
select pg_temp.l5(67, 'account row written', 'update public.social_accounts set updated_at = updated_at + interval ''1 second'' where id = %1$L', null,
  'NOT_PUBLISHABLE failed/CREDENTIAL_CHANGED');
select pg_temp.l5(68, 'refresh in progress', 'insert into public.threads_credential_refresh_leases values (%1$L, gen_random_uuid(), gen_random_uuid(), clock_timestamp() + interval ''30 seconds'')',
  'delete from public.threads_credential_refresh_leases where social_account_id = %1$L', 'RELEASED planned/-');
select pg_temp.l5(68, 'lease ran out', 'update postona_threads_resv.reservations set lease_expires_at = clock_timestamp() - interval ''1 second'' where id = %4$L', null,
  'RELEASED planned/-');
select 'L5_CHANGE_AFTER_CLAIM_REFUSED_PASS' as result;

-- L6: record: shapes refused; after_freeze when the service stopped while the post was in flight; an expired lease is
-- fenced to uncertain ('lease_lost'); uncertain / failed rows are never claimed again; the sweep fences expired claims.
select pg_temp.mk(69, 'L6 本文') as r6 \gset
select pg_temp.claim(:'r6') as l6 \gset
select pg_temp.expect(pg_temp.rec(:'r6', :'l6', o, i, null, t) = 'ERR:POSTONA_THREADS_RESV_REQUEST_INVALID', 'L6 invalid ' || o || coalesce(i, '-') || coalesce(t, '-'))
  from (values ('published', null, 'simulated'), ('uncertain', '18000000000000001', 'simulated'), ('published', '0123', 'simulated'),
               ('published', '18000000000000001', null), ('published', '18000000000000001', 'x'), ('sent', '18000000000000001', 'simulated')) v(o, i, t);
select pg_temp.expect(pg_temp.pre(:'r6', :'l6') like 'OK/%', 'L6 preflight');
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = pg_temp.p(69) and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.rec(:'r6', :'l6', 'published', '18000000000000069', null, 'threads') = 'published', 'L6 in-flight post recorded as it happened');
update public.service_entitlements set status = 'active', ended_at = null where user_id = pg_temp.p(69) and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.receipt(69, (select client_request_id from postona_threads_resv.reservations where id = :'r6')) = 'sent/18000000000000069/PUBLISHED/true/false', 'L6 after_freeze, real transport');
select pg_temp.mk(70, 'L6 期限切れ') as r6b \gset
select pg_temp.claim(:'r6b') as l6b \gset
update postona_threads_resv.reservations set lease_expires_at = clock_timestamp() - interval '1 second' where id = :'r6b';
select pg_temp.expect(pg_temp.rec(:'r6b', :'l6b', 'published', '18000000000000070', null, 'simulated') = 'lease_lost', 'L6 late record');
select pg_temp.expect(pg_temp.st(:'r6b') = 'uncertain/LEASE_EXPIRED_AT_FINISH', 'L6 fenced to uncertain');
select pg_temp.mk(70, 'L6 不明') as r6c \gset
select pg_temp.claim(:'r6c') as l6c \gset
select pg_temp.expect(pg_temp.rec(:'r6c', :'l6c', 'uncertain', null, 'THREADS_UNAVAILABLE', 'simulated') = 'uncertain', 'L6 uncertain');
select pg_temp.mk(70, 'L6 掃除') as r6d \gset
select pg_temp.claim(:'r6d') as l6d \gset
update postona_threads_resv.reservations set lease_expires_at = clock_timestamp() - interval '1 second' where id = :'r6d';
select pg_temp.expect(pg_temp.wk('select count(*)::text from postona_threads_resv.claim_due(''w1'', 60, 50)') = '0', 'L6 sweep claims nothing');
select pg_temp.expect(pg_temp.st(:'r6d') = 'uncertain/LEASE_EXPIRED', 'L6 swept to uncertain');
select pg_temp.expect(pg_temp.receipt(70, (select client_request_id from postona_threads_resv.reservations where id = :'r6c')) = 'uncertain/-/THREADS_UNAVAILABLE/false/true', 'L6 receipt uncertain');
update postona_threads_resv.reservations set scheduled_at = now() - interval '1 second' where id in (:'r6b', :'r6c', :'r6d');
select pg_temp.expect(pg_temp.wk('select count(*)::text from postona_threads_resv.claim_due(''w1'', 60, 50)') = '0', 'L6 uncertain never claimed again');
select 'L6_RECORD_AFTER_FREEZE_UNCERTAIN_PASS' as result;

-- L7: release hands back an unsent claim only with its own lease; cancel only a planned row of the person; receipt of
-- another person / unknown id is the same NOT_FOUND.
select pg_temp.mk(71, 'L7 本文') as r7 \gset
select pg_temp.claim(:'r7') as l7 \gset
select pg_temp.expect(pg_temp.wk(format('select postona_threads_resv.release_unsent(%L, %L)', :'r7', gen_random_uuid())) = 'lease_lost', 'L7 other lease');
select pg_temp.expect(pg_temp.wk(format('select postona_threads_resv.release_unsent(%L, %L)', :'r7', :'l7')) = 'released', 'L7 released');
select pg_temp.expect(pg_temp.api(format('select postona_threads_resv.cancel_reservation(%L)', :'r7'), pg_temp.p(72), pg_temp.sess(72)) = 'ERR:POSTONA_THREADS_RESV_NOT_FOUND', 'L7 other person cannot cancel');
select pg_temp.expect(pg_temp.api(format('select postona_threads_resv.cancel_reservation(%L)', :'r7'), pg_temp.p(71), pg_temp.sess(71)) = 'cancelled', 'L7 cancelled');
select pg_temp.expect(pg_temp.api(format('select postona_threads_resv.cancel_reservation(%L)', :'r4'), pg_temp.p(65), pg_temp.sess(65)) = 'ERR:POSTONA_THREADS_RESV_NOT_CANCELLABLE', 'L7 published not cancellable');
-- G3-33 T5: exactly one audit row for the cancel (codes only), none for the refused attempts; no role reaches the audit table.
select pg_temp.expect((select count(*) from postona_threads_resv.audit where reservation_id = :'r7') = 1
  and (select bool_and(action = 'cancel' and user_id = pg_temp.p(71) and detail = '{"from_status": "planned"}'::jsonb)
       from postona_threads_resv.audit where reservation_id = :'r7'), 'T5 one cancel audit row, codes only');
select pg_temp.expect(not exists (select 1 from postona_threads_resv.audit where reservation_id = :'r4'), 'T5 a refused cancel writes no audit row');
select pg_temp.expect(not exists (select 1 from postona_threads_resv.audit a, postona_threads_resv.reservations r
  where r.id = a.reservation_id and (a.detail::text like '%' || r.body || '%' or a.detail::text like '%' || r.content_sha256 || '%')), 'T5 no text or hash in the audit');
select pg_temp.expect(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'postona_resv_api', 'postona_resv_worker']) r(role)
  where pg_catalog.has_table_privilege(r.role, 'postona_threads_resv.audit', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')), 'T5 audit table unreachable');
select pg_temp.expect(pg_temp.api(format('select state from postona_threads_resv.receipt(%L, %L)', pg_temp.th(71), (select client_request_id from postona_threads_resv.reservations where id = :'r7')),
  pg_temp.p(72), pg_temp.sess(72)) = 'ERR:POSTONA_THREADS_RESV_NOT_FOUND', 'L7 other person receipt');
select pg_temp.expect(pg_temp.api(format('select state from postona_threads_resv.receipt(%L, %L)', pg_temp.th(71), gen_random_uuid()), pg_temp.p(71), pg_temp.sess(71))
  = 'ERR:POSTONA_THREADS_RESV_NOT_FOUND', 'L7 unknown id');
select pg_temp.expect(pg_temp.api(format('select state from postona_threads_resv.receipt(%L, %L)', pg_temp.th(71), (select client_request_id from postona_threads_resv.reservations where id = :'r7')),
  null, null) = 'ERR:POSTONA_RESV_AUTH_REQUIRED', 'L7 no caller');
select 'L7_RELEASE_CANCEL_RECEIPT_PASS' as result;

-- L8: defence in depth -- should F5's brand owner ever ignore the workspace profile, 007's own profile check still
-- refuses. TEST-ONLY stand-in of F5's function inside a rolled-back transaction; F5's function is unchanged afterwards.
select md5(prosrc) as l8src from pg_proc where oid = 'private.account_lifecycle_brand_owner(text)'::regprocedure \gset
begin;
create or replace function private.account_lifecycle_brand_owner(p_brand_id text) returns uuid language sql stable security definer set search_path = '' as $$
  select m.user_id from public.brand_memberships m where m.brand_id = p_brand_id and m.role = 'owner' limit 1 $$;
update public.brands set code_profile_key = 'other_profile' where id = pg_temp.br(73);
select pg_temp.expect(pg_temp.api(pg_temp.create_sql(pg_temp.th(73), gen_random_uuid(), 'L8'), pg_temp.p(73), pg_temp.sess(73)) = 'ERR:POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND', 'L8 profile check');
rollback;
select pg_temp.expect((select md5(prosrc) from pg_proc where oid = 'private.account_lifecycle_brand_owner(text)'::regprocedure) = :'l8src', 'L8 F5 restored');
select 'L8_PROFILE_DEFENCE_IN_DEPTH_PASS' as result;


-- L9: G5's service generation (owner_epoch, lifecycle_version) -- bound at create from R1's allow token, compared with W1 at the claim and right
-- before the send; no timestamp is compared. People 74-79.
create function pg_temp.pair(p_rid uuid) returns text language sql as $$
  select bound_owner_epoch || ':' || bound_lifecycle_version from postona_threads_resv.reservations where id = p_rid $$;
create function pg_temp.claim_answer(p_rid uuid) returns text language plpgsql as $$
declare v text;
begin
  update postona_threads_resv.reservations set scheduled_at = now() - interval '1 second' where id = p_rid;
  v := pg_temp.wk('select coalesce(string_agg(reservation_id::text, '',''), '''') from postona_threads_resv.claim_due(''w1'', 60, 50)');
  update postona_threads_resv.reservations set status = 'cancelled', lease_token = null, lease_expires_at = null where id = p_rid and status = 'claimed';
  return (case when v = p_rid::text then 'claimed' when v = '' then 'not claimed' else 'other:' || v end) || ' ' || pg_temp.st(p_rid);
end $$;
-- a: the stored pair is R1's token for this person and workspace
select pg_temp.mk(74, 'L9 a') as r9a \gset
select pg_temp.expect(pg_temp.pair(:'r9a') = (select e.v from t_g5.owner_epoch e where e.brand_id = pg_temp.br(74)) || ':' || (select l.v from t_g5.lifecycle l where l.user_id = pg_temp.p(74)), 'L9a pair');
select pg_temp.expect(pg_temp.claim_answer(:'r9a') = 'claimed cancelled/-', 'L9a unchanged -> claimed');
-- b: service ended and restarted after the reservation (A -> B -> A of the service) -> never claimed
select pg_temp.mk(74, 'L9 b') as r9b \gset
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = pg_temp.p(74) and service_key = 'x_autopost';
update public.service_entitlements set status = 'active', ended_at = null where user_id = pg_temp.p(74) and service_key = 'x_autopost';
select pg_temp.expect(public.common_account_brand_service_state(pg_temp.br(74), 'x_autopost') = 'active', 'L9b the service is active again');
select pg_temp.expect(pg_temp.claim_answer(:'r9b') = 'not claimed failed/SERVICE_GENERATION_CHANGED', 'L9b restart -> ' || pg_temp.claim_answer(:'r9b'));
-- c: stopped and restarted INSIDE ONE transaction (the old activated_at / now() design let this through)
select pg_temp.mk(75, 'L9 c') as r9c \gset
begin;
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = pg_temp.p(75) and service_key = 'x_autopost';
update public.service_entitlements set status = 'active', ended_at = null where user_id = pg_temp.p(75) and service_key = 'x_autopost';
commit;
select pg_temp.expect(pg_temp.claim_answer(:'r9c') = 'not claimed failed/SERVICE_GENERATION_CHANGED', 'L9c same-transaction restart');
-- d: a stop that was rolled back changes nothing
select pg_temp.mk(75, 'L9 d') as r9d \gset
begin;
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = pg_temp.p(75) and service_key = 'x_autopost';
rollback;
select pg_temp.expect(pg_temp.claim_answer(:'r9d') = 'claimed cancelled/-', 'L9d rolled-back stop -> still claimable');
-- e: owner A -> B -> A -> a new owner epoch
select pg_temp.mk(76, 'L9 e') as r9e \gset
insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.br(76), pg_temp.p(79), 'owner');
delete from public.brand_memberships where brand_id = pg_temp.br(76) and user_id = pg_temp.p(79);
select pg_temp.expect(pg_temp.claim_answer(:'r9e') = 'not claimed failed/OWNER_EPOCH_CHANGED', 'L9e owner A->B->A');
-- f: an UNRELATED service change of the owner (Kabumori started) also moves the generation: the earlier reservation is refused (UX debt)
select pg_temp.mk(77, 'L9 f') as r9f \gset
insert into public.service_entitlements (user_id, service_key, status, source, activated_at) values (pg_temp.p(77), 'kabumori', 'active', 'self_service', now())
on conflict (user_id, service_key) do update set updated_at = now();
select pg_temp.expect(pg_temp.claim_answer(:'r9f') = 'not claimed failed/SERVICE_GENERATION_CHANGED', 'L9f unrelated service change');
-- g: a restart after the claim, before the send -> the preflight (and so the pre-publish hook) refuses
select pg_temp.mk(78, 'L9 g') as r9g \gset
select pg_temp.claim(:'r9g') as l9g \gset
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = pg_temp.p(78) and service_key = 'x_autopost';
update public.service_entitlements set status = 'active', ended_at = null where user_id = pg_temp.p(78) and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.pre(:'r9g', :'l9g') || ' ' || pg_temp.st(:'r9g') = 'NOT_PUBLISHABLE/ failed/SERVICE_GENERATION_CHANGED', 'L9g restart after the claim');
-- h: a row written before this rule (no bound pair) is never claimed
insert into postona_threads_resv.reservations (user_id, brand_id, social_account_id, client_request_id, body, content_sha256, scheduled_at)
select user_id, brand, threads_account, gen_random_uuid(), 'L9 legacy', encode(sha256(convert_to('L9 legacy', 'UTF8')), 'hex'), now() + interval '1 hour'
from t_ids.people where n = 78 returning id as r9h \gset
select pg_temp.expect(pg_temp.claim_answer(:'r9h') = 'not claimed failed/EXPECTED_OWNER_EPOCH_REQUIRED', 'L9h legacy row');
-- i: R1 answers allow with a malformed / out-of-range token, or another decision with a token: nothing is bound (TEST-ONLY stand-in of R1
--    inside rolled-back transactions)
create function pg_temp.with_r1(p_body text) returns text language plpgsql as $fn$
declare v text;
begin
  execute format('create or replace function public.common_account_authorization_verdict(p_app text, p_feature text, p_brand_id text) '
    || 'returns jsonb language sql stable security definer set search_path = '''' as %L', 'select ' || p_body);
  v := pg_temp.api(pg_temp.create_sql(pg_temp.th(79), gen_random_uuid(), 'L9 token'), pg_temp.p(79), pg_temp.sess(79));
  return v;
end $fn$;
select md5(prosrc) as r1src from pg_proc where oid = 'public.common_account_authorization_verdict(text,text,text)'::regprocedure \gset
select count(*) as l9rows from postona_threads_resv.reservations \gset
begin;
select pg_temp.expect(pg_temp.with_r1(format('pg_catalog.jsonb_build_object(%L, %L, %L, %L)', 'decision', 'allow', 'owner_epoch', tok)) = 'ERR:POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE', 'L9i token ' || tok)
  from unnest(array['g5oe:0:1', 'g5oe:1:0', 'g5oe:01:1', 'g5oe:1:01', 'g5oe:1:1:1', 'g5oe:1', 'g5oe:9223372036854775808:1', 'g5oe:1:9223372036854775808',
                    'g5oe:1:-1', 'g5oe: 1:1', 'G5OE:1:1', 'x', '', 'g5oe:1:1 ']) tok;
select pg_temp.expect(pg_temp.with_r1($q$pg_catalog.jsonb_build_object('decision', 'allow')$q$) = 'ERR:POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE', 'L9i allow without token');
select pg_temp.expect(pg_temp.with_r1($q$pg_catalog.jsonb_build_object('decision', 'unknown', 'owner_epoch', 'g5oe:1:1')$q$) = 'ERR:POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE', 'L9i unknown with token');
select pg_temp.expect(pg_temp.with_r1($q$null::jsonb$q$) = 'ERR:POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE', 'L9i no answer');
select pg_temp.expect(pg_temp.with_r1($q$pg_catalog.jsonb_build_object('decision', 'allow', 'owner_epoch', 'g5oe:9223372036854775807:9223372036854775807')$q$) like 'planned/%/true', 'L9i bigint max is accepted');
rollback;
select pg_temp.expect((select md5(prosrc) from pg_proc where oid = 'public.common_account_authorization_verdict(text,text,text)'::regprocedure) = :'r1src', 'L9i R1 double restored');
select pg_temp.expect((select count(*) from postona_threads_resv.reservations) = :'l9rows', 'L9i nothing recorded');
-- j: a freeze between the preflight and the record -> after_freeze from W1 (generation moved)
select pg_temp.mk(79, 'L9 j') as r9j \gset
select pg_temp.claim(:'r9j') as l9j \gset
select pg_temp.expect(pg_temp.pre(:'r9j', :'l9j') like 'OK/%', 'L9j preflight');
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = pg_temp.p(79) and service_key = 'x_autopost';
update public.service_entitlements set status = 'active', ended_at = null where user_id = pg_temp.p(79) and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.rec(:'r9j', :'l9j', 'published', '18000000000000079', null, 'simulated') = 'published', 'L9j recorded as it happened');
select pg_temp.expect((select after_freeze from postona_threads_resv.reservations where id = :'r9j'), 'L9j after_freeze');
select 'L9_SERVICE_GENERATION_ABA_PASS' as result;

select 'POSTONA_THREADS_RESV_BEHAVIOR_PASS' as result;
