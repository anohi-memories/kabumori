-- Rollback of 002_custody_connect_proof.sql (SOURCE CANDIDATE, G4-16). Puts back the custody candidate's writer
-- verbatim (supabase/candidates/postona_threads_publish/threads_credential_custody_candidate.sql), with its
-- verified_at = now() check. Run BEFORE rolling back 001.
begin;
set local lock_timeout = '2s';
set local search_path = '';
do $$
declare
  v_fn oid := pg_catalog.to_regprocedure('public.record_threads_credential_custody(text,timestamptz)');
begin
  if v_fn is null or pg_catalog.obj_description(v_fn, 'pg_proc') is distinct from 'postona G4-16 connect proof' then
    raise exception 'THREADS_CUSTODY_PROOF_NOT_APPLIED';
  end if;
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) <> (select oid from pg_catalog.pg_roles where rolname = current_user) then
    raise exception 'THREADS_CUSTODY_PROOF_ROLLBACK_OWNER';
  end if;
end $$;

create or replace function public.record_threads_credential_custody(p_social_account_id text, p_expires_at timestamptz)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_account public.social_accounts%rowtype;
begin
  if v_user is null then raise exception 'THREADS_CUSTODY_AUTH_REQUIRED' using errcode = 'P0001'; end if;
  if p_expires_at is null or p_expires_at <= pg_catalog.clock_timestamp()
     or p_expires_at > pg_catalog.clock_timestamp() + interval '61 days' then
    raise exception 'THREADS_CUSTODY_EXPIRY_INVALID' using errcode = 'P0001';
  end if;
  select a.* into v_account from public.social_accounts a where a.id = p_social_account_id for update;
  if v_account.id is null or v_account.platform is distinct from 'threads'
     or v_account.connection_status is distinct from 'identity_verified' or v_account.vault_access_token_secret_id is null
     or not exists (select 1 from public.brand_memberships m
                    where m.brand_id = v_account.brand_id and m.user_id = v_user and m.role = 'owner') then
    raise exception 'THREADS_CUSTODY_ACCOUNT_INVALID' using errcode = 'P0001';
  end if;
  -- Only in the very transaction that verified this connection (and stored this credential).
  if v_account.verified_at is distinct from pg_catalog.now() then
    raise exception 'THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION' using errcode = 'P0001';
  end if;
  insert into public.threads_account_credential_custody (social_account_id, vault_secret_id, expires_at, recorded_at, recorded_by)
  values (v_account.id, v_account.vault_access_token_secret_id, p_expires_at, pg_catalog.now(), v_user)
  on conflict (social_account_id) do update
    set vault_secret_id = excluded.vault_secret_id, expires_at = excluded.expires_at,
        recorded_at = excluded.recorded_at, recorded_by = excluded.recorded_by;
end;
$$;

comment on function public.record_threads_credential_custody(text, timestamptz) is null;
do $$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
       where p.oid = pg_catalog.to_regprocedure('public.record_threads_credential_custody(text,timestamptz)')) is distinct from 'eb58930b04d23d6a012cf1b54ab93e0f' then
    raise exception 'THREADS_CUSTODY_PROOF_ROLLBACK_POSTCONDITION';
  end if;
end $$;
commit;
