-- Evidence probe (F5, Phase 6), run by common_account_phase6_overlay_run.sh on the overlay world AFTER F4's guards
-- candidate and F4's T13 behavior suite (so t13.* and the disconnect gate override are present), as the table owner.
-- Fake data only. Prints EVIDENCE lines and ends with PHASE6_OVERLAY_PROBE_OK, or raises with a fixed label.
--
-- A. Ownership / ACL (exact): every definer F4 ships for the Threads writers and the cleanup, and every G5 guard they
--    call, is owned by the table owner (not a superuser), SECURITY DEFINER with an empty search_path, reachable by no
--    API role except the exact set the matrix below names; PUBLIC reaches none. G5's Phase 6 functions are
--    service_role-only.
-- B. Ordering (exact, from the installed source): the caller's T13 decision, then the workspace owner's F5 decision,
--    come before the first workspace / account row lock in every writer that takes the owner's decision.
-- C. Predicate scopes (computed, not asserted by hand): in every lifecycle state, the writers' decision (T13 for the
--    caller, F5 for the owner), the worker's advisory read, the cleanup predicate and F4's own cleanup authorization,
--    side by side; the mutual-exclusion and agreement invariants are asserted.
set timezone = 'UTC';

-- ---- A. ownership / ACL ----------------------------------------------------------------------------------------
create temp table expected_acl (fn text primary key, anon boolean, auth boolean, svc boolean);
insert into expected_acl values
  -- F4: the person's calls (authenticated only)
  ('public.set_threads_manual_publish_permission(text,boolean,boolean)', false, true, false),
  ('public.begin_threads_manual_publish(text,uuid,text)', false, true, false),
  ('public.release_threads_manual_publish_step(uuid,text,bigint,text,text)', false, true, false),
  ('public.record_threads_manual_publish_result(uuid,text,text,text,text,text,text,text,bigint,text,text)', false, true, false),
  ('public.disconnect_threads_account(text,text)', false, true, false),
  ('public.get_threads_manual_publish_state(text)', false, true, false),
  ('public.get_threads_manual_publish_attempt(uuid)', false, true, false),
  -- F4: internal decisions and helpers (nobody)
  ('public.threads_manual_publish_authorize(uuid,text,boolean)', false, false, false),
  ('public.threads_manual_publish_fence(uuid)', false, false, false),
  ('public.threads_manual_publish_owner_fence(text)', false, false, false),
  ('public.threads_manual_publish_attestation_valid(text,text)', false, false, false),
  ('public.threads_account_credential_expires_at(text)', false, false, false),
  ('public.threads_cleanup_authorized(uuid)', false, false, false),
  -- F4: the cleanup pair (owner only until G5's grant candidate is applied)
  ('public.threads_provider_connection_state(uuid)', false, false, false),
  ('public.cleanup_threads_provider_footprint(uuid)', false, false, false),
  -- PR #124: the owner channel (H5)
  ('public.begin_social_mobile_threads_oauth_connection(text,text,timestamp with time zone)', false, false, false),
  ('public.consume_social_mobile_threads_oauth_state(text)', false, false, false),
  ('public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text)', false, false, false),
  -- G5 / F5 guards (nobody)
  ('private.account_lifecycle_assert_active_service_write(uuid,text)', false, false, false),
  ('private.account_lifecycle_assert_brand_service_active(text,text)', false, false, false),
  ('private.account_lifecycle_service_state_refusal(uuid,text)', false, false, false),
  ('private.account_lifecycle_service_state_readonly(uuid,text)', false, false, false),
  ('private.account_lifecycle_brand_owner(text)', false, false, false),
  ('private.account_lifecycle_cleanup_authorized(uuid)', false, false, false),
  -- G5 / F5: what the worker and the deletion function may call (service_role only)
  ('public.common_account_brand_service_state(text,text)', false, false, true),
  ('public.common_account_provider_snapshot(uuid)', false, false, true),
  ('public.begin_service_deletion(uuid,text)', false, false, true),
  ('public.finish_service_deletion(uuid,text,uuid)', false, false, true),
  ('public.abort_service_deletion(uuid,text,uuid)', false, false, true),
  ('public.claim_service_deletion(uuid,text,uuid,uuid,uuid,integer)', false, false, true),
  ('public.renew_service_deletion_claim(uuid,text,uuid,uuid,integer)', false, false, true),
  ('public.release_service_deletion_claim(uuid,text,uuid,uuid)', false, false, true),
  ('public.record_owned_service_deletion_provider_result(uuid,text,uuid,uuid,text,text)', false, false, true),
  ('public.acknowledge_owned_remote_unverified(uuid,text,uuid,uuid,text[])', false, false, true),
  ('public.finish_owned_service_deletion(uuid,text,uuid,uuid)', false, false, true),
  ('public.abort_owned_service_deletion(uuid,text,uuid,uuid)', false, false, true);

do $$
declare
  r record;
  v_owner oid := (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass);
  v_oid regprocedure;
begin
  if (select rolsuper from pg_roles where oid = v_owner) is not false then
    raise exception 'PROBE_A_OWNER_IS_SUPERUSER';
  end if;
  -- no API role reaches the owner's privileges through membership
  if exists (select 1 from pg_roles x where x.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
               and pg_has_role(x.oid, v_owner, 'MEMBER')) then
    raise exception 'PROBE_A_MEMBERSHIP';
  end if;
  for r in select * from expected_acl order by fn loop
    v_oid := r.fn::regprocedure;
    if (select p.proowner from pg_proc p where p.oid = v_oid) is distinct from v_owner then
      raise exception 'PROBE_A_OWNER %', r.fn;
    end if;
    if not (select p.prosecdef from pg_proc p where p.oid = v_oid)
       or not coalesce((select p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = v_oid), false) then
      raise exception 'PROBE_A_DEFINER_OR_SEARCH_PATH %', r.fn;
    end if;
    if has_function_privilege('anon', v_oid, 'EXECUTE') is distinct from r.anon
       or has_function_privilege('authenticated', v_oid, 'EXECUTE') is distinct from r.auth
       or has_function_privilege('service_role', v_oid, 'EXECUTE') is distinct from r.svc
       or has_function_privilege('public', v_oid, 'EXECUTE') then
      raise exception 'PROBE_A_ACL %', r.fn;
    end if;
  end loop;
end $$;
select 'EVIDENCE A: ' || count(*) || ' functions: owner = the owner of public.social_accounts (non-superuser), SECURITY DEFINER, search_path empty; ACL exactly as listed; PUBLIC none; no API role is a member of the owner'
  from expected_acl;

-- ---- B. ordering, from the installed source ---------------------------------------------------------------------
create temp table order_src as
select p.proname as fn,
       lower(regexp_replace(p.prosrc, '--[^\n]*', '', 'g')) as s
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('threads_manual_publish_authorize', 'set_threads_manual_publish_permission', 'begin_threads_manual_publish',
                     'release_threads_manual_publish_step', 'disconnect_threads_account', 'cleanup_threads_provider_footprint');
do $$
declare
  r record;
  v_ws_lock constant text := 'from public\.(brands|brand_memberships|social_accounts|social_account_manual_publish_permissions|threads_manual_publish_attempts) [^;]*for (share|update)';
  v_caller int; v_owner int; v_auth int; v_first int; v_guard int;
begin
  for r in select * from order_src where fn in ('threads_manual_publish_authorize', 'set_threads_manual_publish_permission',
                                                  'begin_threads_manual_publish', 'release_threads_manual_publish_step') order by fn loop
    v_caller := regexp_instr(r.s, 'threads_manual_publish_fence\(');
    v_owner := regexp_instr(r.s, 'threads_manual_publish_owner_fence\(');
    v_auth := regexp_instr(r.s, 'threads_manual_publish_authorize\(');
    v_first := regexp_instr(r.s, v_ws_lock);
    -- the owner's decision is the owner fence itself, or the authorize rule that starts with it
    v_guard := case when v_owner > 0 then v_owner else v_auth end;
    if v_guard = 0 then raise exception 'PROBE_B_NO_OWNER_DECISION %', r.fn; end if;
    if v_first > 0 and v_guard > v_first then raise exception 'PROBE_B_OWNER_DECISION_AFTER_ROW_LOCK % (% > %)', r.fn, v_guard, v_first; end if;
    -- the caller's T13 decision comes first wherever the function takes it itself
    if v_caller > 0 and v_caller > v_guard then raise exception 'PROBE_B_CALLER_AFTER_OWNER %', r.fn; end if;
    raise notice 'ordering % caller_t13=% owner_decision=% first_workspace_row_lock=%', r.fn, v_caller, v_guard, v_first;
  end loop;
  -- the removal paths: G5's decision first (disconnect); the cleanup reads G5's table and takes the workspace lock
  select regexp_instr(s, 'account_lifecycle_service_state_refusal'), regexp_instr(s, v_ws_lock)
    into v_guard, v_first from order_src where fn = 'disconnect_threads_account';
  if v_guard = 0 or v_guard > v_first then raise exception 'PROBE_B_DISCONNECT_ORDER'; end if;
  select regexp_instr(s, 'social_mobile_account_deletion_workspace_lock'), regexp_instr(s, 'account_lifecycle_[a-z_]+\(')
    into v_guard, v_first from order_src where fn = 'cleanup_threads_provider_footprint';
  if v_guard = 0 or v_first <> 0 then raise exception 'PROBE_B_CLEANUP_TAKES_A_LIFECYCLE_LOCK'; end if;
end $$;
select 'EVIDENCE B: ' || fn || ' caller_t13@' || regexp_instr(s, 'threads_manual_publish_fence\(')
       || ' owner_decision@' || (case when regexp_instr(s, 'threads_manual_publish_owner_fence\(') > 0
                                      then regexp_instr(s, 'threads_manual_publish_owner_fence\(')
                                      else regexp_instr(s, 'threads_manual_publish_authorize\(') end)
       || ' first_workspace_row_lock@'
       || regexp_instr(s, 'from public\.(brands|brand_memberships|social_accounts|social_account_manual_publish_permissions|threads_manual_publish_attempts) [^;]*for (share|update)')
  from order_src
 where fn in ('threads_manual_publish_authorize', 'set_threads_manual_publish_permission', 'begin_threads_manual_publish', 'release_threads_manual_publish_step')
 order by fn;
select 'EVIDENCE B: in the installed source the caller''s T13 decision, then the owner''s F5 decision, come before the first workspace/account row lock in authorize, set_permission(ON), begin and release; disconnect decides with G5 first; the cleanup takes no lifecycle lock (workspace lock only)';

-- ---- C. predicate scopes, computed -----------------------------------------------------------------------------------
create temp table scopes (state text primary key, t13 text, f5_writer text, worker text, cleanup boolean, f4_cleanup boolean);
create function pg_temp.pid(p_tag text) returns uuid language sql immutable as $$ select md5('probe-c:' || p_tag)::uuid $$;
do $$
declare
  s record;
  v_user uuid;
  v_ws text;
begin
  for s in select * from (values
      ('active'), ('suspended'), ('ended'), ('service_deleting_no_lease'), ('service_deleting_live_lease'),
      ('service_deleting_expired_lease'), ('account_deleting_no_lease'), ('account_deleting_live_lease'), ('locked')) v(state) loop
    v_user := pg_temp.pid(s.state);
    perform t13.person(v_user, 'pc_' || replace(s.state, '_', ''));
    v_ws := public.social_mobile_account_deletion_workspace(v_user);
    case s.state
      when 'suspended' then perform t13.state(v_user, 'suspended');
      when 'ended' then perform t13.state(v_user, 'ended');
      when 'locked' then perform t13.state(v_user, 'locked');
      when 'service_deleting_no_lease', 'service_deleting_live_lease', 'service_deleting_expired_lease' then
        perform t13.state(v_user, 'service_deleting');
        if s.state = 'service_deleting_live_lease' then
          update private.account_lifecycle_operations set owner_lease = gen_random_uuid(), owner_lease_expires_at = clock_timestamp() + interval '10 minutes'
           where user_id = v_user and operation_type = 'service_deletion' and status = 'in_progress';
        elsif s.state = 'service_deleting_expired_lease' then
          update private.account_lifecycle_operations set owner_lease = gen_random_uuid(), owner_lease_expires_at = clock_timestamp() - interval '1 minute'
           where user_id = v_user and operation_type = 'service_deletion' and status = 'in_progress';
        end if;
      when 'account_deleting_no_lease', 'account_deleting_live_lease' then
        perform t13.state(v_user, 'account_deleting');
        if s.state = 'account_deleting_live_lease' then
          update private.account_lifecycle_operations set owner_lease = gen_random_uuid(), owner_lease_expires_at = clock_timestamp() + interval '10 minutes'
           where user_id = v_user and operation_type = 'account_deletion' and status = 'in_progress';
        end if;
      else null;
    end case;
    insert into scopes values (
      s.state,
      t13.call(v_user, format('select private.account_lifecycle_assert_active_service_write(%L::uuid, ''x_autopost'')', v_user), 'owner'),
      t13.call(v_user, format('select private.account_lifecycle_assert_brand_service_active(%L, ''x_autopost'')', v_ws), 'owner'),
      public.common_account_brand_service_state(v_ws, 'x_autopost'),
      private.account_lifecycle_cleanup_authorized(v_user),
      public.threads_cleanup_authorized(v_user));
  end loop;
end $$;
select 'EVIDENCE C: ' || format('%-32s t13=%-46s f5_writer=%-46s worker=%-30s cleanup=%-5s f4_cleanup=%s', state, t13, f5_writer, worker, cleanup, f4_cleanup)
  from scopes order by state;
do $$
declare r record;
begin
  for r in select * from scopes loop
    -- the three "may write" scopes agree: the caller's T13, the owner's F5 decision and the worker's read allow in
    -- exactly the same states (the caller is the owner here); all of them refuse the moment a deletion is open.
    if (r.t13 = 'OK') is distinct from (r.f5_writer = 'OK') or (r.f5_writer = 'OK') is distinct from (r.worker = 'active') then
      raise exception 'PROBE_C_WRITE_SCOPES_DISAGREE %', r.state;
    end if;
    -- "may write" and "may remove" never hold together
    if r.cleanup and r.t13 = 'OK' then raise exception 'PROBE_C_WRITE_AND_REMOVE %', r.state; end if;
  end loop;
  -- only a deletion that holds a LIVE lease authorizes the removal (G5's predicate) ...
  if (select array_agg(state order by state) from scopes where cleanup)
       is distinct from array['account_deleting_live_lease', 'service_deleting_live_lease'] then
    raise exception 'PROBE_C_CLEANUP_STATES %', (select array_agg(state order by state) from scopes where cleanup);
  end if;
  if (select t13 || f5_writer || worker from scopes where state = 'active') is distinct from 'OKOKactive' then
    raise exception 'PROBE_C_ACTIVE';
  end if;
  -- ... and F4's own authorization (as shipped) is wider for a service deletion: it does not need the lease.
  if (select array_agg(state order by state) from scopes where f4_cleanup)
       is distinct from array['account_deleting_live_lease', 'service_deleting_expired_lease', 'service_deleting_live_lease', 'service_deleting_no_lease'] then
    raise exception 'PROBE_C_F4_CLEANUP_STATES %', (select array_agg(state order by state) from scopes where f4_cleanup);
  end if;
end $$;
select 'EVIDENCE C: F4''s cleanup authorization as shipped also authorizes service_deleting_no_lease and service_deleting_expired_lease (F4-owned correction: private.account_lifecycle_cleanup_authorized)';
select 'PHASE6_OVERLAY_PROBE_OK';
