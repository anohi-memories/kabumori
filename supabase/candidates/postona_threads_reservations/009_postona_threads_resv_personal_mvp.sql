-- G3 SOURCE CANDIDATE (2026-10-29, Issue #318 G3-40). NOT in supabase/migrations/, NOT applied anywhere. Production NO_GO.
--
-- The Threads reservations (007) on G5's PERSONAL MVP auth profile (PR #550, supabase/candidates/postona_personal_mvp_auth, a source
-- candidate: G5's formal adoption, the R1 ACL decision and its independent review are still open) -- the Threads twin of X's 008. There:
--   R1-MVP public.common_account_authorization_verdict('postona', 'threads_publish', brand) -> an allow carries owner_epoch = 'g5pv:<V>'
--          (the person's generation token, NOT an owner epoch)
--   MV     private.postona_personal_worker_verdict(user, brand, 'x_autopost', expected_lifecycle_version) -> 'active' | reason
--          (personal workspace, exactly one membership = the user as owner, F5 state active, the generation still V; owner-only)
--   G5's old W1 (private.account_lifecycle_worker_brand_verdict) does not exist.
-- 007 binds / checks the FULL profile (g5oe:<epoch>:<lifecycle> and W1): there every create is refused and nothing is sent.
-- This file switches exactly the two internal G5 adapters of 007 -- never both profiles at once:
--   g5_r1_bound(brand)   binds ONLY 'g5pv:<V>' (bound_owner_epoch stays NULL, bound_lifecycle_version = V); anything else refuses
--   g5_bound_state(row)  MV(row.user_id, row.brand_id, 'x_autopost', row.bound_lifecycle_version); unbound / no answer -> never 'active'
-- claim_due, preflight (so the dispatcher's pre-publish hook) and record call g5_bound_state: a reservation made in generation V is never
-- claimed or sent after the person's generation moves (an end, a restart, a lock, a deletion) or the workspace stops being the person's
-- own single-owner one; a new one in the new generation works. The Threads credential generation (bound at claim, compared at preflight)
-- and G4's verified-account predicate (still DENY until G4 delivers) are unchanged.
-- Residual (G5's, stated in its docs): an owner change UNDONE between creation and the run (A -> B -> A, only service_role / the owner
-- writing brand_memberships) is invisible to MV. A session ending is S2-2's (caller()).
-- Preconditions (all refuse, nothing created): not a superuser; 007 applied by this owner with the FULL adapters; R1-MVP and MV present
-- (MV STABLE, SECURITY DEFINER, owned by this owner, unreachable from the API roles); G5's old W1 absent; no planned / claimed row bound
-- under the full profile (no mixing). Rollback: 009_postona_threads_resv_personal_mvp_rollback.sql.
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_mv regprocedure := pg_catalog.to_regprocedure('private.postona_personal_worker_verdict(uuid,text,text,bigint)');
  v_r1 regprocedure := pg_catalog.to_regprocedure('public.common_account_authorization_verdict(text,text,text)');
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'G3_THREADS_MVP_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if pg_catalog.to_regprocedure('postona_threads_resv.g5_bound_state(postona_threads_resv.reservations)') is null
     or pg_catalog.to_regprocedure('postona_threads_resv.g5_r1_bound(text)') is null
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_threads_resv') is distinct from v_owner then
    raise exception 'G3_THREADS_MVP_PRECONDITION_007_MISSING';
  end if;
  if (select p.prosrc from pg_catalog.pg_proc p
      where p.oid = 'postona_threads_resv.g5_bound_state(postona_threads_resv.reservations)'::pg_catalog.regprocedure) ~ 'G3_G5_PROFILE_MVP' then
    raise exception 'G3_THREADS_MVP_ALREADY_APPLIED';
  end if;
  if (select p.prosrc from pg_catalog.pg_proc p
      where p.oid = 'postona_threads_resv.g5_bound_state(postona_threads_resv.reservations)'::pg_catalog.regprocedure) !~ 'G3_G5_PROFILE_FULL'
     or (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'postona_threads_resv.g5_r1_bound(text)'::pg_catalog.regprocedure) !~ 'G3_G5_PROFILE_FULL' then
    raise exception 'G3_THREADS_MVP_PRECONDITION_ADAPTERS_UNKNOWN';
  end if;
  if v_r1 is null or (select p.prosrc from pg_catalog.pg_proc p where p.oid = v_r1) !~ '''g5pv:''' then
    raise exception 'G3_THREADS_MVP_PRECONDITION_R1_MVP';
  end if;
  if v_mv is null
     or exists (select 1 from pg_catalog.pg_proc p where p.oid = v_mv and (p.provolatile <> 's' or not p.prosecdef or p.proowner <> v_owner))
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'postona_resv_api', 'postona_resv_worker')
                and pg_catalog.has_function_privilege(r.oid, v_mv, 'EXECUTE')) then
    raise exception 'G3_THREADS_MVP_PRECONDITION_MV';
  end if;
  if pg_catalog.to_regprocedure('private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)') is not null then
    raise exception 'G3_THREADS_MVP_PRECONDITION_FULL_PROFILE_PRESENT';
  end if;
  if exists (select 1 from postona_threads_resv.reservations r where r.status in ('planned', 'claimed') and r.bound_owner_epoch is not null) then
    raise exception 'G3_THREADS_MVP_PRECONDITION_MIXED_BINDINGS';
  end if;
end $$;

-- 007's pair rule (both bound numbers or neither) becomes "an owner epoch only with a generation": a personal-MVP row carries V alone.
do $$
declare v_name text;
begin
  select c.conname into v_name from pg_catalog.pg_constraint c
  where c.conrelid = 'postona_threads_resv.reservations'::pg_catalog.regclass and c.contype = 'c'
    and pg_catalog.pg_get_constraintdef(c.oid) in ('CHECK (((bound_owner_epoch IS NULL) = (bound_lifecycle_version IS NULL)))',
                                                   'CHECK (((bound_owner_epoch IS NULL) = (bound_lifecycle_version IS NULL))) NOT VALID');
  if v_name is null then
    raise exception 'G3_THREADS_MVP_PRECONDITION_PAIR_CHECK';
  end if;
  execute pg_catalog.format('alter table postona_threads_resv.reservations drop constraint %I', v_name);
  alter table postona_threads_resv.reservations add constraint reservations_personal_mvp_bound
    check (bound_owner_epoch is null or bound_lifecycle_version is not null);
  -- the rollback re-adds 007's rule under its own name
  execute pg_catalog.format('comment on constraint reservations_personal_mvp_bound on postona_threads_resv.reservations is %L', v_name);
end $$;

/** G3-40 (personal MVP): the caller's R1-MVP verdict for this workspace (feature threads_publish); only an allow with 'g5pv:<V>' binds V. */
create or replace function postona_threads_resv.g5_r1_bound(p_brand_id text, out owner_epoch bigint, out lifecycle_version bigint)
language plpgsql volatile security definer set search_path = '' as $$
-- G3_G5_PROFILE_MVP (g5pv / MV)
declare v_verdict jsonb; v text[];
begin
  if pg_catalog.to_regprocedure('public.common_account_authorization_verdict(text,text,text)') is null then
    raise exception 'POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  v_verdict := public.common_account_authorization_verdict('postona', 'threads_publish', p_brand_id);
  if v_verdict ->> 'decision' is distinct from 'allow' then
    raise exception 'POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  v := pg_catalog.regexp_match(coalesce(v_verdict ->> 'owner_epoch', ''), '^g5pv:([1-9][0-9]{0,18})$');
  if v is null then
    raise exception 'POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  begin
    lifecycle_version := v[1]::bigint;
  exception when numeric_value_out_of_range then
    raise exception 'POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE' using errcode = 'P0001';
  end;
  owner_epoch := null;
end $$;

/** G3-40 (personal MVP): G5's MV for the row's user, workspace and bound generation; unbound or no answer is never 'active'. */
create or replace function postona_threads_resv.g5_bound_state(p_row postona_threads_resv.reservations) returns text
language plpgsql stable security definer set search_path = '' as $$
-- G3_G5_PROFILE_MVP (g5pv / MV)
begin
  if p_row.bound_lifecycle_version is null or p_row.bound_owner_epoch is not null then return 'PERSONAL_GENERATION_UNBOUND'; end if;
  if pg_catalog.to_regprocedure('private.postona_personal_worker_verdict(uuid,text,text,bigint)') is null then
    return 'SERVICE_STATE_UNKNOWN';
  end if;
  return coalesce(private.postona_personal_worker_verdict(p_row.user_id, p_row.brand_id, 'x_autopost', p_row.bound_lifecycle_version),
                  'SERVICE_STATE_UNKNOWN');
end $$;

revoke all on function postona_threads_resv.g5_r1_bound(text) from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
revoke all on function postona_threads_resv.g5_bound_state(postona_threads_resv.reservations)
  from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;

do $$
begin
  if exists (select 1 from pg_catalog.pg_roles r
             cross join (values ('postona_threads_resv.g5_r1_bound(text)'),
                                ('postona_threads_resv.g5_bound_state(postona_threads_resv.reservations)')) f(fn)
             where r.rolname in ('anon', 'authenticated', 'service_role', 'postona_resv_api', 'postona_resv_worker')
               and pg_catalog.has_function_privilege(r.oid, f.fn::pg_catalog.regprocedure, 'EXECUTE')) then
    raise exception 'G3_THREADS_MVP_POSTCONDITION_ACL';
  end if;
end $$;

commit;
