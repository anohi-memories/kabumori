-- Phase 3H AI Lab pre-live safeguards.
-- Local implementation only: do not apply this migration without separate explicit approval.
-- No posting window, publish mode, account setting, OAuth scope, or Cron row is changed here.

-- Make the confirmed X post id an idempotency key for the fingerprint write. A read-only production
-- audit on 2026-09-13 found zero fingerprint rows and zero duplicate (account, X post id) pairs.
create unique index if not exists published_content_fingerprints_account_x_post_uidx
  on public.published_content_fingerprints (social_account_id, x_post_id)
  where x_post_id is not null;

-- After X has confirmed success, persist a hash and make the scheduled row terminal in one service-only
-- call. Fingerprint insertion is isolated in a subtransaction: if it fails, the row is still completed
-- so a persistence error can never lead to an automatic second X post. Repeated RPC delivery is
-- idempotent and reports whether the expected fingerprint is present.
create or replace function public.complete_ai_salaryman_lab_brand_post(
  p_scheduled_post_id uuid,
  p_x_post_id text,
  p_normalized_text_sha256 text
)
returns table(fingerprint_persisted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_brand_id text;
  v_post_type text;
  v_fingerprint_persisted boolean := false;
begin
  if p_scheduled_post_id is null
    or p_x_post_id is null or length(p_x_post_id) = 0
    or p_normalized_text_sha256 is null or p_normalized_text_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'AI_LAB_POST_COMPLETION_ARGUMENT_INVALID';
  end if;

  select sp.status, sp.brand_id, sp.post_type
    into v_status, v_brand_id, v_post_type
  from public.scheduled_posts as sp
  where sp.id = p_scheduled_post_id
  for update;

  if not found or v_brand_id <> 'ai_salaryman_lab' or v_post_type <> 'brand_post' then
    raise exception 'AI_LAB_SCHEDULED_POST_NOT_FOUND';
  end if;

  if v_status = 'succeeded' then
    select exists (
      select 1 from public.published_content_fingerprints as f
      where f.brand_id = 'ai_salaryman_lab'
        and f.social_account_id = 'ai_salaryman_lab_x'
        and f.post_type = 'brand_post'
        and f.x_post_id = p_x_post_id
        and f.normalized_text_sha256 = p_normalized_text_sha256
    ) into v_fingerprint_persisted;
    return query select v_fingerprint_persisted;
    return;
  end if;

  if v_status <> 'running' then
    raise exception 'AI_LAB_SCHEDULED_POST_NOT_RUNNING';
  end if;

  begin
    insert into public.published_content_fingerprints
      (brand_id, social_account_id, post_type, normalized_text_sha256, x_post_id)
    values
      ('ai_salaryman_lab', 'ai_salaryman_lab_x', 'brand_post', p_normalized_text_sha256, p_x_post_id)
    on conflict (social_account_id, x_post_id) where x_post_id is not null do nothing;

    select exists (
      select 1 from public.published_content_fingerprints as f
      where f.brand_id = 'ai_salaryman_lab'
        and f.social_account_id = 'ai_salaryman_lab_x'
        and f.post_type = 'brand_post'
        and f.x_post_id = p_x_post_id
        and f.normalized_text_sha256 = p_normalized_text_sha256
    ) into v_fingerprint_persisted;
  exception when others then
    -- Do not put raw post text or database exception detail into execution logs.
    v_fingerprint_persisted := false;
  end;

  update public.scheduled_posts
  set status = 'succeeded', finished_at = pg_catalog.now()
  where id = p_scheduled_post_id and status = 'running';

  begin
    insert into public.post_execution_logs
      (scheduled_post_id, post_type, status, x_post_id, message, brand_id)
    values
      (p_scheduled_post_id, 'brand_post', 'succeeded', p_x_post_id,
       case when v_fingerprint_persisted
         then 'AI Lab post completed; fingerprint persisted'
         else 'AI Lab post completed; fingerprint persistence failed'
       end,
       'ai_salaryman_lab');
  exception when others then
    -- The scheduled row is already terminal; logging failure must not make X eligible for replay.
    null;
  end;

  return query select v_fingerprint_persisted;
end;
$$;

revoke all on function public.complete_ai_salaryman_lab_brand_post(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.complete_ai_salaryman_lab_brand_post(uuid, text, text) to service_role;
