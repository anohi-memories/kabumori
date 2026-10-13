-- TEST STAND-INS ONLY (disposable local database). On top of G5's production-shaped baseline, provide the three
-- Stage 3B prerequisites the real publish-authority migration (20261006160200) checks for, so that the REAL
-- Stage 3B functions can be created and then replaced by the F3 candidate. Never production.
--   * brand_settings.enabled_post_types (the baseline's brand_settings has only fixed_hashtags)
--   * public.complete_vault_account_brand_post(uuid,text,text,text): a do-nothing stand-in (never called here)
--   * public.read_social_mobile_publish_settings(uuid,text): reads a test consent table instead of the PR81 store
\set ON_ERROR_STOP 1
alter table public.brand_settings add column if not exists enabled_post_types jsonb not null default '[]'::jsonb;

create schema t3b;
create table t3b.consent (brand_id text primary key, settings jsonb not null);

create function public.complete_vault_account_brand_post(p_scheduled_post_id uuid, p_social_account_id text, p_x_post_id text, p_normalized_text_sha256 text)
returns table (fingerprint_persisted boolean) language sql security definer set search_path = '' as $$ select false $$;
revoke all on function public.complete_vault_account_brand_post(uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.complete_vault_account_brand_post(uuid, text, text, text) to service_role;

create function public.read_social_mobile_publish_settings(p_scheduled_post_id uuid, p_brand_id text)
returns table (settings jsonb) language sql stable security definer set search_path = '' as $$
  select c.settings from t3b.consent c
   where c.brand_id = p_brand_id
     and exists (select 1 from public.scheduled_posts sp where sp.id = p_scheduled_post_id and sp.brand_id = p_brand_id
                 and sp.status = 'running' and sp.post_type = 'brand_post') $$;
revoke all on function public.read_social_mobile_publish_settings(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.read_social_mobile_publish_settings(uuid, text) to service_role;
