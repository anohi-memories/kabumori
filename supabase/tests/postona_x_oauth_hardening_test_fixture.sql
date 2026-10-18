-- Fake-only test support for the POSTONA X OAuth hardening candidate
-- (supabase/candidates/postona_x_oauth_hardening_candidate.sql). Applied by
-- postona_x_oauth_hardening_run.sh after PR #124's test fixture (Vault with secret names, the TEST-ONLY
-- create_secret failure injection, the call log) and before the candidates. Disposable local database
-- only; every value is fake.
set timezone = 'UTC';

-- The X server attestation key (TEST-ONLY value; the X Edge exchange would hold the same one).
insert into vault.secrets (name, secret)
values ('postona_x_connect_attestation_v1', 'fake_x_attestation_key_0123456789abcdef0123456789ab');
