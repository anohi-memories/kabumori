create schema if not exists private;

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

grant select on table public.admin_users to authenticated;
grant select, insert, update, delete on table public.admin_users to service_role;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users
    where user_id = (select auth.uid())
  );
$$;

grant usage on schema private to authenticated;
grant execute on function private.is_admin() to authenticated;
revoke execute on function private.is_admin() from anon, public;

create policy admin_users_select_self
on public.admin_users
for select
to authenticated
using ((select auth.uid()) is not null and user_id = (select auth.uid()));

-- Read access for dashboard data.
grant select on table public.scheduled_posts to authenticated;
grant select on table public.post_execution_logs to authenticated;
grant select on table public.important_news_candidates to authenticated;
grant select on table public.important_news_monitor_runs to authenticated;
grant select on table public.morning_report_runs to authenticated;
grant select on table public.close_report_runs to authenticated;
grant select on table public.us_premarket_report_runs to authenticated;
grant select on table public.posting_windows to authenticated;
grant select on table public.posting_blackouts to authenticated;

grant select on table public.important_news_monitor_settings to authenticated;
grant select on table public.morning_report_settings to authenticated;
grant select on table public.close_report_settings to authenticated;
grant select on table public.us_premarket_report_settings to authenticated;
grant select on table public.useful_tip_schedule_settings to authenticated;

-- Settings the admin dashboard is allowed to edit.
grant update on table public.important_news_monitor_settings to authenticated;
grant update on table public.morning_report_settings to authenticated;
grant update on table public.close_report_settings to authenticated;
grant update on table public.us_premarket_report_settings to authenticated;
grant update on table public.useful_tip_schedule_settings to authenticated;

create policy admin_select_scheduled_posts on public.scheduled_posts for select to authenticated using ((select private.is_admin()));
create policy admin_select_post_execution_logs on public.post_execution_logs for select to authenticated using ((select private.is_admin()));
create policy admin_select_important_news_candidates on public.important_news_candidates for select to authenticated using ((select private.is_admin()));
create policy admin_select_important_news_monitor_runs on public.important_news_monitor_runs for select to authenticated using ((select private.is_admin()));
create policy admin_select_morning_report_runs on public.morning_report_runs for select to authenticated using ((select private.is_admin()));
create policy admin_select_close_report_runs on public.close_report_runs for select to authenticated using ((select private.is_admin()));
create policy admin_select_us_premarket_report_runs on public.us_premarket_report_runs for select to authenticated using ((select private.is_admin()));
create policy admin_select_posting_windows on public.posting_windows for select to authenticated using ((select private.is_admin()));
create policy admin_select_posting_blackouts on public.posting_blackouts for select to authenticated using ((select private.is_admin()));

create policy admin_select_important_news_monitor_settings on public.important_news_monitor_settings for select to authenticated using ((select private.is_admin()));
create policy admin_update_important_news_monitor_settings on public.important_news_monitor_settings for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

create policy admin_select_morning_report_settings on public.morning_report_settings for select to authenticated using ((select private.is_admin()));
create policy admin_update_morning_report_settings on public.morning_report_settings for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

create policy admin_select_close_report_settings on public.close_report_settings for select to authenticated using ((select private.is_admin()));
create policy admin_update_close_report_settings on public.close_report_settings for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

create policy admin_select_us_premarket_report_settings on public.us_premarket_report_settings for select to authenticated using ((select private.is_admin()));
create policy admin_update_us_premarket_report_settings on public.us_premarket_report_settings for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

create policy admin_select_useful_tip_schedule_settings on public.useful_tip_schedule_settings for select to authenticated using ((select private.is_admin()));
create policy admin_update_useful_tip_schedule_settings on public.useful_tip_schedule_settings for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
