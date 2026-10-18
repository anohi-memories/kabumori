-- F4 / G4 M1: X identity and the server-only credential handoff, one session, on the runner's world + the fixture.
-- Every person is created here; every value is fake. (Post-COMMIT checks below run in later transactions of this
-- session; the e2e repeats R1 / R2 from separate psql sessions with a counting fake X.)
\set ON_ERROR_STOP 1
set timezone = 'UTC';

-- 0. Access: no API role reaches G4's functions, the attestation record or F3's bound predicate (PR #257 K6).
do $$
declare r text; s text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    foreach s in array array[
      'select public.x_posting_access_token_for(''sa_x'')', 'select public.x_account_g4_verified(gen_random_uuid(), ''sa_x'')',
      'select public.x_account_attested_owner(''sa_x'')', 'select * from public.x_posting_credential_row(''sa_x'')',
      'select * from public.x_posting_credential_for(''sa_x'')', 'select public.x_account_attest_refreshed_credential(''sa_x'', repeat(''0'', 64), repeat(''0'', 64))',
      'select 1 from public.x_account_identity_attestations', 'select postona_x_resv.g4_x_account_verified(gen_random_uuid(), ''sa_x'')'] loop
      perform xg.check(xg.try_as(r, s) = '42501', 'ACL ' || r || ': ' || s);
    end loop;
  end loop;
end $$;

-- 1. An attested connect: verified for its person only; the handoff is that account's own token; credentialFor answers
--    it together with F3's own 64-hex generation; F3's predicate agrees.
select xg.enroll(101) as a \gset
select xg.connect_v2(:'a', 'a1', '1101', 'A') as acct_a \gset
select xg.check(:'acct_a' like 'sa_%', '1 connect: ' || :'acct_a');
select xg.check(xg.view(:'a', :'acct_a') = xg.ok_view(:'a', :'acct_a', 'A'), '1 view ' || xg.view(:'a', :'acct_a'));
select xg.check((select c.token = xg.access('A') and c.generation = postona_x_resv.x_credential_generation(:'acct_a') and c.generation ~ '^[0-9a-f]{64}$'
                 from public.x_posting_credential_for(:'acct_a') c), '1 credentialFor = token + F3 generation');
select xg.check(postona_x_resv.g4_x_account_verified(:'a', :'acct_a'), '1 F3 predicate bound to G4');
select xg.check((select a.user_id = :'a' and a.platform_user_id = '1101' and a.verified_at = sa.verified_at
                        and a.access_token_sha256 = xg.sha(xg.access('A')) and a.refresh_token_sha256 = xg.sha(xg.refresh('A'))
                        and a.owner_epoch = private.account_lifecycle_brand_owner_epoch(sa.brand_id) and a.owner_epoch > 0
                        and a.brand_id = public.social_mobile_account_deletion_workspace(:'a')
                 from public.x_account_identity_attestations a join public.social_accounts sa on sa.id = a.social_account_id
                 where a.social_account_id = :'acct_a'), '1 attestation record (digests, owner epoch)');
select xg.enroll(102) as b \gset
select xg.connect_v2(:'b', 'b1', '1102', 'B') as acct_b \gset
select xg.check(public.x_account_g4_verified(:'b', :'acct_a') is false and public.x_account_g4_verified(:'a', :'acct_b') is false, '1 never for another person');
select xg.check(public.x_posting_access_token_for(:'acct_b') = xg.access('B') and xg.access('A') <> xg.access('B'), '1 each account its own token (C4)');
select xg.check(public.x_account_g4_verified(:'a', 'sa_no_such_account') is false and public.x_posting_access_token_for('sa_no_such_account') is null
                and public.x_posting_access_token_for('Not A Valid Id') is null and public.x_posting_access_token_for(null) is null
                and not exists (select 1 from public.x_posting_credential_for('sa_no_such_account')), '1 unknown / malformed: null');

-- 2. Provider identity claimed by the client (the live v1 complete) is never proof: v1-only, a v1 overwrite of an
--    attested account (later transaction), even v1 re-submitting the very same tokens -- unverified until a new attested
--    connect, which gives a new generation.
select xg.enroll(103) as c \gset
select xg.connect_v1(:'c', 'c1', '1103', 'C') as acct_c \gset
select xg.check(:'acct_c' like 'sa_%' and (select connection_status from public.social_accounts where id = :'acct_c') = 'identity_verified', '2 v1 connected: ' || :'acct_c');
select xg.check(xg.view(:'c', :'acct_c') = xg.denied(), '2 v1-only identity: ' || xg.view(:'c', :'acct_c'));
select xg.check(postona_x_resv.g4_x_account_verified(:'c', :'acct_c') is false, '2 F3 predicate refuses a v1-only identity');
select xg.gen(:'acct_a') as gen_a1 \gset
select xg.check(xg.connect_v1(:'a', 'a2', '1101', 'A-V1') = :'acct_a', '2 v1 overwrite of the attested account');
select xg.check(xg.view(:'a', :'acct_a') = xg.denied(), '2 after a v1 overwrite: ' || xg.view(:'a', :'acct_a'));
select xg.check(xg.connect_v2(:'a', 'a3', '1101', 'A2') = :'acct_a', '2 attested reconnect');
select xg.check(xg.view(:'a', :'acct_a') = xg.ok_view(:'a', :'acct_a', 'A2'), '2 reconnected: ' || xg.view(:'a', :'acct_a'));
select xg.check(xg.gen(:'acct_a') <> :'gen_a1', '2 a reconnect changes the generation');
select xg.check(xg.connect_v1(:'a', 'a3b', '1101', 'A2') = :'acct_a', '2 v1 re-submitting the same tokens');
select xg.check(xg.view(:'a', :'acct_a') = xg.denied(), '2 any later v1 completion ends the attested state: ' || xg.view(:'a', :'acct_a'));
select xg.check(xg.connect_v2(:'a', 'a3c', '1101', 'A2') = :'acct_a', '2 attested again (connect)');
select xg.check(xg.view(:'a', :'acct_a') = xg.ok_view(:'a', :'acct_a', 'A2'), '2 attested again: ' || xg.view(:'a', :'acct_a'));

-- 3. The attestation itself: a wrong one, another state's, another X id, a replayed (used) state -- refused, nothing changes.
select row(a.*)::text as att_a from public.x_account_identity_attestations a where a.social_account_id = :'acct_a' \gset
select xg.check(xg.connect_v2(:'a', 'a4', '1101', 'A3', repeat('0', 64)) = 'ERR:X_CONNECT_ATTESTATION_INVALID', '3 wrong attestation');
select xg.check(xg.connect_v2(:'a', 'a5', '1101', 'A4', xg.attest('00000000-0000-4000-8000-000000000000', '1101', 'h1101', xg.access('A4'), xg.refresh('A4'))) = 'ERR:X_CONNECT_ATTESTATION_INVALID', '3 attestation of another state');
select xg.check(xg.connect_v2(:'a', 'a6', '9999', 'A5') = 'ERR:X_IDENTITY_ACCOUNT_MISMATCH', '3 another X identity on this account');
select xg.check((select row(a.*)::text from public.x_account_identity_attestations a where a.social_account_id = :'acct_a') = :'att_a', '3 nothing recorded');
select s.id as used_state from public.social_account_oauth_states s where s.state_hash = xg.h('a3c') \gset
select xg.check(xg.as_person(:'a', format('select public.complete_social_mobile_x_oauth_connection_v2(%L::uuid, %L, %L, %L, %L, %L)::text',
                :'used_state', '1101', 'h1101', xg.access('A9'), xg.refresh('A9'), xg.attest(:'used_state'::uuid, '1101', 'h1101', xg.access('A9'), xg.refresh('A9'))))
                = 'ERR:OAUTH_STATE_NOT_CONSUMABLE', '3 duplicate callback of a used state');
select xg.check((select row(a.*)::text from public.x_account_identity_attestations a where a.social_account_id = :'acct_a') = :'att_a'
                and xg.view(:'a', :'acct_a') = xg.ok_view(:'a', :'acct_a', 'A2'), '3 the duplicate changed nothing');

-- R1 (J2 V2). In ONE transaction: the signed v2 connect, then the unsigned v1 complete with other tokens. now() is the
-- same for both, the Vault references are the same -- after COMMIT the account must still be unverified (content).
begin;
select xg.enroll(110) as r1 \gset
select xg.connect_v2(:'r1', 'r1v2', '1110', 'R1-SIGNED') as acct_r1 \gset
select xg.check(xg.connect_v1(:'r1', 'r1v1', '1110', 'R1-UNSIGNED') = :'acct_r1', 'R1 same-transaction v1 overwrite');
select xg.check((select verified_at = now() from public.social_accounts where id = :'acct_r1'), 'R1 verified_at is the same now()');
commit;
select xg.check(xg.view(:'r1', :'acct_r1') = xg.denied(), 'R1 after COMMIT: ' || xg.view(:'r1', :'acct_r1'));
select xg.check(postona_x_resv.g4_x_account_verified(:'r1', :'acct_r1') is false, 'R1 F3 predicate refuses');
-- The same in one transaction but v1 re-stating exactly the signed tokens: the credential IS the attested one.
begin;
select xg.enroll(111) as r1b \gset
select xg.connect_v2(:'r1b', 'r1bv2', '1111', 'R1B') as acct_r1b \gset
select xg.check(xg.connect_v1(:'r1b', 'r1bv1', '1111', 'R1B') = :'acct_r1b', 'R1 same-transaction v1 with the signed tokens');
commit;
select xg.check(xg.view(:'r1b', :'acct_r1b') = xg.ok_view(:'r1b', :'acct_r1b', 'R1B'), 'R1 identical signed content stays usable: ' || xg.view(:'r1b', :'acct_r1b'));
-- Only the refresh token replaced in place (any other credential writer): unverified.
select vault.update_secret((select vault_refresh_token_secret_id from public.social_accounts where id = :'acct_r1b'), 'fake-x-refresh-OTHER-0123456789');
select xg.check(xg.view(:'r1b', :'acct_r1b') = xg.denied(), 'R1 the refresh token replaced in place');

-- 4. The person's POSTONA (F5): every state that is not active -> unverified, no token; back to active -> both again.
select xg.state(:'a', 'ended');
select xg.check(public.x_account_g4_verified(:'a', :'acct_a') is false and public.x_posting_access_token_for(:'acct_a') is null, '4 ended');
select xg.state(:'a', 'active');
select xg.state(:'a', 'suspended');
select xg.check(public.x_account_g4_verified(:'a', :'acct_a') is false and public.x_posting_access_token_for(:'acct_a') is null, '4 suspended');
select xg.state(:'a', 'active');
select xg.state(:'a', 'locked');
select xg.check(public.x_account_g4_verified(:'a', :'acct_a') is false and public.x_posting_access_token_for(:'acct_a') is null, '4 locked');
select xg.state(:'a', 'active');
select xg.state(:'a', 'account_deleting');
select xg.check(public.x_account_g4_verified(:'a', :'acct_a') is false and public.x_posting_access_token_for(:'acct_a') is null, '4 account deletion');
select xg.state(:'a', 'active');
select xg.state(:'a', 'service_deleting');
select xg.check(public.x_account_g4_verified(:'a', :'acct_a') is false and public.x_posting_access_token_for(:'acct_a') is null, '4 POSTONA deletion');
select xg.state(:'a', 'active');
select xg.check(xg.view(:'a', :'acct_a') = xg.ok_view(:'a', :'acct_a', 'A2'), '4 active again');

-- 5. The workspace: no longer a self-service workspace (F5's owner rule), a deletion tombstone -> unverified.
update public.brands set code_profile_key = 'social_mobile_user_v0' where id = public.social_mobile_account_deletion_workspace(:'a');
select xg.check(xg.view(:'a', :'acct_a') = xg.denied(), '5 not a self-service workspace (F5 owner rule)');
update public.brands set code_profile_key = 'social_mobile_user_v1' where id = public.social_mobile_account_deletion_workspace(:'a');
select xg.check(xg.view(:'a', :'acct_a') = xg.ok_view(:'a', :'acct_a', 'A2'), '5 restored');
select xg.enroll(105) as e \gset
select xg.connect_v2(:'e', 'e1', '1105', 'E') as acct_e \gset
insert into public.social_mobile_account_deletions (user_id, workspace_id, state, scope, credential_set)
values (:'e', public.social_mobile_account_deletion_workspace(:'e'), 'started', 'social_only', '[]'::jsonb);
select xg.check(xg.view(:'e', :'acct_e') = xg.denied(), '5 workspace being deleted (K4)');

-- R2 (J2 V2). Owner A -> B, then B -> A, in three committed transactions: never verified again without a new attested
-- connect (F5's owner epoch moved on), which then gives a new generation. Also a second owner, and the same person's
-- owner -> admin -> owner.
select xg.enroll(120) as r2 \gset
select xg.connect_v2(:'r2', 'r2a', '1120', 'R2') as acct_r2 \gset
select xg.gen(:'acct_r2') as gen_r2 \gset
select xg.enroll(121) as r2b \gset
update public.brand_memberships set user_id = :'r2b' where brand_id = public.social_mobile_account_deletion_workspace(:'r2') and user_id = :'r2' and role = 'owner';
select xg.check(xg.view(:'r2', :'acct_r2') = xg.denied() and xg.view(:'r2b', :'acct_r2') = xg.denied(), 'R2 A -> B');
update public.brand_memberships set user_id = :'r2' where brand_id = public.social_mobile_account_deletion_workspace(:'r2') and user_id = :'r2b' and role = 'owner';
select xg.check(xg.view(:'r2', :'acct_r2') = xg.denied(), 'R2 B -> A: the old attestation does NOT revive: ' || xg.view(:'r2', :'acct_r2'));
select xg.check(xg.gen(:'acct_r2') = 'null', 'R2 nor its generation');
select xg.check(xg.connect_v2(:'r2', 'r2b', '1120', 'R2-NEW') = :'acct_r2', 'R2 a new attested connect');
select xg.check(xg.view(:'r2', :'acct_r2') = xg.ok_view(:'r2', :'acct_r2', 'R2-NEW'), 'R2 verified again: ' || xg.view(:'r2', :'acct_r2'));
select xg.check(xg.gen(:'acct_r2') <> :'gen_r2', 'R2 with a new generation');
update public.brand_memberships set role = 'admin' where brand_id = public.social_mobile_account_deletion_workspace(:'r2') and user_id = :'r2';
update public.brand_memberships set role = 'owner' where brand_id = public.social_mobile_account_deletion_workspace(:'r2') and user_id = :'r2';
select xg.check(xg.view(:'r2', :'acct_r2') = xg.denied(), 'R2 owner -> admin -> owner of the same person');
select xg.check(xg.connect_v2(:'r2', 'r2c', '1120', 'R2-C') = :'acct_r2', 'R2 reattested');
insert into public.brand_memberships (brand_id, user_id, role) values (public.social_mobile_account_deletion_workspace(:'r2'), :'r2b', 'owner');
select xg.check(xg.view(:'r2', :'acct_r2') = xg.denied() and xg.view(:'r2b', :'acct_r2') = xg.denied(), 'R2 a second owner');
delete from public.brand_memberships where brand_id = public.social_mobile_account_deletion_workspace(:'r2') and user_id = :'r2b';
select xg.check(xg.view(:'r2', :'acct_r2') = xg.denied(), 'R2 the second owner removed: still not revived');

-- 6. The credential: connection error, pending, a shared / swapped / dangling reference -> unverified, no token (K3).
select xg.enroll(106) as f \gset
select xg.connect_v2(:'f', 'f1', '1106', 'F') as acct_f \gset
update public.social_accounts set last_connection_error_code = 'X_ACCOUNT_ALREADY_CONNECTED' where id = :'acct_f';
select xg.check(xg.view(:'f', :'acct_f') = xg.denied(), '6 connection error');
update public.social_accounts set last_connection_error_code = null, connection_status = 'authorization_pending' where id = :'acct_f';
select xg.check(xg.view(:'f', :'acct_f') = xg.denied(), '6 pending');
update public.social_accounts set connection_status = 'identity_verified' where id = :'acct_f';
select xg.check(xg.view(:'f', :'acct_f') = xg.ok_view(:'f', :'acct_f', 'F'), '6 restored');
select vault_refresh_token_secret_id as f_refresh from public.social_accounts where id = :'acct_f' \gset
update public.social_accounts set vault_refresh_token_secret_id = (select vault_access_token_secret_id from public.social_accounts where id = :'acct_b') where id = :'acct_f';
select xg.check(xg.view(:'f', :'acct_f') = xg.denied() and xg.view(:'b', :'acct_b') = xg.denied(), '6 a reference shared with another account: neither');
update public.social_accounts set vault_refresh_token_secret_id = :'f_refresh'::uuid where id = :'acct_f';
select xg.check(xg.view(:'b', :'acct_b') = xg.ok_view(:'b', :'acct_b', 'B'), '6 B restored');
select vault_access_token_secret_id as f_access from public.social_accounts where id = :'acct_f' \gset
update public.social_accounts set vault_access_token_secret_id = vault.create_secret(xg.access('F'), 'f_swapped_access') where id = :'acct_f';
select xg.check(xg.view(:'f', :'acct_f') = xg.denied(), '6 the access reference swapped to another secret (even with the same content)');
update public.social_accounts set vault_access_token_secret_id = :'f_access'::uuid where id = :'acct_f';
select xg.check(xg.view(:'f', :'acct_f') = xg.ok_view(:'f', :'acct_f', 'F'), '6 restored after the swap');
delete from vault.secrets where id = :'f_refresh'::uuid;
select xg.check(xg.view(:'f', :'acct_f') = xg.denied(), '6 a dangling reference');

-- 7. Freshness: the refresh state, the recorded expiry, and a server refresh -- usable again ONLY when G4 re-attests the
--    exact tokens the refresh writer got (digests), with the refresh state idle and a newer generation.
select xg.enroll(107) as g \gset
select xg.connect_v2(:'g', 'g1', '1107', 'G') as acct_g \gset
select xg.gen(:'acct_g') as gen_g0 \gset
insert into public.x_account_refresh_state_v2 (social_account_id) values (:'acct_g') on conflict do nothing;
select xg.check(public.x_posting_access_token_for(:'acct_g') = xg.access('G'), '7 idle refresh state');
update public.x_account_refresh_state_v2 set status = 'uncertain' where social_account_id = :'acct_g';
select xg.check(public.x_posting_access_token_for(:'acct_g') is null and public.x_account_g4_verified(:'g', :'acct_g'), '7 uncertain: identity still verified, no token');
update public.x_account_refresh_state_v2 set status = 'reauth_required' where social_account_id = :'acct_g';
select xg.check(public.x_posting_access_token_for(:'acct_g') is null, '7 reauth_required: no token');
update public.x_account_refresh_state_v2 set status = 'idle' where social_account_id = :'acct_g';
update public.x_account_identity_attestations set access_expires_at = now() + interval '1 minute' where social_account_id = :'acct_g';
select xg.check(public.x_posting_access_token_for(:'acct_g') is null, '7 within 2 minutes of the recorded expiry: no token');
update public.x_account_identity_attestations set access_expires_at = now() - interval '1 hour' where social_account_id = :'acct_g';
select xg.check(public.x_posting_access_token_for(:'acct_g') is null, '7 expired: no token');
update public.x_account_identity_attestations set access_expires_at = now() + interval '1 hour' where social_account_id = :'acct_g';
-- A refresh as the refresh core commits one: the tokens in place, generation + 1, a new expiry.
select vault.update_secret((select vault_access_token_secret_id from public.social_accounts where id = :'acct_g'), xg.access('G-refreshed'));
select vault.update_secret((select vault_refresh_token_secret_id from public.social_accounts where id = :'acct_g'), xg.refresh('G-refreshed'));
select xg.check(public.x_account_attest_refreshed_credential(:'acct_g', xg.sha(xg.access('G-refreshed')), xg.sha(xg.refresh('G-refreshed'))) is false,
                '7 no re-attestation before the refresh state moved on');
update public.x_account_refresh_state_v2 set generation = generation + 1, last_refreshed_at = now(), access_expires_at = now() + interval '2 hours'
 where social_account_id = :'acct_g';
select xg.check(public.x_posting_access_token_for(:'acct_g') is null, '7 refreshed but not re-attested: no token');
select xg.check(public.x_account_attest_refreshed_credential(:'acct_g', xg.sha(xg.access('G-other')), xg.sha(xg.refresh('G-refreshed'))) is false,
                '7 re-attestation with digests that are not the stored tokens');
select xg.check(public.x_account_attest_refreshed_credential(:'acct_g', xg.sha(xg.access('G-refreshed')), xg.sha(xg.refresh('G-refreshed'))) is true,
                '7 re-attested');
select xg.check(public.x_posting_access_token_for(:'acct_g') = xg.access('G-refreshed'), '7 the refreshed token');
select xg.check(xg.gen(:'acct_g') not in ('null', :'gen_g0'), '7 a refresh changes the generation');
-- A token write with no newer refresh generation (not a refresh the refresh core committed), expiry present: refused.
select vault.update_secret((select vault_access_token_secret_id from public.social_accounts where id = :'acct_g'), xg.access('G-nogen'));
update public.x_account_refresh_state_v2 set access_expires_at = now() + interval '2 hours' where social_account_id = :'acct_g';
select xg.check(public.x_account_attest_refreshed_credential(:'acct_g', xg.sha(xg.access('G-nogen')), xg.sha(xg.refresh('G-refreshed'))) is false,
                '7 no newer refresh generation: not re-attested');
select xg.check(public.x_posting_access_token_for(:'acct_g') is null, '7 the unrefreshed write is not handed over');
-- Something writes between a refresh and its re-attestation: refused.
select vault.update_secret((select vault_access_token_secret_id from public.social_accounts where id = :'acct_g'), xg.access('G-r2'));
select vault.update_secret((select vault_access_token_secret_id from public.social_accounts where id = :'acct_g'), xg.access('G-slipped-in'));
update public.x_account_refresh_state_v2 set generation = generation + 1, last_refreshed_at = now(), access_expires_at = now() + interval '2 hours'
 where social_account_id = :'acct_g';
select xg.check(public.x_account_attest_refreshed_credential(:'acct_g', xg.sha(xg.access('G-r2')), xg.sha(xg.refresh('G-refreshed'))) is false,
                '7 a write slipped in between: not re-attested');
select xg.check(public.x_posting_access_token_for(:'acct_g') is null, '7 and nothing handed over');

-- E. F5 PR #285's owner epoch, the real candidate: NULL = unknown = refuse (never 0, never a match); a rolled-back owner
--    change moves nothing; an old epoch can never re-attest; a new attested connect recovers with the new epoch.
select xg.enroll(130) as ep \gset
select xg.enroll(131) as ep2 \gset
select xg.connect_v2(:'ep', 'ep1', '1130', 'EP') as acct_ep \gset
select xg.check(xg.view(:'ep', :'acct_ep') = xg.ok_view(:'ep', :'acct_ep', 'EP'), 'E attested: ' || xg.view(:'ep', :'acct_ep'));
select xg.check((select a.owner_epoch >= 1 and a.owner_epoch = private.account_lifecycle_brand_owner_epoch(a.brand_id)
                 from public.x_account_identity_attestations a where a.social_account_id = :'acct_ep'), 'E the recorded epoch is F5''s');
select xg.gen(:'acct_ep') as gen_ep \gset
begin;
update public.brand_memberships set user_id = :'ep2' where brand_id = public.social_mobile_account_deletion_workspace(:'ep') and user_id = :'ep' and role = 'owner';
rollback;
select xg.check(xg.view(:'ep', :'acct_ep') = xg.ok_view(:'ep', :'acct_ep', 'EP') and xg.gen(:'acct_ep') = :'gen_ep', 'E a rolled-back owner change moves nothing');
select row(a.*)::text as att_ep from public.x_account_identity_attestations a where a.social_account_id = :'acct_ep' \gset
alter table public.brand_memberships disable trigger account_lifecycle_owner_epoch_row;
select xg.check(private.account_lifecycle_brand_owner_epoch(public.social_mobile_account_deletion_workspace(:'ep')) is null, 'E F5 answers NULL when its coverage is broken');
select xg.check(xg.view(:'ep', :'acct_ep') = xg.denied(), 'E an unknown epoch never verifies: ' || xg.view(:'ep', :'acct_ep'));
select xg.check(not exists (select 1 from public.x_posting_credential_for(:'acct_ep')) and postona_x_resv.g4_x_account_verified(:'ep', :'acct_ep') is false, 'E no credential, F3 predicate false');
select xg.check(xg.connect_v2(:'ep', 'ep2', '1130', 'EP2') = 'ERR:X_OWNER_EPOCH_UNKNOWN', 'E an attested connect under an unknown epoch: fixed refusal');
select xg.check((select row(a.*)::text from public.x_account_identity_attestations a where a.social_account_id = :'acct_ep') = :'att_ep'
                and (select s.secret from vault.secrets s join public.social_accounts sa on sa.vault_access_token_secret_id = s.id where sa.id = :'acct_ep') = xg.access('EP'),
                'E the refused connect wrote nothing (record, Vault)');
alter table public.brand_memberships enable trigger account_lifecycle_owner_epoch_row;
select xg.check(xg.view(:'ep', :'acct_ep') = xg.ok_view(:'ep', :'acct_ep', 'EP'), 'E coverage back, nothing changed: usable again');
update public.brand_memberships set user_id = :'ep2' where brand_id = public.social_mobile_account_deletion_workspace(:'ep') and user_id = :'ep' and role = 'owner';
update public.brand_memberships set user_id = :'ep' where brand_id = public.social_mobile_account_deletion_workspace(:'ep') and user_id = :'ep2' and role = 'owner';
select xg.check(private.account_lifecycle_brand_owner_epoch(public.social_mobile_account_deletion_workspace(:'ep'))
                = (select a.owner_epoch + 2 from public.x_account_identity_attestations a where a.social_account_id = :'acct_ep'), 'E A -> B -> A moved F5''s epoch twice');
select xg.check(xg.view(:'ep', :'acct_ep') = xg.denied(), 'E A -> B -> A: not revived');
select vault.update_secret((select vault_access_token_secret_id from public.social_accounts where id = :'acct_ep'), xg.access('EP-refreshed'));
select vault.update_secret((select vault_refresh_token_secret_id from public.social_accounts where id = :'acct_ep'), xg.refresh('EP-refreshed'));
insert into public.x_account_refresh_state_v2 (social_account_id) values (:'acct_ep') on conflict do nothing;
update public.x_account_refresh_state_v2 set generation = generation + 1, last_refreshed_at = now(), access_expires_at = now() + interval '2 hours'
 where social_account_id = :'acct_ep';
select xg.check(public.x_account_attest_refreshed_credential(:'acct_ep', xg.sha(xg.access('EP-refreshed')), xg.sha(xg.refresh('EP-refreshed'))) is false,
                'E a refresh re-attestation under the old epoch is refused');
select xg.check(xg.view(:'ep', :'acct_ep') = xg.denied(), 'E still nothing handed over');
select xg.check(xg.connect_v2(:'ep', 'ep3', '1130', 'EP3') = :'acct_ep', 'E a new attested connect (connect)');
select xg.check(xg.view(:'ep', :'acct_ep') = xg.ok_view(:'ep', :'acct_ep', 'EP3'), 'E recovered: ' || xg.view(:'ep', :'acct_ep'));
select xg.check((select a.owner_epoch = private.account_lifecycle_brand_owner_epoch(a.brand_id) from public.x_account_identity_attestations a
                 where a.social_account_id = :'acct_ep') and xg.gen(:'acct_ep') <> :'gen_ep', 'E with the current epoch and a new generation');

-- 8. Session lost: the attested flow itself is T13-guarded (G5's real guard); a signed-out person gets nothing.
select xg.enroll(108) as h \gset
update auth.sessions set not_after = now() - interval '1 second' where user_id = :'h';
select xg.check(xg.connect_v2(:'h', 'h1', '1108', 'H') like 'ERR:ACCOUNT_LIFECYCLE_AUTH_REQUIRED%', '8 signed out: ' || xg.connect_v2(:'h', 'h2', '1108', 'H'));
select xg.check(not exists (select 1 from public.x_account_identity_attestations a where a.user_id = :'h'), '8 nothing recorded');

select 'X_IDENTITY_CREDENTIAL_BEHAVIOR_OK';
