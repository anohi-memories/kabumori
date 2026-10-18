-- F4 / G4 M1: X identity and the server-only credential handoff, one session, on the runner's world + the fixture.
-- Every person is created here; every value is fake.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

-- 0. Access: no API role reaches G4's functions, the attestation record or F3's bound predicate (PR #257 K6).
do $$
declare r text; s text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    foreach s in array array[
      'select public.x_posting_access_token_for(''sa_x'')', 'select public.x_account_g4_verified(gen_random_uuid(), ''sa_x'')',
      'select public.x_account_credential_generation(''sa_x'')', 'select public.x_account_attested_owner(''sa_x'')',
      'select 1 from public.x_account_identity_attestations', 'select postona_x_resv.g4_x_account_verified(gen_random_uuid(), ''sa_x'')'] loop
      perform xg.check(xg.try_as(r, s) = '42501', 'ACL ' || r || ': ' || s);
    end loop;
  end loop;
end $$;

-- 1. An attested connect: verified for its person only; the handoff is that account's own token; F3's predicate agrees.
select xg.enroll(101) as a \gset
select xg.connect_v2(:'a', 'a1', '1101', 'A') as acct_a \gset
select xg.check(:'acct_a' like 'sa_%', '1 connect: ' || :'acct_a');
select xg.check(xg.view(:'a', :'acct_a') = xg.ok_view(:'a', :'acct_a', 'A'), '1 view ' || xg.view(:'a', :'acct_a'));
select xg.check(postona_x_resv.g4_x_account_verified(:'a', :'acct_a'), '1 F3 predicate bound to G4');
select xg.check((select a.user_id = :'a' and a.platform_user_id = '1101' and a.verified_at = sa.verified_at
                        and a.vault_access_token_secret_id = sa.vault_access_token_secret_id
                        and a.brand_id = public.social_mobile_account_deletion_workspace(:'a')
                 from public.x_account_identity_attestations a join public.social_accounts sa on sa.id = a.social_account_id
                 where a.social_account_id = :'acct_a'), '1 attestation record');
select xg.enroll(102) as b \gset
select xg.connect_v2(:'b', 'b1', '1102', 'B') as acct_b \gset
select xg.check(public.x_account_g4_verified(:'b', :'acct_a') is false and public.x_account_g4_verified(:'a', :'acct_b') is false, '1 never for another person');
select xg.check(public.x_posting_access_token_for(:'acct_b') = xg.access('B') and xg.access('A') <> xg.access('B'), '1 each account its own token (C4)');
select xg.check(public.x_account_g4_verified(:'a', 'sa_no_such_account') is false and public.x_posting_access_token_for('sa_no_such_account') is null
                and public.x_posting_access_token_for('Not A Valid Id') is null and public.x_posting_access_token_for(null) is null, '1 unknown / malformed: null');

-- 2. Provider identity claimed by the client (the live v1 complete) is never proof: v1-only, and a v1 overwrite of an
--    attested account (same X id, other tokens) -- both unverified, no token, until the next attested connect.
select xg.enroll(103) as c \gset
select xg.connect_v1(:'c', 'c1', '1103', 'C') as acct_c \gset
select xg.check(:'acct_c' like 'sa_%' and (select connection_status from public.social_accounts where id = :'acct_c') = 'identity_verified', '2 v1 connected: ' || :'acct_c');
select xg.check(xg.view(:'c', :'acct_c') = xg.denied(), '2 v1-only identity: ' || xg.view(:'c', :'acct_c'));
select xg.check(postona_x_resv.g4_x_account_verified(:'c', :'acct_c') is false, '2 F3 predicate refuses a v1-only identity');
select public.x_account_credential_generation(:'acct_a') as gen_a1 \gset
select xg.check(xg.connect_v1(:'a', 'a2', '1101', 'A-V1') = :'acct_a', '2 v1 overwrite of the attested account');
select xg.check(xg.view(:'a', :'acct_a') = xg.denied(), '2 after a v1 overwrite: ' || xg.view(:'a', :'acct_a'));
select xg.check(xg.connect_v2(:'a', 'a3', '1101', 'A2') = :'acct_a', '2 attested reconnect');
select xg.check(xg.view(:'a', :'acct_a') = xg.ok_view(:'a', :'acct_a', 'A2'), '2 reconnected: ' || xg.view(:'a', :'acct_a'));
select xg.check(public.x_account_credential_generation(:'acct_a') <> :'gen_a1', '2 a reconnect changes the generation');

-- 3. The attestation itself: a wrong one, a fake token, a replayed (used) state -- each refused, nothing changes.
select row(a.*)::text as att_a from public.x_account_identity_attestations a where a.social_account_id = :'acct_a' \gset
select xg.check(xg.connect_v2(:'a', 'a4', '1101', 'A3', repeat('0', 64)) = 'ERR:X_CONNECT_ATTESTATION_INVALID', '3 wrong attestation');
select xg.check(xg.connect_v2(:'a', 'a5', '1101', 'A4', xg.attest('00000000-0000-4000-8000-000000000000', '1101', 'h1101', xg.access('A4'), xg.refresh('A4'))) = 'ERR:X_CONNECT_ATTESTATION_INVALID', '3 attestation of another state');
select xg.check(xg.connect_v2(:'a', 'a6', '9999', 'A5') = 'ERR:X_IDENTITY_ACCOUNT_MISMATCH', '3 another X identity on this account');
select xg.check((select row(a.*)::text from public.x_account_identity_attestations a where a.social_account_id = :'acct_a') = :'att_a', '3 nothing recorded');
select s.id as used_state from public.social_account_oauth_states s where s.state_hash = xg.h('a3') \gset
select xg.check(xg.as_person(:'a', format('select public.complete_social_mobile_x_oauth_connection_v2(%L::uuid, %L, %L, %L, %L, %L)::text',
                :'used_state', '1101', 'h1101', xg.access('A9'), xg.refresh('A9'), xg.attest(:'used_state'::uuid, '1101', 'h1101', xg.access('A9'), xg.refresh('A9'))))
                = 'ERR:OAUTH_STATE_NOT_CONSUMABLE', '3 duplicate callback of a used state');
select xg.check((select row(a.*)::text from public.x_account_identity_attestations a where a.social_account_id = :'acct_a') = :'att_a'
                and xg.view(:'a', :'acct_a') = xg.ok_view(:'a', :'acct_a', 'A2'), '3 the duplicate changed nothing');

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

-- 5. The workspace: a second owner, another single owner, a deletion tombstone -> unverified, no token.
select xg.enroll(104) as d \gset
insert into public.brand_memberships (brand_id, user_id, role) values (public.social_mobile_account_deletion_workspace(:'a'), :'d', 'owner');
select xg.check(xg.view(:'a', :'acct_a') = xg.denied() and public.x_account_g4_verified(:'d', :'acct_a') is false, '5 two owners');
update public.brand_memberships set role = 'admin' where brand_id = public.social_mobile_account_deletion_workspace(:'a') and user_id = :'a';
select xg.check(xg.view(:'a', :'acct_a') = xg.denied() and xg.view(:'d', :'acct_a') = xg.denied(), '5 another single owner: the attested person is not the owner, the owner is not attested');
update public.brand_memberships set role = 'owner' where brand_id = public.social_mobile_account_deletion_workspace(:'a') and user_id = :'a';
delete from public.brand_memberships where brand_id = public.social_mobile_account_deletion_workspace(:'a') and user_id = :'d';
select xg.check(xg.view(:'a', :'acct_a') = xg.ok_view(:'a', :'acct_a', 'A2'), '5 restored');
select xg.enroll(105) as e \gset
select xg.connect_v2(:'e', 'e1', '1105', 'E') as acct_e \gset
insert into public.social_mobile_account_deletions (user_id, workspace_id, state, scope, credential_set)
values (:'e', public.social_mobile_account_deletion_workspace(:'e'), 'started', 'social_only', '[]'::jsonb);
select xg.check(xg.view(:'e', :'acct_e') = xg.denied(), '5 workspace being deleted (K4)');

-- 6. The credential: connection error, a missing / shared / dangling reference -> unverified, no token (K3).
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
-- A reference swapped to another secret under an unchanged verification (no product path does this; a direct write
-- or a future writer could): not the attested credential any more.
select vault_access_token_secret_id as f_access from public.social_accounts where id = :'acct_f' \gset
update public.social_accounts set vault_access_token_secret_id = vault.create_secret('fake-x-access-SWAPPED-0123456789', 'f_swapped_access') where id = :'acct_f';
select xg.check(xg.view(:'f', :'acct_f') = xg.denied(), '6 the access reference swapped to another secret');
update public.social_accounts set vault_access_token_secret_id = :'f_access'::uuid where id = :'acct_f';
select xg.check(xg.view(:'f', :'acct_f') = xg.ok_view(:'f', :'acct_f', 'F'), '6 restored after the swap');
delete from vault.secrets where id = :'f_refresh'::uuid;
select xg.check(xg.view(:'f', :'acct_f') = xg.denied(), '6 a dangling reference');

-- 7. Token freshness: the refresh state (refreshing / uncertain / reauth_required), the expiry, a refresh.
select xg.enroll(107) as g \gset
select xg.connect_v2(:'g', 'g1', '1107', 'G') as acct_g \gset
select public.x_account_credential_generation(:'acct_g') as gen_g0 \gset
insert into public.x_account_refresh_state_v2 (social_account_id) values (:'acct_g') on conflict do nothing;
select xg.check(public.x_account_credential_generation(:'acct_g') is not null, '7 generation with an idle refresh state');
update public.x_account_refresh_state_v2 set status = 'uncertain' where social_account_id = :'acct_g';
select xg.check(public.x_posting_access_token_for(:'acct_g') is null and public.x_account_g4_verified(:'g', :'acct_g'), '7 uncertain: identity still verified, no token');
update public.x_account_refresh_state_v2 set status = 'reauth_required' where social_account_id = :'acct_g';
select xg.check(public.x_posting_access_token_for(:'acct_g') is null, '7 reauth_required: no token');
update public.x_account_refresh_state_v2 set status = 'idle' where social_account_id = :'acct_g';
select xg.check(public.x_posting_access_token_for(:'acct_g') = xg.access('G'), '7 idle again');
update public.x_account_identity_attestations set attested_at = now() - interval '119 minutes' where social_account_id = :'acct_g';
select xg.check(public.x_posting_access_token_for(:'acct_g') is null, '7 within 2 minutes of the 2-hour expiry: no token');
update public.x_account_identity_attestations set attested_at = now() - interval '3 hours' where social_account_id = :'acct_g';
select xg.check(public.x_posting_access_token_for(:'acct_g') is null, '7 expired: no token');
-- A refresh (as the refresh core commits one: the secret in place, generation + 1, a new expiry) after the attestation.
select vault.update_secret((select vault_access_token_secret_id from public.social_accounts where id = :'acct_g'), xg.access('G-refreshed'));
update public.x_account_refresh_state_v2 set generation = generation + 1, last_refreshed_at = now(), access_expires_at = now() + interval '2 hours'
 where social_account_id = :'acct_g';
select xg.check(public.x_posting_access_token_for(:'acct_g') = xg.access('G-refreshed'), '7 refreshed: the new token');
select xg.check(public.x_account_credential_generation(:'acct_g') is distinct from :'gen_g0', '7 a refresh changes the generation');
update public.x_account_refresh_state_v2 set access_expires_at = now() + interval '1 minute' where social_account_id = :'acct_g';
select xg.check(public.x_posting_access_token_for(:'acct_g') is null, '7 refreshed token about to expire: no token');

-- 8. Session lost: the attested flow itself is T13-guarded (G5's real guard); a signed-out person gets nothing.
select xg.enroll(108) as h \gset
update auth.sessions set not_after = now() - interval '1 second' where user_id = :'h';
select xg.check(xg.connect_v2(:'h', 'h1', '1108', 'H') like 'ERR:ACCOUNT_LIFECYCLE_AUTH_REQUIRED%', '8 signed out: ' || xg.connect_v2(:'h', 'h2', '1108', 'H'));
select xg.check(not exists (select 1 from public.x_account_identity_attestations a where a.user_id = :'h'), '8 nothing recorded');

select 'X_IDENTITY_CREDENTIAL_BEHAVIOR_OK';
