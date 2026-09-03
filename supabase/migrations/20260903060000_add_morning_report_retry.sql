-- Adds a narrow reset-to-pending path for scheduled_posts, used only to retry a morning_report run that
-- failed on a transient infra error before any X post was attempted. Mirrors fail_scheduled_post's shape
-- (same guard, same log table) rather than introducing a parallel scheduling mechanism.
create or replace function public.retry_scheduled_post(
  p_scheduled_post_id uuid,
  p_retry_at timestamptz,
  p_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_type text;
begin
  update public.scheduled_posts
  set status = 'pending', scheduled_for = p_retry_at, started_at = null, finished_at = null
  where id = p_scheduled_post_id and status = 'running'
  returning post_type into selected_type;

  if selected_type is not null then
    insert into public.post_execution_logs (scheduled_post_id, post_type, status, message)
    values (p_scheduled_post_id, selected_type, 'failed', left(p_message, 300));
  end if;
end;
$$;

revoke all on function public.retry_scheduled_post(uuid, timestamptz, text) from public;
grant execute on function public.retry_scheduled_post(uuid, timestamptz, text) to service_role;
