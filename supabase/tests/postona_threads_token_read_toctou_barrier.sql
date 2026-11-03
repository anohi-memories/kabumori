-- G4-34 (Issue #319): TEST-WORLD setup for the token read TOCTOU proof, run after the cr.* prelude and helpers. Only for
-- disposable databases with the FAKE Vault of the test fixtures; never a product object.
-- Barrier: vault.decrypted_secrets is redefined to call g4test.toctou_hook(id) for every row it returns. The hook is inert
-- unless the session armed it with a secret id (set_config('g4test.toctou_arm', <id>, false)); then the FIRST evaluation
-- for that id disarms it and waits on advisory lock 774100 (held by the attacker session). The statement that blocks there
-- keeps the snapshot it started with, so the attacker's committed write is invisible to THAT statement and visible to the
-- next one: the gap between "checked" and "read" becomes deterministic.
create schema g4test;
create function g4test.toctou_hook(p_id uuid) returns boolean language plpgsql volatile set search_path = '' as $$
begin
  if pg_catalog.current_setting('g4test.toctou_arm', true) = p_id::text then
    perform pg_catalog.set_config('g4test.toctou_arm', '', false);
    perform pg_catalog.pg_advisory_lock(774100);
    perform pg_catalog.pg_advisory_unlock(774100);
  end if;
  return true;
end $$;
create or replace view vault.decrypted_secrets as
  select s.id, s.secret as decrypted_secret, s.name from vault.secrets s where g4test.toctou_hook(s.id);
-- The publish server's attestation key (fake) for the release.
insert into vault.secrets (name, secret)
select 'postona_threads_publish_attestation_v1', 'fake_publish_attestation_key_0123456789abcdef0123'
 where not exists (select 1 from vault.secrets where name = 'postona_threads_publish_attestation_v1');

-- The publish release as the publish server calls it: attested, then acting as the person (JSON claims).
create function cr.release(p_user uuid, p_attempt uuid, p_step text default 'create_container') returns jsonb language plpgsql as $$
declare v_issued bigint := extract(epoch from clock_timestamp())::bigint;
        v_nonce text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
        v_att text; v_out jsonb;
begin
  v_att := encode(extensions.hmac(convert_to(concat_ws(chr(10), 'postona-threads-publish-release-v1', p_user::text, p_attempt::text,
                                                       p_step, v_issued::text, v_nonce), 'UTF8'),
                                  convert_to('fake_publish_attestation_key_0123456789abcdef0123', 'UTF8'), 'sha256'), 'hex');
  perform cr.claims(p_user, cr.session(p_user));
  v_out := public.release_threads_manual_publish_step(p_attempt, p_step, v_issued, v_nonce, v_att);
  perform cr.claims(null, null);
  return v_out;
end $$;
-- One connected person with manual publishing permitted and one reserved attempt; prints account|user|attempt|secret.
create function cr.publish_ready(p_n integer) returns text language plpgsql as $$
declare v_acct text := cr.connected(p_n, 'tt' || p_n); v_user uuid := cr.uid(p_n); v_att text;
begin
  perform cr.check(cr.as_person(v_user, format('select public.set_threads_manual_publish_permission(%L, true, false) ->> ''permitted''', v_acct)) = 'true', 'permission');
  v_att := (cr.as_person(v_user, format('select public.begin_threads_manual_publish(%L, %L::uuid, %L)::text', v_acct, gen_random_uuid(), 'hello threads')))::jsonb #>> '{attempt,attempt_id}';
  perform cr.check(v_att is not null, 'attempt');
  return concat_ws('|', v_acct, v_user, v_att, (select a.vault_access_token_secret_id from public.social_accounts a where a.id = v_acct));
end $$;
create function cr.attempt_status(p_att uuid) returns text language sql volatile as $$
  select t.status from public.threads_manual_publish_attempts t where t.id = p_att $$;
