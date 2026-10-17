-- Behaviour of the publish-switch guard (001) on G5's production-shaped disposable baseline (real lifecycle, enrollment
-- and Phase 3b service-write guard), the live switch (20261003090000) underneath, PR #257's guarded X onboarding and the
-- F3 reservation candidate's G4 predicate. Run by run.sh as the schema owner after 001.
-- H0 runs with the SHIPPED G4 stub (DENY); then the TEST DOUBLE from PR #257 (g4_predicate_test_double.sql, MOCK_ONLY)
-- stands in for G4. TEST STAND-INS: owner UPDATEs / INSERTs set lifecycle states and a non-POSTONA brand.
\ir setup.sql
create function pg_temp.t(p_account text, p_desired boolean, p_expected boolean, p_n integer, p_session uuid) returns text language sql as $$
  select pg_temp.status_of(pg_temp.as_person(pg_temp.toggle_sql(p_account, p_desired, p_expected), pg_temp.uid(p_n), p_session)) $$;

-- H0: G4 has not delivered (shipped DENY): ON is refused as not verified; nothing changes. OFF is never blocked by it.
select pg_temp.onboarded(41) as a41 \gset
select pg_temp.session(pg_temp.uid(41)) as s41 \gset
select pg_temp.expect(pg_temp.t(:'a41', true, false, 41, :'s41') = 'blocked:CONNECTION_NOT_VERIFIED', 'H0 default deny');
select pg_temp.expect(pg_temp.enabled(:'a41') = false, 'H0 still off');
select pg_temp.expect(pg_temp.t(:'a41', false, false, 41, :'s41') = 'unchanged', 'H0 OFF answers as before');
select 'H0_G4_NOT_DELIVERED_DEFAULT_DENY_PASS' as result;

\ir ../postona_x_oauth_t13_guard/g4_predicate_test_double.sql

-- H1: an onboarded owner with an active service: ON, OFF, stale and unchanged answer exactly as the live switch.
select pg_temp.expect(pg_temp.t(:'a41', true, false, 41, :'s41') = 'updated', 'H1 ON');
select pg_temp.expect(pg_temp.enabled(:'a41') = true, 'H1 on');
select pg_temp.expect(pg_temp.t(:'a41', true, true, 41, :'s41') = 'unchanged', 'H1 unchanged');
select pg_temp.expect(pg_temp.t(:'a41', true, false, 41, :'s41') = 'stale', 'H1 stale');
select pg_temp.expect(pg_temp.t(:'a41', false, true, 41, :'s41') = 'updated', 'H1 OFF');
select pg_temp.expect(pg_temp.enabled(:'a41') = false, 'H1 off');
select 'H1_ACTIVE_OWNER_UNCHANGED_CONTRACT_PASS' as result;

-- H2: x_autopost ended: ON forbidden, nothing written; OFF still works (stopping is never blocked).
select pg_temp.expect(pg_temp.t(:'a41', true, false, 41, :'s41') = 'updated', 'H2 setup ON');
select pg_temp.end_service(pg_temp.uid(41));
select pg_temp.expect(pg_temp.t(:'a41', false, true, 41, :'s41') = 'updated', 'H2 OFF after the end');
select pg_temp.expect(pg_temp.t(:'a41', true, false, 41, :'s41') = 'forbidden', 'H2 ON refused');
select pg_temp.expect(pg_temp.enabled(:'a41') = false, 'H2 stays off');
select 'H2_SERVICE_ENDED_ON_REFUSED_OFF_WORKS_PASS' as result;

-- H3: account being deleted / locked / service being deleted: refused with the existing statuses, nothing written.
select pg_temp.onboarded(42) as a42 \gset
select pg_temp.session(pg_temp.uid(42)) as s42 \gset
update public.common_accounts set status = 'deleting' where user_id = pg_temp.uid(42);
select pg_temp.expect(pg_temp.t(:'a42', true, false, 42, :'s42') = 'busy', 'H3 account deleting');
select pg_temp.onboarded(43) as a43 \gset
select pg_temp.session(pg_temp.uid(43)) as s43 \gset
update public.common_accounts set status = 'locked' where user_id = pg_temp.uid(43);
select pg_temp.expect(pg_temp.t(:'a43', true, false, 43, :'s43') = 'forbidden', 'H3 locked');
select pg_temp.onboarded(44) as a44 \gset
select pg_temp.session(pg_temp.uid(44)) as s44 \gset
update public.service_entitlements set status = 'deleting' where user_id = pg_temp.uid(44) and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.t(:'a44', true, false, 44, :'s44') in ('busy', 'forbidden'), 'H3 service deleting');
select pg_temp.expect(not pg_temp.enabled(:'a42') and not pg_temp.enabled(:'a43') and not pg_temp.enabled(:'a44'), 'H3 all off');
select 'H3_LIFECYCLE_STATES_REFUSED_PASS' as result;

-- H4: signed out / no session id: auth_required, nothing written; a new session works.
select pg_temp.onboarded(45) as a45 \gset
select pg_temp.session(pg_temp.uid(45)) as s45 \gset
delete from auth.sessions where user_id = pg_temp.uid(45);
select pg_temp.expect(pg_temp.t(:'a45', true, false, 45, :'s45') = 'auth_required', 'H4 signed out');
select pg_temp.expect(pg_temp.t(:'a45', true, false, 45, null) = 'auth_required', 'H4 no session id');
select pg_temp.expect(pg_temp.status_of(pg_temp.as_person(pg_temp.toggle_sql(:'a45', true, false), null, null)) = 'auth_required', 'H4 no caller (live answer)');
select pg_temp.session(pg_temp.uid(45)) as s45b \gset
select pg_temp.expect(pg_temp.t(:'a45', true, false, 45, :'s45b') = 'updated', 'H4 new session works');
select 'H4_SIGNED_OUT_REFUSED_PASS' as result;

-- H5: another person (non-member) -> not_found; an admin member of someone's personal workspace -> forbidden; a person's
-- own active service never authorizes another workspace.
select pg_temp.onboarded(46) as a46 \gset
select pg_temp.session(pg_temp.uid(46)) as s46 \gset
select pg_temp.expect(pg_temp.t(:'a45', false, true, 46, :'s46') = 'not_found', 'H5 other person (OFF)');
select pg_temp.expect(pg_temp.t(:'a45', true, false, 46, :'s46') = 'not_found', 'H5 other person (ON)');
insert into public.brand_memberships (brand_id, user_id, role)
select brand_id, pg_temp.uid(46), 'admin' from public.social_accounts where id = :'a45';
select pg_temp.expect(pg_temp.t(:'a45', false, true, 46, :'s46') = 'updated', 'H5 admin member may still stop');
select pg_temp.expect(pg_temp.t(:'a45', true, false, 46, :'s46') = 'forbidden', 'H5 admin member cannot turn a personal workspace ON');
select pg_temp.expect(pg_temp.enabled(:'a45') = false, 'H5 stays off');
select 'H5_OTHER_PERSON_AND_NON_OWNER_PASS' as result;

-- H6: a brand that is NOT a self-service POSTONA workspace (Kabumori / AI Lab style) keeps the live behaviour: no T13,
-- no G4 (its admin has no POSTONA service at all).
select public.fixture_login(pg_temp.uid(47)) is null as setup_47;
select pg_temp.session(pg_temp.uid(47)) as s47 \gset
insert into public.brands (id, display_name, is_active, publish_mode, code_profile_key) values ('ops_brand_h6', 'Ops', true, 'live', 'operator_v1');
insert into public.brand_memberships (brand_id, user_id, role) values ('ops_brand_h6', pg_temp.uid(47), 'admin');
insert into public.social_accounts (id, brand_id, platform, handle, publish_enabled, oauth_client_ref, connection_status, platform_user_id, verified_at,
                                    vault_access_token_secret_id, vault_refresh_token_secret_id)
values ('sa_ops_h6', 'ops_brand_h6', 'x', 'ops', false, 'default', 'identity_verified', '4700', now(), vault.create_secret('a'), vault.create_secret('r'));
select pg_temp.expect(pg_temp.t('sa_ops_h6', true, false, 47, :'s47') = 'updated', 'H6 non-POSTONA brand unchanged');
select 'H6_NON_POSTONA_BRAND_UNCHANGED_PASS' as result;

-- H7: ACL. anon / service_role cannot call the switch; authenticated cannot call the unguarded one, the guard or G4.
select pg_temp.expect(pg_temp.as_person(pg_temp.toggle_sql(:'a46', true, false), pg_temp.uid(46), :'s46', r) like 'ERR:permission denied%', 'H7 closed to ' || r)
  from unnest(array['anon', 'service_role']) r;
select pg_temp.expect(pg_temp.as_person(q, pg_temp.uid(46), :'s46') like 'ERR:permission denied%', 'H7 refused: ' || q) from unnest(array[
  format('select public.set_social_account_publish_enabled_unguarded_v1(%L, true, false)::text', :'a46'),
  format('select private.account_lifecycle_assert_active_service_write(%L::uuid, ''x_autopost'')::text', pg_temp.uid(46)),
  format('select postona_x_resv.g4_x_account_verified(%L::uuid, %L)::text', pg_temp.uid(46), :'a46')]) q;
select 'H7_ACL_PASS' as result;

-- H8: the X deletion saga holds the workspace (tombstone): the live answer (busy) is kept, ON or OFF.
select pg_temp.expect(pg_temp.t(:'a46', true, false, 46, :'s46') = 'updated', 'H8 setup ON');
insert into public.social_mobile_account_deletions (user_id, workspace_id, state, scope, credential_set)
select pg_temp.uid(46), brand_id, 'started', 'social_only', '[]'::jsonb from public.social_accounts where id = :'a46';
select pg_temp.expect(pg_temp.t(:'a46', false, true, 46, :'s46') = 'busy', 'H8 OFF under the saga (live answer)');
select pg_temp.expect(pg_temp.t(:'a46', true, true, 46, :'s46') in ('unchanged', 'blocked:CONNECTION_NOT_VERIFIED'), 'H8 ON under the saga never changes anything');
select 'H8_SAGA_TOMBSTONE_LIVE_ANSWER_PASS' as result;

select 'POSTONA_PUBLISH_ENABLED_T13_BEHAVIOR_PASS' as result;
