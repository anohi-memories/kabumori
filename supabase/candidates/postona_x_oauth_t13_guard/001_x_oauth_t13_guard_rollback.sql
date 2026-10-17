-- Rollback of 001_x_oauth_t13_guard.sql (F3 SOURCE CANDIDATE). Re-runnable. Restores the live v1 names and today's
-- grants exactly (authenticated EXECUTE; public / anon / service_role none). The function bodies were never changed.
begin;
do $$
begin
  if to_regprocedure('public.begin_social_mobile_x_oauth_connection_unguarded_v1(text,text,timestamptz)') is null then
    return;  -- not applied (or already rolled back)
  end if;
  if (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.begin_social_mobile_x_oauth_connection(text,text,timestamptz)'::regprocedure) !~ 'X_OAUTH_T13_GUARD_V1'
     or (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.consume_social_mobile_x_oauth_state(text)'::regprocedure) !~ 'X_OAUTH_T13_GUARD_V1'
     or (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)'::regprocedure) !~ 'X_OAUTH_T13_GUARD_V1' then
    raise exception 'POSTONA_X_OAUTH_T13_ROLLBACK_NOT_OURS';
  end if;
  drop function public.begin_social_mobile_x_oauth_connection(text, text, timestamptz);
  drop function public.consume_social_mobile_x_oauth_state(text);
  drop function public.complete_social_mobile_x_oauth_connection(uuid, text, text, text, text);
  alter function public.begin_social_mobile_x_oauth_connection_unguarded_v1(text, text, timestamptz) rename to begin_social_mobile_x_oauth_connection;
  alter function public.consume_social_mobile_x_oauth_state_unguarded_v1(text) rename to consume_social_mobile_x_oauth_state;
  alter function public.complete_social_mobile_x_oauth_connection_unguarded_v1(uuid, text, text, text, text) rename to complete_social_mobile_x_oauth_connection;
  revoke all on function public.begin_social_mobile_x_oauth_connection(text, text, timestamptz) from public, anon, service_role;
  revoke all on function public.consume_social_mobile_x_oauth_state(text) from public, anon, service_role;
  revoke all on function public.complete_social_mobile_x_oauth_connection(uuid, text, text, text, text) from public, anon, service_role;
  grant execute on function public.begin_social_mobile_x_oauth_connection(text, text, timestamptz) to authenticated;
  grant execute on function public.consume_social_mobile_x_oauth_state(text) to authenticated;
  grant execute on function public.complete_social_mobile_x_oauth_connection(uuid, text, text, text, text) to authenticated;
end $$;
commit;
