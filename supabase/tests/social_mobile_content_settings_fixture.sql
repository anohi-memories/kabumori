-- Fake-only baseline for the social-mobile content settings hardening proof.
-- Mirrors the production pieces the table depends on (H2 read-only catalog, 2026-10-03):
-- brands(id text PK), brand_memberships(brand_id FK cascade, user_id FK cascade, role
-- owner/admin/member/viewer, self-SELECT RLS), auth.uid() from the JWT subject, and a public
-- default ACL at least as broad as production's (which hands authenticated/service_role
-- TRUNCATE/REFERENCES/TRIGGER/MAINTAIN). Apply to a disposable local database as a
-- NON-superuser owner, never to production. All ids are fake.
set timezone = 'UTC';

-- Worst case: every new public table starts with ALL privileges for these roles.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create table public.brands (
  id text primary key,
  display_name text not null default 'My Workspace',
  code_profile_key text not null default 'social_mobile_user_v1'
);
create table public.brand_memberships (
  brand_id text not null references public.brands (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  primary key (brand_id, user_id)
);
alter table public.brand_memberships enable row level security;
create policy brand_memberships_self_select on public.brand_memberships
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on table public.brands, public.brand_memberships from anon, authenticated, service_role;
grant select on table public.brand_memberships to authenticated;

-- An unrelated table in the same schema: the migration must not touch it.
create table public.unrelated_rows (id integer primary key, note text not null);
insert into public.unrelated_rows values (1, 'keep'), (2, 'keep');

-- Users: owner A (brand_a), owner B (brand_b), admin/member/viewer of brand_a, a non-member.
insert into auth.users values
  ('00000000-0000-4000-8000-00000000000a'),
  ('00000000-0000-4000-8000-00000000000b'),
  ('00000000-0000-4000-8000-0000000000ad'),
  ('00000000-0000-4000-8000-0000000000e0'),
  ('00000000-0000-4000-8000-0000000000e1'),
  ('00000000-0000-4000-8000-0000000000ff');
insert into public.brands (id) values ('u_brand_a'), ('u_brand_b'), ('u_brand_c');
insert into public.brand_memberships values
  ('u_brand_a', '00000000-0000-4000-8000-00000000000a', 'owner'),
  ('u_brand_b', '00000000-0000-4000-8000-00000000000b', 'owner'),
  ('u_brand_a', '00000000-0000-4000-8000-0000000000ad', 'admin'),
  ('u_brand_a', '00000000-0000-4000-8000-0000000000e0', 'member'),
  ('u_brand_a', '00000000-0000-4000-8000-0000000000e1', 'viewer');

-- Test helpers live in their own schema; they are not part of the candidate.
create schema t;
grant usage on schema t to anon, authenticated, service_role;

-- Act as a signed-in user for the rest of the transaction.
create function t.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
end;
$$;
grant execute on function t.as_user(uuid) to anon, authenticated, service_role;

-- The canonical first-run settings, exactly as the app's SOCIAL_MOBILE_CONTENT_DEFAULTS.
create function t.default_settings() returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'locale', 'ja-JP',
    'preferredTone', '自然で親しみやすく、押しつけない',
    'themes', jsonb_build_array('日々の生活や仕事に役立つ小さな工夫'),
    'objective', '読者にひとつの実用的な気づきを届ける',
    'frequencyTargetPerWeek', 3,
    'approvalMode', 'manual_review',
    'generationWindow', jsonb_build_object('timezone', 'Asia/Tokyo', 'startLocal', '09:00', 'endLocal', '24:00',
      'defaultGenerationLocal', '17:00', 'generationDayOffset', -1),
    'optionalNgWords', jsonb_build_array(),
    'notes', '')
$$;
grant execute on function t.default_settings() to anon, authenticated, service_role;
