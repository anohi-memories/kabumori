-- Lets an admin (checked via private.is_admin(), same as every other
-- admin_update_* policy) flip posting_windows.is_active from the admin
-- dashboard. Read-only access already existed (admin_select_posting_windows);
-- this only adds UPDATE, scoped the same way. No other table, no schedule
-- logic, no Edge Function is touched.
grant update on table public.posting_windows to authenticated;

create policy admin_update_posting_windows
on public.posting_windows
for update
to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));
