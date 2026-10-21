-- NOT A MIGRATION. SOURCE CANDIDATE ONLY (G4-16, Issue #319). Kept outside supabase/migrations: no tool applies it. A
-- security review and an explicit approval come before any real database.
--
-- G4's custody writer public.record_threads_credential_custody (supabase/candidates/postona_threads_publish/
-- threads_credential_custody_candidate.sql) accepted an expiry "only in the very transaction that verified this
-- connection" by checking verified_at = now(). now() is the transaction START time, not a transaction identity: another
-- transaction that started in the same microsecond passes it (reproduced by postona_threads_binding_epoch_run.sh 5c).
--
-- This file REPLACES ONLY that check, in place (same name, arguments, void result, SECURITY INVOKER, empty search_path,
-- the same ACL -- the shape H5's custody port asserts), with the connect proof that 001's entry
-- (postona_threads_binding.complete_and_attest_binding, G4-16) leaves: a random uuid stored in the account's binding AND
-- set transaction-locally as postona_threads_binding.connect_proof. Every other check of the writer is unchanged.
-- Apply order: the custody candidate, then 001 (G4-16), then this file. Roll back this file before 001.
--
-- The proof is not a secret and not a credential; it only says "this transaction ran the entry for this account". The
-- table owner can read it and could set the setting by hand -- the owner is trusted (it owns every table here); the
-- check stops a caller that merely runs in another transaction, not the owner itself.

begin;
set local lock_timeout = '2s';
set local search_path = '';

do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  v_fn oid := pg_catalog.to_regprocedure('public.record_threads_credential_custody(text,timestamptz)');
  v_api text;
begin
  if (select rolsuper from pg_catalog.pg_roles where oid = v_me) then
    raise exception 'THREADS_CUSTODY_PROOF_PRECONDITION_OWNER';
  end if;
  foreach v_api in array array['anon', 'authenticated', 'service_role', 'authenticator'] loop
    if exists (select 1 from pg_catalog.pg_roles r where r.rolname = v_api)
       and (pg_catalog.pg_has_role(v_api, v_me, 'MEMBER') or pg_catalog.pg_has_role(v_api, v_me, 'SET')
            or pg_catalog.pg_has_role(v_api, v_me, 'USAGE')) then
      raise exception 'THREADS_CUSTODY_PROOF_PRECONDITION_OWNER_REACHABLE %', v_api;
    end if;
  end loop;
  if v_fn is null or not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.proowner = v_me) then
    raise exception 'THREADS_CUSTODY_PROOF_PRECONDITION_WRITER';
  end if;
  if pg_catalog.obj_description(v_fn, 'pg_proc') is not distinct from 'postona G4-16 connect proof' then
    raise exception 'THREADS_CUSTODY_PROOF_ALREADY_APPLIED';
  end if;
  -- The writer replaced is exactly the reviewed custody candidate's (its source pinned).
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from 'eb58930b04d23d6a012cf1b54ab93e0f' then
    raise exception 'THREADS_CUSTODY_PROOF_PRECONDITION_WRITER_UNPINNED';
  end if;
  if pg_catalog.to_regclass('public.threads_account_credential_custody') is null
     or (select relowner from pg_catalog.pg_class where oid = pg_catalog.to_regclass('public.threads_account_credential_custody')) <> v_me
     or pg_catalog.to_regprocedure('public.threads_account_credential_expires_at(text)') is null then
    raise exception 'THREADS_CUSTODY_PROOF_PRECONDITION_CUSTODY';
  end if;
  -- 001 (G4-16): the binding carries connect_proof and the entry sets the setting.
  if pg_catalog.to_regclass('postona_threads_binding.bindings') is null
     or (select relowner from pg_catalog.pg_class where oid = pg_catalog.to_regclass('postona_threads_binding.bindings')) <> v_me
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = pg_catalog.to_regclass('postona_threads_binding.bindings') and a.attname = 'connect_proof'
                       and a.atttypid = 'uuid'::regtype and a.attnotnull and not a.attisdropped)
     or not exists (select 1 from pg_catalog.pg_proc p
                     where p.oid = pg_catalog.to_regprocedure('postona_threads_binding.complete_and_attest_binding(uuid,text,text,text,text)')
                       and p.proowner = v_me
                       and pg_catalog.strpos(p.prosrc, 'postona_threads_binding.connect_proof') > 0) then
    raise exception 'THREADS_CUSTODY_PROOF_PRECONDITION_BINDING';
  end if;
end $$;

create or replace function public.record_threads_credential_custody(p_social_account_id text, p_expires_at timestamptz)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_account public.social_accounts%rowtype;
  v_proof text := pg_catalog.current_setting('postona_threads_binding.connect_proof', true);
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
  -- Only in the very transaction that verified this connection (and stored this credential) -- G4-16: proven by the
  -- connect proof the binding entry (001 complete_and_attest_binding) set for THIS transaction and stored in this
  -- account's binding, bound by this person, for this workspace and Threads user. Not by a clock: another transaction
  -- that merely started in the same microsecond (equal now()) carries no proof.
  -- (No setting, or '' after the transaction that set it ended, matches no binding.)
  if not exists (
       select 1 from postona_threads_binding.bindings b
        where b.social_account_id = v_account.id and b.brand_id = v_account.brand_id
          and b.threads_user_id = v_account.platform_user_id and b.bound_by = v_user
          and b.connect_proof::text = v_proof) then
    raise exception 'THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION' using errcode = 'P0001';
  end if;
  insert into public.threads_account_credential_custody (social_account_id, vault_secret_id, expires_at, recorded_at, recorded_by)
  values (v_account.id, v_account.vault_access_token_secret_id, p_expires_at, pg_catalog.now(), v_user)
  on conflict (social_account_id) do update
    set vault_secret_id = excluded.vault_secret_id, expires_at = excluded.expires_at,
        recorded_at = excluded.recorded_at, recorded_by = excluded.recorded_by;
end;
$$;

comment on function public.record_threads_credential_custody(text, timestamptz) is 'postona G4-16 connect proof';

-- Postconditions: the shape H5's custody port asserts (owner, void, SECURITY INVOKER, empty search_path) and an ACL
-- naming only this owner (CREATE OR REPLACE keeps the candidate's revoked ACL; any other grantee refuses).
do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  v_fn oid := pg_catalog.to_regprocedure('public.record_threads_credential_custody(text,timestamptz)');
begin
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.proowner = v_me and not p.prosecdef
                   and p.prorettype = 'void'::regtype and coalesce(p.proconfig @> array['search_path=""'], false)
                   and pg_catalog.strpos(p.prosrc, 'connect_proof') > 0 and pg_catalog.strpos(p.prosrc, 'verified_at is distinct from pg_catalog.now()') = 0) then
    raise exception 'THREADS_CUSTODY_PROOF_POSTCONDITION_FUNCTION';
  end if;
  if (select p.proacl from pg_catalog.pg_proc p where p.oid = v_fn) is null
     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a where p.oid = v_fn and a.grantee <> v_me) then
    raise exception 'THREADS_CUSTODY_PROOF_POSTCONDITION_ACL';
  end if;
end $$;

commit;
