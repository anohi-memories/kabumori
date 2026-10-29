-- G3 SOURCE CANDIDATE (2026-10-29, Issue #318 G3-40): rollback of 009_postona_threads_resv_personal_mvp.sql. NOT applied anywhere.
-- Restores 007's FULL-profile adapters (g5oe / W1) verbatim and its pair rule under its own name. The pair rule comes back NOT VALID: rows
-- bound under the MVP (a generation, no owner epoch) stay, and the FULL g5_bound_state answers EXPECTED_OWNER_EPOCH_REQUIRED for them --
-- they are never claimed or sent. Refuses unless 009 is applied (nothing changed).
begin;

set local lock_timeout = '5s';

do $$
begin
  if pg_catalog.to_regprocedure('postona_threads_resv.g5_bound_state(postona_threads_resv.reservations)') is null
     or (select p.prosrc from pg_catalog.pg_proc p
         where p.oid = 'postona_threads_resv.g5_bound_state(postona_threads_resv.reservations)'::pg_catalog.regprocedure) !~ 'G3_G5_PROFILE_MVP'
     or (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'postona_threads_resv.g5_r1_bound(text)'::pg_catalog.regprocedure) !~ 'G3_G5_PROFILE_MVP'
     or not exists (select 1 from pg_catalog.pg_constraint c
                    where c.conrelid = 'postona_threads_resv.reservations'::pg_catalog.regclass and c.conname = 'reservations_personal_mvp_bound') then
    raise exception 'G3_THREADS_MVP_ROLLBACK_NOT_APPLIED';
  end if;
end $$;

do $$
declare v_name text := (select pg_catalog.obj_description(c.oid, 'pg_constraint') from pg_catalog.pg_constraint c
                        where c.conrelid = 'postona_threads_resv.reservations'::pg_catalog.regclass and c.conname = 'reservations_personal_mvp_bound');
begin
  if v_name is null or v_name !~ '^[a-z0-9_]{1,63}$' then
    raise exception 'G3_THREADS_MVP_ROLLBACK_PAIR_NAME_UNKNOWN';
  end if;
  alter table postona_threads_resv.reservations drop constraint reservations_personal_mvp_bound;
  execute pg_catalog.format('alter table postona_threads_resv.reservations add constraint %I check ((bound_owner_epoch is null) = (bound_lifecycle_version is null)) not valid', v_name);
end $$;

create or replace function postona_threads_resv.g5_r1_bound(p_brand_id text, out owner_epoch bigint, out lifecycle_version bigint)
language plpgsql volatile security definer set search_path = '' as $$
-- G3_G5_PROFILE_FULL (g5oe / W1)
declare v_verdict jsonb;
begin
  v_verdict := public.common_account_authorization_verdict('postona', 'threads_publish', p_brand_id);
  if v_verdict ->> 'decision' is distinct from 'allow' then
    raise exception 'POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  select t.owner_epoch, t.lifecycle_version into owner_epoch, lifecycle_version
    from postona_threads_resv.parse_owner_epoch_token(v_verdict ->> 'owner_epoch') t;
  if owner_epoch is null or lifecycle_version is null then
    raise exception 'POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE' using errcode = 'P0001';
  end if;
end $$;

create or replace function postona_threads_resv.g5_bound_state(p_row postona_threads_resv.reservations) returns text
language plpgsql stable security definer set search_path = '' as $$
-- G3_G5_PROFILE_FULL (g5oe / W1)
begin
  if p_row.bound_owner_epoch is null or p_row.bound_owner_epoch < 1 then return 'EXPECTED_OWNER_EPOCH_REQUIRED'; end if;
  if p_row.bound_lifecycle_version is null or p_row.bound_lifecycle_version < 1 then return 'EXPECTED_LIFECYCLE_VERSION_REQUIRED'; end if;
  if to_regprocedure('private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)') is null then
    return 'SERVICE_STATE_UNKNOWN';
  end if;
  return coalesce(private.account_lifecycle_worker_brand_verdict(p_row.brand_id, 'x_autopost', p_row.bound_owner_epoch, p_row.bound_lifecycle_version),
                  'SERVICE_STATE_UNKNOWN');
end $$;

commit;
