-- G4 SOURCE CANDIDATE ROLLBACK (2026-10-25, Issue #319 G4-43) for 004_x_consume_preexchange_recheck.sql. Disposable PG17 only.
-- Puts public.consume_social_mobile_x_oauth_state back to main's body, copied verbatim from main 0c42933c
-- supabase/migrations/20260919120000_social_mobile_x_oauth_onboarding.sql L167-L192 (CREATE OR REPLACE keeps OID, owner, ACL).
begin;

set local lock_timeout = '5s';

do $$
begin
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.consume_social_mobile_x_oauth_state(text)'))
     is distinct from '58beaeb51a72b55612c01f505077ee63' then
    raise exception 'G4X_CONSUME_ROLLBACK_NOT_APPLIED';
  end if;
end $$;

-- main 0c42933c 20260919120000 L167-L192, verbatim
create or replace function public.consume_social_mobile_x_oauth_state(p_state_hash text)
returns table (oauth_state_id uuid, redirect_uri text, brand_id text, social_account_id text)
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_user_id uuid := auth.uid();
  v_state public.social_account_oauth_states%rowtype;
begin
  if v_user_id is null then
    raise exception 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED';
  end if;
  select * into v_state from public.social_account_oauth_states
  where state_hash = p_state_hash;
  if not found or v_state.initiated_by_user_id is distinct from v_user_id then
    -- Deliberately the same error for "no such state" and "belongs to someone else": do not let the
    -- error message itself reveal whether a given state hash exists for another user.
    raise exception 'OAUTH_STATE_NOT_CONSUMABLE';
  end if;
  if v_state.consumed_at is not null or v_state.expires_at <= now() then
    raise exception 'OAUTH_STATE_NOT_CONSUMABLE';
  end if;
  return query select v_state.id, v_state.redirect_uri, v_state.brand_id, v_state.social_account_id;
end;
$$;

do $$
begin
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.consume_social_mobile_x_oauth_state(text)'))
     is distinct from '9da3c2fdfe2f1ca6ecedacfc9ee56a1c' then
    raise exception 'G4X_CONSUME_ROLLBACK_POSTCONDITION_BODY';
  end if;
end $$;

commit;
