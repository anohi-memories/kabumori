-- READ-ONLY check to run right before supabase/tests/ai_consumer_call_store_rollback.sql (operator use only; never a
-- migration). The rollback deletes every call-store row, and with them the protection against sending an
-- operationId twice. This check refuses (raises ACS_ROLLBACK_BLOCKED) while that protection is still needed:
--   * an acquired claim exists: a worker may still be running, and after the rollback a retry would be sent again;
--   * a row is younger than min_age_hours (default 24): a client retry of that operationId would be sent again.
-- It cannot see whether the callers are stopped: switch every caller back to the OpenAI path (feature flags) and
-- wait at least the bridge deadline (60 s) BEFORE running it. Data is only read.
--
--   psql -v min_age_hours=24 -f supabase/tests/ai_consumer_call_store_rollback_preflight.sql
\set ON_ERROR_STOP 1
\if :{?min_age_hours}
\else
\set min_age_hours 24
\endif
select set_config('acs.rollback_min_age_hours', :'min_age_hours', false);
do $$
declare
  v_hours integer := current_setting('acs.rollback_min_age_hours')::integer;
  v_acquired bigint;
  v_recent bigint;
  v_total bigint;
begin
  if v_hours < 1 then
    raise exception 'ACS_ROLLBACK_BLOCKED: min_age_hours must be at least 1' using errcode = 'P0001';
  end if;
  select count(*) filter (where c.state = 'acquired'),
         count(*) filter (where c.created_at > now() - make_interval(hours => v_hours)
                             or c.completed_at > now() - make_interval(hours => v_hours)
                             or c.abandoned_at > now() - make_interval(hours => v_hours)),
         count(*)
    into v_acquired, v_recent, v_total
    from ai_calls.consumer_calls c;
  if v_acquired > 0 or v_recent > 0 then
    raise exception 'ACS_ROLLBACK_BLOCKED: % acquired, % younger than % h (of % rows)', v_acquired, v_recent, v_hours, v_total
      using errcode = 'P0001';
  end if;
  raise notice 'ACS_ROLLBACK_PREFLIGHT_OK: % rows, none acquired, none younger than % h', v_total, v_hours;
end;
$$;
