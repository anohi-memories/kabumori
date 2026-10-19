-- POSTONA X autopost Stage 3B readiness: findings that the existing PR #41 proofs do not pin.
-- Run by run.sh on a disposable local database after 20261006160000 / 160100 / 160200 are applied on top
-- of the production-shaped Stage 3A + PR81 fixture. Fake data only; never production.
--
--   R1  AI consultation memory is not consent: a confirmed conversation persona with approvalMode
--       'manual_review' never publishes.
--   R2  baseline: every current gate satisfied -> 'allowed'.
--   R3  GAP (MOCK_ONLY): no G5 x_autopost entitlement / account-lifecycle condition exists in the publish
--       predicate or in the authority setter. An "ended" entitlement (mock table, not G5's real schema)
--       changes nothing. This is evidence of a missing gate, NOT security evidence.
--   R4  GAP: x_account_publish_authority.social_account_id references social_accounts with NO ACTION:
--       an authority row (even 'revoked') blocks deleting the X account; service_role cannot delete it.
\set ON_ERROR_STOP on
set timezone = 'Asia/Tokyo';

create function pg_temp.expect_error(p_sql text, p_expected text) returns text
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'EXPECTED_ERROR_NOT_RAISED: % :: %', p_expected, p_sql;
exception when others then
  if sqlerrm like 'EXPECTED_ERROR_NOT_RAISED%' then raise; end if;
  if sqlerrm <> p_expected and sqlstate <> p_expected then
    raise exception 'WRONG_ERROR expected % got % (%) :: %', p_expected, sqlerrm, sqlstate, p_sql;
  end if;
  return sqlerrm;
end;
$$;
create function pg_temp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'CHECK_FAILED: %', p_what; end if; end; $$;
grant execute on function pg_temp.expect_error(text, text), pg_temp.check(boolean, text) to service_role;

-- Admin enablement + a verified, publish-enabled pilot account (as in the PR #41 authority proof).
update public.brands set is_active = true, publish_mode = 'live' where id = 'u_pilot';
insert into public.brand_settings (brand_id, enabled_post_types) values ('u_pilot', '["brand_post"]');
update public.social_accounts set connection_status = 'identity_verified', publish_enabled = true, last_connection_error_code = null
where id = 'sa_pilot';
insert into public.scheduled_posts (brand_id, post_type, status, attempt_count, started_at)
values ('u_pilot', 'brand_post', 'running', 1, now());
select set_config('rd.post', (select id::text from public.scheduled_posts where brand_id = 'u_pilot' and status = 'running' limit 1), false);

-- R1: what AI consultation V1 can save -- a confirmed conversation persona, settings with the default
-- 'manual_review' (the consult delta allowlist cannot change approvalMode) -- is not consent.
insert into public.social_mobile_content_settings (brand_id, settings, persona_profile, persona_provenance, persona_confirmed)
values ('u_pilot', jsonb_build_object(
  'locale', 'ja-JP', 'preferredTone', 'やわらかく親しみやすい', 'themes', jsonb_build_array('日々の工夫'),
  'objective', '気づきを届ける', 'frequencyTargetPerWeek', 4, 'approvalMode', 'manual_review',
  'generationWindow', jsonb_build_object('timezone', 'Asia/Tokyo', 'startLocal', '09:00', 'endLocal', '24:00',
    'defaultGenerationLocal', '17:00', 'generationDayOffset', -1),
  'optionalNgWords', jsonb_build_array(), 'notes', ''),
  '{"punctuationEmoji": "控えめ", "ctaStyle": "問いかけで締める"}'::jsonb, 'conversation', true);
set role service_role;
select public.set_x_account_publish_authority('sa_pilot', 'enabled', 'READINESS_PROOF', now() - interval '1 minute', now() + interval '3 days');
select pg_temp.expect_error(format('select public.check_x_account_publish_authority(%L, %L, %L)',
  current_setting('rd.post'), 'sa_pilot', 'u_pilot'), 'SOCIAL_MOBILE_AUTO_POST_NOT_CONSENTED');
reset role;
select 'R1_CONSULT_MEMORY_IS_NOT_CONSENT_PASS' as result;

-- R2: the owner's explicit opt-in (the settings screen, not the consultation) completes the current gates.
update public.social_mobile_content_settings set settings = jsonb_set(settings, '{approvalMode}', '"auto_post_preference"')
where brand_id = 'u_pilot';
set role service_role;
select pg_temp.check(public.check_x_account_publish_authority(current_setting('rd.post')::uuid, 'sa_pilot', 'u_pilot') = 'allowed',
  'baseline allowed');
reset role;
select 'R2_BASELINE_ALL_CURRENT_GATES_ALLOWED_PASS' as result;

-- R3 (MOCK_ONLY): the owner's x_autopost service has ENDED (mock table; G5's real contract differs) --
-- the predicate and the setter still allow, because neither consults any entitlement or lifecycle state.
create schema mock_g5;
create table mock_g5.service_entitlements (brand_id text, service_key text, status text);
insert into mock_g5.service_entitlements values ('u_pilot', 'x_autopost', 'ended');
grant usage on schema mock_g5 to service_role;
grant select on mock_g5.service_entitlements to service_role;
set role service_role;
select pg_temp.check(public.check_x_account_publish_authority(current_setting('rd.post')::uuid, 'sa_pilot', 'u_pilot') = 'allowed',
  'GAP: ended entitlement still allowed by the predicate');
select pg_temp.check(public.set_x_account_publish_authority('sa_pilot', 'enabled', 'READINESS_REENABLE', now(), now() + interval '1 day') = 'enabled',
  'GAP: setter re-enables for an ended service');
reset role;
select pg_temp.check(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('check_x_account_publish_authority', 'set_x_account_publish_authority')
    and p.prosrc ~* '(entitlement|lifecycle|service_key|x_autopost|common_account|account_lifecycle)'),
  'no entitlement / lifecycle reference in either routine');
select 'R3_GAP_G5_ENTITLEMENT_NOT_ENFORCED_MOCK_ONLY' as result;

-- R4: deletion order. 'revoked' stops publishing but keeps the row, and the row blocks deleting the account.
set role service_role;
select public.set_x_account_publish_authority('sa_pilot', 'revoked', 'READINESS_REVOKE');
select pg_temp.expect_error(format('select public.check_x_account_publish_authority(%L, %L, %L)',
  current_setting('rd.post'), 'sa_pilot', 'u_pilot'), 'VAULT_PUBLISH_AUTHORITY_REVOKED');
select pg_temp.expect_error($q$delete from public.x_account_publish_authority where social_account_id = 'sa_pilot'$q$, '42501');
reset role;
select pg_temp.check((select confdeltype from pg_constraint
  where conrelid = 'public.x_account_publish_authority'::regclass and contype = 'f') = 'a', 'FK is NO ACTION');
-- Isolate the FK under test: only the authority row references sa_pilot here (the running post is not account-bound).
select pg_temp.check(position('x_account_publish_authority' in pg_temp.expect_error(
  $q$delete from public.social_accounts where id = 'sa_pilot'$q$, '23503')) > 0,
  'authority row blocks the account delete');
select 'R4_GAP_AUTHORITY_ROW_BLOCKS_ACCOUNT_DELETE' as result;

select 'READINESS_BEHAVIOR_PASS' as result;
