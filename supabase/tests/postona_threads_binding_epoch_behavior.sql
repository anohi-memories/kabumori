-- G4-09 behavior proof of supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql, run by
-- postona_threads_binding_epoch_run.sh as the non-superuser table owner on a disposable PG17 database (the real G5/F5
-- lifecycle + F5's owner epoch candidate + PR #124 + 001). Calls go through the owner channel with the person's JWT claims
-- (as H5's owner transport would); every value is fake. Each "connect" is ONE call of 001's complete_and_attest_binding
-- (G4-14: PR #124's complete and the binding inside one entry), so a refusal rolls both back.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create schema tb;
create function tb.uid(p_n integer) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function tb.h(p_tag text) returns text language sql immutable as $$
  select encode(sha256(convert_to('state:' || p_tag, 'UTF8')), 'hex') $$;
create function tb.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAIL %', p_label; end if; end $$;
create function tb.claims(p_user uuid, p_session uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', case when p_user is null then '' else
    jsonb_build_object('sub', p_user, 'role', 'authenticated', 'session_id', p_session)::text end, true);
end $$;
create function tb.session(p_user uuid) returns uuid language sql as $$
  select (select s.id from auth.sessions s where s.user_id = p_user and s.not_after is null order by s.created_at limit 1) $$;
create function tb.as_person(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform tb.claims(p_user, tb.session(p_user));
  execute p_sql into v;
  perform tb.claims(null, null);
  return coalesce(v, '<null>');
exception when others then
  perform tb.claims(null, null);
  return 'ERR:' || sqlerrm;
end $$;
create function tb.enroll(p_n integer) returns uuid language plpgsql as $$
declare v_user uuid := tb.uid(p_n);
begin
  perform public.fixture_login(v_user);
  insert into auth.sessions (user_id) values (v_user);
  perform tb.check(tb.as_person(v_user, 'select public.start_x_autopost_service() ->> ''status''') = 'active', 'enroll ' || p_n);
  return v_user;
end $$;
-- PR #124's server attestation with the fixture's fake key (postona_threads_oauth_test_fixture.sql).
create function tb.attest(p_state uuid, p_puid text, p_handle text, p_token text) returns text language sql immutable as $$
  select encode(extensions.hmac(
    convert_to(concat_ws(chr(10), 'postona-threads-connect-v1', p_state::text, p_puid, coalesce(p_handle, ''),
                         encode(sha256(convert_to(p_token, 'UTF8')), 'hex')), 'UTF8'),
    convert_to('fake_attestation_key_0123456789abcdef0123456789abcdef', 'UTF8'), 'sha256'), 'hex') $$;
create function tb.token(p_tag text) returns text language sql immutable as $$ select 'fakeTHREADS' || p_tag || '0123456789ab' $$;
create function tb.ws(p_user uuid) returns text language sql stable as $$ select public.social_mobile_account_deletion_workspace(p_user) $$;
create function tb.state(p_tag text) returns uuid language sql stable as $$
  select s.id from public.social_account_oauth_states s where s.state_hash = tb.h(p_tag) $$;
-- PR #124 begin for a person; the account id or 'ERR:...'.
create function tb.begin(p_user uuid, p_tag text) returns text language sql as $$
  select tb.as_person(p_user, format('select social_account_id from public.begin_social_mobile_threads_oauth_connection(%L, %L, now() + interval ''5 minutes'')',
                                     tb.h(p_tag), 'https://app.postona.test/oauth/threads/callback')) $$;
-- The numbers the database holds now for a person's workspace: owner epoch and the owner's lifecycle_version.
create function tb.epoch(p_user uuid) returns bigint language sql stable as $$ select private.account_lifecycle_brand_owner_epoch(tb.ws(p_user)) $$;
create function tb.lifecycle(p_user uuid) returns bigint language sql stable as $$ select a.lifecycle_version from public.common_accounts a where a.user_id = p_user $$;
-- 001's calls, as the owner transport would make them; 'OK' or 'ERR:...'.
create function tb.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'OK';
exception when others then return 'ERR:' || sqlerrm; end $$;
create function tb.record(p_actor uuid, p_tag text, p_epoch bigint, p_lifecycle bigint) returns text language sql as $$
  select tb.try(format('select postona_threads_binding.record_state_generation(%L::uuid, %L::uuid, %s, %s)',
                       p_actor, tb.state(p_tag), coalesce(p_epoch::text, 'null'), coalesce(p_lifecycle::text, 'null'))) $$;
-- The Threads callback as the owner transport makes it: ONE call of complete_and_attest_binding under the claims of p_as
-- (default: the person who began the state). 'OK' or 'ERR:...' with everything undone.
create function tb.connect(p_user uuid, p_tag text, p_puid text, p_as uuid default null)
returns text language plpgsql as $$
declare v_state uuid := tb.state(p_tag); v_as uuid := coalesce(p_as, p_user);
begin
  perform tb.claims(v_as, tb.session(v_as));
  perform postona_threads_binding.complete_and_attest_binding(v_state, p_puid, 'h' || p_puid, tb.token(p_tag),
                                                              tb.attest(v_state, p_puid, 'h' || p_puid, tb.token(p_tag)));
  perform tb.claims(null, null);
  return 'OK';
exception when others then
  perform tb.claims(null, null);
  return 'ERR:' || sqlerrm;
end $$;
-- PR #124's complete called ON ITS OWN (outside the entry), as the person: 'OK' or 'ERR:...'.
create function tb.complete_alone(p_user uuid, p_tag text, p_puid text) returns text language sql as $$
  select case when r like 'ERR:%' then r else 'OK' end
    from (select tb.as_person(p_user, format('select public.complete_social_mobile_threads_oauth_connection(%L::uuid, %L, %L, %L, %L)::text',
            tb.state(p_tag), p_puid, 'h' || p_puid, tb.token(p_tag), tb.attest(tb.state(p_tag), p_puid, 'h' || p_puid, tb.token(p_tag))))) x(r) $$;
-- PR #124's complete on its own and then the entry, in ONE subtransaction: 'OK' or 'ERR:...' with both undone.
create function tb.complete_then_connect(p_user uuid, p_tag text, p_puid text) returns text language plpgsql as $$
declare v_state uuid := tb.state(p_tag);
begin
  perform tb.claims(p_user, tb.session(p_user));
  perform public.complete_social_mobile_threads_oauth_connection(v_state, p_puid, 'h' || p_puid, tb.token(p_tag),
                                                                 tb.attest(v_state, p_puid, 'h' || p_puid, tb.token(p_tag)));
  perform postona_threads_binding.complete_and_attest_binding(v_state, p_puid, 'h' || p_puid, tb.token(p_tag),
                                                              tb.attest(v_state, p_puid, 'h' || p_puid, tb.token(p_tag)));
  perform tb.claims(null, null);
  return 'OK';
exception when others then
  perform tb.claims(null, null);
  return 'ERR:' || sqlerrm;
end $$;
create function tb.unbound(p_tag text) returns boolean language sql stable as $$
  select not exists (select 1 from postona_threads_binding.bindings b where b.oauth_state_id = tb.state(p_tag))
     and (select g.attested_at is null from postona_threads_binding.state_generations g where g.oauth_state_id = tb.state(p_tag)) $$;
create function tb.snap() returns text language sql stable set timezone = 'UTC' as $$
  select md5(concat_ws('|',
    (select string_agg(t::text, ',' order by t.id) from public.social_accounts t),
    (select string_agg(t::text, ',' order by t.id) from public.social_account_oauth_states t),
    (select string_agg(t::text, ',' order by t.id) from vault.secrets t),
    (select string_agg(t::text, ',' order by t.oauth_state_id) from postona_threads_binding.state_generations t),
    (select string_agg(t::text, ',' order by t.social_account_id) from postona_threads_binding.bindings t))) $$;
create function tb.refused(p_got text, p_want text, p_before text, p_label text) returns void language plpgsql as $$
begin
  perform tb.check(p_got = 'ERR:' || p_want, p_label || ': got ' || p_got);
  perform tb.check(tb.snap() = p_before, p_label || ': a refusal changed something');
end $$;
create function tb.row(p_account text) returns text language sql stable as $$
  select row(r.*)::text from postona_threads_binding.binding_row(p_account) r $$;

-- 0. No API role reaches 001 (functions, tables, schema).
do $$
declare r text; s text; v text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    foreach s in array array[
      'select postona_threads_binding.record_state_generation(gen_random_uuid(), gen_random_uuid(), 1, 1)',
      'select postona_threads_binding.complete_and_attest_binding(gen_random_uuid(), ''1'', null, ''t'', ''a'')',
      'select * from postona_threads_binding.binding_row(''sa_x'')',
      'select 1 from postona_threads_binding.bindings', 'select 1 from postona_threads_binding.state_generations'] loop
      begin
        execute format('set local role %I', r);
        execute s;
        reset role;
        raise exception 'FAIL 0 % reached: %', r, s;
      exception when insufficient_privilege then
        reset role;
      end;
    end loop;
  end loop;
end $$;

-- 0b. G4-14: there is no separate attest. The schema holds exactly the three entries.
select tb.check(to_regprocedure('postona_threads_binding.attest_binding(uuid,uuid,text)') is null, '0b no attest_binding');
select tb.check((select string_agg(p.proname, ',' order by p.proname) from pg_proc p
                  where p.pronamespace = 'postona_threads_binding'::regnamespace) = 'binding_row,complete_and_attest_binding,record_state_generation',
                '0b exactly three functions');

-- 1. The normal connect: begin, record the numbers of the allow, complete + attest; the binding row carries them as text.
select tb.enroll(1) as a \gset
select tb.begin(:'a', 'a1') as acct_a \gset
select tb.check(:'acct_a' like 'sa_%', '1 begin: ' || :'acct_a');
select tb.epoch(:'a') as ea, tb.lifecycle(:'a') as la \gset
select tb.check(:'ea'::bigint >= 1 and :'la'::bigint >= 1, '1 the workspace has an owner epoch and a lifecycle_version');
select tb.check(tb.record(:'a', 'a1', :'ea', :'la') = 'OK', '1 record');
select tb.check(tb.connect(:'a', 'a1', '17841400000000001') = 'OK', '1 connect');
select tb.check(tb.row(:'acct_a') = format('(%s,%s,threads,17841400000000001,identity_verified,t,%s,%s,%s)', :'acct_a', tb.ws(:'a'), :'a', :'ea', :'la'),
                '1 binding row: ' || tb.row(:'acct_a'));
select tb.check((select pg_typeof(r.bind_owner_epoch)::text = 'text' and pg_typeof(r.bind_lifecycle_version)::text = 'text'
                 from postona_threads_binding.binding_row(:'acct_a') r), '1 the numbers are text');
select tb.check((select b.bound_by = :'a' and b.oauth_state_id = tb.state('a1') and b.bound_at is not null
                 from postona_threads_binding.bindings b where b.social_account_id = :'acct_a'), '1 bound by A, from that state, bound_at recorded');

-- 2. record: wrong numbers, unknown, another actor, twice, a consumed or expired state, bad input -- nothing written.
select tb.enroll(2) as b \gset
select tb.begin(:'b', 'b1') as acct_b \gset
select tb.epoch(:'b') as eb, tb.lifecycle(:'b') as lb \gset
select tb.snap() as s \gset
select tb.refused(tb.record(:'b', 'b1', :'eb'::bigint + 1, :'lb'), 'THREADS_BINDING_OWNER_EPOCH_CHANGED', :'s', '2 another owner epoch');
select tb.refused(tb.record(:'b', 'b1', :'eb', :'lb'::bigint + 1), 'THREADS_BINDING_SERVICE_GENERATION_CHANGED', :'s', '2 another lifecycle_version');
select tb.refused(tb.record(:'b', 'b1', 0, :'lb'), 'THREADS_BINDING_INPUT_INVALID', :'s', '2 epoch 0');
select tb.refused(tb.record(:'b', 'b1', :'eb', null), 'THREADS_BINDING_INPUT_INVALID', :'s', '2 no lifecycle_version');
select tb.refused(tb.record(:'a', 'b1', :'eb', :'lb'), 'THREADS_BINDING_STATE_INVALID', :'s', '2 another actor (A for B''s state)');
select tb.refused(tb.record(:'a', 'a1', :'ea', :'la'), 'THREADS_BINDING_STATE_INVALID', :'s', '2 a consumed state');
select tb.check(tb.record(:'b', 'b1', :'eb', :'lb') = 'OK', '2 record');
select tb.snap() as s \gset
select tb.refused(tb.record(:'b', 'b1', :'eb', :'lb'), 'THREADS_BINDING_STATE_ALREADY_RECORDED', :'s', '2 recorded twice');
select tb.begin(:'b', 'b2') as ignore \gset
update public.social_account_oauth_states set expires_at = now() - interval '1 second' where id = tb.state('b2');
select tb.snap() as s \gset
select tb.refused(tb.record(:'b', 'b2', :'eb', :'lb'), 'THREADS_BINDING_STATE_INVALID', :'s', '2 an expired state');

-- 3. attest: a state never recorded (begun before 001 / by an old path) -- refused, and complete is rolled back with it.
select tb.enroll(3) as c \gset
select tb.begin(:'c', 'c1') as acct_c \gset
select tb.snap() as s \gset
select tb.refused(tb.connect(:'c', 'c1', '17841400000000003'), 'THREADS_BINDING_GENERATION_UNRECORDED', :'s', '3 unrecorded state');
select tb.check((select s.consumed_at is null from public.social_account_oauth_states s where s.id = tb.state('c1')), '3 the state is still unconsumed');
select tb.check((select sa.vault_access_token_secret_id is null and sa.connection_status <> 'identity_verified' from public.social_accounts sa where sa.id = :'acct_c'), '3 no credential stored');

-- 4. Owner A -> B -> A between begin and callback: the epoch moved; the old allow does not come back.
select tb.enroll(4) as d \gset
select tb.enroll(5) as e \gset
select tb.begin(:'d', 'd1') as acct_d \gset
select tb.check(tb.record(:'d', 'd1', tb.epoch(:'d'), tb.lifecycle(:'d')) = 'OK', '4 record');
select tb.epoch(:'d') as ed0 \gset
update public.brand_memberships set role = 'admin' where brand_id = tb.ws(:'d') and user_id = :'d';
insert into public.brand_memberships (brand_id, user_id, role) values (tb.ws(:'d'), :'e', 'owner');
delete from public.brand_memberships where brand_id = tb.ws(:'d') and user_id = :'e';
update public.brand_memberships set role = 'owner' where brand_id = tb.ws(:'d') and user_id = :'d';
select tb.check(tb.epoch(:'d') > :'ed0'::bigint, '4 the epoch moved (A -> B -> A)');
select tb.snap() as s \gset
select tb.refused(tb.connect(:'d', 'd1', '17841400000000004'), 'THREADS_BINDING_OWNER_EPOCH_CHANGED', :'s', '4 A -> B -> A');
-- a fresh begin under the new epoch works
select tb.begin(:'d', 'd2') as ignore \gset
select tb.check(tb.record(:'d', 'd2', tb.epoch(:'d'), tb.lifecycle(:'d')) = 'OK' and tb.connect(:'d', 'd2', '17841400000000004') = 'OK', '4 a new connect under the new epoch');

-- 5. The service ended and restarted (lifecycle_version moved) between begin and callback.
select tb.enroll(6) as f \gset
select tb.begin(:'f', 'f1') as acct_f \gset
select tb.check(tb.record(:'f', 'f1', tb.epoch(:'f'), tb.lifecycle(:'f')) = 'OK', '5 record');
update public.common_accounts set lifecycle_version = lifecycle_version + 2 where user_id = :'f'; -- SYNTHETIC: end + restart
select tb.snap() as s \gset
select tb.refused(tb.connect(:'f', 'f1', '17841400000000006'), 'THREADS_BINDING_SERVICE_GENERATION_CHANGED', :'s', '5 ended and restarted');

-- 6. attest: another actor, another Threads user, before complete, a replay, two owners -- refused, nothing changes.
select tb.enroll(7) as g \gset
select tb.begin(:'g', 'g1') as acct_g \gset
select tb.check(tb.record(:'g', 'g1', tb.epoch(:'g'), tb.lifecycle(:'g')) = 'OK', '6 record');
select tb.snap() as s \gset
select tb.refused(tb.connect(:'g', 'g1', '17841400000000007', :'a'), 'THREADS_OAUTH_STATE_NOT_CONSUMABLE', :'s', '6 another person completes G''s state');
select tb.refused(tb.connect(:'g', 'g1', '0'), 'THREADS_BINDING_INPUT_INVALID', :'s', '6 malformed Threads user id');
select tb.refused(tb.try(format('select postona_threads_binding.complete_and_attest_binding(%L::uuid, %L, %L, %L, %L)', tb.state('g1'),
                  '17841400000000007', 'h17841400000000007', tb.token('g1'), tb.attest(tb.state('g1'), '17841400000000007', 'h17841400000000007', tb.token('g1')))),
                  'THREADS_BINDING_INPUT_INVALID', :'s', '6 no JWT claims: no actor');
select tb.refused(tb.connect(:'g', 'g1', '17841400000000007', '00000000-0000-4000-8000-000000000777'), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', :'s', '6 claims of a person with no login: G5 T13 refuses first');
select tb.check(tb.connect(:'g', 'g1', '17841400000000007') = 'OK', '6 connect');
select tb.snap() as s \gset
select tb.refused(tb.connect(:'g', 'g1', '17841400000000007'), 'THREADS_OAUTH_STATE_NOT_CONSUMABLE', :'s', '6 replayed callback refused by PR #124 first');
-- two owners between record and attest: no single owner
select tb.enroll(8) as h \gset
select tb.begin(:'g', 'g2') as ignore \gset
select tb.check(tb.record(:'g', 'g2', tb.epoch(:'g'), tb.lifecycle(:'g')) = 'OK', '6 record g2');
insert into public.brand_memberships (brand_id, user_id, role) values (tb.ws(:'g'), :'h', 'owner');
select tb.snap() as s \gset
select tb.refused(tb.connect(:'g', 'g2', '17841400000000007'), 'THREADS_BINDING_NOT_OWNER', :'s', '6 two owners: no single owner');
delete from public.brand_memberships where brand_id = tb.ws(:'g') and user_id = :'h';

-- 7. Reconnect: a new state replaces the binding with the numbers it was begun under.
select tb.begin(:'a', 'a2') as ignore \gset
select tb.check(tb.record(:'a', 'a2', tb.epoch(:'a'), tb.lifecycle(:'a')) = 'OK' and tb.connect(:'a', 'a2', '17841400000000001') = 'OK', '7 reconnect');
select tb.check((select b.oauth_state_id = tb.state('a2') from postona_threads_binding.bindings b where b.social_account_id = :'acct_a'), '7 the binding is the new state''s');
select tb.check((select count(*) = 1 from postona_threads_binding.bindings b where b.social_account_id = :'acct_a'), '7 one binding per account');

-- 7b. G4-13 (H2 #329): S1 -> S2 -> S1. After the reconnect above (a1 then a2), the old state a1 is never attested again;
--     the binding stays a2's. The callback itself is refused by PR #124 (consumed). Even if some defect elsewhere freed the
--     consumed state again (SYNTHETIC: consumed_at reset), the entry refuses it once-only, with nothing changed.
select tb.snap() as s \gset
select tb.refused(tb.connect(:'a', 'a1', '17841400000000001'), 'THREADS_OAUTH_STATE_NOT_CONSUMABLE', :'s', '7b S1 callback after S2');
update public.social_account_oauth_states set consumed_at = null where id = tb.state('a1'); -- SYNTHETIC: a freed state
select tb.snap() as s \gset
select tb.refused(tb.connect(:'a', 'a1', '17841400000000001'), 'THREADS_BINDING_ALREADY_ATTESTED', :'s', '7b S1 re-attested after S2 (state freed)');
update public.social_account_oauth_states set consumed_at = now() where id = tb.state('a1');
select tb.check((select b.oauth_state_id = tb.state('a2') from postona_threads_binding.bindings b where b.social_account_id = :'acct_a'), '7b the binding is still S2''s');
select tb.check((select count(*) = 2 from postona_threads_binding.state_generations g where g.oauth_state_id in (tb.state('a1'), tb.state('a2')) and g.attested_at is not null),
                '7b both states recorded as attested once');

-- 7c. G4-14 (H2 #329 C2): no attest outside the completing call. There is no attest entry to call directly; a PR #124
--     complete on its own -- committed earlier, or earlier in the same transaction -- leaves a state the entry refuses.
select tb.enroll(10) as k \gset
select tb.begin(:'k', 'k1') as acct_k \gset
select tb.check(tb.record(:'k', 'k1', tb.epoch(:'k'), tb.lifecycle(:'k')) = 'OK', '7c record');
select tb.check(tb.try(format('select postona_threads_binding.attest_binding(%L::uuid, %L::uuid, %L)', :'k', tb.state('k1'), '17841400000000010'))
                like 'ERR:function postona_threads_binding.attest_binding(uuid, uuid, unknown) does not exist%', '7c no direct attest entry');
select tb.check(tb.complete_alone(:'k', 'k1', '17841400000000010') = 'OK', '7c complete alone, committed');
select tb.snap() as s \gset
select tb.refused(tb.connect(:'k', 'k1', '17841400000000010'), 'THREADS_OAUTH_STATE_NOT_CONSUMABLE', :'s', '7c the entry in a later transaction');
select tb.check(tb.unbound('k1'), '7c never bound, never attested');
select tb.begin(:'k', 'k2') as ignore \gset
select tb.check(tb.record(:'k', 'k2', tb.epoch(:'k'), tb.lifecycle(:'k')) = 'OK', '7c record k2');
select tb.snap() as s \gset
select tb.refused(tb.complete_then_connect(:'k', 'k2', '17841400000000010'), 'THREADS_OAUTH_STATE_NOT_CONSUMABLE', :'s', '7c complete then the entry, same transaction');
select tb.check(tb.unbound('k2') and (select s.consumed_at is null from public.social_account_oauth_states s where s.id = tb.state('k2')),
                '7c both undone: k2 unconsumed, unbound');

-- 7d. G4-14: the claim and the binding are one unit. A savepoint rolled back, or the whole transaction rolled back, after a
--     successful entry call undoes PR #124's complete too: no consumed state, no stored credential, no binding.
select tb.enroll(11) as m \gset
select tb.begin(:'m', 'm1') as acct_m \gset
select tb.check(tb.record(:'m', 'm1', tb.epoch(:'m'), tb.lifecycle(:'m')) = 'OK', '7d record');
select tb.snap() as s \gset
begin;
savepoint g4_14;
select tb.check(tb.connect(:'m', 'm1', '17841400000000011') = 'OK', '7d connect inside a savepoint');
rollback to savepoint g4_14;
commit;
select tb.check(tb.snap() = :'s', '7d savepoint rollback undid complete and binding together');
begin;
select tb.check(tb.connect(:'m', 'm1', '17841400000000011') = 'OK', '7d connect inside a transaction');
rollback;
select tb.check(tb.snap() = :'s', '7d transaction rollback undid complete and binding together');
select tb.check(tb.unbound('m1')
                and (select s.consumed_at is null from public.social_account_oauth_states s where s.id = tb.state('m1'))
                and (select sa.vault_access_token_secret_id is null from public.social_accounts sa where sa.id = :'acct_m'),
                '7d unconsumed, no credential reference, unbound');
select tb.check(tb.connect(:'m', 'm1', '17841400000000011') = 'OK', '7d the same state connects afterwards, committed');
select tb.check(not tb.unbound('m1'), '7d bound');

-- 8. The binding row: none, an account that no longer carries the bound identity, a disconnected account.
select tb.check(tb.row(:'acct_b') like '%,,,)', '8 no binding: bind columns null: ' || tb.row(:'acct_b'));
select tb.check(tb.row('sa_no_such_account') is null, '8 unknown account: no row');
update public.social_accounts set connection_status = 'unconnected' where id = :'acct_g';
select tb.check(tb.row(:'acct_g') like '%,unconnected,%', '8 disconnected: the status says so (G4-03 refuses): ' || tb.row(:'acct_g'));
update public.social_accounts set platform_user_id = '17841400000000888' where id = :'acct_g';
select tb.check(tb.row(:'acct_g') like '%,,,)', '8 another identity on the account: bind columns null: ' || tb.row(:'acct_g'));

-- 9. Beyond 2^53: the stored lifecycle_version keeps every digit and comes back as the same text.
select tb.enroll(9) as p \gset
update public.common_accounts set lifecycle_version = 9007199254740993 where user_id = :'p';
select tb.begin(:'p', 'p1') as acct_p \gset
select tb.check(tb.record(:'p', 'p1', tb.epoch(:'p'), 9007199254740993) = 'OK' and tb.connect(:'p', 'p1', '17841400000000009') = 'OK', '9 connect');
select tb.check((select r.bind_lifecycle_version = '9007199254740993' from postona_threads_binding.binding_row(:'acct_p') r), '9 exact decimal text');

-- 10. Cascade: the state rows go with their state (account deletion / cleanup removes states first).
select count(*) as before_n from postona_threads_binding.state_generations \gset
delete from public.social_account_oauth_states where id = tb.state('b2');
delete from public.social_account_oauth_states where id = tb.state('b1');
select tb.check((select count(*) from postona_threads_binding.state_generations) = :'before_n'::bigint - 1, '10 a recorded state row goes with its state');

-- 11. G4-14: the entry calls only the reviewed PR #124 complete, owner-only. Exposed (granted to an API role), turned
--     SECURITY INVOKER, or any change of its body: the entry refuses before anything is claimed. (Last: it changes PR #124.)
select tb.enroll(12) as n \gset
select tb.begin(:'n', 'n1') as acct_n \gset
select tb.check(tb.record(:'n', 'n1', tb.epoch(:'n'), tb.lifecycle(:'n')) = 'OK', '11 record');
grant execute on function public.complete_social_mobile_threads_oauth_connection(uuid, text, text, text, text) to authenticated;
select tb.snap() as s \gset
select tb.refused(tb.connect(:'n', 'n1', '17841400000000012'), 'THREADS_BINDING_COMPLETE_UNPINNED', :'s', '11 complete exposed to authenticated');
revoke execute on function public.complete_social_mobile_threads_oauth_connection(uuid, text, text, text, text) from authenticated;
alter function public.complete_social_mobile_threads_oauth_connection(uuid, text, text, text, text) security invoker;
select tb.refused(tb.connect(:'n', 'n1', '17841400000000012'), 'THREADS_BINDING_COMPLETE_UNPINNED', :'s', '11 complete turned security invoker');
alter function public.complete_social_mobile_threads_oauth_connection(uuid, text, text, text, text) security definer;
do $$ begin
  execute format('create or replace function public.complete_social_mobile_threads_oauth_connection(p_oauth_state_id uuid, p_platform_user_id text, p_handle text, p_access_token text, p_attestation text) returns void language plpgsql volatile security definer set search_path = '''' as %L',
                 (select p.prosrc from pg_proc p where p.oid = 'public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text)'::regprocedure) || '-- drift');
end $$;
select tb.refused(tb.connect(:'n', 'n1', '17841400000000012'), 'THREADS_BINDING_COMPLETE_UNPINNED', :'s', '11 complete body changed');

select 'POSTONA_THREADS_BINDING_EPOCH_BEHAVIOR_PASS' as result;
