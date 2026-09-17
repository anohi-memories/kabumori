-- Social mobile Phase 4 candidate: tenant membership and read isolation.
--
-- This migration is intentionally review-only in Phase 4.  It targets the
-- production schema confirmed in the Phase 3 inventory (text brand ids and
-- brand_id on the operational tables).  Run the documented preflight before
-- any production application; do not use blind `supabase db push`.

do $$
declare
  required_table text;
begin
  foreach required_table in array array[
    'brands', 'social_accounts', 'scheduled_posts',
    'post_execution_logs', 'posting_windows'
  ] loop
    if to_regclass('public.' || required_table) is null then
      raise exception 'PHASE4_PREFLIGHT_MISSING_TABLE:%', required_table;
    end if;
  end loop;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'brands' and column_name = 'id'
  ) then
    raise exception 'PHASE4_PREFLIGHT_MISSING_COLUMN:brands.id';
  end if;

  foreach required_table in array array[
    'social_accounts', 'scheduled_posts', 'post_execution_logs', 'posting_windows'
  ] loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = required_table and column_name = 'brand_id'
    ) then
      raise exception 'PHASE4_PREFLIGHT_MISSING_COLUMN:%', required_table || '.brand_id';
    end if;
  end loop;
end;
$$;

create table if not exists public.brand_memberships (
  brand_id text not null references public.brands(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member'
    check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (brand_id, user_id)
);

create index if not exists brand_memberships_user_id_idx
  on public.brand_memberships (user_id);

alter table public.brand_memberships enable row level security;

-- Membership rows are readable only by the member themselves.  Inserts,
-- updates, and deletes remain backend/service-role-only in this candidate.
grant select on table public.brand_memberships to authenticated;
revoke all on table public.brand_memberships from anon;
revoke insert, update, delete on table public.brand_memberships from anon, authenticated;

drop policy if exists social_mobile_membership_self_select on public.brand_memberships;
create policy social_mobile_membership_self_select
  on public.brand_memberships
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Keep existing admin policies intact and add a tenant-scoped authenticated
-- read path.  RLS combines policies with OR, so an existing admin can still
-- read the same resources while a normal member sees only their brands.
grant select on table public.brands, public.social_accounts,
  public.scheduled_posts, public.post_execution_logs, public.posting_windows
  to authenticated;
revoke select on table public.brands, public.social_accounts,
  public.scheduled_posts, public.post_execution_logs, public.posting_windows
  from anon;

drop policy if exists social_mobile_member_select_brands on public.brands;
create policy social_mobile_member_select_brands
  on public.brands
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.brand_memberships as bm
      where bm.brand_id = brands.id
        and bm.user_id = (select auth.uid())
    )
  );

drop policy if exists social_mobile_member_select_social_accounts on public.social_accounts;
create policy social_mobile_member_select_social_accounts
  on public.social_accounts
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.brand_memberships as bm
      where bm.brand_id = social_accounts.brand_id
        and bm.user_id = (select auth.uid())
    )
  );

drop policy if exists social_mobile_member_select_scheduled_posts on public.scheduled_posts;
create policy social_mobile_member_select_scheduled_posts
  on public.scheduled_posts
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.brand_memberships as bm
      where bm.brand_id = scheduled_posts.brand_id
        and bm.user_id = (select auth.uid())
    )
  );

drop policy if exists social_mobile_member_select_post_execution_logs on public.post_execution_logs;
create policy social_mobile_member_select_post_execution_logs
  on public.post_execution_logs
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.brand_memberships as bm
      where bm.brand_id = post_execution_logs.brand_id
        and bm.user_id = (select auth.uid())
    )
  );

drop policy if exists social_mobile_member_select_posting_windows on public.posting_windows;
create policy social_mobile_member_select_posting_windows
  on public.posting_windows
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.brand_memberships as bm
      where bm.brand_id = posting_windows.brand_id
        and bm.user_id = (select auth.uid())
    )
  );
