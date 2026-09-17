-- Disposable PostgreSQL proof only. Never run against production.
-- The harness must provide auth.users, public.brands, and the operational tables
-- with the production-compatible columns before applying the candidate migration.

begin;

-- Object/read-back assertions after applying the candidate.
do $$
begin
  if to_regclass('public.brand_memberships') is null then
    raise exception 'PHASE4_ASSERT_MEMBERSHIP_TABLE_MISSING';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.brand_memberships'::regclass
      and contype = 'p'
  ) then
    raise exception 'PHASE4_ASSERT_PRIMARY_KEY_MISSING';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'brand_memberships'
      and policyname = 'social_mobile_membership_self_select'
  ) then
    raise exception 'PHASE4_ASSERT_MEMBERSHIP_POLICY_MISSING';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'brands'
      and policyname = 'social_mobile_member_select_brands'
  ) then
    raise exception 'PHASE4_ASSERT_BRAND_POLICY_MISSING';
  end if;
end;
$$;

-- The harness should run the following as separate roles/transactions with
-- SET LOCAL ROLE and SET LOCAL request.jwt.claim.sub values:
--   anon: select count(*) = 0 from public.brand_memberships/brands/...;
--   non-member: same zero-row assertions;
--   A member: membership/brand-A/brand-A operational rows > 0, brand-B = 0;
--   B member: brand-B > 0, brand-A = 0;
--   admin: existing private.is_admin() policy remains readable;
--   authenticated member: insert/update/delete on membership must fail;
--   service_role: backend fixture writes remain possible.
-- Exact role switching is harness-specific because auth.uid() claims are
-- supplied by Supabase's request context, not ordinary PostgreSQL role names.

rollback;
