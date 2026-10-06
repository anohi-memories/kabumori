-- SOURCE CANDIDATE ONLY. Do not apply until a separately reviewed activation.
--
-- Stage 3B: completion of a scheduled brand_post published through the
-- generic Vault-backed account path (_shared/brand/vault_account_brand_post.ts).
-- AI Lab keeps complete_ai_salaryman_lab_brand_post and Kabumori its legacy
-- completions: both brands are refused here explicitly.
--
-- The caller names the exact account its X port was bound to. The row is
-- completed only if that account is the running post's brand's one and only
-- X account; the fingerprint is written for that brand/account only. A
-- confirmed X post is recorded idempotently and never made retryable.
--
-- Requires the Stage 3A rollout authority (20260926032054, live) and the
-- production published_content_fingerprints / post_execution_logs tables.
-- (Renumbered from the unapplied candidate 20260927101423 so that the Stage 3B
-- set -- completion, publish settings reader, publish authority -- sorts after
-- the PR81 settings hardening it depends on. Body unchanged.)
-- Transaction: one explicit transaction; apply alone; not re-runnable.
begin;

do $$
begin
  if to_regclass('public.x_account_refresh_rollout') is null
     or to_regclass('public.published_content_fingerprints') is null
     or to_regclass('public.post_execution_logs') is null then
    raise exception 'STAGE3B_PRECONDITION_MISSING';
  end if;
  if to_regprocedure('public.complete_vault_account_brand_post(uuid,text,text,text)') is not null then
    raise exception 'STAGE3B_PRECONDITION_ALREADY_APPLIED';
  end if;
end $$;

create function public.complete_vault_account_brand_post(
  p_scheduled_post_id uuid, p_social_account_id text, p_x_post_id text, p_normalized_text_sha256 text
) returns table (fingerprint_persisted boolean)
language plpgsql security definer set search_path = '' as $$
declare v_post public.scheduled_posts%rowtype;
        v_account public.social_accounts%rowtype;
        v_persisted boolean := false;
begin
  if p_scheduled_post_id is null or nullif(btrim(p_social_account_id), '') is null
     or p_x_post_id is null or p_x_post_id !~ '^[0-9]{1,30}$'
     or p_normalized_text_sha256 is null or p_normalized_text_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'VAULT_BRAND_POST_COMPLETION_ARGUMENT_INVALID' using errcode = 'P0001';
  end if;
  select sp.* into v_post from public.scheduled_posts sp where sp.id = p_scheduled_post_id for update;
  -- Specialised paths keep their own completion (Kabumori legacy; AI Lab uses
  -- complete_ai_salaryman_lab_brand_post) and never complete through here.
  if not found or v_post.post_type is distinct from 'brand_post' or v_post.brand_id in ('kabumori', 'ai_salaryman_lab')
     or (pg_catalog.to_jsonb(v_post) ->> 'social_account_id') is not null then
    raise exception 'VAULT_BRAND_POST_NOT_FOUND' using errcode = 'P0001';
  end if;
  -- The exact account: the post brand's one X account, and it must be the caller's.
  if (select count(*) from public.social_accounts sa where sa.brand_id = v_post.brand_id and sa.platform = 'x') <> 1 then
    raise exception 'X_ACCOUNT_NOT_UNIQUE_FOR_BRAND' using errcode = 'P0001';
  end if;
  select sa.* into v_account from public.social_accounts sa
  where sa.brand_id = v_post.brand_id and sa.platform = 'x';
  if v_account.id is distinct from p_social_account_id then
    raise exception 'X_CLAIM_ACCOUNT_MISMATCH' using errcode = 'P0001';
  end if;

  if v_post.status = 'succeeded' then
    -- Idempotent re-report of the same completion; never re-opens the row.
    select exists (
      select 1 from public.published_content_fingerprints f
      where f.brand_id = v_post.brand_id and f.social_account_id = v_account.id and f.post_type = 'brand_post'
        and f.x_post_id = p_x_post_id and f.normalized_text_sha256 = p_normalized_text_sha256
    ) into v_persisted;
    return query select v_persisted;
    return;
  end if;
  if v_post.status <> 'running' then
    raise exception 'VAULT_BRAND_POST_NOT_RUNNING' using errcode = 'P0001';
  end if;

  begin
    insert into public.published_content_fingerprints
      (brand_id, social_account_id, post_type, normalized_text_sha256, x_post_id)
    values (v_post.brand_id, v_account.id, 'brand_post', p_normalized_text_sha256, p_x_post_id)
    on conflict (social_account_id, x_post_id) where x_post_id is not null do nothing;
    select exists (
      select 1 from public.published_content_fingerprints f
      where f.brand_id = v_post.brand_id and f.social_account_id = v_account.id and f.post_type = 'brand_post'
        and f.x_post_id = p_x_post_id and f.normalized_text_sha256 = p_normalized_text_sha256
    ) into v_persisted;
  exception when others then
    -- Never surface post text or database detail; the X write is already confirmed.
    v_persisted := false;
  end;

  update public.scheduled_posts sp set status = 'succeeded', finished_at = pg_catalog.now()
  where sp.id = p_scheduled_post_id and sp.status = 'running';

  begin
    insert into public.post_execution_logs (scheduled_post_id, post_type, status, x_post_id, message, brand_id)
    values (p_scheduled_post_id, 'brand_post', 'succeeded', p_x_post_id,
            case when v_persisted then 'Vault account post completed; fingerprint persisted'
                 else 'Vault account post completed; fingerprint persistence failed' end,
            v_post.brand_id);
  exception when others then
    null;  -- the row is already terminal; a logging failure must not make X eligible for replay
  end;
  return query select v_persisted;
exception
  when sqlstate 'P0001' then raise;
  when others then raise exception 'VAULT_BRAND_POST_COMPLETION_UNAVAILABLE' using errcode = 'P0001';
end;
$$;

revoke all on function public.complete_vault_account_brand_post(uuid, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.complete_vault_account_brand_post(uuid, text, text, text) to service_role;

commit;
