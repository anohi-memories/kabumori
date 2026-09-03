-- GRANT hardening for the Kabumori 5 tables created in
-- 20260901061217_add_kabumori_mvp_tables.sql. That migration enabled RLS and
-- created all owner-scoped policies (profiles_select_own, profiles_insert_own,
-- profiles_update_own, tracked_stocks_select_own, tracked_stocks_insert_own,
-- tracked_stocks_update_own, tracked_stocks_delete_own, alert_settings_select_own,
-- alert_settings_insert_own, alert_settings_update_own, notifications_select_own,
-- notifications_update_own, stocks_master_authenticated_read) but never granted
-- any table-level privilege to anon/authenticated/service_role, so every role was
-- effectively locked out. No policies are created or modified here.

-- profiles
revoke all on public.profiles from anon;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.profiles to service_role;

-- tracked_stocks
revoke all on public.tracked_stocks from anon;
grant select, insert, update, delete on public.tracked_stocks to authenticated;
grant select, insert, update, delete on public.tracked_stocks to service_role;

-- alert_settings (DELETE is intentionally not granted to authenticated for the MVP)
revoke all on public.alert_settings from anon;
grant select, insert, update on public.alert_settings to authenticated;
grant select, insert, update, delete on public.alert_settings to service_role;

-- notifications: authenticated may only flip read_at (mark as read).
-- Row creation and fields like title/summary/importance/push_status stay service_role-only.
revoke all on public.notifications from anon;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant select, insert, update on public.notifications to service_role;

-- stocks_master: read-only for the app; writes belong to the JPX sync job (service_role).
revoke all on public.stocks_master from anon;
grant select on public.stocks_master to authenticated;
grant select, insert, update on public.stocks_master to service_role;
