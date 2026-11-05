-- G3 SOURCE CANDIDATE (2026-11-05, Issue #589 G3-02 #16): removes 018. NOT applied anywhere. Run FIRST, before 017's and every other rollback.
-- Drops 018's functions, types and tables. Reservations that approvals created stay as ordinary reservations (unchanged). Candidates and
-- notifications are discarded only when the operator states their counts: set postona_resv_approval_rollback.discard = '<candidates>:<notifications>'
-- (both 0 when the tables are empty). Any other value refuses, nothing changed.
-- Refuses (nothing changed) when: 018 is not applied; the caller is a superuser or does not own the schema and the tables; the stated
-- counts are not the current ones; something outside 018 depends on its objects (no CASCADE).

begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user); v_counts text;
begin
  if pg_catalog.to_regclass('postona_x_resv.approval_candidates') is null then
    raise exception 'G3_APPROVALS_ROLLBACK_NOT_APPLIED';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from v_owner
     or exists (select 1 from pg_catalog.pg_class c where c.oid in ('postona_x_resv.approval_candidates'::pg_catalog.regclass,
                  'postona_x_resv.notifications'::pg_catalog.regclass, 'postona_x_resv.push_outbox'::pg_catalog.regclass)
                and c.relowner is distinct from v_owner) then
    raise exception 'G3_APPROVALS_ROLLBACK_OWNER';
  end if;
  lock table postona_x_resv.approval_candidates, postona_x_resv.notifications, postona_x_resv.push_outbox in access exclusive mode;
  v_counts := (select count(*) from postona_x_resv.approval_candidates)::text || ':' || (select count(*) from postona_x_resv.notifications)::text;
  if pg_catalog.current_setting('postona_resv_approval_rollback.discard', true) is distinct from v_counts then
    raise exception 'G3_APPROVALS_ROLLBACK_ROWS: state the counts %', v_counts;
  end if;
end $$;

drop function postona_x_resv.submit_approval(text, uuid, text, timestamptz);
drop function postona_x_resv.revise_approval(uuid, integer, text, timestamptz);
drop function postona_x_resv.approve_candidate(uuid, integer, text);
drop function postona_x_resv.reject_candidate(uuid, integer);
drop function postona_x_resv.list_approvals(text);
drop function postona_x_resv.get_approval(uuid);
drop function postona_x_resv.list_notifications(integer);
drop function postona_x_resv.mark_notification_read(uuid);
drop function postona_x_resv.approval_row(uuid);
drop function postona_x_resv.lock_own_candidate(uuid, uuid);
drop function postona_x_resv.approval_check_input(text, timestamptz);
drop function postona_x_resv.approval_owned(uuid, text);
drop function postona_x_resv.sync_reservation_notifications(uuid);
drop function postona_x_resv.notify(uuid, text, text, text, uuid, uuid, integer, text, timestamptz);
drop function postona_x_resv.approval_generation_active(uuid, text, bigint);
drop type postona_x_resv.approval_view;
drop type postona_x_resv.notification_view;
drop table postona_x_resv.push_outbox;
drop table postona_x_resv.notifications;
drop table postona_x_resv.approval_candidates;

do $$
begin
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'postona_x_resv' and p.prosrc ~ 'G3_APPROVALS') then
    raise exception 'G3_APPROVALS_ROLLBACK_POSTCONDITION: a function is left';
  end if;
end $$;

commit;
