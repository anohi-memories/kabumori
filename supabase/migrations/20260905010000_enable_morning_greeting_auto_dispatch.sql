-- Step 2 of morning greeting auto-dispatch: the corresponding Edge Function change
-- (index.ts, post_type === 'morning_greeting' branch, calling the already-tested
-- runMorningGreetingManualPublish) ships alongside this migration.
--
-- 20260901044548_add_morning_greeting_schedule.sql was drafted as "STEP 1" but never applied to
-- production (posting_windows has no morning_greeting row today) — it also used a 07:00-07:30 JST
-- window and deliberately excluded morning_greeting from claim_due_post() ("Generation and publication
-- for morning_greeting are intentionally not part of STEP 1"). This migration supersedes that draft:
-- the window here is 06:30-07:00 JST per the current instruction, and claim_due_post() is left exactly
-- as it is in production today (it never actually carried that draft's exclusion clause, so there is
-- nothing to remove) — dispatch is now safe because the Edge Function branch above exists to handle it.
insert into public.posting_windows
  (post_type, slot_no, start_time, end_time, timezone, daily_probability, is_active)
values
  ('morning_greeting', 1, '06:30:00', '07:00:00', 'Asia/Tokyo', 1, true)
on conflict (post_type, slot_no) do update
set start_time = excluded.start_time,
    end_time = excluded.end_time,
    timezone = excluded.timezone,
    daily_probability = excluded.daily_probability,
    is_active = true;

-- Mirrors complete_tip_post(): scheduled_posts/post_execution_logs bookkeeping only. The rich same-day
-- claim/completion/failure tracking already lives in publish_claims via runMorningGreetingManualPublish
-- itself (claimPublishSlot/completePublishSlot/failPublishSlot) and is untouched by this function.
create or replace function public.complete_morning_greeting_post(
  p_scheduled_post_id uuid,
  p_x_post_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.scheduled_posts
  set status = 'succeeded', finished_at = now()
  where id = p_scheduled_post_id and status = 'running';

  insert into public.post_execution_logs
    (scheduled_post_id, post_type, status, x_post_id, message)
  values
    (p_scheduled_post_id, 'morning_greeting', 'succeeded', p_x_post_id, 'X post created');
end;
$$;
