-- G4 SOURCE CANDIDATE (2026-10-25, Issue #319 G4-43). NOT in supabase/migrations/. NOT applied anywhere but a disposable local PG17.
-- Applies ON TOP OF 001 (PR #511) + 002 (PR #516) (+ 003 if present). Same adoption gates as 001-003.
--
-- Before the Edge exchanges the authorization code with X it calls public.consume_social_mobile_x_oauth_state (read-only;
-- x-oauth-connect-user/oauth_logic.ts completeConnection). On main that checks only: the caller began it, not consumed, not
-- expired. Everything else is only checked by complete, i.e. AFTER X has issued tokens for a connection that will be refused.
-- G4-05's PR #353 closed that in the Edge with an authorization port to G5 R1 that is not wired (deploying it turns X connect
-- off). This file closes it in SQL instead, with the authority 001 already uses: consume now refuses, before the exchange,
-- exactly what complete would refuse for this state --
--   a state begun before 001 (OAUTH_STATE_NOT_BOUND), an older begin (OAUTH_STATE_SUPERSEDED), a moved connection epoch
--   (X_CONNECTION_CHANGED), a dead / anonymous session (SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE, G5 S2-2), a workspace that no
--   longer passes G5's S2-3 rule (OWN_WORKSPACE_CONFLICT / WORKSPACE_OWNER_UNKNOWN / WORKSPACE_VERDICT_UNKNOWN) and a moved
--   owner epoch (OWNER_EPOCH_CHANGED / OWNER_EPOCH_UNAVAILABLE).
-- Still read-only (no lock, no write); complete re-checks everything under its locks, so a change between the two is refused
-- there. Same signature, owner and ACL (CREATE OR REPLACE). Not changed: begin, complete, the Edge, the app.
-- Rollback: 004_x_consume_preexchange_recheck_rollback.sql (main's body back, byte for byte).
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regnamespace('postona_g4_x_oauth') is null
     or to_regprocedure('postona_g4_x_oauth.store_refreshed_x_tokens(text,bigint,text,text)') is not null
     or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('postona_g4_x_oauth.disconnect_x_connection()'))
        is distinct from 'f9de8f83c65f4ca228aad31ad1d6900b' then
    raise exception 'G4X_CONSUME_NEEDS_002';
  end if;
  -- main's body (20260919120000 L167-L192), measured on PG17
  if (select md5(p.prosrc) from pg_proc p
        where p.oid = to_regprocedure('public.consume_social_mobile_x_oauth_state(text)'))
     is distinct from '9da3c2fdfe2f1ca6ecedacfc9ee56a1c' then
    raise exception 'G4X_CONSUME_PRECONDITION_BODY';
  end if;
end $$;

create or replace function public.consume_social_mobile_x_oauth_state(p_state_hash text)
returns table (oauth_state_id uuid, redirect_uri text, brand_id text, social_account_id text)
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_user_id uuid := auth.uid();
  v_state public.social_account_oauth_states%rowtype;
  v_binding postona_g4_x_oauth.state_bindings%rowtype;
  v_connection postona_g4_x_oauth.connections%rowtype;
begin
  if v_user_id is null then
    raise exception 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED';
  end if;
  select * into v_state from public.social_account_oauth_states s
  where s.state_hash = p_state_hash;
  if not found or v_state.initiated_by_user_id is distinct from v_user_id then
    -- the same error for "no such state" and "someone else's" (main's rule)
    raise exception 'OAUTH_STATE_NOT_CONSUMABLE';
  end if;
  if v_state.consumed_at is not null or v_state.expires_at <= now() then
    raise exception 'OAUTH_STATE_NOT_CONSUMABLE';
  end if;
  -- G4-43: what complete will require, asked before the code is exchanged with X
  select b.* into v_binding from postona_g4_x_oauth.state_bindings b where b.oauth_state_id = v_state.id;
  if not found or v_binding.initiated_by <> v_user_id or v_binding.social_account_id <> v_state.social_account_id
     or v_binding.brand_id <> v_state.brand_id then
    raise exception 'OAUTH_STATE_NOT_BOUND';
  end if;
  select c.* into v_connection from postona_g4_x_oauth.connections c where c.social_account_id = v_state.social_account_id;
  if not found or v_connection.latest_state_id is distinct from v_state.id then
    raise exception 'OAUTH_STATE_SUPERSEDED';
  end if;
  if v_connection.connection_epoch <> v_binding.connection_epoch then
    raise exception 'X_CONNECTION_CHANGED';
  end if;
  if v_binding.brand_id <> 'u_' || substr(md5(v_user_id::text), 1, 24)
     or postona_g4_x_oauth.require_person(v_user_id) <> 'own' then
    raise exception 'OWN_WORKSPACE_CONFLICT';
  end if;
  if postona_g4_x_oauth.require_owner_epoch(v_binding.brand_id) <> v_binding.owner_epoch then
    raise exception 'OWNER_EPOCH_CHANGED';
  end if;
  return query select v_state.id, v_state.redirect_uri, v_state.brand_id, v_state.social_account_id;
end;
$$;

do $$
begin
  if not has_function_privilege('authenticated', 'public.consume_social_mobile_x_oauth_state(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.consume_social_mobile_x_oauth_state(text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.consume_social_mobile_x_oauth_state(text)', 'EXECUTE') then
    raise exception 'G4X_CONSUME_POSTCONDITION_ACL';
  end if;
end $$;

commit;
