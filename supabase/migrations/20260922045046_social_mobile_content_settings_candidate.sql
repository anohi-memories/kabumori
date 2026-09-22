-- Phase 14 source candidate only. Do not apply to production in this phase.
-- General-user content preferences are intentionally separate from the
-- admin-owned brand_settings/posting_windows operational controls.

create table if not exists public.social_mobile_content_settings (
  brand_id text primary key references public.brands(id) on delete cascade,
  settings jsonb not null default jsonb_build_object(
    'locale', 'ja-JP',
    'preferredTone', '自然で親しみやすく、押しつけない',
    'themes', jsonb_build_array('日々の生活や仕事に役立つ小さな工夫'),
    'objective', '読者にひとつの実用的な気づきを届ける',
    'frequencyTargetPerWeek', 3,
    'approvalMode', 'manual_review',
    'generationWindow', jsonb_build_object(
      'timezone', 'Asia/Tokyo',
      'startLocal', '09:00',
      'endLocal', '24:00',
      'defaultGenerationLocal', '17:00',
      'generationDayOffset', -1
    ),
    'optionalNgWords', jsonb_build_array(),
    'notes', ''
  ),
  -- This profile contains derived style signals only; it must never contain
  -- tokens, full historical posts, or a publish permission.
  persona_profile jsonb not null default '{}'::jsonb,
  persona_provenance text not null default 'conversation'
    check (persona_provenance in ('conversation', 'past_post_analysis', 'manual')),
  persona_confirmed boolean not null default false,
  persona_last_analyzed_at timestamptz,
  persona_last_analyzed_count integer
    check (persona_last_analyzed_count is null or persona_last_analyzed_count between 0 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_mobile_content_settings_shape check (
    jsonb_typeof(settings) = 'object'
    and settings ? 'locale'
    and settings ? 'preferredTone'
    and settings ? 'themes'
    and settings ? 'objective'
    and settings ? 'frequencyTargetPerWeek'
    and settings ? 'approvalMode'
    and settings ? 'generationWindow'
    and settings ? 'optionalNgWords'
    and settings ? 'notes'
    and not (settings ?| array['livePublishingEnabled', 'publish_enabled', 'publishEnabled'])
    and jsonb_typeof(settings->'themes') = 'array'
    and jsonb_array_length(settings->'themes') between 0 and 8
    and jsonb_typeof(settings->'optionalNgWords') = 'array'
    and jsonb_array_length(settings->'optionalNgWords') between 0 and 20
    and jsonb_typeof(settings->'generationWindow') = 'object'
    and (settings->>'locale') in ('ja-JP', 'en-US')
    and length(settings->>'preferredTone') between 1 and 120
    and length(settings->>'objective') between 1 and 160
    and (settings->>'frequencyTargetPerWeek') ~ '^[0-9]+$'
    and (settings->>'frequencyTargetPerWeek')::integer between 0 and 14
    and (settings->>'approvalMode') in ('manual_review', 'auto_post_preference')
    and (settings->'generationWindow'->>'timezone') ~ '^[A-Za-z_]+/[A-Za-z_]+$'
    and (settings->'generationWindow'->>'startLocal') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    and (settings->'generationWindow'->>'endLocal') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    and (settings->'generationWindow'->>'defaultGenerationLocal') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    and (settings->'generationWindow'->>'generationDayOffset') in ('-1', '0')
    and length(coalesce(settings->>'notes', '')) <= 1000
  ),
  constraint social_mobile_content_settings_persona_shape check (
    jsonb_typeof(persona_profile) = 'object'
    and not (persona_profile ?| array['access_token', 'refresh_token', 'publish_enabled', 'posts'])
  )
);

create or replace function public.social_mobile_content_settings_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists social_mobile_content_settings_touch_updated_at
  on public.social_mobile_content_settings;
create trigger social_mobile_content_settings_touch_updated_at
before update on public.social_mobile_content_settings
for each row execute function public.social_mobile_content_settings_touch_updated_at();

alter table public.social_mobile_content_settings enable row level security;
revoke all on table public.social_mobile_content_settings from anon;
grant select, insert, update on table public.social_mobile_content_settings to authenticated;
revoke delete on table public.social_mobile_content_settings from authenticated;

drop policy if exists social_mobile_content_settings_owner_select
  on public.social_mobile_content_settings;
create policy social_mobile_content_settings_owner_select
  on public.social_mobile_content_settings
  for select to authenticated
  using (exists (
    select 1 from public.brand_memberships bm
    where bm.brand_id = social_mobile_content_settings.brand_id
      and bm.user_id = (select auth.uid())
      and bm.role = 'owner'
  ));

drop policy if exists social_mobile_content_settings_owner_insert
  on public.social_mobile_content_settings;
create policy social_mobile_content_settings_owner_insert
  on public.social_mobile_content_settings
  for insert to authenticated
  with check (exists (
    select 1 from public.brand_memberships bm
    where bm.brand_id = social_mobile_content_settings.brand_id
      and bm.user_id = (select auth.uid())
      and bm.role = 'owner'
  ));

drop policy if exists social_mobile_content_settings_owner_update
  on public.social_mobile_content_settings;
create policy social_mobile_content_settings_owner_update
  on public.social_mobile_content_settings
  for update to authenticated
  using (exists (
    select 1 from public.brand_memberships bm
    where bm.brand_id = social_mobile_content_settings.brand_id
      and bm.user_id = (select auth.uid())
      and bm.role = 'owner'
  ))
  with check (exists (
    select 1 from public.brand_memberships bm
    where bm.brand_id = social_mobile_content_settings.brand_id
      and bm.user_id = (select auth.uid())
      and bm.role = 'owner'
  ));

revoke all on function public.social_mobile_content_settings_touch_updated_at() from public, anon, authenticated, service_role;
