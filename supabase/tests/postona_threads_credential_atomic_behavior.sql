-- G4-11 behavior proof of supabase/candidates/postona_threads_credential_atomic/001_threads_credential_atomic.sql, run by
-- postona_threads_credential_atomic_run.sh as the non-superuser owner on a disposable PG17 database: the real G5/F5
-- lifecycle, PR #124, G4 custody, G4 PR #367's binding, G5 PR #358's W1 and G3 PR #374's generation function. Calls go
-- through the owner channel with the person's JWT claims; every value is fake (Vault is the fixtures' table stub).
-- psql variable: delegate (a role authenticated reaches WITH INHERIT FALSE, SET TRUE; it holds nothing here).
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create schema tc;
create function tc.uid(p_n integer) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function tc.h(p_tag text) returns text language sql immutable as $$
  select encode(sha256(convert_to('state:' || p_tag, 'UTF8')), 'hex') $$;
create function tc.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAIL %', p_label; end if; end $$;
create function tc.claims(p_user uuid, p_session uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', case when p_user is null then '' else
    jsonb_build_object('sub', p_user, 'role', 'authenticated', 'session_id', p_session)::text end, true);
end $$;
create function tc.session(p_user uuid) returns uuid language sql as $$
  select (select s.id from auth.sessions s where s.user_id = p_user and s.not_after is null order by s.created_at limit 1) $$;
create function tc.as_person(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform tc.claims(p_user, tc.session(p_user));
  execute p_sql into v;
  perform tc.claims(null, null);
  return coalesce(v, '<null>');
exception when others then
  perform tc.claims(null, null);
  return 'ERR:' || sqlerrm;
end $$;
create function tc.enroll(p_n integer) returns uuid language plpgsql as $$
declare v_user uuid := tc.uid(p_n);
begin
  perform public.fixture_login(v_user);
  insert into auth.sessions (user_id) values (v_user);
  perform tc.check(tc.as_person(v_user, 'select public.start_x_autopost_service() ->> ''status''') = 'active', 'enroll ' || p_n);
  return v_user;
end $$;
create function tc.attest(p_state uuid, p_puid text, p_handle text, p_token text) returns text language sql immutable as $$
  select encode(extensions.hmac(
    convert_to(concat_ws(chr(10), 'postona-threads-connect-v1', p_state::text, p_puid, coalesce(p_handle, ''),
                         encode(sha256(convert_to(p_token, 'UTF8')), 'hex')), 'UTF8'),
    convert_to('fake_attestation_key_0123456789abcdef0123456789abcdef', 'UTF8'), 'sha256'), 'hex') $$;
create function tc.token(p_tag text) returns text language sql immutable as $$ select 'fakeTHREADS' || p_tag || '0123456789ab' $$;
create function tc.ws(p_user uuid) returns text language sql stable as $$ select public.social_mobile_account_deletion_workspace(p_user) $$;
create function tc.state(p_tag text) returns uuid language sql stable as $$
  select s.id from public.social_account_oauth_states s where s.state_hash = tc.h(p_tag) $$;
-- The whole reviewed connect, as H5's owner transport would run it: begin; record the numbers (G4-09); then in ONE
-- subtransaction complete (PR #124) + attest (G4-09) + custody (G4, same transaction as the verification). The account id.
create function tc.connect_all(p_user uuid, p_tag text, p_puid text) returns text language plpgsql as $$
declare v_account text; v_state uuid;
begin
  v_account := tc.as_person(p_user, format('select social_account_id from public.begin_social_mobile_threads_oauth_connection(%L, %L, now() + interval ''5 minutes'')',
                                           tc.h(p_tag), 'https://app.postona.test/oauth/threads/callback'));
  if v_account like 'ERR:%' then return v_account; end if;
  v_state := tc.state(p_tag);
  perform postona_threads_binding.record_state_generation(p_user, v_state,
    private.account_lifecycle_brand_owner_epoch(tc.ws(p_user)), (select a.lifecycle_version from public.common_accounts a where a.user_id = p_user));
  begin
    perform tc.claims(p_user, tc.session(p_user));
    perform public.complete_social_mobile_threads_oauth_connection(v_state, p_puid, 'h' || p_puid, tc.token(p_tag),
                                                                   tc.attest(v_state, p_puid, 'h' || p_puid, tc.token(p_tag)));
    perform tc.claims(null, null);
    perform postona_threads_binding.attest_binding(p_user, v_state, p_puid);
    perform tc.claims(p_user, tc.session(p_user));
    perform public.record_threads_credential_custody(v_account, now() + interval '30 days');
    perform tc.claims(null, null);
  exception when others then
    perform tc.claims(null, null);
    return 'ERR:' || sqlerrm;
  end;
  return v_account;
end $$;
create function tc.cred(p_account text, p_key text default 'x_autopost') returns text language sql stable as $$
  select coalesce((select string_agg(r.social_account_id || '|' || r.threads_user_id || '|' || r.access_token || '|' || r.generation, ';')
                   from postona_threads_credential.credential_row(p_account, p_key) r), '<none>') $$;
create function tc.gen(p_account text) returns text language sql stable as $$
  select postona_threads_resv.threads_credential_generation(p_account) $$;
create function tc.snap() returns text language sql stable set timezone = 'UTC' as $$
  select md5(concat_ws('|',
    (select string_agg(t::text, ',' order by t.id) from public.social_accounts t),
    (select string_agg(t::text, ',' order by t.id) from vault.secrets t),
    (select string_agg(t::text, ',' order by t.social_account_id) from public.threads_account_credential_custody t),
    (select string_agg(t::text, ',' order by t.social_account_id) from postona_threads_binding.bindings t),
    (select string_agg(t::text, ',' order by t.user_id) from public.common_accounts t))) $$;
-- An account connected through the whole flow, for one case. Returns its id.
create function tc.fresh(p_n integer, p_puid text) returns text language plpgsql as $$
declare v_user uuid := tc.enroll(p_n); v text;
begin
  v := tc.connect_all(v_user, 'u' || p_n, p_puid);
  perform tc.check(v like 'sa_%', 'connect ' || p_n || ': ' || v);
  perform tc.check(tc.cred(v) like v || '|' || p_puid || '|%', 'credential before the change ' || p_n || ': ' || tc.cred(v));
  return v;
end $$;

-- 0. No API role reaches 001, nor through the delegate role authenticated may SET ROLE to; the ACL names the owner only.
do $$
declare r text; v_owner oid := (select oid from pg_roles where rolname = current_user);
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    begin
      execute format('set local role %I', r);
      perform 1 from postona_threads_credential.credential_row('sa_x', 'x_autopost');
      reset role;
      raise exception 'FAIL 0 % reached credential_row', r;
    exception when insufficient_privilege then
      reset role;
    end;
  end loop;
  perform tc.check(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                               where p.oid = 'postona_threads_credential.credential_row(text,text)'::regprocedure and a.grantee <> v_owner)
                   and (select p.proacl is not null from pg_proc p where p.oid = 'postona_threads_credential.credential_row(text,text)'::regprocedure),
                   '0 the function ACL names only the owner');
end $$;
set role authenticated;
set role :"delegate";
do $$
begin
  perform 1 from postona_threads_credential.credential_row('sa_x', 'x_autopost');
  raise exception 'FAIL 0 the delegate (authenticated SET ROLE) reached credential_row';
exception when insufficient_privilege then null;
end $$;
reset role;

-- 1. The whole connect, then ONE row: this account, its Threads user, its token and G3's generation (64 hex), together.
select tc.enroll(1) as a \gset
select tc.connect_all(:'a', 'a1', '17841400000000001') as acct_a \gset
select tc.check(:'acct_a' ~ '^[a-z][a-z0-9_]{1,80}$', '1 a real (text) account id: ' || :'acct_a');
select tc.check(tc.cred(:'acct_a') = format('%s|17841400000000001|%s|%s', :'acct_a', tc.token('a1'), tc.gen(:'acct_a')), '1 the row: ' || tc.cred(:'acct_a'));
select tc.check(tc.gen(:'acct_a') ~ '^[0-9a-f]{64}$', '1 G3 generation is 64 lowercase hex');
select tc.check((select array_agg(x order by o) from unnest(
                   (select p.proargnames from pg_proc p where p.oid = 'postona_threads_credential.credential_row(text,text)'::regprocedure)) with ordinality t(x, o) where o > 2)
                = array['social_account_id', 'threads_user_id', 'access_token', 'generation'], '1 the four columns G4-02 expects');
select tc.snap() as s0 \gset

-- 2. Only the common POSTONA key; the key alone is not enough (every other case below uses it and still gets nothing).
select tc.check(tc.cred(:'acct_a', 'kabumori') = '<none>' and tc.cred(:'acct_a', null) = '<none>' and tc.cred(:'acct_a', 'X_AUTOPOST') = '<none>'
                and tc.cred(:'acct_a', '') = '<none>' and tc.cred(:'acct_a', 'x_autopost ') = '<none>', '2 other keys: no row');
select tc.check(tc.cred('sa_no_such_account') = '<none>' and tc.cred(null) = '<none>' and tc.cred('') = '<none>', '2 unknown account: no row');

-- 3. No binding (a connect that never attested, or one removed): no row.
select tc.fresh(3, '17841400000000003') as acct_c \gset
delete from postona_threads_binding.bindings where social_account_id = :'acct_c';
select tc.check(tc.cred(:'acct_c') = '<none>', '3 no binding');

-- 4. The account now carries another Threads user than the one bound: no row.
select tc.fresh(4, '17841400000000004') as acct_d \gset
update public.social_accounts set platform_user_id = '17841400000000444' where id = :'acct_d';
select tc.check(tc.cred(:'acct_d') = '<none>', '4 another Threads user on the account');

-- 5. Owner A -> B -> A after the binding (W1 OWNER_EPOCH_CHANGED): no row.
select tc.fresh(5, '17841400000000005') as acct_e \gset
select tc.enroll(51) as e2 \gset
select tc.uid(5) as e \gset
update public.brand_memberships set role = 'admin' where brand_id = tc.ws(:'e') and user_id = :'e';
insert into public.brand_memberships (brand_id, user_id, role) values (tc.ws(:'e'), :'e2', 'owner');
delete from public.brand_memberships where brand_id = tc.ws(:'e') and user_id = :'e2';
update public.brand_memberships set role = 'owner' where brand_id = tc.ws(:'e') and user_id = :'e';
select tc.check(private.account_lifecycle_worker_brand_verdict(tc.ws(:'e'), 'x_autopost',
                  (select b.owner_epoch from postona_threads_binding.bindings b where b.social_account_id = :'acct_e'),
                  (select b.lifecycle_version from postona_threads_binding.bindings b where b.social_account_id = :'acct_e')) = 'OWNER_EPOCH_CHANGED', '5 W1 says the epoch moved');
select tc.check(tc.cred(:'acct_e') = '<none>', '5 A -> B -> A');

-- 6. The service ended and restarted after the binding (lifecycle_version moved; W1 SERVICE_GENERATION_CHANGED): no row.
select tc.fresh(6, '17841400000000006') as acct_f \gset
update public.common_accounts set lifecycle_version = lifecycle_version + 2 where user_id = tc.uid(6); -- SYNTHETIC: end + restart
select tc.check(tc.cred(:'acct_f') = '<none>', '6 ended and restarted');

-- 7. Two owners now (no single owner): no row.
select tc.fresh(7, '17841400000000007') as acct_g \gset
select tc.enroll(71) as g2 \gset
insert into public.brand_memberships (brand_id, user_id, role) values (tc.ws(tc.uid(7)), :'g2', 'owner');
select tc.check(tc.cred(:'acct_g') = '<none>', '7 two owners');

-- 8. Disconnected (not identity_verified): no row.
select tc.fresh(8, '17841400000000008') as acct_h \gset
update public.social_accounts set connection_status = 'unconnected' where id = :'acct_h';
select tc.check(tc.cred(:'acct_h') = '<none>', '8 disconnected');

-- 9. Custody: expired, missing, or about another secret (rotated without a recorded custody): no row.
select tc.fresh(9, '17841400000000009') as acct_i \gset
update public.threads_account_credential_custody set expires_at = now() - interval '1 second' where social_account_id = :'acct_i';
select tc.check(tc.cred(:'acct_i') = '<none>', '9 expired token');
select tc.fresh(10, '17841400000000010') as acct_j \gset
delete from public.threads_account_credential_custody where social_account_id = :'acct_j';
select tc.check(tc.cred(:'acct_j') = '<none>', '9 no custody');
select tc.fresh(11, '17841400000000011') as acct_k \gset
update public.social_accounts set vault_access_token_secret_id = vault.create_secret('fakeTHREADSswapped0123456789ab', 'swap_' || :'acct_k') where id = :'acct_k';
select tc.check(tc.cred(:'acct_k') = '<none>', '9 another Vault secret than the one in custody');

-- 10. The Vault secret is gone: no row.
select tc.fresh(12, '17841400000000012') as acct_l \gset
delete from vault.secrets where id = (select vault_access_token_secret_id from public.social_accounts where id = :'acct_l');
select tc.check(tc.cred(:'acct_l') = '<none>', '10 secret gone');

-- 11. A rotation (SYNTHETIC: the secret updated in place and the custody re-recorded): the new token comes with a NEW
--     generation, from the same call; the old generation is never paired with the new token.
select tc.fresh(13, '17841400000000013') as acct_m \gset
select tc.gen(:'acct_m') as gen_m0 \gset
update vault.secrets set secret = 'fakeTHREADSrotated0123456789ab' where id = (select vault_access_token_secret_id from public.social_accounts where id = :'acct_m');
update public.threads_account_credential_custody set recorded_at = clock_timestamp() where social_account_id = :'acct_m';
select tc.check(tc.cred(:'acct_m') = format('%s|17841400000000013|fakeTHREADSrotated0123456789ab|%s', :'acct_m', tc.gen(:'acct_m'))
                and tc.gen(:'acct_m') <> :'gen_m0', '11 rotated: new token, new generation');

-- 12. Beyond 2^53: a lifecycle_version that a JS number would round still matches exactly (bigint end to end).
select tc.enroll(14) as p \gset
update public.common_accounts set lifecycle_version = 9007199254740993 where user_id = :'p';
select tc.connect_all(:'p', 'p1', '17841400000000014') as acct_p \gset
select tc.check((select b.lifecycle_version = 9007199254740993 from postona_threads_binding.bindings b where b.social_account_id = :'acct_p')
                and tc.cred(:'acct_p') like :'acct_p' || '|17841400000000014|%', '12 exact bigint');

-- 13a. The binding row names another binder than the workspace's owner (a corrupted or foreign row): no row.
select tc.fresh(15, '17841400000000015') as acct_q \gset
update postona_threads_binding.bindings set bound_by = tc.uid(999) where social_account_id = :'acct_q';
select tc.check(tc.cred(:'acct_q') = '<none>', '13a bound by someone else');

-- 13. Reading writes nothing.
select tc.snap() as s1 \gset
select tc.cred(:'acct_a') as ignore \gset
select tc.cred(:'acct_c') as ignore \gset
select tc.cred(:'acct_a', 'kabumori') as ignore \gset
select tc.check(tc.snap() = :'s1', '13 credential_row writes nothing');

select 'POSTONA_THREADS_CREDENTIAL_ATOMIC_BEHAVIOR_PASS' as result;
