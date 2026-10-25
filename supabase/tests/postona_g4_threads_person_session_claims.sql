-- G4-43 (Issue #319): the owner transport's claims for the Threads tests, with is_anonymous controlled by g4t.anon:
--   'omit'  = what H5's owner_transport.ts sets today (sub, session_id, role)   'false' / 'true' = the verified JWT's own value.
-- Inserted by postona_g4_threads_person_session_run.sh right after the tb.* helpers of postona_threads_binding_epoch_behavior.sql.
create or replace function tb.claims(p_user uuid, p_session uuid) returns void language plpgsql as $$
declare v_anon text := coalesce(nullif(current_setting('g4t.anon', true), ''), 'omit');
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', case when p_user is null then '' else
    (jsonb_build_object('sub', p_user, 'role', 'authenticated', 'session_id', p_session)
     || case v_anon when 'false' then jsonb_build_object('is_anonymous', false)
                    when 'true' then jsonb_build_object('is_anonymous', true) else '{}'::jsonb end)::text end, true);
end $$;
