-- G4-24 (Issue #319): Threads PR #412 (credential_row: clock expiry, READ COMMITTED) x PR #418 (binding entry + custody
-- connect proof) COMPOSED, on a disposable PG17 built by postona_threads_credential_composition_run.sh: G5's chain and R1 / W1
-- (PR #399), F5's owner epoch, 2a-2, PR #124, G4 custody, 001 + 002 (PR #418), credential_row (PR #412), G3's generation
-- (PR #374, verbatim). Runs as the non-superuser owner. The owner transport is MODELLED (H5's code is not used): JSON-only
-- request.jwt.claims {sub, role, session_id, is_anonymous:false} (G5 T-1), one transaction per operation. Every value is fake.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create schema cr;
create function cr.uid(p_n integer) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function cr.h(p_tag text) returns text language sql immutable as $$
  select encode(sha256(convert_to('state:' || p_tag, 'UTF8')), 'hex') $$;
create function cr.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAIL %', p_label; end if; end $$;
create function cr.session(p_user uuid) returns uuid language sql as $$
  select (select s.id from auth.sessions s where s.user_id = p_user and s.not_after is null order by s.created_at limit 1) $$;
-- G5 T-1: JSON only (every per-claim setting empty).
create function cr.claims(p_user uuid, p_session uuid, p_mode text default 'json') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', case when p_mode = 'mixed' then coalesce(p_user::text, '') else '' end, true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.session_id', '', true);
  perform set_config('request.jwt.claim.is_anonymous', '', true);
  perform set_config('request.jwt.claims', case when p_user is null then '' else
    jsonb_strip_nulls(jsonb_build_object('sub', p_user, 'role', 'authenticated',
      'session_id', case when p_mode = 'no_session' then null else p_session end, 'is_anonymous', false))::text end, true);
end $$;
create function cr.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'OK';
exception when others then return 'ERR:' || sqlerrm; end $$;
create function cr.as_person(p_user uuid, p_sql text, p_mode text default 'json') returns text language plpgsql as $$
declare v text;
begin
  perform cr.claims(p_user, cr.session(p_user), p_mode);
  execute p_sql into v;
  perform cr.claims(null, null);
  return coalesce(v, '<null>');
exception when others then
  perform cr.claims(null, null);
  return 'ERR:' || sqlerrm;
end $$;
create function cr.enroll(p_n integer) returns uuid language plpgsql as $$
declare v_user uuid := cr.uid(p_n);
begin
  perform public.fixture_login(v_user);
  insert into auth.sessions (user_id) values (v_user);
  perform cr.check(cr.as_person(v_user, 'select public.start_x_autopost_service() ->> ''status''') = 'active', 'enroll ' || p_n);
  return v_user;
end $$;
create function cr.attest(p_state uuid, p_puid text, p_handle text, p_token text) returns text language sql immutable as $$
  select encode(extensions.hmac(
    convert_to(concat_ws(chr(10), 'postona-threads-connect-v1', p_state::text, p_puid, coalesce(p_handle, ''),
                         encode(sha256(convert_to(p_token, 'UTF8')), 'hex')), 'UTF8'),
    convert_to('fake_attestation_key_0123456789abcdef0123456789abcdef', 'UTF8'), 'sha256'), 'hex') $$;
create function cr.token(p_tag text) returns text language sql immutable as $$ select 'fakeTHREADS' || p_tag || '0123456789ab' $$;
create function cr.ws(p_user uuid) returns text language sql stable as $$ select public.social_mobile_account_deletion_workspace(p_user) $$;
create function cr.state(p_tag text) returns uuid language sql stable as $$
  select s.id from public.social_account_oauth_states s where s.state_hash = cr.h(p_tag) $$;

-- The MODELLED owner transport (G4-19 §4-6): begin tx = begin -> G5 R1 (the allow token's two numbers) ->
-- record_state_generation; complete tx = the entry -> custody. Each is ONE function call (one transaction / subtransaction).
create function cr.t_begin(p_user uuid, p_tag text, p_mode text default 'json') returns text language plpgsql as $$
declare v_account text; v_verdict jsonb; v_token text; v_parts text[];
begin
  perform cr.claims(p_user, cr.session(p_user), p_mode);
  select b.social_account_id into v_account from public.begin_social_mobile_threads_oauth_connection(
    cr.h(p_tag), 'https://app.postona.test/oauth/threads/callback', now() + interval '5 minutes') b;
  v_verdict := public.common_account_authorization_verdict('postona', 'threads_connect', cr.ws(p_user));
  if v_verdict ->> 'decision' is distinct from 'allow' then raise exception 'R1_NOT_ALLOW %', v_verdict; end if;
  v_token := v_verdict ->> 'owner_epoch';
  v_parts := regexp_match(v_token, '^g5oe:([1-9][0-9]*):([1-9][0-9]*)$');
  if v_parts is null then raise exception 'R1_TOKEN_MALFORMED'; end if;
  perform postona_threads_binding.record_state_generation(p_user, cr.state(p_tag), v_parts[1]::bigint, v_parts[2]::bigint);
  perform cr.claims(null, null);
  return v_account;
exception when others then
  perform cr.claims(null, null);
  return 'ERR:' || sqlerrm;
end $$;
create function cr.t_complete(p_user uuid, p_tag text, p_puid text, p_expires timestamptz, p_mode text default 'json', p_as uuid default null)
returns text language plpgsql as $$
declare v_state uuid := cr.state(p_tag); v_as uuid := coalesce(p_as, p_user);
begin
  perform cr.claims(v_as, cr.session(v_as), p_mode);
  perform postona_threads_binding.complete_and_attest_binding(v_state, p_puid, 'h' || p_puid, cr.token(p_tag),
                                                              cr.attest(v_state, p_puid, 'h' || p_puid, cr.token(p_tag)));
  perform public.record_threads_credential_custody((select s.social_account_id from public.social_account_oauth_states s where s.id = v_state), p_expires);
  perform cr.claims(null, null);
  return 'OK';
exception when others then
  perform cr.claims(null, null);
  return 'ERR:' || sqlerrm;
end $$;
-- PR #124's complete called ON ITS OWN (an unmigrated transport), then custody, in one subtransaction.
create function cr.legacy_complete(p_user uuid, p_tag text, p_puid text, p_with_custody boolean) returns text language plpgsql as $$
declare v_state uuid := cr.state(p_tag);
begin
  perform cr.claims(p_user, cr.session(p_user));
  perform public.complete_social_mobile_threads_oauth_connection(v_state, p_puid, 'h' || p_puid, cr.token(p_tag),
                                                                 cr.attest(v_state, p_puid, 'h' || p_puid, cr.token(p_tag)));
  if p_with_custody then
    perform public.record_threads_credential_custody((select s.social_account_id from public.social_account_oauth_states s where s.id = v_state), now() + interval '30 days');
  end if;
  perform cr.claims(null, null);
  return 'OK';
exception when others then
  perform cr.claims(null, null);
  return 'ERR:' || sqlerrm;
end $$;
create function cr.rows(p_account text) returns integer language sql volatile as $$
  select count(*)::integer from postona_threads_credential.credential_row(p_account, 'x_autopost') $$;
create function cr.cred(p_account text) returns text language sql volatile as $$
  select coalesce((select string_agg(r.social_account_id || '|' || r.threads_user_id || '|' || r.access_token || '|' || r.generation, ';')
                   from postona_threads_credential.credential_row(p_account, 'x_autopost') r), '<none>') $$;
create function cr.snap() returns text language sql stable set timezone = 'UTC' as $$
  select md5(concat_ws('|',
    (select string_agg(t::text, ',' order by t.id) from public.social_accounts t),
    (select string_agg(t::text, ',' order by t.id) from public.social_account_oauth_states t),
    (select string_agg(t::text, ',' order by t.id) from vault.secrets t),
    (select string_agg(t::text, ',' order by t.social_account_id) from public.threads_account_credential_custody t),
    (select string_agg(t::text, ',' order by t.oauth_state_id) from postona_threads_binding.state_generations t),
    (select string_agg(t::text, ',' order by t.social_account_id) from postona_threads_binding.bindings t))) $$;
-- One connected person: enroll, begin tx, complete tx. Returns the account id.
create function cr.connected(p_n integer, p_tag text) returns text language plpgsql as $$
declare v_user uuid := cr.enroll(p_n); v_account text; v text;
begin
  v_account := cr.t_begin(v_user, p_tag);
  perform cr.check(v_account like 'sa_%', 'begin ' || p_n || ': ' || v_account);
  v := cr.t_complete(v_user, p_tag, '178414000000' || lpad(p_n::text, 5, '0'), now() + interval '30 days');
  perform cr.check(v = 'OK', 'complete ' || p_n || ': ' || v);
  return v_account;
end $$;

-- K1. ACL of the composed objects: the owner only (no API role, no PUBLIC, no null ACL), PR #124's complete included.
do $$
declare v_fn text; v_owner oid := (select oid from pg_roles where rolname = current_user);
begin
  foreach v_fn in array array[
    'postona_threads_credential.credential_row(text,text)', 'postona_threads_binding.complete_and_attest_binding(uuid,text,text,text,text)',
    'postona_threads_binding.record_state_generation(uuid,uuid,bigint,bigint)', 'postona_threads_binding.binding_row(text)',
    'public.record_threads_credential_custody(text,timestamptz)', 'public.threads_account_credential_expires_at(text)',
    'public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text)'] loop
    perform cr.check((select p.proacl is not null and not exists (select 1 from aclexplode(p.proacl) a where a.grantee <> v_owner)
                      from pg_proc p where p.oid = v_fn::regprocedure), 'K1 owner-only ACL: ' || v_fn);
  end loop;
end $$;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    begin
      execute format('set local role %I', r);
      perform 1 from postona_threads_credential.credential_row('sa_x', 'x_autopost');
      reset role;
      raise exception 'FAIL K1 % reached credential_row', r;
    exception when insufficient_privilege then reset role;
    end;
  end loop;
end $$;
-- K2. G5 W1 as PR #399 ships it: STABLE, definer, row_security = off -- and credential_row's install and per-call checks accept it.
select cr.check((select p.provolatile = 's' and p.prosecdef and p.proconfig @> array['row_security=off']
                 from pg_proc p where p.oid = 'private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)'::regprocedure),
                'K2 W1 is STABLE, definer, row_security = off');

-- C1. A new connect through the modelled transport: exactly one row -- this account, its Threads user, its token, a 64-hex generation.
select cr.connected(1, 'c1') as acct_a \gset
select cr.check(cr.rows(:'acct_a') = 1, 'C1 one row');
select cr.check(cr.cred(:'acct_a') ~ ('^' || :'acct_a' || '\|17841400000000001\|' || cr.token('c1') || '\|[0-9a-f]{64}$'), 'C1 the row: ' || cr.cred(:'acct_a'));
select cr.check((select b.oauth_state_id = cr.state('c1') from postona_threads_binding.bindings b where b.social_account_id = :'acct_a'), 'C1 bound to its state');
select split_part(cr.cred(:'acct_a'), '|', 4) as gen_a1 \gset

-- C2. Reconnect (a new state): the newest binding and the newest token only, a new generation.
select cr.uid(1) as a \gset
select cr.check(cr.t_begin(:'a', 'c2') = :'acct_a', 'C2 begin');
select cr.check(cr.t_complete(:'a', 'c2', '17841400000000001', now() + interval '40 days') = 'OK', 'C2 complete');
select cr.check(cr.rows(:'acct_a') = 1 and cr.cred(:'acct_a') like '%|' || cr.token('c2') || '|%', 'C2 the new token only: ' || cr.cred(:'acct_a'));
select cr.check(split_part(cr.cred(:'acct_a'), '|', 4) <> :'gen_a1', 'C2 a new generation');
select cr.check((select b.oauth_state_id = cr.state('c2') from postona_threads_binding.bindings b where b.social_account_id = :'acct_a'), 'C2 bound to the new state');

-- C3. PR #124's complete alone (an unmigrated transport): with custody in the same transaction -> refused as a whole; committed
--     alone -> the credential is stored but no binding / custody: credential_row gives NO row, and the state can never be bound.
select cr.enroll(2) as b \gset
select cr.t_begin(:'b', 'c3') as acct_b \gset
select cr.snap() as s \gset
select cr.check(cr.legacy_complete(:'b', 'c3', '17841400000000002', true) = 'ERR:THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION', 'C3 complete + custody without the entry: refused');
select cr.check(cr.snap() = :'s', 'C3 nothing stayed');
select cr.check(cr.legacy_complete(:'b', 'c3', '17841400000000002', false) = 'OK', 'C3 complete alone, committed');
select cr.check(cr.rows(:'acct_b') = 0, 'C3 no credential row without binding and custody');
select cr.check(cr.t_complete(:'b', 'c3', '17841400000000002', now() + interval '30 days') like 'ERR:THREADS_OAUTH_STATE_NOT_CONSUMABLE%', 'C3 the state can no longer be bound');

-- C3b. The same on an account that IS bound from an earlier connect (A, after C2): an unmigrated complete + custody in one
--      transaction is still refused (no connect proof in it, even though a binding of this account exists), nothing stays.
select cr.check(cr.t_begin(:'a', 'c3b') = :'acct_a', 'C3b begin');
select cr.snap() as s \gset
select cr.check(cr.legacy_complete(:'a', 'c3b', '17841400000000001', true) = 'ERR:THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION', 'C3b bound account, complete + custody without the entry: refused');
select cr.check(cr.snap() = :'s', 'C3b nothing stayed');

-- C4. Expiry by the clock at retrieval (PR #412), in the composed world.
select cr.connected(3, 'c4') as acct_c \gset
update public.threads_account_credential_custody set expires_at = clock_timestamp() + interval '1 second' where social_account_id = :'acct_c';
begin;
select cr.check(cr.rows(:'acct_c') = 1, 'C4 a row before the expiry');
select pg_sleep(1.3);
select cr.check(cr.rows(:'acct_c') = 0, 'C4 none once the clock passed it, same transaction');
commit;

-- C5. Owner: a second owner -> none; removing it does NOT bring the old binding back (the owner epoch only moves forward: W1
--     answers OWNER_EPOCH_CHANGED); a reconnect under the current epoch gives one row again. Owner A -> B -> A -> none as well.
select cr.connected(4, 'c5') as acct_d \gset
select cr.enroll(41) as d2 \gset
select cr.uid(4) as d \gset
insert into public.brand_memberships (brand_id, user_id, role) values (cr.ws(:'d'), :'d2', 'owner');
select cr.check(cr.rows(:'acct_d') = 0, 'C5 two owners: none');
delete from public.brand_memberships where brand_id = cr.ws(:'d') and user_id = :'d2';
select cr.check(cr.rows(:'acct_d') = 0, 'C5 single owner again: still none (the old binding''s epoch is gone)');
select cr.check(private.account_lifecycle_worker_brand_verdict(cr.ws(:'d'), 'x_autopost',
                  (select b.owner_epoch from postona_threads_binding.bindings b where b.social_account_id = :'acct_d'),
                  (select b.lifecycle_version from postona_threads_binding.bindings b where b.social_account_id = :'acct_d')) = 'OWNER_EPOCH_CHANGED',
                'C5 W1 says OWNER_EPOCH_CHANGED');
select cr.check(cr.t_begin(:'d', 'c5b') = :'acct_d' and cr.t_complete(:'d', 'c5b', '17841400000000004', now() + interval '30 days') = 'OK', 'C5 reconnect');
select cr.check(cr.rows(:'acct_d') = 1, 'C5 a row again after the reconnect');
update public.brand_memberships set role = 'admin' where brand_id = cr.ws(:'d') and user_id = :'d';
insert into public.brand_memberships (brand_id, user_id, role) values (cr.ws(:'d'), :'d2', 'owner');
delete from public.brand_memberships where brand_id = cr.ws(:'d') and user_id = :'d2';
update public.brand_memberships set role = 'owner' where brand_id = cr.ws(:'d') and user_id = :'d';
select cr.check(cr.rows(:'acct_d') = 0, 'C5 owner A -> B -> A: none');

-- C6. Revoked: the service ended and restarted (SYNTHETIC lifecycle_version + 2) -> none; disconnected -> none.
select cr.connected(5, 'c6') as acct_e \gset
update public.common_accounts set lifecycle_version = lifecycle_version + 2 where user_id = cr.uid(5); -- SYNTHETIC
select cr.check(cr.rows(:'acct_e') = 0, 'C6 service generation moved: none');
select cr.connected(6, 'c6b') as acct_f \gset
update public.social_accounts set connection_status = 'unconnected' where id = :'acct_f';
select cr.check(cr.rows(:'acct_f') = 0, 'C6 disconnected: none');

-- C7. Claims at the entry: none / without session_id / another person / mixed per-claim + JSON -- refused, nothing written.
select cr.enroll(7) as g \gset
select cr.t_begin(:'g', 'c7') as acct_g \gset
select cr.snap() as s \gset
select cr.check(cr.try(format('select postona_threads_binding.complete_and_attest_binding(%L::uuid, %L, %L, %L, %L)', cr.state('c7'),
                '17841400000000007', 'h17841400000000007', cr.token('c7'), cr.attest(cr.state('c7'), '17841400000000007', 'h17841400000000007', cr.token('c7'))))
                = 'ERR:THREADS_BINDING_INPUT_INVALID', 'C7 no claims');
select cr.t_complete(:'g', 'c7', '17841400000000007', now() + interval '30 days', 'no_session') as c7_nosession \gset
select cr.check(:'c7_nosession' like 'ERR:%', 'C7 JSON claims without session_id: refused (' || :'c7_nosession' || ')');
select cr.enroll(71) as g2 \gset
select cr.t_complete(:'g', 'c7', '17841400000000007', now() + interval '30 days', 'json', :'g2') as c7_other \gset
select cr.check(:'c7_other' like 'ERR:%', 'C7 another person''s claims: refused (' || :'c7_other' || ')');
select 'C7_OTHER_PERSON ' || :'c7_other' as observed;
select cr.check(cr.snap() = :'s', 'C7 nothing written by the refusals');
-- Mixed per-claim sub + JSON (H5's transport today): G5 says R0 / R1 / T13 refuse it. Observed and reported either way.
select cr.t_complete(:'g', 'c7', '17841400000000007', now() + interval '30 days', 'mixed') as c7_mixed \gset
select (:'c7_mixed' like 'ERR:%') as c7_mixed_refused \gset
\if :c7_mixed_refused
select cr.check(cr.snap() = :'s', 'C7 mixed claims refused, nothing written');
select 'C7_MIXED_CLAIMS_REFUSED ' || :'c7_mixed' as observed;
select cr.check(cr.t_complete(:'g', 'c7', '17841400000000007', now() + interval '30 days') = 'OK', 'C7 JSON-only claims complete');
\else
select 'C7_MIXED_CLAIMS_ACCEPTED (differs from G5 T-1)' as observed;
\endif

-- C8. Atomicity: custody refused inside the complete transaction (expiry out of range) -> the entry is undone too; savepoint and
--     transaction rollback undo both; the same state then connects.
select cr.enroll(8) as h \gset
select cr.t_begin(:'h', 'c8') as acct_h \gset
select cr.snap() as s \gset
select cr.check(cr.t_complete(:'h', 'c8', '17841400000000008', now() + interval '62 days') = 'ERR:THREADS_CUSTODY_EXPIRY_INVALID', 'C8 custody refused');
select cr.check(cr.snap() = :'s', 'C8 the entry was undone with it');
begin;
savepoint g4_24;
select cr.check(cr.t_complete(:'h', 'c8', '17841400000000008', now() + interval '30 days') = 'OK', 'C8 inside a savepoint');
rollback to savepoint g4_24;
commit;
select cr.check(cr.snap() = :'s', 'C8 savepoint rollback undid entry + custody');
begin;
select cr.check(cr.t_complete(:'h', 'c8', '17841400000000008', now() + interval '30 days') = 'OK', 'C8 inside a transaction');
rollback;
select cr.check(cr.snap() = :'s' and cr.rows(:'acct_h') = 0, 'C8 transaction rollback undid both; no row');
select cr.check(cr.t_complete(:'h', 'c8', '17841400000000008', now() + interval '30 days') = 'OK' and cr.rows(:'acct_h') = 1, 'C8 the same state then connects');

-- C10. A binding row naming another binder than the workspace's single owner (SYNTHETIC: a corrupted or foreign row) -> none.
select cr.connected(10, 'c10') as acct_j \gset
update postona_threads_binding.bindings set bound_by = cr.uid(999) where social_account_id = :'acct_j'; -- SYNTHETIC
select cr.check(cr.rows(:'acct_j') = 0, 'C10 bound by someone else: none');

-- C9. Isolation: only READ COMMITTED gets a row.
begin isolation level repeatable read;
select cr.check(cr.rows(:'acct_a') = 0, 'C9 repeatable read: none');
commit;
begin isolation level serializable;
select cr.check(cr.rows(:'acct_a') = 0, 'C9 serializable: none');
commit;
begin isolation level read committed;
select cr.check(cr.rows(:'acct_a') = 1, 'C9 read committed: one');
commit;

select 'POSTONA_THREADS_CREDENTIAL_COMPOSITION_BEHAVIOR_PASS' as result;
