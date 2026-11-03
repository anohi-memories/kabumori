-- G4-33 (Issue #319): the token digest (004_rotation_token_digest.sql) on top of A, C and (4), on the composed world with
-- a FAKE Vault, run after the cr.* prelude of postona_threads_credential_composition_behavior.sql and the cr.claim ..
-- cr.release helpers of postona_threads_rotation_cas_behavior.sql. Fake tokens only.
-- cr.oob = a DIRECT Vault write (vault.update_secret on the account's secret id; no custody, no binding, no state): F2.

create function cr.store(p_acct text, p_claim jsonb, p_token text, p_days integer default 55) returns jsonb language sql volatile as $$
  select public.rotate_and_store_threads_credential(p_acct, (p_claim ->> 'lease')::uuid, (p_claim ->> 'vault_secret_id')::uuid,
                                                    (p_claim ->> 'custody_recorded_at')::timestamptz, now() + make_interval(days => p_days), p_token) $$;
create function cr.oob(p_acct text, p_token text) returns void language sql volatile as $$
  select vault.update_secret((select a.vault_access_token_secret_id from public.social_accounts a where a.id = p_acct), p_token) $$;
create function cr.vault_token(p_acct text) returns text language sql volatile as $$
  select s.secret from vault.secrets s join public.social_accounts a on a.vault_access_token_secret_id = s.id where a.id = p_acct $$;
create function cr.digest_of(p_token text) returns text language sql immutable as $$ select encode(sha256(convert_to(p_token, 'UTF8')), 'hex') $$;
create function cr.recorded_digest(p_acct text) returns text language sql volatile as $$
  select c.token_digest from public.threads_account_credential_custody c where c.social_account_id = p_acct $$;
create function cr.reader(p_acct text) returns timestamptz language sql volatile as $$ select public.threads_account_credential_expires_at(p_acct) $$;

-- D1. Normal: connect records the token's digest; claim; credential_row hands the token out; rotate_and_store writes the
--     new token and its digest in one statement; credential_row hands the NEW token out; the lease is used up.
select cr.connected(501, 'd1') as d1 \gset
select cr.check(cr.recorded_digest(:'d1') = cr.digest_of(cr.token('d1')) and cr.token_of(:'d1') = cr.token('d1'), 'D1 connect records the token''s digest');
select cr.claim(:'d1')::text as k1 \gset
select cr.check((:'k1')::jsonb ->> 'status' = 'claimed', 'D1 claim');
select cr.store(:'d1', :'k1', 'fakeTHREADSstoredD1_0123456789')::text as s1 \gset
select cr.check((:'s1')::jsonb ->> 'status' = 'rotated' and cr.vault_token(:'d1') = 'fakeTHREADSstoredD1_0123456789'
                and cr.recorded_digest(:'d1') = cr.digest_of('fakeTHREADSstoredD1_0123456789') and cr.token_of(:'d1') = 'fakeTHREADSstoredD1_0123456789',
                'D1 rotate_and_store: the new token and its digest, handed out');
select cr.check(cr.store(:'d1', :'k1', 'fakeTHREADSstoredD1again_0123456789') ->> 'code' = 'LEASE_NOT_HELD', 'D1 single use');

-- D2. F2 after the claim: a direct Vault write -> rotate_and_store CREDENTIAL_CHANGED, the direct write is NOT overwritten;
--     every reader refuses (credential_row 0 rows, the expiry reader NULL).
select cr.connected(502, 'd2') as d2 \gset
select cr.claim(:'d2')::text as k2 \gset
select cr.oob(:'d2', 'fakeTHREADSoutOfBandD2_0123456789');
select cr.check(cr.store(:'d2', :'k2', 'fakeTHREADSstoredD2_0123456789') ->> 'code' = 'CREDENTIAL_CHANGED', 'D2 F2 after the claim: CREDENTIAL_CHANGED');
select cr.check(cr.vault_token(:'d2') = 'fakeTHREADSoutOfBandD2_0123456789' and cr.rows(:'d2') = 0 and cr.reader(:'d2') is null,
                'D2 nothing overwritten; credential_row 0 rows; the expiry reader NULL');
select cr.check(cr.rotate(:'d2', :'k2', ((:'k2')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days') ->> 'code' = 'CREDENTIAL_CHANGED',
                'D2 the legacy rotate refuses too');

-- D3. F2 before the claim: claim CREDENTIAL_CHANGED.
select cr.connected(503, 'd3') as d3 \gset
select cr.oob(:'d3', 'fakeTHREADSoutOfBandD3_0123456789');
select cr.check(cr.claim(:'d3') ->> 'code' = 'CREDENTIAL_CHANGED' and cr.rows(:'d3') = 0, 'D3 F2 before the claim: CREDENTIAL_CHANGED, no credential row');

-- D4. A direct write of the SAME content: the digest still matches (harmless, recorded as such).
select cr.connected(504, 'd4') as d4 \gset
select cr.claim(:'d4')::text as k4 \gset
select cr.oob(:'d4', cr.token('d4'));
select cr.check(cr.store(:'d4', :'k4', 'fakeTHREADSstoredD4_0123456789') ->> 'status' = 'rotated', 'D4 same content rewritten: rotated (no change to detect)');

-- D5. F2 in ONE transaction with ONE now() (connect, claim, direct write, rotate_and_store): refused by content, not time.
create function cr.f2_same_now(p_n integer) returns jsonb language plpgsql as $$
declare v_user uuid := cr.enroll(p_n); v_acct text; v_claim jsonb; v_rot jsonb;
begin
  v_acct := cr.t_begin(v_user, 'd5a' || p_n);
  perform cr.check(cr.t_complete(v_user, 'd5a' || p_n, '178414000000' || lpad(p_n::text, 5, '0'), now() + interval '30 days') = 'OK', 'D5 connect');
  v_claim := cr.claim(v_acct);
  perform cr.oob(v_acct, 'fakeTHREADSoutOfBandD5_0123456789');
  v_rot := cr.store(v_acct, v_claim, 'fakeTHREADSstaleLineageD5_0123456789');
  return jsonb_build_object('rotation', v_rot, 'vault_now', cr.vault_token(v_acct), 'rows', cr.rows(v_acct));
end $$;
select cr.f2_same_now(505)::text as d5 \gset
select 'D5 ' || :'d5' as observed;
select cr.check((:'d5')::jsonb #>> '{rotation,code}' = 'CREDENTIAL_CHANGED' and (:'d5')::jsonb ->> 'vault_now' = 'fakeTHREADSoutOfBandD5_0123456789'
                and ((:'d5')::jsonb ->> 'rows')::integer = 0, 'D5 same transaction, same now(): CREDENTIAL_CHANGED, no credential row');

-- D6. The LEGACY flow (rotate, then a separate Vault write): the record describes the OLD token -> every reader refuses
--     (fail closed until the next connect). Measured, so that the refresh must move to rotate_and_store.
select cr.connected(506, 'd6') as d6 \gset
select cr.claim(:'d6')::text as k6 \gset
select cr.check(cr.rotate(:'d6', :'k6', ((:'k6')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days') ->> 'status' = 'rotated', 'D6 legacy rotate');
select cr.h5_write(:'d6', 'fakeTHREADSlegacyWriteD6_0123456789');
select cr.check(cr.rows(:'d6') = 0 and cr.reader(:'d6') is null and cr.claim(:'d6') ->> 'code' = 'CREDENTIAL_CHANGED',
                'D6 legacy rotate + separate Vault write: every reader refuses (fail closed)');
select cr.check(cr.t_begin(cr.uid(506), 'd6b') = :'d6' and cr.t_complete(cr.uid(506), 'd6b', '17841400000000506', now() + interval '40 days') = 'OK'
                and cr.token_of(:'d6') = cr.token('d6b'), 'D6 a reconnect restores the credential');

-- D7. A custody row WITHOUT a digest (as every row existing before the candidate): unverified until a reconnect.
select cr.connected(507, 'd7') as d7 \gset
alter table public.threads_account_credential_custody disable trigger threads_credential_custody_token_digest;
update public.threads_account_credential_custody set token_digest = null where social_account_id = :'d7';
alter table public.threads_account_credential_custody enable always trigger threads_credential_custody_token_digest;
select cr.check(cr.claim(:'d7') ->> 'code' = 'CREDENTIAL_UNVERIFIED' and cr.rows(:'d7') = 0 and cr.reader(:'d7') is null,
                'D7 no digest: CREDENTIAL_UNVERIFIED, no credential row');
select cr.check(cr.t_begin(cr.uid(507), 'd7b') = :'d7' and cr.t_complete(cr.uid(507), 'd7b', '17841400000000507', now() + interval '40 days') = 'OK'
                and cr.claim(:'d7') ->> 'status' = 'claimed', 'D7 a reconnect records the digest');

-- D8. LIMIT (recorded): an owner custody write after a direct Vault write re-records the digest of that content.
select cr.connected(508, 'd8') as d8 \gset
select cr.oob(:'d8', 'fakeTHREADSoutOfBandD8_0123456789');
update public.threads_account_credential_custody set recorded_by = recorded_by where social_account_id = :'d8';
select cr.check(cr.token_of(:'d8') = 'fakeTHREADSoutOfBandD8_0123456789', 'D8 measured: a custody write blesses the content now in Vault');
select 'EXPECTED_LIMIT_D8 an owner custody write after a direct Vault write re-records that content (also what an apply-time backfill would do)' as finding;

-- D9. The digest cannot be chosen by a writer: a direct UPDATE of token_digest is replaced by the real digest.
select cr.connected(509, 'd9') as d9 \gset
update public.threads_account_credential_custody set token_digest = repeat('0', 64) where social_account_id = :'d9';
select cr.check(cr.recorded_digest(:'d9') = cr.digest_of(cr.token('d9')), 'D9 a written digest is replaced by the Vault content''s');

-- D10. rotate_and_store input and refusals write NOTHING to Vault.
select cr.connected(510, 'd10') as d10 \gset
select cr.claim(:'d10')::text as k10 \gset
select cr.check(cr.store(:'d10', :'k10', 'short') ->> 'code' = 'REQUEST_INVALID' and cr.vault_token(:'d10') = cr.token('d10'), 'D10 malformed token: REQUEST_INVALID, Vault unchanged');
select cr.check(public.rotate_and_store_threads_credential(:'d10', gen_random_uuid(), ((:'k10')::jsonb ->> 'vault_secret_id')::uuid,
                  ((:'k10')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '50 days', 'fakeTHREADSwrongLease_0123456789') ->> 'code' = 'LEASE_NOT_HELD'
                and cr.vault_token(:'d10') = cr.token('d10'), 'D10 another lease: LEASE_NOT_HELD, Vault unchanged');
select cr.check(cr.store(:'d10', :'k10', 'fakeTHREADSshortExpiry_0123456789', 1) ->> 'code' in ('EXPIRY_NOT_EXTENDED', 'EXPIRY_INVALID')
                and cr.vault_token(:'d10') = cr.token('d10'), 'D10 a shorter expiry: refused, Vault unchanged');

-- D11. Atomicity: a rotate_and_store rolled back leaves the token, the digest, the record and the lease as they were.
select cr.recorded(:'d10') as rec10 \gset
begin;
select cr.check(cr.store(:'d10', :'k10', 'fakeTHREADSrolledBack_0123456789') ->> 'status' = 'rotated', 'D11 rotated inside');
rollback;
select cr.check(cr.vault_token(:'d10') = cr.token('d10') and cr.recorded_digest(:'d10') = cr.digest_of(cr.token('d10'))
                and cr.recorded(:'d10') = :'rec10'::timestamptz
                and exists (select 1 from public.threads_credential_refresh_leases l where l.lease_id = ((:'k10')::jsonb ->> 'lease')::uuid),
                'D11 rollback: token, digest, record and lease as before');

-- D12. ACL: rotate_and_store and the trigger function are the owner's; the digest column is not readable by API roles.
select cr.check(not pg_catalog.has_function_privilege(r.oid, 'public.rotate_and_store_threads_credential(text,uuid,uuid,timestamptz,timestamptz,text)', 'execute')
                and not pg_catalog.has_function_privilege(r.oid, 'public.threads_credential_custody_token_digest()', 'execute')
                and not pg_catalog.has_column_privilege(r.oid, 'public.threads_account_credential_custody', 'token_digest', 'select'),
                'D12 no API access for ' || r.rolname)
  from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator');

select 'POSTONA_THREADS_TOKEN_DIGEST_BEHAVIOR_DONE' as result;
