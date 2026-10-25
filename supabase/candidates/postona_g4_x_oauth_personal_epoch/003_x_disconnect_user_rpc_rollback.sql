-- G4 SOURCE CANDIDATE ROLLBACK (2026-10-25, Issue #319 G4-41) for 003_x_disconnect_user_rpc.sql. Disposable PG17 only.
-- Removes the user RPC, the operator switch and the settings row; 001 + 002 stay as they are. Refuses unless 003 is installed or
-- while another function's body names the RPC (unwire the app / any caller first).
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.disconnect_social_mobile_x_connection()') is null
     or to_regclass('postona_g4_x_oauth.settings') is null then
    raise exception 'G4X_DISCONNECT_RPC_ROLLBACK_NOT_APPLIED';
  end if;
  if exists (select 1 from pg_proc p
               where p.oid <> to_regprocedure('public.disconnect_social_mobile_x_connection()')
                 and p.prosrc like '%disconnect_social_mobile_x_connection%') then
    raise exception 'G4X_DISCONNECT_RPC_ROLLBACK_STILL_REFERENCED';
  end if;
end $$;

drop function public.disconnect_social_mobile_x_connection();
drop function postona_g4_x_oauth.set_x_disconnect_enabled(boolean);
drop table postona_g4_x_oauth.settings;

do $$
begin
  if to_regprocedure('public.disconnect_social_mobile_x_connection()') is not null
     or to_regclass('postona_g4_x_oauth.settings') is not null
     or to_regprocedure('postona_g4_x_oauth.disconnect_x_connection()') is null then
    raise exception 'G4X_DISCONNECT_RPC_ROLLBACK_POSTCONDITION';
  end if;
end $$;

commit;
