-- S5 before/after snapshot (read-only; counts and digests only, no row contents leave the database).
-- Proves the smoke created no scheduled post, execution log or published fingerprint for any
-- social-mobile workspace, and changed no publish permission, brand or brand setting.
-- (Kabumori / AI Lab cron activity can move the global totals; those are informational only.)
with sm as (
  select b.id from public.brands b where b.code_profile_key = 'social_mobile_user_v1'
),
sm_posts as (
  select s.id::text as id from public.scheduled_posts s where to_jsonb(s) ->> 'brand_id' in (select id from sm)
)
select jsonb_build_object(
  'social_mobile_brands', (select count(*) from sm),
  'scheduled_posts_social_mobile', (select count(*) from sm_posts),
  'post_execution_logs_social_mobile', (select count(*) from public.post_execution_logs l
      where to_jsonb(l) ->> 'brand_id' in (select id from sm)
         or to_jsonb(l) ->> 'scheduled_post_id' in (select id from sm_posts)),
  'fingerprints_social_mobile', (select count(*) from public.published_content_fingerprints f
      where to_jsonb(f) ->> 'brand_id' in (select id from sm)),
  'social_accounts_publish_md5', (select md5(coalesce(string_agg(
        concat_ws('|', a.id, a.brand_id, a.platform, a.publish_enabled::text), ',' order by a.id), ''))
      from public.social_accounts a),
  'brands_md5', (select md5(coalesce(string_agg(
        concat_ws('|', b.id, b.is_active::text, b.publish_mode, b.code_profile_key), ',' order by b.id), ''))
      from public.brands b),
  'brand_settings_md5', (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by to_jsonb(s)::text), ''))
      from public.brand_settings s),
  'content_settings_rows', (select count(*) from public.social_mobile_content_settings),
  'scheduled_posts_total', (select count(*) from public.scheduled_posts),
  'post_execution_logs_total', (select count(*) from public.post_execution_logs)
) as snapshot;
