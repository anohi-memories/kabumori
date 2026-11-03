-- G4 SOURCE CANDIDATE (2026-10-25, Issue #319 G4-41). NOT in supabase/migrations/. NOT applied anywhere but a disposable local PG17.
-- Applies ON TOP OF 001 (PR #511) + 002 (PR #516). Same adoption gates (G5's authority interface accepted, one Codex Sol (high)
-- batch review, the owner's explicit production approval) and, in addition, an operator decision to open the gate below.
--
-- The person's own "disconnect X" as an API call: public.disconnect_social_mobile_x_connection() -> 'unconnected'.
--   * EXECUTE for authenticated only (explicit grant; nothing for anon / service_role), SECURITY DEFINER, empty search_path.
--   * Takes NO argument: the account is derived from auth.uid() by 002's postona_g4_x_oauth.disconnect_x_connection(), which
--     also asks G5's session and workspace verdicts, locks the workspace and social_accounts (W3), writes 'unconnected' (W1),
--     deletes pending states and moves the connection epoch (an in-flight refresh lease then commits 'account_changed').
--   * A GATE, closed by this file: until the operator opens it (postona_g4_x_oauth.set_x_disconnect_enabled(true), owner only)
--     every call refuses X_DISCONNECT_NOT_ENABLED. Nothing here opens it.
--   * The Vault secrets are kept (retention after a disconnect is the user's open decision, #299).
-- App side: apps/social-mobile/src/features/x-connect/use-x-connect.ts disconnect() calls this RPC; no screen shows it yet (G1/G2).
-- Rollback: 003_x_disconnect_user_rpc_rollback.sql.
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regnamespace('postona_g4_x_oauth') is null
     or to_regprocedure('postona_g4_x_oauth.store_refreshed_x_tokens(text,bigint,text,text)') is not null
     or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('postona_g4_x_oauth.disconnect_x_connection()'))
        is distinct from 'f9de8f83c65f4ca228aad31ad1d6900b' then
    raise exception 'G4X_DISCONNECT_RPC_NEEDS_002';
  end if;
  if to_regprocedure('public.disconnect_social_mobile_x_connection()') is not null
     or to_regclass('postona_g4_x_oauth.settings') is not null then
    raise exception 'G4X_DISCONNECT_RPC_ALREADY_APPLIED';
  end if;
end $$;

create table postona_g4_x_oauth.settings (
  id smallint not null default 1 check (id = 1),
  x_disconnect_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint g4x_settings_pkey primary key (id));
insert into postona_g4_x_oauth.settings (id) values (1);
revoke all on table postona_g4_x_oauth.settings from public, anon, authenticated, service_role;

-- the operator's switch (owner only; no grant)
create function postona_g4_x_oauth.set_x_disconnect_enabled(p_enabled boolean) returns void
language sql volatile security definer set search_path = ''
as $$
  update postona_g4_x_oauth.settings set x_disconnect_enabled = coalesce(p_enabled, false), updated_at = pg_catalog.now()
  where id = 1;
$$;
revoke all on function postona_g4_x_oauth.set_x_disconnect_enabled(boolean) from public, anon, authenticated, service_role;

create function public.disconnect_social_mobile_x_connection() returns text
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED';
  end if;
  if (select s.x_disconnect_enabled from postona_g4_x_oauth.settings s where s.id = 1) is not true then
    raise exception 'X_DISCONNECT_NOT_ENABLED';
  end if;
  perform postona_g4_x_oauth.disconnect_x_connection();
  return 'unconnected';
end $$;
revoke all on function public.disconnect_social_mobile_x_connection() from public, anon, service_role;
grant execute on function public.disconnect_social_mobile_x_connection() to authenticated;

do $$
declare v_role text;
begin
  if not has_function_privilege('authenticated', 'public.disconnect_social_mobile_x_connection()', 'EXECUTE')
     or has_function_privilege('anon', 'public.disconnect_social_mobile_x_connection()', 'EXECUTE')
     or has_function_privilege('service_role', 'public.disconnect_social_mobile_x_connection()', 'EXECUTE') then
    raise exception 'G4X_DISCONNECT_RPC_POSTCONDITION_ACL';
  end if;
  if (select s.x_disconnect_enabled from postona_g4_x_oauth.settings s where s.id = 1) is not false then
    raise exception 'G4X_DISCONNECT_RPC_POSTCONDITION_GATE_OPEN';
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if has_schema_privilege(v_role, 'postona_g4_x_oauth', 'USAGE')
       or exists (select 1 from pg_proc p where p.pronamespace = 'postona_g4_x_oauth'::regnamespace
                    and has_function_privilege(v_role, p.oid, 'EXECUTE'))
       or has_table_privilege(v_role, 'postona_g4_x_oauth.settings', 'SELECT,INSERT,UPDATE,DELETE') then
      raise exception 'G4X_DISCONNECT_RPC_POSTCONDITION_API_ROLE_REACHES %', v_role;
    end if;
  end loop;
end $$;

commit;
