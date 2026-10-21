-- G4-16 behavior proof of supabase/candidates/postona_threads_binding_epoch/002_custody_connect_proof.sql (G4's custody
-- writer, its "same transaction as the verified connection" check proven by 001's connect proof instead of
-- verified_at = now()). Run by postona_threads_binding_epoch_run.sh AFTER the tb prelude of
-- postona_threads_binding_epoch_behavior.sql, as the non-superuser owner, on a disposable PG17 database holding the
-- world + G4 custody + 001 + 002. Every value is fake (Vault is the fixtures' stub; tokens are fake strings).

-- The custody writer as the person (owner transport with the person's claims): 'OK' or 'ERR:...'.
create function tb.custody(p_user uuid, p_account text, p_expires timestamptz) returns text language sql as $$
  select case when r like 'ERR:%' then r else 'OK' end
    from (select tb.as_person(p_user, format('select public.record_threads_credential_custody(%L, %L::timestamptz)::text',
                                             p_account, p_expires))) x(r) $$;
-- The reviewed connect: the entry, then the custody writer, in ONE subtransaction: 'OK' or 'ERR:...' with all undone.
create function tb.connect_custody(p_user uuid, p_tag text, p_puid text, p_expires timestamptz) returns text
language plpgsql as $$
declare v_state uuid := tb.state(p_tag); v_account text;
begin
  perform tb.claims(p_user, tb.session(p_user));
  perform postona_threads_binding.complete_and_attest_binding(v_state, p_puid, 'h' || p_puid, tb.token(p_tag),
                                                              tb.attest(v_state, p_puid, 'h' || p_puid, tb.token(p_tag)));
  v_account := (select s.social_account_id from public.social_account_oauth_states s where s.id = v_state);
  perform public.record_threads_credential_custody(v_account, p_expires);
  perform tb.claims(null, null);
  return 'OK';
exception when others then
  perform tb.claims(null, null);
  return 'ERR:' || sqlerrm;
end $$;
create function tb.expiry(p_account text) returns text language sql stable as $$
  select coalesce(public.threads_account_credential_expires_at(p_account)::text, '<null>') $$;
create function tb.csnap() returns text language sql stable set timezone = 'UTC' as $$
  select md5(concat_ws('|', tb.snap(),
    (select string_agg(t::text, ',' order by t.social_account_id) from public.threads_account_credential_custody t))) $$;
create function tb.crefused(p_got text, p_want text, p_before text, p_label text) returns void language plpgsql as $$
begin
  perform tb.check(p_got = 'ERR:' || p_want, p_label || ': got ' || p_got);
  perform tb.check(tb.csnap() = p_before, p_label || ': a refusal changed something');
end $$;
create function tb.setting() returns text language sql stable as $$
  select coalesce(current_setting('postona_threads_binding.connect_proof', true), '') $$;

-- C0. The writer keeps the shape H5's custody port asserts; no API role reaches it; 002's marker is set.
select tb.check((select not p.prosecdef and p.prorettype = 'void'::regtype and p.proconfig @> array['search_path=""']
                   and obj_description(p.oid, 'pg_proc') = 'postona G4-16 connect proof'
                   and strpos(p.prosrc, 'verified_at is distinct from pg_catalog.now()') = 0
                 from pg_proc p where p.oid = 'public.record_threads_credential_custody(text,timestamptz)'::regprocedure),
                'C0 writer shape: invoker, void, empty search_path, marker, no now() check');
select tb.check(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                             where p.oid = 'public.record_threads_credential_custody(text,timestamptz)'::regprocedure
                               and a.grantee <> p.proowner), 'C0 the writer ACL names only the owner');

-- C1. The reviewed connect: entry + custody in one transaction. The expiry is recorded for exactly the stored secret.
select tb.enroll(21) as u \gset
select tb.begin(:'u', 'c21a') as acct_u \gset
select tb.check(tb.record(:'u', 'c21a', tb.epoch(:'u'), tb.lifecycle(:'u')) = 'OK', 'C1 record');
select tb.check(tb.connect_custody(:'u', 'c21a', '17841400000000021', now() + interval '30 days') = 'OK', 'C1 entry + custody');
select tb.check(tb.expiry(:'acct_u') <> '<null>', 'C1 the reader has the expiry');
select tb.check((select c.vault_secret_id = a.vault_access_token_secret_id from public.threads_account_credential_custody c
                   join public.social_accounts a on a.id = c.social_account_id where c.social_account_id = :'acct_u'),
                'C1 custody names the stored secret');
select tb.check(tb.setting() = '', 'C1 no proof outside the transaction that set it');

-- C2. A later transaction (no entry in it): refused, nothing written -- whatever the account's verified_at says.
select tb.csnap() as s \gset
select tb.crefused(tb.custody(:'u', :'acct_u', now() + interval '20 days'), 'THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION', :'s', 'C2 a later transaction');
begin;
select tb.check(tb.setting() = '', 'C2 an explicit later transaction carries no proof');
select tb.crefused(tb.custody(:'u', :'acct_u', now() + interval '20 days'), 'THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION', :'s', 'C2 inside an explicit later transaction');
commit;
-- SYNTHETIC: even with verified_at set to this transaction's now() (what the old check accepted), no proof -> refused.
begin;
update public.social_accounts set verified_at = now() where id = :'acct_u';
select tb.check(tb.custody(:'u', :'acct_u', now() + interval '20 days') = 'ERR:THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION',
                'C2 verified_at = now() alone is no longer enough');
rollback;

-- C3. PR #124's complete on its own (no entry) and then custody, in ONE transaction: no proof -> refused, both undone.
select tb.enroll(22) as v \gset
select tb.begin(:'v', 'c22a') as acct_v \gset
select tb.check(tb.record(:'v', 'c22a', tb.epoch(:'v'), tb.lifecycle(:'v')) = 'OK', 'C3 record');
create function tb.complete_then_custody(p_user uuid, p_tag text, p_puid text) returns text language plpgsql as $$
declare v_state uuid := tb.state(p_tag);
begin
  perform tb.claims(p_user, tb.session(p_user));
  perform public.complete_social_mobile_threads_oauth_connection(v_state, p_puid, 'h' || p_puid, tb.token(p_tag),
                                                                 tb.attest(v_state, p_puid, 'h' || p_puid, tb.token(p_tag)));
  perform public.record_threads_credential_custody((select s.social_account_id from public.social_account_oauth_states s where s.id = v_state),
                                                   now() + interval '30 days');
  perform tb.claims(null, null);
  return 'OK';
exception when others then
  perform tb.claims(null, null);
  return 'ERR:' || sqlerrm;
end $$;
select tb.csnap() as s \gset
select tb.crefused(tb.complete_then_custody(:'v', 'c22a', '17841400000000022'), 'THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION', :'s', 'C3 complete alone then custody');

-- C4. A savepoint rolled back over a reconnect's entry takes the proof back with it: the account is the earlier
--     connect again (verified, bound, with its own old proof), and custody in the rest of the transaction is refused.
select tb.begin(:'u', 'c21b') as ignore \gset
select tb.check(tb.record(:'u', 'c21b', tb.epoch(:'u'), tb.lifecycle(:'u')) = 'OK', 'C4 record');
select tb.csnap() as s \gset
begin;
savepoint g4_16;
select tb.check(tb.connect(:'u', 'c21b', '17841400000000021') = 'OK', 'C4 reconnect entry inside the savepoint');
select tb.check(tb.setting() ~ '^[0-9a-f-]{36}$', 'C4 the proof is set inside the savepoint');
rollback to savepoint g4_16;
select tb.check(tb.setting() = '', 'C4 the proof is gone with the savepoint');
select tb.check(tb.custody(:'u', :'acct_u', now() + interval '20 days') = 'ERR:THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION', 'C4 custody after the rolled-back entry');
commit;
select tb.check(tb.csnap() = :'s', 'C4 nothing changed');

-- C5. Entry + custody, then ROLLBACK: nothing stays (no consumed state, no binding change, no custody change).
begin;
select tb.check(tb.connect_custody(:'u', 'c21b', '17841400000000021', now() + interval '40 days') = 'OK', 'C5 entry + custody');
rollback;
select tb.check(tb.csnap() = :'s', 'C5 the rollback undid entry and custody together');

-- C6. The proof is one account's: an entry for A, then custody for B (connected earlier, bound) in the same transaction
--     is refused; custody for A is accepted.
select tb.enroll(23) as w \gset
select tb.begin(:'w', 'c23a') as acct_w \gset
select tb.check(tb.record(:'w', 'c23a', tb.epoch(:'w'), tb.lifecycle(:'w')) = 'OK', 'C6 record');
create function tb.entry_then_other(p_user uuid, p_tag text, p_puid text, p_other_user uuid, p_other text) returns text
language plpgsql as $$
declare v_state uuid := tb.state(p_tag); v text;
begin
  perform tb.claims(p_user, tb.session(p_user));
  perform postona_threads_binding.complete_and_attest_binding(v_state, p_puid, 'h' || p_puid, tb.token(p_tag),
                                                              tb.attest(v_state, p_puid, 'h' || p_puid, tb.token(p_tag)));
  v := tb.custody(p_other_user, p_other, now() + interval '20 days');
  if v <> 'ERR:THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION' then raise exception 'FAIL C6 custody for the other account: %', v; end if;
  v := tb.custody(p_user, (select s.social_account_id from public.social_account_oauth_states s where s.id = v_state), now() + interval '30 days');
  if v <> 'OK' then raise exception 'FAIL C6 custody for the connected account: %', v; end if;
  return 'OK';
end $$;
select tb.csnap() as s \gset
select tb.check(tb.entry_then_other(:'w', 'c23a', '17841400000000023', :'u', :'acct_u') = 'OK', 'C6 entry for W: custody for U refused, for W accepted');
select tb.check(tb.expiry(:'acct_w') <> '<null>', 'C6 W has its expiry');

-- C7. Two entries in one transaction: the proof is the LAST one's (one connect per transaction).
select tb.enroll(24) as x \gset
select tb.begin(:'x', 'c24a') as acct_x \gset
select tb.check(tb.record(:'x', 'c24a', tb.epoch(:'x'), tb.lifecycle(:'x')) = 'OK', 'C7 record x');
select tb.enroll(25) as y \gset
select tb.begin(:'y', 'c25a') as acct_y \gset
select tb.check(tb.record(:'y', 'c25a', tb.epoch(:'y'), tb.lifecycle(:'y')) = 'OK', 'C7 record y');
begin;
select tb.check(tb.connect(:'x', 'c24a', '17841400000000024') = 'OK' and tb.connect(:'y', 'c25a', '17841400000000025') = 'OK', 'C7 two entries');
select tb.check(tb.custody(:'x', :'acct_x', now() + interval '30 days') = 'ERR:THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION', 'C7 the first account: refused');
select tb.check(tb.custody(:'y', :'acct_y', now() + interval '30 days') = 'OK', 'C7 the last account: accepted');
commit;

-- C8. Two owners: the entry by X, then custody as the second owner in the same transaction -- refused (bound_by).
select tb.begin(:'x', 'c24b') as ignore \gset
select tb.check(tb.record(:'x', 'c24b', tb.epoch(:'x'), tb.lifecycle(:'x')) = 'OK', 'C8 record');
create function tb.second_owner_custody(p_user uuid, p_tag text, p_puid text, p_second uuid) returns text language plpgsql as $$
declare v_state uuid := tb.state(p_tag); v_account text; v text;
begin
  perform tb.claims(p_user, tb.session(p_user));
  perform postona_threads_binding.complete_and_attest_binding(v_state, p_puid, 'h' || p_puid, tb.token(p_tag),
                                                              tb.attest(v_state, p_puid, 'h' || p_puid, tb.token(p_tag)));
  v_account := (select s.social_account_id from public.social_account_oauth_states s where s.id = v_state);
  insert into public.brand_memberships (brand_id, user_id, role) values (tb.ws(p_user), p_second, 'owner');
  v := tb.custody(p_second, v_account, now() + interval '30 days');
  raise exception 'C8_RESULT %', v;
exception when others then
  perform tb.claims(null, null);
  return sqlerrm;
end $$;
select tb.csnap() as s \gset
select tb.check(tb.second_owner_custody(:'x', 'c24b', '17841400000000024', :'y') = 'C8_RESULT ERR:THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION',
                'C8 a second owner cannot record custody on the first owner''s connect');
select tb.check(tb.csnap() = :'s', 'C8 nothing stays');

-- C9. The account no longer carries the bound Threads user (changed after the entry, same transaction): refused.
create function tb.identity_changed_custody(p_user uuid, p_tag text, p_puid text) returns text language plpgsql as $$
declare v_state uuid := tb.state(p_tag); v_account text; v text;
begin
  perform tb.claims(p_user, tb.session(p_user));
  perform postona_threads_binding.complete_and_attest_binding(v_state, p_puid, 'h' || p_puid, tb.token(p_tag),
                                                              tb.attest(v_state, p_puid, 'h' || p_puid, tb.token(p_tag)));
  v_account := (select s.social_account_id from public.social_account_oauth_states s where s.id = v_state);
  update public.social_accounts set platform_user_id = '17841400000000999' where id = v_account; -- SYNTHETIC
  v := tb.custody(p_user, v_account, now() + interval '30 days');
  raise exception 'C9_RESULT %', v;
exception when others then
  perform tb.claims(null, null);
  return sqlerrm;
end $$;
select tb.check(tb.identity_changed_custody(:'x', 'c24b', '17841400000000024') = 'C9_RESULT ERR:THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION',
                'C9 another Threads user on the account');
select tb.check(tb.csnap() = :'s', 'C9 nothing stays');

-- C10. Reconnect: a new entry, a new proof, a new expiry; the old proof is not the new binding's.
select tb.connect_custody(:'u', 'c21b', '17841400000000021', now() + interval '45 days') as r \gset
select tb.check(:'r' = 'OK', 'C10 reconnect with custody: ' || :'r');
select tb.check((select b.oauth_state_id = tb.state('c21b') from postona_threads_binding.bindings b where b.social_account_id = :'acct_u'), 'C10 the binding is the new state''s');
select tb.check(tb.expiry(:'acct_u')::timestamptz > now() + interval '44 days', 'C10 the new expiry');

-- C11. The proof is not a secret: a uuid, never the token, never in the custody row.
select tb.enroll(26) as z \gset
select tb.begin(:'z', 'c26a') as acct_z \gset
select tb.check(tb.record(:'z', 'c26a', tb.epoch(:'z'), tb.lifecycle(:'z')) = 'OK', 'C11 record');
begin;
select tb.check(tb.connect(:'z', 'c26a', '17841400000000026') = 'OK', 'C11 entry');
select tb.check(tb.setting() ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                and strpos(tb.setting(), tb.token('c26a')) = 0
                and tb.setting() = (select b.connect_proof::text from postona_threads_binding.bindings b where b.social_account_id = :'acct_z'),
                'C11 the proof is a random uuid, the binding''s, not the token');
select tb.check(tb.custody(:'z', :'acct_z', now() + interval '30 days') = 'OK', 'C11 custody in the same transaction');
commit;
select tb.check((select strpos(t::text, tb.token('c26a')) = 0 from public.threads_account_credential_custody t where t.social_account_id = :'acct_z'),
                'C11 the custody row holds no token');

-- C12. The writer's other checks are unchanged: expiry bounds, no claims.
select tb.begin(:'z', 'c26b') as ignore \gset
select tb.check(tb.record(:'z', 'c26b', tb.epoch(:'z'), tb.lifecycle(:'z')) = 'OK', 'C12 record');
select tb.check(tb.connect_custody(:'z', 'c26b', '17841400000000026', clock_timestamp() - interval '1 second') = 'ERR:THREADS_CUSTODY_EXPIRY_INVALID'
                and tb.connect_custody(:'z', 'c26b', '17841400000000026', now() + interval '62 days') = 'ERR:THREADS_CUSTODY_EXPIRY_INVALID',
                'C12 expiry bounds (and the entry is undone with the refusal)');
select tb.check(tb.try(format('select public.record_threads_credential_custody(%L, now() + interval ''1 day'')', :'acct_z')) = 'ERR:THREADS_CUSTODY_AUTH_REQUIRED',
                'C12 no claims');

-- C13. No API role and no delegate reaches the writer.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    begin
      execute format('set local role %I', r);
      perform public.record_threads_credential_custody('sa_x', now() + interval '1 day');
      reset role;
      raise exception 'FAIL C13 % reached the custody writer', r;
    exception when insufficient_privilege then
      reset role;
    end;
  end loop;
end $$;

select 'POSTONA_THREADS_BINDING_CUSTODY_BEHAVIOR_PASS' as result;
