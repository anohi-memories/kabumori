-- Behavior proof for 20261013120000_common_account_service_deletion_ownership (common account Phase 6, F5).
-- Fake data only, disposable database only. The runner applies the production-shaped fixtures, the real
-- onboarding RPCs, the social-mobile deletion candidate, Phase 1, Phase 2, Phase 3a, the Phase 3b guard, the
-- Phase 4 fence, the Phase 5 workspace state and the candidate. Prints COMMON_ACCOUNT_SERVICE_DELETION_BEHAVIOR_PASS.
--
-- TEST STAND-INS, never in the candidate: owner UPDATEs of owner_lease_expires_at move a lease's expiry (time
-- is not evidence in the design; the tests need a lease that has ended); the social_accounts platform check is
-- widened as the real Phase 2a-2 migration does; owner INSERTs build workspaces / accounts.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

alter table public.social_accounts drop constraint social_accounts_platform_check;
alter table public.social_accounts add constraint social_accounts_platform_check check (platform in ('x', 'threads', 'instagram'));

create function pg_temp.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL %', p_label; end if;
end;
$$;
create function pg_temp.uid(p_n integer) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
create function pg_temp.set_claims(p_sub uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p_sub is null then '' else 'authenticated' end, true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;
-- Runs one statement returning jsonb or text as a database role; jsonb text, or 'ERR:<message>'.
create function pg_temp.as_role(p_sql text, p_role text, p_sub uuid default null) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.set_claims(p_sub);
  if p_role <> current_user then execute format('set local role %I', p_role); end if;
  execute p_sql into v;
  reset role;
  perform pg_temp.set_claims(null);
  return coalesce(v, '<null>');
exception when others then
  reset role;
  perform pg_temp.set_claims(null);
  return 'ERR:' || sqlerrm;
end;
$$;
create function pg_temp.svc(p_sql text) returns jsonb language plpgsql as $$
declare v text := pg_temp.as_role(p_sql, 'service_role');
begin
  if v like 'ERR:%' then return jsonb_build_object('error', substr(v, 5)); end if;
  return v::jsonb;
end;
$$;
-- A person who started POSTONA (and optionally Kabumori), with their own workspace.
create function pg_temp.person(p_n integer, p_kabumori boolean default false) returns uuid language plpgsql as $$
declare
  v_user uuid := pg_temp.uid(p_n);
  v_ws text := public.social_mobile_account_deletion_workspace(pg_temp.uid(p_n));
begin
  perform public.fixture_login(v_user);
  perform pg_temp.expect(pg_temp.as_role('select (public.start_x_autopost_service() ->> ''status'')', 'authenticated', v_user) = 'active', 'setup: start POSTONA');
  if p_kabumori then
    perform pg_temp.expect(pg_temp.as_role('select (public.start_kabumori_service() ->> ''status'')', 'authenticated', v_user) = 'active', 'setup: start Kabumori');
  end if;
  insert into public.brands (id, code_profile_key) values (v_ws, 'social_mobile_user_v1') on conflict (id) do nothing;
  insert into public.brand_memberships (brand_id, user_id, role) values (v_ws, v_user, 'owner') on conflict do nothing;
  return v_user;
end;
$$;
create function pg_temp.account(p_user uuid, p_platform text) returns void language plpgsql as $$
begin
  insert into public.social_accounts (id, brand_id, platform, handle)
  values (p_platform || '_' || substr(p_user::text, 25), public.social_mobile_account_deletion_workspace(p_user), p_platform, 'h');
end;
$$;
create function pg_temp.begin_service(p_user uuid) returns uuid language plpgsql as $$
declare v jsonb := pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, ''x_autopost'')', p_user));
begin
  perform pg_temp.expect(v ->> 'status' = 'started', 'setup: begin service deletion ' || v::text);
  return (v ->> 'operation_id')::uuid;
end;
$$;
create function pg_temp.claim(p_user uuid, p_op uuid) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.claim_service_deletion(%L::uuid, ''x_autopost'', %L::uuid)', p_user, p_op))
$$;
create function pg_temp.rec(p_user uuid, p_op uuid, p_lease uuid, p_provider text, p_result text) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.record_owned_service_deletion_provider_result(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid, %L, %L)', p_user, p_op, p_lease, p_provider, p_result))
$$;
create function pg_temp.finish(p_user uuid, p_op uuid, p_lease uuid) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.finish_owned_service_deletion(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid)', p_user, p_op, p_lease))
$$;
create function pg_temp.results(p_op uuid) returns jsonb language sql as $$
  select provider_results from private.account_lifecycle_operations where id = p_op
$$;
create function pg_temp.status_of(p_user uuid, p_service text) returns text language sql as $$
  select status from public.service_entitlements where user_id = p_user and service_key = p_service $$;

-- 0. Shape and ACL. ---------------------------------------------------------------------------------------
select pg_temp.expect(has_function_privilege('service_role', f, 'EXECUTE')
                      and not has_function_privilege('authenticated', f, 'EXECUTE') and not has_function_privilege('anon', f, 'EXECUTE')
                      and not has_function_privilege('kb_cal_auth_child', f, 'EXECUTE'), format('0: %s is service_role only', f))
  from unnest(array['public.claim_service_deletion(uuid,text,uuid,uuid,uuid,integer)', 'public.renew_service_deletion_claim(uuid,text,uuid,uuid,integer)',
                    'public.release_service_deletion_claim(uuid,text,uuid,uuid)', 'public.record_owned_service_deletion_provider_result(uuid,text,uuid,uuid,text,text)',
                    'public.acknowledge_owned_remote_unverified(uuid,text,uuid,uuid,text[])', 'public.finish_owned_service_deletion(uuid,text,uuid,uuid)',
                    'public.abort_owned_service_deletion(uuid,text,uuid,uuid)', 'public.common_account_provider_snapshot(uuid)']) f;
select pg_temp.expect(not has_function_privilege(r, f, 'EXECUTE'), format('0: %s cannot execute %s', r, f))
  from unnest(array['anon', 'authenticated', 'service_role', 'kb_cal_auth_child', 'kb_cal_svc_child']) r,
       unnest(array['private.account_lifecycle_cleanup_authorized(uuid)', 'private.account_lifecycle_owned_service_operation(uuid,text,uuid,uuid)',
                    'private.account_lifecycle_finish_service_deletion(uuid,text,uuid)', 'private.account_lifecycle_abort_service_deletion(uuid,text,uuid)']) f;
select pg_temp.expect(pg_temp.as_role(format('select public.claim_service_deletion(%L::uuid, ''x_autopost'', gen_random_uuid())', pg_temp.uid(1)), 'authenticated', pg_temp.uid(1))
                      like 'ERR:permission denied for function%', '0: a person cannot claim');

-- A. The claim: provider snapshot, scope, refusals. -----------------------------------------------------
select pg_temp.person(1) as u \gset a_
select pg_temp.account(:'a_u', 'threads');
select pg_temp.begin_service(:'a_u') as op \gset a_
select pg_temp.claim(:'a_u', :'a_op') as c \gset a_
select pg_temp.expect(:'a_c'::jsonb ->> 'status' = 'acquired' and (:'a_c'::jsonb ->> 'fence')::int = 1, 'A1: acquired, fence 1');
select (:'a_c'::jsonb ->> 'lease') as lease \gset a_
select pg_temp.expect(pg_temp.results(:'a_op') = '{"x": "pending", "threads": "pending"}'::jsonb, 'A2: X always, and every connected platform, pending');
select pg_temp.expect(pg_temp.claim(:'a_u', :'a_op') ->> 'status' = 'in_progress', 'A3: a second claim while the lease is live');
select pg_temp.expect(pg_temp.as_role(format('select public.claim_service_deletion(%L::uuid, ''kabumori'', %L::uuid)', :'a_u', :'a_op'), 'service_role') like 'ERR:ACCOUNT_LIFECYCLE_SERVICE_INVALID',
                      'A4: only POSTONA has an owner lease');
select pg_temp.expect(pg_temp.claim(pg_temp.uid(9999), :'a_op') ->> 'status' = 'not_found', 'A5: another person / unknown cannot claim this operation');
select pg_temp.expect(pg_temp.svc(format('select public.renew_service_deletion_claim(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid)', :'a_u', :'a_op', :'a_lease')) ->> 'status' = 'owned', 'A6: renew');
select pg_temp.expect(pg_temp.svc(format('select public.renew_service_deletion_claim(%L::uuid, ''x_autopost'', %L::uuid, gen_random_uuid())', :'a_u', :'a_op')) ->> 'status' = 'lease_lost', 'A7: a wrong lease is not the owner');
-- a service-only claim is refused while a whole-account deletion is open
select pg_temp.person(2) as u \gset a2_
select pg_temp.begin_service(:'a2_u') as op \gset a2_
select pg_temp.expect(pg_temp.svc(format('select public.begin_common_account_deletion(%L::uuid, %s)', :'a2_u',
        (select lifecycle_version from public.common_accounts where user_id = :'a2_u'))) ->> 'status' = 'started', 'A8 setup: account deletion begun');
select pg_temp.expect(pg_temp.claim(:'a2_u', :'a2_op') = jsonb_build_object('status', 'blocked', 'reason', 'ACCOUNT_DELETION_IN_PROGRESS'), 'A8: service-only claim refused during an account deletion');
-- an entitlement that is not "deleting" is inconsistent
select pg_temp.person(3) as u \gset a3_
select pg_temp.begin_service(:'a3_u') as op \gset a3_
update public.service_entitlements set status = 'active' where user_id = :'a3_u' and service_key = 'x_autopost';
select pg_temp.expect(pg_temp.claim(:'a3_u', :'a3_op') ->> 'reason' = 'LIFECYCLE_STATE_INCONSISTENT', 'A9: inconsistent state refused');

-- B. Expiry, takeover, a stale owner. ------------------------------------------------------------------------
update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() - interval '1 second' where id = :'a_op';
select pg_temp.claim(:'a_u', :'a_op') as c \gset b_
select pg_temp.expect(:'b_c'::jsonb ->> 'status' = 'acquired' and (:'b_c'::jsonb ->> 'fence')::int = 2, 'B1: an expired lease is taken over, fence 2');
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'a_lease', 'x', 'done') ->> 'status' = 'lease_lost', 'B2: the old owner cannot record');
select pg_temp.expect(pg_temp.finish(:'a_u', :'a_op', :'a_lease') ->> 'status' = 'lease_lost', 'B3: the old owner cannot finish');
select pg_temp.expect(pg_temp.svc(format('select public.release_service_deletion_claim(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid)', :'a_u', :'a_op', :'a_lease')) ->> 'status' = 'not_owned', 'B4: the old owner cannot release the new lease');
select pg_temp.expect(pg_temp.status_of(:'a_u', 'x_autopost') = 'deleting', 'B5: nothing was ended by a stale owner');
select (:'b_c'::jsonb ->> 'lease') as lease \gset b_
-- the lease that ends AFTER the call began but before the write: wall clock, not the transaction start
update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() - interval '1 millisecond' where id = :'a_op';
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'b_lease', 'x', 'done') ->> 'status' = 'lease_lost', 'B6: an expired lease records nothing');
update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() + interval '5 minutes' where id = :'a_op';

-- C. What each provider answered; the finish gates. ------------------------------------------------------
select pg_temp.expect(pg_temp.finish(:'a_u', :'a_op', :'b_lease') = jsonb_build_object('status', 'not_ready', 'reason', 'PROVIDER_RESULTS_UNSETTLED', 'providers', jsonb_build_array('threads', 'x')),
                      'C1: pending results are not settled');
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'b_lease', 'x', 'done') ->> 'status' = 'recorded', 'C2: X recorded');
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'b_lease', 'threads', 'reconciliation_required') ->> 'status' = 'recorded', 'C3: an unreconciled answer');
select pg_temp.expect(pg_temp.finish(:'a_u', :'a_op', :'b_lease') ->> 'reason' = 'PROVIDER_RESULTS_UNSETTLED', 'C4: reconciliation_required blocks the end');
select pg_temp.rec(:'a_u', :'a_op', :'b_lease', 'threads', 'blocked');
select pg_temp.expect(pg_temp.finish(:'a_u', :'a_op', :'b_lease') ->> 'reason' = 'PROVIDER_RESULTS_UNSETTLED', 'C5: blocked blocks the end');
select pg_temp.rec(:'a_u', :'a_op', :'b_lease', 'threads', 'local_removed_remote_unverified');
select pg_temp.expect(pg_temp.finish(:'a_u', :'a_op', :'b_lease') = jsonb_build_object('status', 'not_ready', 'reason', 'REMOTE_UNVERIFIED_NOT_ACKNOWLEDGED', 'providers', jsonb_build_array('threads')),
                      'C6: an unverified remote grant needs the person''s acknowledgement');
-- a retry can only say "not connected": the fact stays
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'b_lease', 'threads', 'not_connected') ->> 'kept' = 'local_removed_remote_unverified'
                      and pg_temp.results(:'a_op') ->> 'threads' = 'local_removed_remote_unverified', 'C7: a later weaker answer does not erase the fact');
select pg_temp.expect(pg_temp.rec(:'a_u', :'a_op', :'b_lease', 'threads', 'blocked') ->> 'kept' = 'local_removed_remote_unverified', 'C8: nor does a later blocked');
select pg_temp.expect(pg_temp.as_role(format('select public.acknowledge_owned_remote_unverified(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid, array[''x''])', :'a_u', :'a_op', :'b_lease'), 'service_role') like 'ERR:ACCOUNT_LIFECYCLE_PROVIDER_RESULT_INVALID%',
                      'C9: X is not acknowledgeable (it is not a remote-unverified provider)');
select pg_temp.expect(pg_temp.as_role(format('select public.record_owned_service_deletion_provider_result(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid, ''Threads'', ''done'')', :'a_u', :'a_op', :'b_lease'), 'service_role') like 'ERR:ACCOUNT_LIFECYCLE_PROVIDER_RESULT_INVALID%',
                      'C10: a malformed provider key');
select pg_temp.expect(pg_temp.as_role(format('select public.record_owned_service_deletion_provider_result(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid, ''threads'', ''ok'')', :'a_u', :'a_op', :'b_lease'), 'service_role') like 'ERR:ACCOUNT_LIFECYCLE_PROVIDER_RESULT_INVALID%',
                      'C11: an unknown result');
select pg_temp.expect(pg_temp.svc(format('select public.acknowledge_owned_remote_unverified(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid, array[''threads''])', :'a_u', :'a_op', :'b_lease')) ->> 'status' = 'recorded', 'C12: acknowledged');
select pg_temp.expect((select remote_unverified_ack_providers = array['threads'] and remote_unverified_ack_at is not null from private.account_lifecycle_operations where id = :'a_op'),
                      'C13: the acknowledgement is on the record (when, which)');
-- the footprint is still the Phase 1 gate: the Threads row has not been removed
select pg_temp.expect(pg_temp.finish(:'a_u', :'a_op', :'b_lease') ->> 'reason' = 'SERVICE_FOOTPRINT_REMAINS', 'C14: a remaining social account still blocks (Phase 1 read-back)');
delete from public.social_accounts where brand_id = public.social_mobile_account_deletion_workspace(:'a_u');
delete from public.brand_memberships where brand_id = public.social_mobile_account_deletion_workspace(:'a_u');
delete from public.brands where id = public.social_mobile_account_deletion_workspace(:'a_u');
select pg_temp.expect(pg_temp.finish(:'a_u', :'a_op', :'b_lease') ->> 'status' = 'ended', 'C15: ended by the owner once settled, acknowledged and read back');
select pg_temp.expect(pg_temp.status_of(:'a_u', 'x_autopost') = 'ended', 'C16: the entitlement ended');
select pg_temp.expect((select status = 'completed' and owner_lease is null and provider_results ->> 'threads' = 'local_removed_remote_unverified' from private.account_lifecycle_operations where id = :'a_op'),
                      'C17: completed, lease cleared, the provider facts kept');

-- C-x. X is always accounted for: even if the record lost its `x` key, the end is refused.
select pg_temp.person(50) as u \gset cx_
select pg_temp.begin_service(:'cx_u') as op \gset cx_
select pg_temp.claim(:'cx_u', :'cx_op') ->> 'lease' as lease \gset cx_
update private.account_lifecycle_operations set provider_results = provider_results - 'x' where id = :'cx_op';
select pg_temp.expect(pg_temp.finish(:'cx_u', :'cx_op', :'cx_lease') = jsonb_build_object('status', 'not_ready', 'reason', 'PROVIDER_RESULTS_UNSETTLED', 'providers', jsonb_build_array('x')),
                      'C-x: without an X answer the end is refused');

-- D. The legacy entry points. ----------------------------------------------------------------------------
select pg_temp.person(10, true) as u \gset d_
select pg_temp.begin_service(:'d_u') as op \gset d_
select pg_temp.expect(pg_temp.svc(format('select public.finish_service_deletion(%L::uuid, ''x_autopost'', %L::uuid)', :'d_u', :'d_op')) = jsonb_build_object('status', 'blocked', 'reason', 'OWNED_FINISH_REQUIRED'),
                      'D1: the legacy finish refuses POSTONA');
select pg_temp.expect(pg_temp.svc(format('select public.abort_service_deletion(%L::uuid, ''x_autopost'', %L::uuid)', :'d_u', :'d_op')) = jsonb_build_object('status', 'blocked', 'reason', 'OWNED_ABORT_REQUIRED'),
                      'D2: the legacy abort refuses POSTONA');
select pg_temp.expect(pg_temp.status_of(:'d_u', 'x_autopost') = 'deleting', 'D3: refusals changed nothing');
select pg_temp.expect(pg_temp.svc(format('select public.withdraw_kabumori_service(%L::uuid)', :'d_u')) ->> 'status' = 'ended', 'D4: Kabumori withdrawal is unchanged');
select pg_temp.expect(pg_temp.status_of(:'d_u', 'kabumori') = 'ended' and pg_temp.status_of(:'d_u', 'x_autopost') = 'deleting', 'D5: Kabumori ended, POSTONA untouched');
select pg_temp.claim(:'d_u', :'d_op') as c \gset d_
select (:'d_c'::jsonb ->> 'lease') as lease \gset d_
select pg_temp.expect(pg_temp.svc(format('select public.abort_owned_service_deletion(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid)', :'d_u', :'d_op', :'d_lease')) ->> 'status' = 'aborted', 'D6: the owner aborts');
select pg_temp.expect(pg_temp.status_of(:'d_u', 'x_autopost') = 'active' and pg_temp.status_of(:'d_u', 'kabumori') = 'ended',
                      'D7: POSTONA is active again; the other service is as it was');
select pg_temp.expect((select owner_lease is null from private.account_lifecycle_operations where id = :'d_op'), 'D8: the aborted operation holds no lease');

-- E. Inside a whole-account deletion: one chain of ownership. ----------------------------------------------
select pg_temp.person(20) as u \gset e_
select pg_temp.begin_service(:'e_u') as op \gset e_
select pg_temp.svc(format('select public.begin_common_account_deletion(%L::uuid, %s)', :'e_u',
         (select lifecycle_version from public.common_accounts where user_id = :'e_u'))) ->> 'operation_id' as aop \gset e_
select pg_temp.svc(format('select public.claim_common_account_deletion(%L::uuid, %L::uuid)', :'e_u', :'e_aop')) ->> 'lease' as alease \gset e_
select pg_temp.expect(pg_temp.svc(format('select public.claim_service_deletion(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid, gen_random_uuid())', :'e_u', :'e_op', :'e_aop')) ->> 'status' = 'lease_lost',
                      'E1: a wrong account lease is not the owner');
select pg_temp.svc(format('select public.claim_service_deletion(%L::uuid, ''x_autopost'', %L::uuid, %L::uuid, %L::uuid)', :'e_u', :'e_op', :'e_aop', :'e_alease')) as c \gset e_
select pg_temp.expect(:'e_c'::jsonb ->> 'status' = 'acquired', 'E2: acquired with the account deletion''s own lease');
update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() - interval '1 second' where id = :'e_aop';
select pg_temp.expect(pg_temp.claim(:'e_u', :'e_op') = jsonb_build_object('status', 'blocked', 'reason', 'ACCOUNT_DELETION_IN_PROGRESS'),
                      'E3: with the account lease ended, a service-only claim is still refused (the account deletion is open)');

-- F. The cleanup predicate and the snapshot. --------------------------------------------------------------
select pg_temp.person(30) as u \gset f_
select pg_temp.expect(not private.account_lifecycle_cleanup_authorized(:'f_u') and not private.account_lifecycle_cleanup_authorized(null), 'F1: nothing open: not authorized');
select pg_temp.begin_service(:'f_u') as op \gset f_
select pg_temp.expect(not private.account_lifecycle_cleanup_authorized(:'f_u'), 'F2: a service deletion without a lease is not authorized');
select pg_temp.claim(:'f_u', :'f_op') as c \gset f_
select pg_temp.expect(private.account_lifecycle_cleanup_authorized(:'f_u'), 'F3: with a live lease it is');
update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() - interval '1 second' where id = :'f_op';
select pg_temp.expect(not private.account_lifecycle_cleanup_authorized(:'f_u'), 'F4: an ended lease is not (wall clock)');
-- F4b. The wall clock inside ONE transaction: a lease that ends while the transaction runs is not live any more
--      (a transaction-start clock would still call it live).
create function pg_temp.wall_clock(p_user uuid, p_op uuid) returns boolean language plpgsql as $$
begin
  update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() + interval '300 milliseconds' where id = p_op;
  if not private.account_lifecycle_cleanup_authorized(p_user) then return false; end if;   -- live right now
  perform pg_sleep(0.7);
  return private.account_lifecycle_cleanup_authorized(p_user);                              -- must be false now
end;
$$;
select pg_temp.expect(pg_temp.wall_clock(:'f_u', :'f_op') = false, 'F4b: judged on the wall clock inside one transaction');
select pg_temp.expect(pg_temp.svc(format('select public.common_account_provider_snapshot(%L::uuid)', :'f_u')) = jsonb_build_object('workspace', public.social_mobile_account_deletion_workspace(:'f_u'), 'platforms', '[]'::jsonb),
                      'F5: no connected platform');
select pg_temp.account(:'f_u', 'threads');
select pg_temp.expect(pg_temp.svc(format('select public.common_account_provider_snapshot(%L::uuid)', :'f_u')) -> 'platforms' = '["threads"]'::jsonb, 'F6: the connected platforms');
select pg_temp.expect(pg_temp.as_role(format('select public.common_account_provider_snapshot(%L::uuid)::text', :'f_u'), 'authenticated', :'f_u') like 'ERR:permission denied%', 'F7: not for a person');

-- G. Isolation: another person's service end and the other service are never touched. -------------------------
select pg_temp.person(40, true) as u \gset g_
select pg_temp.person(41, true) as u \gset g2_
select pg_temp.begin_service(:'g_u') as op \gset g_
select pg_temp.claim(:'g_u', :'g_op') ->> 'lease' as lease \gset g_
select pg_temp.expect(pg_temp.status_of(:'g2_u', 'x_autopost') = 'active' and pg_temp.status_of(:'g2_u', 'kabumori') = 'active'
                      and pg_temp.status_of(:'g_u', 'kabumori') = 'active', 'G1: another person and the same person''s Kabumori are untouched');
select pg_temp.expect(pg_temp.rec(:'g2_u', :'g_op', :'g_lease', 'x', 'done') ->> 'status' = 'lease_lost', 'G2: another person cannot use this operation or lease');

select 'COMMON_ACCOUNT_SERVICE_DELETION_BEHAVIOR_PASS';
