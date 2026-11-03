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
  -- G4-45 (H1 F1): another body naming the RPC or the switch, in any letter case, or anything the catalog records as depending
  -- on the RPC, the switch or the settings table refuses (the drops below are RESTRICT as well). Dynamic SQL is not found:
  -- unwire the app / any caller first.
  if exists (select 1 from pg_proc p
               where p.oid not in (to_regprocedure('public.disconnect_social_mobile_x_connection()'),
                                   to_regprocedure('postona_g4_x_oauth.set_x_disconnect_enabled(boolean)'))
                 and (p.prosrc ilike '%disconnect_social_mobile_x_connection%' or p.prosrc ilike '%x_disconnect_enabled%'))
     or exists (select 1 from pg_depend d
                 where d.deptype in ('n', 'a')
                   and ((d.refclassid = 'pg_proc'::regclass
                         and d.refobjid in (to_regprocedure('public.disconnect_social_mobile_x_connection()'),
                                            to_regprocedure('postona_g4_x_oauth.set_x_disconnect_enabled(boolean)')))
                     or (d.refclassid = 'pg_class'::regclass and d.refobjid = to_regclass('postona_g4_x_oauth.settings')
                         -- the table's own constraints and defaults are not consumers
                         and not (d.classid = 'pg_constraint'::regclass
                                  and exists (select 1 from pg_constraint k where k.oid = d.objid
                                                and k.conrelid = to_regclass('postona_g4_x_oauth.settings')))
                         and not (d.classid = 'pg_attrdef'::regclass
                                  and exists (select 1 from pg_attrdef a where a.oid = d.objid
                                                and a.adrelid = to_regclass('postona_g4_x_oauth.settings')))))) then
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
