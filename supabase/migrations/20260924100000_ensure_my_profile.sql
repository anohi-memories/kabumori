-- Consumer mobile account lifecycle, step 1: make "a signed-in user always has a profile row"
-- server-enforced and idempotent.
--
-- Why an RPC and not a trigger on auth.users:
--   * public.profiles.id already references auth.users(id) on delete cascade, and every user-owned
--     table (tracked_stocks, alert_settings, alert_category_settings, notifications,
--     device_push_tokens, personalized_reports) references public.profiles(id) on delete cascade.
--     So the only thing missing is the *creation* side, not the deletion side.
--   * A trigger on the auth schema runs inside Supabase's own signup transaction. Any error there
--     turns a signup into a 500 for every new user, and this repository already has a known
--     migration-history inconsistency that makes broad auth-schema changes riskier than they look.
--   * The client already calls an ensure step on every session it accepts, so the remaining gap is
--     only that the step was expressed as a client-side select-then-insert (two round trips, a
--     TOCTOU window, and behaviour defined by client code). One idempotent RPC closes that gap
--     without touching the auth schema at all.
--
-- security invoker (not definer) on purpose: the existing profiles_insert_own / profiles_select_own
-- RLS policies already restrict a caller to auth.uid(), so this function needs no elevated rights.
-- The id is taken from auth.uid() and never from an argument, so a caller cannot create or touch
-- another user's profile even if RLS were later relaxed.
create or replace function public.ensure_my_profile()
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;

  insert into public.profiles (id)
  values (v_user_id)
  on conflict (id) do nothing;

  return v_user_id;
end
$function$;

revoke all on function public.ensure_my_profile() from public, anon, authenticated, service_role;
grant execute on function public.ensure_my_profile() to authenticated;
