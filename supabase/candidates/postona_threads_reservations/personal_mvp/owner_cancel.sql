-- G3-43 (TEST ONLY, fake data): the person's own Threads cancel after the service ended / the account is no longer verified / an old
-- generation (007's cancel_reservation, unchanged) and the lease-expired audit (011), in the personal MVP world with 009
-- (postona_threads_personal_mvp_run.sh, phase EC). Two new people, C = uid(8) and E = uid(9), set up as live_rows.sql does. Every state
-- comes from the real paths (API create / cancel / receipt, worker claim / record, claim_due's lease sweep, G5's service end / restart);
-- only the clock and the TEST DOUBLE's verified list are moved.
\ir helpers.sql

create schema t43;
create table t43.ids (name text primary key, id uuid);
create function pg_temp.keep(p_name text, p_id uuid) returns uuid language sql as $$ insert into t43.ids values (p_name, p_id) returning id $$;
create function pg_temp.id(p_name text) returns uuid language sql stable as $$ select id from t43.ids where name = p_name $$;
create function pg_temp.cancel(p_name text, p_sub uuid) returns text language sql as $$
  select pg_temp.api(format('select postona_threads_resv.cancel_reservation(%L)', pg_temp.id(p_name)), p_sub) $$;
create function pg_temp.audits(p_name text, p_action text) returns bigint language sql stable as $$
  select count(*) from postona_threads_resv.audit a where a.reservation_id = pg_temp.id(p_name) and a.action = p_action $$;
create function pg_temp.snap() returns text language sql stable as $$
  select md5(coalesce(string_agg(concat_ws('/', id, status, outcome_code, lease_token, updated_at), ',' order by id), '')) || ':'
         || (select count(*) from postona_threads_resv.audit) from postona_threads_resv.reservations $$;

select public.fixture_user_with_workspace(u, 's43' || right(u::text, 2)), public.fixture_login(u) from unnest(array[pg_temp.uid(8), pg_temp.uid(9)]) u;
insert into auth.sessions (user_id, not_after) select u, null from unnest(array[pg_temp.uid(8), pg_temp.uid(9)]) u;
select pg_temp.expect(pg_temp.as_role('select public.start_x_autopost_service() ->> ''status''', 'authenticated', u) = 'active', 'setup: start ' || u)
from unnest(array[pg_temp.uid(8), pg_temp.uid(9)]) u;
update public.brands set code_profile_key = 'social_mobile_user_v1' where id in (pg_temp.ws(pg_temp.uid(8)), pg_temp.ws(pg_temp.uid(9)));
insert into public.social_accounts (id, brand_id, platform, handle, platform_user_id, publish_enabled, connection_status, verified_at,
  vault_access_token_secret_id, vault_refresh_token_secret_id)
select pg_temp.tacct(u), pg_temp.ws(u), 'threads', '@th43' || right(u::text, 2), (17841400000043000 + right(u::text, 2)::integer)::text, true,
       'identity_verified', now(), gen_random_uuid(), null
from unnest(array[pg_temp.uid(8), pg_temp.uid(9)]) u;
insert into public.threads_account_credential_custody (social_account_id, vault_secret_id, expires_at, recorded_by)
select pg_temp.tacct(u), gen_random_uuid(), now() + interval '50 days', u from unnest(array[pg_temp.uid(8), pg_temp.uid(9)]) u;
insert into t_threads.verified select pg_temp.tacct(u) from unnest(array[pg_temp.uid(8), pg_temp.uid(9)]) u;
select pg_temp.expect(postona_threads_resv.fence(u, pg_temp.tacct(u)) = pg_temp.ws(u), 'setup: Threads fence passes ' || u)
from unnest(array[pg_temp.uid(8), pg_temp.uid(9)]) u;
select pg_temp.expect(pg_catalog.to_regprocedure('postona_threads_resv.audit_lease_expired()') is not null, 'setup: 011 applied');

select pg_temp.keep(t.name, pg_temp.reserve(t.u, 'g43' || t.name, t.h)) is not null
from (values ('c1', pg_temp.uid(8), 300), ('c2', pg_temp.uid(8), 310), ('c3', pg_temp.uid(8), 320), ('c4', pg_temp.uid(8), 330),
             ('e1', pg_temp.uid(9), 300), ('e2', pg_temp.uid(9), 310)) t(name, u, h);

-- TC1 another person's row, no subject, an ended session: refused, nothing written
select pg_temp.snap() as s0 \gset
select pg_temp.expect(pg_temp.cancel('c1', pg_temp.uid(9)) = 'ERR:POSTONA_THREADS_RESV_NOT_FOUND', 'TC1 E cannot cancel C''s row');
select pg_temp.expect(pg_temp.cancel('c1', null) = 'ERR:POSTONA_RESV_AUTH_REQUIRED', 'TC1 no subject');
update auth.sessions set not_after = now() - interval '1 second' where user_id = pg_temp.uid(8);
select pg_temp.expect(pg_temp.cancel('c1', pg_temp.uid(8)) = 'ERR:POSTONA_RESV_AUTH_REQUIRED', 'TC1 ended session');
update auth.sessions set not_after = null where user_id = pg_temp.uid(8);
select pg_temp.expect(pg_temp.snap() = :'s0', 'TC1 nothing written');

-- TC2 C's Threads account is no longer verified (TEST DOUBLE list): create stays refused; C cancels c1
delete from t_threads.verified where social_account_id = pg_temp.tacct(pg_temp.uid(8));
select pg_temp.expect(pg_temp.create_raw(pg_temp.uid(8), 'c5', 350) = 'ERR:POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED', 'TC2 create refused');
select pg_temp.expect(pg_temp.cancel('c1', pg_temp.uid(8)) = 'cancelled', 'TC2 cancelled');
select pg_temp.expect(pg_temp.audits('c1', 'cancel') = 1, 'TC2 one cancel audit row');
select pg_temp.expect(pg_temp.cancel('c1', pg_temp.uid(8)) = 'ERR:POSTONA_THREADS_RESV_NOT_CANCELLABLE', 'TC2 twice: not cancellable');
insert into t_threads.verified values (pg_temp.tacct(pg_temp.uid(8)));

-- TC3 a claimed row is not cancellable; a lease that ran out: claim_due fences it to uncertain with ONE audit row (worker, lease end; no
-- text), E's due row is claimed in the same round, the receipt says uncertain, nothing is re-sent
select pg_temp.make_due(pg_temp.id(n)) from unnest(array['c3', 'c4']) n;
select pg_temp.claim() as cl \gset
select pg_temp.expect(:'cl' like '%' || pg_temp.id('c3') || '=%' and :'cl' like '%' || pg_temp.id('c4') || '=%', 'TC3 c3 / c4 claimed');
select pg_temp.expect(pg_temp.cancel('c3', pg_temp.uid(8)) = 'ERR:POSTONA_THREADS_RESV_NOT_CANCELLABLE', 'TC3 claimed: not cancellable');
update postona_threads_resv.reservations set lease_expires_at = now() - interval '1 second' where id = pg_temp.id('c4');
select pg_temp.make_due(pg_temp.id('e1'));
select pg_temp.claim() as cl \gset
select pg_temp.expect(:'cl' like '%' || pg_temp.id('e1') || '=%' and :'cl' not like '%' || pg_temp.id('c4') || '%', 'TC3 E claimed in the same round, c4 not');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('c4')) = 'uncertain/LEASE_EXPIRED', 'TC3 c4 uncertain');
select pg_temp.expect((select count(*) = 1 and bool_and(a.user_id = pg_temp.uid(8)) and bool_and(a.detail ->> 'worker' = 'w40')
                              and bool_and((select array_agg(k order by k) from jsonb_object_keys(a.detail) k) = array['lease_expires_at', 'worker'])
                              and bool_and(a.detail::text !~ '本文')
                       from postona_threads_resv.audit a where a.reservation_id = pg_temp.id('c4') and a.action = 'lease_expired_uncertain'), 'TC3 one audit row, codes only');
select pg_temp.expect(pg_temp.audits('c3', 'lease_expired_uncertain') = 0 and pg_temp.audits('e1', 'lease_expired_uncertain') = 0, 'TC3 no audit for a live lease');
select pg_temp.expect(pg_temp.api(format('select state from postona_threads_resv.receipt(%L, %L)', pg_temp.tacct(pg_temp.uid(8)), r.client_request_id), pg_temp.uid(8)) = 'uncertain',
  'TC3 receipt: uncertain') from postona_threads_resv.reservations r where r.id = pg_temp.id('c4');
select pg_temp.expect(pg_temp.cancel('c4', pg_temp.uid(8)) = 'ERR:POSTONA_THREADS_RESV_NOT_CANCELLABLE', 'TC3 uncertain: not cancellable');
select pg_temp.claim() as cl \gset
select pg_temp.expect(:'cl' not like '%' || pg_temp.id('c4') || '%' and pg_temp.audits('c4', 'lease_expired_uncertain') = 1, 'TC3 next round: not claimed, no second audit');
select pg_temp.expect(pg_temp.record(pg_temp.id(n), 'failed_before_send', null, 'TEST_STOP') = 'failed_before_send', 'TC3 record ' || n) from unnest(array['c3', 'e1']) n;

-- TC4 C's service is being ended: create refused; C cancels the planned c2 (007's cancel needs only the person session)
select pg_temp.expect(pg_temp.as_role(format('select public.begin_service_deletion(%L::uuid, ''x_autopost'')::text', pg_temp.uid(8)), 'service_role') !~ '^ERR', 'setup: C end begins');
select pg_temp.expect(pg_temp.create_raw(pg_temp.uid(8), 'c6', 360) like 'ERR:POSTONA_%', 'TC4 create refused');
-- G3-44: after the end C reads c2 through the receipt (pending), cancels, reads again (cancelled); E cannot read C's receipt; anonymous /
-- no session refused (007's receipt needs only the person session and the own row: no SQL change)
create function pg_temp.receipt(p_name text, p_sub uuid, p_account uuid default null) returns text language sql as $$
  select pg_temp.api(format('select state from postona_threads_resv.receipt(%L, %L)', pg_temp.tacct(coalesce(p_account, p_sub)), r.client_request_id), p_sub)
  from postona_threads_resv.reservations r where r.id = pg_temp.id(p_name) $$;
select pg_temp.expect(pg_temp.receipt('c2', pg_temp.uid(8)) = 'pending', 'TC4 receipt after the end: pending ' || pg_temp.receipt('c2', pg_temp.uid(8)));
select pg_temp.expect(pg_temp.receipt('c2', pg_temp.uid(9), pg_temp.uid(8)) = 'ERR:POSTONA_THREADS_RESV_NOT_FOUND', 'TC4 E cannot read C''s receipt');
select pg_temp.expect(pg_temp.receipt('c2', null, pg_temp.uid(8)) = 'ERR:POSTONA_RESV_AUTH_REQUIRED', 'TC4 receipt, no subject');
select pg_temp.expect(pg_temp.cancel('c2', pg_temp.uid(8)) = 'cancelled', 'TC4 C cancels c2 ' || pg_temp.cancel('c2', pg_temp.uid(8)));
select pg_temp.expect(pg_temp.receipt('c2', pg_temp.uid(8)) = 'cancelled', 'TC4 receipt after the cancel: cancelled');
select pg_temp.expect(pg_temp.receipt('c4', pg_temp.uid(8)) = 'uncertain', 'TC4 the uncertain row reads uncertain after the end');
update auth.sessions set not_after = now() - interval '1 second' where user_id = pg_temp.uid(8);
select pg_temp.expect(pg_temp.receipt('c2', pg_temp.uid(8)) = 'ERR:POSTONA_RESV_AUTH_REQUIRED', 'TC4 receipt, ended session');
update auth.sessions set not_after = null where user_id = pg_temp.uid(8);

-- TC5 E's service restarts (a NEW generation): e2 is bound to the old one; E cancels it
select pg_temp.restart(pg_temp.uid(9)) is not null;
select pg_temp.expect(pg_temp.bound_of(pg_temp.id('e2')) <> 'null/' || pg_temp.lv(pg_temp.uid(9)), 'TC5 e2 is of the old generation');
select pg_temp.expect(pg_temp.cancel('e2', pg_temp.uid(9)) = 'cancelled', 'TC5 E cancels the old-generation row');

select 'G3_THREADS_OWNER_CANCEL_BEHAVIOR_PASS';
