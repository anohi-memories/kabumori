-- G3-43 (TEST ONLY, fake data): the person's own cancel without the service gate and the lease-expired audit (010), in the personal MVP
-- world with 008 (personal_mvp_run.sh, phase EC). Two new people, C = uid(8) and E = uid(9), set up as live_rows.sql does. Every state
-- comes from the real paths (API create / cancel / single post, worker claim / finish, claim_due's sweep, G5's service end / restart); only
-- the clock and the fake "verified X account" columns are moved. C's c9 stays planned for the runner's 010 rollback check.
\ir helpers.sql

create schema t43;
create table t43.ids (name text primary key, id uuid);
create function pg_temp.keep(p_name text, p_id uuid) returns uuid language sql as $$ insert into t43.ids values (p_name, p_id) returning id $$;
create function pg_temp.id(p_name text) returns uuid language sql stable as $$ select id from t43.ids where name = p_name $$;
create function pg_temp.rev(p_name text) returns integer language sql stable as $$ select revision from postona_x_resv.reservations where id = pg_temp.id(p_name) $$;
-- the person's cancel through the API role: status@revision, or ERR:<code>
create function pg_temp.cancel(p_name text, p_sub uuid, p_rev text default null) returns text language sql as $$
  select pg_temp.api(format('select status || ''@'' || revision from postona_x_resv.cancel(%L, %s)', pg_temp.id(p_name), coalesce(p_rev, pg_temp.rev(p_name)::text)), p_sub) $$;
create function pg_temp.audits(p_name text, p_action text) returns bigint language sql stable as $$
  select count(*) from postona_x_resv.audit a where a.reservation_id = pg_temp.id(p_name) and a.action = p_action $$;
create function pg_temp.snap() returns text language sql stable as $$
  select md5(coalesce(string_agg(concat_ws('/', id, status, revision, outcome_code, lease_token, updated_at), ',' order by id), '')) || ':'
         || (select count(*) from postona_x_resv.audit) from postona_x_resv.reservations $$;

select public.fixture_user_with_workspace(u, 's43' || right(u::text, 2)), public.fixture_login(u) from unnest(array[pg_temp.uid(8), pg_temp.uid(9)]) u;
insert into auth.sessions (user_id, not_after) select u, null from unnest(array[pg_temp.uid(8), pg_temp.uid(9)]) u;
select pg_temp.expect(pg_temp.as_role('select public.start_x_autopost_service() ->> ''status''', 'authenticated', u) = 'active', 'setup: start ' || u)
from unnest(array[pg_temp.uid(8), pg_temp.uid(9)]) u;
update public.brands set code_profile_key = 'social_mobile_user_v1' where id in (pg_temp.ws(pg_temp.uid(8)), pg_temp.ws(pg_temp.uid(9)));
update public.social_accounts set platform = 'x', connection_status = 'identity_verified', verified_at = now(), last_connection_error_code = null,
  platform_user_id = 'fake-x-' || right(brand_id, 6), vault_access_token_secret_id = gen_random_uuid(), vault_refresh_token_secret_id = gen_random_uuid(),
  publish_enabled = true
where brand_id in (pg_temp.ws(pg_temp.uid(8)), pg_temp.ws(pg_temp.uid(9)));
select pg_temp.expect(postona_x_resv.g4_x_account_verified(u, pg_temp.acct(u)), 'setup: fake verified X ' || u) from unnest(array[pg_temp.uid(8), pg_temp.uid(9)]) u;
select pg_temp.expect((select prosrc ~ 'G3_OWNER_CANCEL' from pg_proc where oid = 'postona_x_resv.cancel(uuid,integer)'::regprocedure), 'setup: 010 applied');

select pg_temp.keep(t.name, pg_temp.reserve(t.u, 'g43' || t.name, t.h)) is not null
from (values ('c1', pg_temp.uid(8), 300), ('c2', pg_temp.uid(8), 310), ('c3', pg_temp.uid(8), 320), ('c4', pg_temp.uid(8), 330), ('c9', pg_temp.uid(8), 340),
             ('e1', pg_temp.uid(9), 300), ('e2', pg_temp.uid(9), 310)) t(name, u, h);

-- EC1 another person's row, an unknown id: the same NOT_FOUND, nothing written
select pg_temp.snap() as s0 \gset
select pg_temp.expect(pg_temp.cancel('c1', pg_temp.uid(9)) = 'ERR:POSTONA_RESV_NOT_FOUND', 'EC1 E cannot cancel C''s row');
select pg_temp.expect(pg_temp.api(format('select status from postona_x_resv.cancel(%L, 1)', gen_random_uuid()), pg_temp.uid(8)) = 'ERR:POSTONA_RESV_NOT_FOUND', 'EC1 unknown id');
-- EC2 no person session: no subject, an ended session (G5 S2-2)
select pg_temp.expect(pg_temp.cancel('c1', null) = 'ERR:POSTONA_RESV_AUTH_REQUIRED', 'EC2 no subject');
update auth.sessions set not_after = now() - interval '1 second' where user_id = pg_temp.uid(8);
select pg_temp.expect(pg_temp.cancel('c1', pg_temp.uid(8)) = 'ERR:POSTONA_RESV_AUTH_REQUIRED', 'EC2 ended session ' || pg_temp.cancel('c1', pg_temp.uid(8)));
update auth.sessions set not_after = null where user_id = pg_temp.uid(8);
-- EC3 a stale or missing revision
select pg_temp.expect(pg_temp.cancel('c1', pg_temp.uid(8), '7') = 'ERR:POSTONA_RESV_STALE_REVISION', 'EC3 stale revision');
select pg_temp.expect(pg_temp.cancel('c1', pg_temp.uid(8), 'null::integer') = 'ERR:POSTONA_RESV_STALE_REVISION', 'EC3 null revision');
select pg_temp.expect(pg_temp.snap() = :'s0', 'EC1-EC3 nothing written');

-- EC4 C's X account is no longer verified (fake G4 columns off): create and reschedule stay refused; C cancels c1
update public.social_accounts set connection_status = 'failed', last_connection_error_code = 'TEST_REVOKED' where brand_id = pg_temp.ws(pg_temp.uid(8));
select pg_temp.expect(pg_temp.create_raw(pg_temp.uid(8), 'g43c5', 350) = 'ERR:POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED', 'EC4 create refused ' || pg_temp.create_raw(pg_temp.uid(8), 'g43c5', 350));
select pg_temp.expect(pg_temp.api(format('select status from postona_x_resv.reschedule(%L, %s, %L)', pg_temp.id('c1'), pg_temp.rev('c1'), now() + interval '301 hours'), pg_temp.uid(8))
  = 'ERR:POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED', 'EC4 reschedule refused');
select pg_temp.expect(pg_temp.cancel('c1', pg_temp.uid(8)) = 'cancelled@2', 'EC4 cancelled');
select pg_temp.expect((select a.detail = '{"gate": "owner_only", "from_revision": 1}'::jsonb and a.user_id = pg_temp.uid(8) from postona_x_resv.audit a
                       where a.reservation_id = pg_temp.id('c1') and a.action = 'cancel'), 'EC4 one cancel audit row');
select pg_temp.expect(pg_temp.cancel('c1', pg_temp.uid(8)) = 'ERR:POSTONA_RESV_ALREADY_FINAL', 'EC4 twice: final');
update public.social_accounts set connection_status = 'identity_verified', last_connection_error_code = null where brand_id = pg_temp.ws(pg_temp.uid(8));

-- EC5 a claimed row is too late; EC6 a lease that ran out: claim_due fences it to uncertain with ONE audit row (worker, lease end; no text),
-- and E's due row is claimed in the same round (another person is not stopped)
select pg_temp.make_due(pg_temp.id(n)) from unnest(array['c3', 'c4']) n;
select pg_temp.claim() as cl \gset
select pg_temp.expect(:'cl' like '%' || pg_temp.id('c3') || '=%' and :'cl' like '%' || pg_temp.id('c4') || '=%', 'EC5 c3 / c4 claimed');
select pg_temp.expect(pg_temp.cancel('c3', pg_temp.uid(8)) = 'ERR:POSTONA_RESV_CANCEL_TOO_LATE', 'EC5 claimed: too late');
update postona_x_resv.reservations set lease_expires_at = now() - interval '1 second' where id = pg_temp.id('c4');
select pg_temp.make_due(pg_temp.id('e1'));
select pg_temp.claim() as cl \gset
select pg_temp.expect(:'cl' like '%' || pg_temp.id('e1') || '=%', 'EC6 E claimed in the same round');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('c4')) = 'uncertain/LEASE_EXPIRED', 'EC6 c4 uncertain');
select pg_temp.expect((select count(*) = 1 and bool_and(a.user_id = pg_temp.uid(8)) and bool_and(a.detail ->> 'worker' = 'w39')
                              and bool_and((select array_agg(k order by k) from jsonb_object_keys(a.detail) k) = array['lease_expires_at', 'worker'])
                              and bool_and(a.detail::text !~ '本文')
                       from postona_x_resv.audit a where a.reservation_id = pg_temp.id('c4') and a.action = 'lease_expired_uncertain'), 'EC6 one audit row, codes only');
select pg_temp.expect(pg_temp.audits('c3', 'lease_expired_uncertain') = 0 and pg_temp.audits('e1', 'lease_expired_uncertain') = 0, 'EC6 no audit for a live lease');
select pg_temp.expect(pg_temp.cancel('c4', pg_temp.uid(8)) = 'ERR:POSTONA_RESV_ALREADY_FINAL', 'EC6 uncertain: final (never re-sent)');
select pg_temp.claim() as cl \gset
select pg_temp.expect(pg_temp.row_of(pg_temp.id('c4')) = 'uncertain/LEASE_EXPIRED' and pg_temp.audits('c4', 'lease_expired_uncertain') = 1, 'EC6 next round: unchanged, no second audit');
select pg_temp.expect(pg_temp.worker(format('select postona_x_resv.finish(%L, %L, ''failed_before_send'', null, ''TEST_STOP'')', pg_temp.id(n), pg_temp.lease_of(pg_temp.id(n))))
  = 'failed_before_send', 'EC6 finish ' || n) from unnest(array['c3', 'e1']) n;

-- EC7 single post's re-entry after its lease ran out: uncertain, never re-sent, ONE audit row
create table t43.k (k uuid);
insert into t43.k values (gen_random_uuid());
create function pg_temp.begin_sp() returns text language sql as $$
  select pg_temp.api(format('select reservation_id || '','' || state from postona_x_resv.post_now_begin(%L, %L, %L, %L)', pg_temp.acct(pg_temp.uid(8)),
    (select k from t43.k), 'G3-43 単発 ek', pg_temp.body_sha('G3-43 単発 ek')), pg_temp.uid(8)) $$;
select pg_temp.keep('ek', split_part(pg_temp.begin_sp(), ',', 1)::uuid) is not null;
select pg_temp.expect(pg_temp.row_of(pg_temp.id('ek')) = 'claimed/-', 'EC7 single post claimed');
update postona_x_resv.reservations set lease_expires_at = now() - interval '1 second' where id = pg_temp.id('ek');
select pg_temp.expect(pg_temp.begin_sp() = pg_temp.id('ek') || ',uncertain', 'EC7 re-entry: uncertain');
select pg_temp.expect(pg_temp.begin_sp() = pg_temp.id('ek') || ',uncertain', 'EC7 again: uncertain');
select pg_temp.expect((select count(*) = 1 and bool_and(a.detail ->> 'worker' = 'single_post') from postona_x_resv.audit a
                       where a.reservation_id = pg_temp.id('ek') and a.action = 'lease_expired_uncertain'), 'EC7 one audit row');

-- EC8 C's service is being ended: C cannot create / reschedule / list; C's due row is never claimed; C cancels c2 (own row, no service)
select pg_temp.expect(pg_temp.as_role(format('select public.begin_service_deletion(%L::uuid, ''x_autopost'')::text', pg_temp.uid(8)), 'service_role') !~ '^ERR', 'setup: C end begins');
select pg_temp.expect(pg_temp.create_raw(pg_temp.uid(8), 'g43c6', 360) like 'ERR:POSTONA_RESV_%', 'EC8 create refused');
select pg_temp.expect(pg_temp.api(format('select status from postona_x_resv.reschedule(%L, %s, %L)', pg_temp.id('c2'), pg_temp.rev('c2'), now() + interval '311 hours'), pg_temp.uid(8))
  like 'ERR:POSTONA_RESV_%', 'EC8 reschedule refused');
select pg_temp.expect(pg_temp.api(format('select count(*) from postona_x_resv.list_reservations(%L)', pg_temp.acct(pg_temp.uid(8))), pg_temp.uid(8))
  = 'ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE', 'EC8 list refused (unchanged: a read after the end is not decided here)');
update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute' where id = pg_temp.id('c2');
select pg_temp.expect(pg_temp.claim() not like '%' || pg_temp.id('c2') || '%', 'EC8 not claimed');
select pg_temp.expect(pg_temp.cancel('c2', pg_temp.uid(8)) = 'cancelled@2', 'EC8 C cancels c2 ' || pg_temp.cancel('c2', pg_temp.uid(8)));
select pg_temp.expect(pg_temp.cancel('c2', pg_temp.uid(9)) = 'ERR:POSTONA_RESV_NOT_FOUND', 'EC8 still not E''s');

-- EC9 E's service restarts (a NEW generation): e2 is bound to the old one; E cancels it; a new create in the new generation works
select pg_temp.restart(pg_temp.uid(9)) is not null;
select pg_temp.expect(pg_temp.bound_of(pg_temp.id('e2')) <> 'null/' || pg_temp.lv(pg_temp.uid(9)), 'EC9 e2 is of the old generation');
select pg_temp.expect(pg_temp.cancel('e2', pg_temp.uid(9)) = 'cancelled@2', 'EC9 E cancels the old-generation row');
select pg_temp.expect(pg_temp.create_raw(pg_temp.uid(9), 'g43e3', 320) !~ '^ERR', 'EC9 new generation create');

select pg_temp.expect(pg_temp.row_of(pg_temp.id('c9')) = 'planned/-', 'EC c9 left planned for the rollback check');
select 'G3_OWNER_CANCEL_BEHAVIOR_PASS';
