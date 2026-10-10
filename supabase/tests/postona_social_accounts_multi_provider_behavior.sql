-- Behavior proof for the POSTONA multi-provider account schema candidate
-- (20261007150000_postona_social_accounts_multi_provider.sql). Run by
-- postona_social_accounts_multi_provider_run.sh as the table owner on a disposable database:
-- publish-permission fixture, the real X migrations (onboarding, reconnect, refresh core, refresh
-- rollout, account deletion, publish permission), production-like access
-- (postona_social_accounts_multi_provider_fixture.sql), seeded X accounts, a snapshot taken right
-- before the candidate (postona_proof.accounts_before / catalog_before / constraints_before), then
-- the candidate. Fake data only; prints POSTONA_ACCOUNTS_BEHAVIOR_PASS.
-- Writes as the owner pass the provider-write guard (the owner is the reviewed writer); the guard's
-- refusals for every other role are proven in section 4.
set timezone = 'UTC';

create function pg_temp.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAIL %', p_label; end if;
end;
$$;

-- Runs one statement as a role (null: as the caller) and always undoes it: 'accepted', or
-- SQLSTATE:constraint of the refusal (SQLSTATE:message for a raised P0001, SQLSTATE:- otherwise).
create function pg_temp.probe_as(p_role text, p_sql text) returns text language plpgsql as $$
declare
  v_state text;
  v_constraint text;
  v_message text;
begin
  begin
    if p_role is not null then
      execute format('set local role %I', p_role);
    end if;
    execute p_sql;
    raise exception using errcode = 'PX001', message = 'probe';
  exception
    when sqlstate 'PX001' then return 'accepted';
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_message = message_text;
      return v_state || ':' || coalesce(nullif(v_constraint, ''), case when v_state = 'P0001' then v_message else '-' end);
  end;
end;
$$;
create function pg_temp.probe(p_sql text) returns text language sql as $$ select pg_temp.probe_as(null, p_sql) $$;

-- 1. The X-only CHECK gone; every other constraint, column, default, grant, RLS flag, policy, index,
--    pre-existing trigger, role membership and row as before. (The exact text of the new CHECKs is
--    asserted last, after their behavior.)
select pg_temp.check(
  (select array_agg(c.conname || '=' || pg_get_constraintdef(c.oid) || ':' || c.convalidated order by c.conname)
   from pg_constraint c
   where c.conrelid = 'public.social_accounts'::regclass
     and c.conname not in ('social_accounts_platform_supported', 'social_accounts_provider_credential_profile',
                           'social_accounts_meta_connected_access', 'social_accounts_meta_publish_disabled'))
  = (select array_agg(b.def order by b.conname) from postona_proof.constraints_before b
     where b.def <> b.conname || '=CHECK ((platform = ''x''::text)):true'),
  'every other constraint unchanged, the X-only CHECK removed');
select pg_temp.check((select count(*) from postona_proof.constraints_before b
                      where b.def = b.conname || '=CHECK ((platform = ''x''::text)):true') = 1,
  'exactly one X-only CHECK existed before');
select pg_temp.check((postona_proof.catalog() - 'constraints' - 'triggers' - 'functions')
                     = (select c.v - 'constraints' - 'triggers' - 'functions' from postona_proof.catalog_before c),
  'columns, defaults, grants, RLS, policies, indexes, memberships and rows unchanged');
create temporary view pg_temp.triggers_now as
  select t.tgname::text as tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled::text as enabled, md5(p.prosrc) as body
  from pg_trigger t join pg_proc p on p.oid = t.tgfoid
  where t.tgrelid = 'public.social_accounts'::regclass and not t.tgisinternal;
select pg_temp.check(
  (select count(*) from postona_proof.triggers_before) = 2
  and not exists (select * from postona_proof.triggers_before except select * from pg_temp.triggers_now)
  and (select array_agg(tgname order by tgname) from pg_temp.triggers_now)
      = array['social_accounts_provider_guard', 'social_accounts_x_refresh_reset_on_reconnect', 'social_mobile_deletion_guard'],
  'the two existing triggers kept exactly (definition, enabled, function body), one guard added');
select pg_temp.check((select count(*) from public.social_accounts) = (select count(*) from postona_proof.accounts_before)
                     and not exists (select * from postona_proof.accounts_before except select * from public.social_accounts),
  'every existing X row unchanged, publish_enabled included');
select pg_temp.check((select count(*) from public.social_accounts where publish_enabled) = 2,
  'the seeded publish-enabled X rows are still enabled (the candidate toggles nothing)');
select pg_temp.check(not exists (
    select 1 from pg_attribute a
    where a.attrelid = 'public.social_accounts'::regclass and a.attnum > 0 and not a.attisdropped
      and a.attname ~* '(token|secret|credential)' and format_type(a.atttypid, a.atttypmod) <> 'uuid'),
  'credential columns are Vault references (uuid) only');

-- 2. Threads and Instagram accounts: one long-lived access reference, no refresh reference,
--    unpublished by default, beside the workspace's X account (written as the owner).
select brand_id as b_off from public.social_accounts where id = 'sa_x_off' \gset
insert into vault.secrets (secret) values ('fake_threads_off_ACCESS') returning id as threads_secret \gset
insert into vault.secrets (secret) values ('fake_instagram_off_ACCESS') returning id as instagram_secret \gset
insert into public.social_accounts
  (id, brand_id, platform, handle, platform_user_id, connection_status, verified_at, vault_access_token_secret_id)
values ('sa_x_off_threads', :'b_off', 'threads', 'th_off', 'th_1', 'identity_verified', now(), :'threads_secret'),
       ('sa_x_off_instagram', :'b_off', 'instagram', 'ig_off', 'ig_1', 'identity_verified', now(), :'instagram_secret');
select pg_temp.check((select string_agg(platform, ',' order by platform) from public.social_accounts where brand_id = :'b_off')
                     = 'instagram,threads,x', 'one X, one Threads and one Instagram account in one workspace');
select pg_temp.check((select bool_and(not publish_enabled and vault_refresh_token_secret_id is null
                                      and vault_access_token_secret_id is not null)
                      from public.social_accounts where id in ('sa_x_off_threads', 'sa_x_off_instagram')),
  'Meta rows start unpublished (schema default) with an access reference only');
select pg_temp.check(pg_temp.probe(format(
    $q$insert into public.social_accounts (id, brand_id, platform) values ('sa_probe', 'postona_meta_only', %L)$q$, p)) = 'accepted',
  'platform ' || p || ' accepted')
from unnest(array['x', 'threads', 'instagram']) p;

-- 3. The Meta credential profile, connected-access rule and publish lock, as a full matrix:
--    provider x status x access x refresh. A refresh reference is always refused; a connected or
--    identity_verified Meta row needs its access reference; pre-connect states may lack it. CHECKs are
--    evaluated in name order, so meta_connected_access reports first when both are violated. X rows
--    keep every combination they accepted before.
select pg_temp.check(pg_temp.probe(format(
    $q$insert into public.social_accounts (id, brand_id, platform, connection_status, vault_access_token_secret_id, vault_refresh_token_secret_id)
       values ('sa_probe', 'postona_meta_only', %L, %L, %s, %s)$q$, p, s, a, r))
  = case when p = 'x' then 'accepted'
         when a = 'null' and s in ('connected', 'identity_verified') then '23514:social_accounts_meta_connected_access'
         when r <> 'null' then '23514:social_accounts_provider_credential_profile'
         else 'accepted' end,
  format('%s / %s / access %s / refresh %s', p, s, a, r))
from unnest(array['x', 'threads', 'instagram']) p,
     unnest(array['unconnected', 'authorization_pending', 'connected', 'identity_verified', 'failed']) s,
     unnest(array['gen_random_uuid()', 'null']) a,
     unnest(array['gen_random_uuid()', 'null']) r;
select pg_temp.check(pg_temp.probe(format(
    $q$update public.social_accounts set vault_refresh_token_secret_id = gen_random_uuid() where id = %L$q$, a))
  = '23514:social_accounts_provider_credential_profile', a || ': adding a refresh reference refused')
from unnest(array['sa_x_off_threads', 'sa_x_off_instagram']) a;
select pg_temp.check(pg_temp.probe(format(
    $q$update public.social_accounts set vault_access_token_secret_id = null where id = %L$q$, a))
  = '23514:social_accounts_meta_connected_access', a || ': dropping the access reference while connected refused')
from unnest(array['sa_x_off_threads', 'sa_x_off_instagram']) a;
select pg_temp.check(pg_temp.probe(format(
    $q$update public.social_accounts set vault_access_token_secret_id = null, connection_status = 'unconnected' where id = %L$q$, a))
  = 'accepted', a || ': disconnecting (no access reference, unconnected) accepted')
from unnest(array['sa_x_off_threads', 'sa_x_off_instagram']) a;
select pg_temp.check(pg_temp.probe(format(
    $q$insert into public.social_accounts (id, brand_id, platform, publish_enabled) values ('sa_probe', 'postona_meta_only', %L, true)$q$, p))
  = '23514:social_accounts_meta_publish_disabled', p || ' created publish-enabled refused')
from unnest(array['threads', 'instagram']) p;
select pg_temp.check(pg_temp.probe(format(
    $q$update public.social_accounts set publish_enabled = true where id = %L$q$, a))
  = '23514:social_accounts_meta_publish_disabled', a || ': enabling publishing refused')
from unnest(array['sa_x_off_threads', 'sa_x_off_instagram']) a;

-- 4. The provider guard. (a) A row's provider never changes: every pair, connected or not, alone or
--    with simultaneous credential / status / publish edits, as the owner and as service_role, by
--    UPDATE, by a multi-row UPDATE and by an upsert.
select pg_temp.check(pg_temp.probe_as(w, format($q$update public.social_accounts set platform = %L%s where id = %L$q$, t, e, a))
                     = 'P0001:SOCIAL_ACCOUNT_PROVIDER_IMMUTABLE',
  format('%s: %s -> %s%s refused', coalesce(w, 'owner'), a, t, e))
from (values ('sa_x_off', 'threads'), ('sa_x_off', 'instagram'), ('sa_x_pending', 'threads'), ('sa_x_pending', 'instagram'),
             ('sa_x_off_threads', 'x'), ('sa_x_off_threads', 'instagram'), ('sa_x_off_instagram', 'x'),
             ('sa_x_off_instagram', 'threads')) v(a, t),
     unnest(array['', ', vault_refresh_token_secret_id = null, publish_enabled = false',
                  ', vault_refresh_token_secret_id = null, vault_access_token_secret_id = null, connection_status = ''unconnected'', publish_enabled = false',
                  ', vault_access_token_secret_id = gen_random_uuid(), connection_status = ''identity_verified''']) e,
     unnest(array[null, 'service_role']) w;
select pg_temp.check(pg_temp.probe(format(
    $q$update public.social_accounts set platform = case platform when 'x' then 'threads' else platform end,
              vault_refresh_token_secret_id = null where brand_id = %L$q$, :'b_off')) = 'P0001:SOCIAL_ACCOUNT_PROVIDER_IMMUTABLE',
  'a multi-row relabel refused');
-- (An upsert fires BEFORE INSERT on the proposed row first: service_role is stopped there already.)
select pg_temp.check(pg_temp.probe_as(w,
    $q$insert into public.social_accounts (id, brand_id, platform) select 'sa_x_pending', brand_id, 'threads' from public.social_accounts
       where id = 'sa_x_pending' on conflict (id) do update set platform = excluded.platform, vault_refresh_token_secret_id = null$q$)
  = e, coalesce(w, 'owner') || ': relabel by upsert refused')
from (values (null, 'P0001:SOCIAL_ACCOUNT_PROVIDER_IMMUTABLE'),
             ('service_role', 'P0001:SOCIAL_ACCOUNT_PROVIDER_WRITE_NOT_ALLOWED')) v(w, e);
--    (b) Only the owner writes Threads/Instagram rows: service_role's direct DML is refused, X DML is not.
select pg_temp.check(pg_temp.probe_as('service_role', format(
    $q$insert into public.social_accounts (id, brand_id, platform) values ('sa_probe', 'postona_meta_only', %L)$q$, p))
  = 'P0001:SOCIAL_ACCOUNT_PROVIDER_WRITE_NOT_ALLOWED', 'service_role: creating a ' || p || ' row refused')
from unnest(array['threads', 'instagram']) p;
select pg_temp.check(pg_temp.probe_as('service_role', format($q$update public.social_accounts set %s where id = %L$q$, e, a))
                     = 'P0001:SOCIAL_ACCOUNT_PROVIDER_WRITE_NOT_ALLOWED', format('service_role: %s on %s refused', e, a))
from unnest(array['sa_x_off_threads', 'sa_x_off_instagram']) a,
     unnest(array['handle = handle', 'publish_enabled = false', 'vault_access_token_secret_id = gen_random_uuid()',
                  'connection_status = ''failed''', 'platform_user_id = ''th_other''']) e;
select pg_temp.check(pg_temp.probe_as('service_role',
    $q$insert into public.social_accounts (id, brand_id, platform) values ('sa_x_off_threads', 'postona_meta_only', 'threads')
       on conflict (id) do update set handle = 'taken'$q$) = 'P0001:SOCIAL_ACCOUNT_PROVIDER_WRITE_NOT_ALLOWED',
  'service_role: changing a Threads row by upsert refused');
select pg_temp.check(pg_temp.probe_as('service_role',
    $q$insert into public.social_accounts (id, brand_id, platform) values ('sa_probe', 'postona_meta_only', 'x')$q$) = 'accepted',
  'service_role: creating an X row still accepted');
select pg_temp.check(pg_temp.probe_as('service_role',
    $q$update public.social_accounts set last_connection_error_code = null, updated_at = now() where id = 'sa_x_off'$q$) = 'accepted',
  'service_role: updating an X row still accepted');
select pg_temp.check(pg_temp.probe_as('service_role',
    $q$delete from public.social_accounts where id = 'sa_x_off_instagram'$q$) = 'accepted',
  'service_role: deleting a Meta row is not guarded (it creates or widens nothing)');
select pg_temp.check(pg_temp.probe_as(r, format($q$%s$q$, s)) = '42501:-', r || ' cannot write: ' || s)
from unnest(array['anon', 'authenticated']) r,
     unnest(array[$q$insert into public.social_accounts (id, brand_id, platform) values ('sa_probe', 'postona_meta_only', 'x')$q$,
                  $q$insert into public.social_accounts (id, brand_id, platform) values ('sa_probe', 'postona_meta_only', 'threads')$q$,
                  $q$update public.social_accounts set handle = handle where id = 'sa_x_off_threads'$q$,
                  $q$delete from public.social_accounts where id = 'sa_x_off_threads'$q$]) s;
select pg_temp.check(pg_temp.probe($q$update public.social_accounts set handle = 'th_renamed' where id = 'sa_x_off_threads'$q$) = 'accepted',
  'the owner (the reviewed writer) may update a Threads row');
--    (c) No existing SECURITY DEFINER function can be used as a generic Meta writer. This is the reviewed
--    list of SECURITY DEFINER functions that write social_accounts; each either picks the X row
--    (platform = 'x' or x_legacy_post_account), inserts only 'x', only clears publish_enabled /
--    sets an error state on a row it was given, refuses Meta ON, or deletes. A new one fails this check
--    until it is reviewed.
select pg_temp.check(
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p
   where p.prosecdef and p.prosrc ~* '(insert[[:space:]]+into|update|delete[[:space:]]+from)[[:space:]]+(public\.)?social_accounts')
  = 'begin_social_mobile_x_oauth_connection,complete_social_mobile_x_oauth_connection,record_x_account_access_unauthorized,'
    || 'set_social_account_publish_enabled,social_mobile_account_deletion_acquire,social_mobile_account_deletion_purge,'
    || 'x_account_refresh_health_mirror',
  'reviewed list of SECURITY DEFINER writers of social_accounts');
--    The X completion is the only one that writes credentials onto a row it was handed: an OAuth state
--    forged to point at a Threads row cannot make it store a token pair there.
select brand_id as b_th from public.social_accounts where id = 'sa_x_off_threads' \gset
insert into public.social_account_oauth_states (social_account_id, brand_id, state_hash, redirect_uri, expires_at, initiated_by_user_id)
values ('sa_x_off_threads', :'b_th', repeat('f', 64), 'kabumori-social://oauth-callback', now() + interval '10 minutes',
        '00000000-0000-4000-8000-000000000301')
returning id as forged \gset
select count(*) as secrets_before from vault.secrets \gset
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000301', false);
select pg_temp.check(pg_temp.probe_as('authenticated', format(
    $q$select public.complete_social_mobile_x_oauth_connection(%L, 'th_1', 'forged', 'fake_forged_access', 'fake_forged_refresh')$q$, :'forged'))
  = '23514:social_accounts_provider_credential_profile', 'the X completion cannot store tokens on a Threads row');
select set_config('request.jwt.claim.sub', '', false);
select pg_temp.check((select count(*) from vault.secrets) = :secrets_before
                     and (select consumed_at is null from public.social_account_oauth_states where id = :'forged')
                     and (select vault_refresh_token_secret_id is null and handle = 'th_off'
                          from public.social_accounts where id = 'sa_x_off_threads'),
  'the refused completion wrote nothing (no secret, state not consumed, row unchanged)');
delete from public.social_account_oauth_states where id = :'forged';

-- 5. Unknown providers stay refused; exact spelling only.
select pg_temp.check(pg_temp.probe(format(
    $q$insert into public.social_accounts (id, brand_id, platform) values ('sa_probe', 'postona_meta_only', %L)$q$, p))
  = '23514:social_accounts_platform_supported', 'platform ' || quote_literal(p) || ' refused')
from unnest(array['tiktok', 'facebook', 'bluesky', '', ' ', 'X', 'Threads', 'INSTAGRAM', ' x', 'x ', 'threads ',
                  'instagram' || chr(10), 'meta', 'ig']) p;
select pg_temp.check(pg_temp.probe(
    $q$insert into public.social_accounts (id, brand_id, platform) values ('sa_probe', 'postona_meta_only', null)$q$) = '23502:-',
  'platform null refused');

-- 6. One account per workspace and provider; provider identities unique per provider.
select pg_temp.check(pg_temp.probe(format(
    $q$insert into public.social_accounts (id, brand_id, platform) values ('sa_probe', %L, %L)$q$, :'b_off', p))
  = '23505:social_accounts_brand_id_platform_key', 'a second ' || p || ' account in one workspace refused')
from unnest(array['x', 'threads', 'instagram']) p;
select pg_temp.check(pg_temp.probe(format(
    $q$insert into public.social_accounts (id, brand_id, platform, platform_user_id) values ('sa_probe', 'postona_meta_only', %L, %L)$q$, p, u))
  = '23505:social_accounts_platform_user_id_key', 'one ' || p || ' identity cannot be in two workspaces')
from (values ('threads', 'th_1'), ('instagram', 'ig_1'), ('x', 'x_x_off')) v(p, u);
select pg_temp.check(pg_temp.probe(
    $q$insert into public.social_accounts (id, brand_id, platform, platform_user_id) values ('sa_probe', 'postona_meta_only', 'threads', 'x_x_off')$q$)
  = 'accepted', 'identities are unique per provider, not across providers');

-- 7. X is unchanged: the X functions still refuse an X account without its refresh reference.
select brand_id as b_norefresh from public.social_accounts where id = 'sa_x_norefresh' \gset
select public.fixture_running_post(:'b_norefresh') as p_norefresh \gset
select pg_temp.check(public.fixture_permission(:'p_norefresh', 'sa_x_norefresh', :'b_norefresh') = 'X_CREDENTIAL_NOT_CONFIGURED',
  'pre-send check refuses an enabled X account without a refresh reference');
select pg_temp.check(public.x_account_refresh_authority('sa_x_norefresh') = 'X_REFRESH_CREDENTIAL_NOT_CONFIGURED',
  'refresh authority refuses an X account without a refresh reference');
select pg_temp.check(public.fixture_toggle('00000000-0000-4000-8000-000000000304', 'sa_x_norefresh_off', true, false)
                     = '{"status": "blocked", "reason": "CREDENTIALS_MISSING"}'::jsonb,
  'publish switch refuses ON for an X account without a refresh reference');
select pg_temp.check(not (select publish_enabled from public.social_accounts where id = 'sa_x_norefresh_off'), 'still OFF');

-- 8. Every X path ignores or refuses a Meta row; the workspace's X account works exactly as before.
select pg_temp.check(public.fixture_toggle('00000000-0000-4000-8000-000000000301', a, true, false)
                     = '{"status": "blocked", "reason": "PLATFORM_NOT_SUPPORTED"}'::jsonb,
  'publish switch refuses ON for ' || a)
from unnest(array['sa_x_off_threads', 'sa_x_off_instagram']) a;
select public.fixture_running_post(:'b_off') as p_off \gset
select pg_temp.check(public.fixture_permission(:'p_off', 'sa_x_off_threads', :'b_off') = 'X_CLAIM_ACCOUNT_MISMATCH',
  'pre-send check refuses a Threads account id');
select pg_temp.check(public.x_account_refresh_authority(a) = 'X_ACCOUNT_NOT_X', 'refresh authority refuses ' || a)
from unnest(array['sa_x_off_threads', 'sa_x_off_instagram']) a;
select pg_temp.check(public.fixture_toggle('00000000-0000-4000-8000-000000000301', 'sa_x_off', true, false)
                     = '{"status": "updated", "publish_enabled": true}'::jsonb,
  'the X account beside Threads/Instagram rows is switched ON as before');
select pg_temp.check(public.fixture_permission(:'p_off', 'sa_x_off', :'b_off') = 'authorized',
  'the X account beside Threads/Instagram rows is authorized to send as before');
select pg_temp.check((select string_agg(id || '=' || publish_enabled, ',' order by id) from public.social_accounts where brand_id = :'b_off')
                     = 'sa_x_off=true,sa_x_off_instagram=false,sa_x_off_threads=false', 'only the X account was enabled');
select set_config('postona.p_off', :'p_off', false), set_config('postona.b_off', :'b_off', false);
do $$
begin
  begin
    update public.social_accounts
       set vault_access_token_secret_id = (select vault_access_token_secret_id from public.social_accounts where id = 'sa_x_off')
     where id = 'sa_x_off_threads';
    perform pg_temp.check(public.fixture_permission(current_setting('postona.p_off')::uuid, 'sa_x_off', current_setting('postona.b_off'))
                          = 'X_REFRESH_SECRET_REF_SHARED', 'an X send is refused while a Meta row shares its secret reference');
    raise exception using errcode = 'PX001', message = 'undo';
  exception when sqlstate 'PX001' then null;
  end;
end;
$$;
insert into vault.secrets (secret) values ('fake_threads_only_ACCESS') returning id as only_secret \gset
insert into public.social_accounts
  (id, brand_id, platform, handle, platform_user_id, connection_status, verified_at, vault_access_token_secret_id)
values ('sa_meta_only_threads', 'postona_meta_only', 'threads', 'th_only', 'th_2', 'identity_verified', now(), :'only_secret');
select public.fixture_running_post('postona_meta_only') as p_meta \gset
select pg_temp.check(public.fixture_permission(:'p_meta', 'sa_meta_only_threads', 'postona_meta_only') = 'X_ACCOUNT_NOT_UNIQUE_FOR_BRAND',
  'pre-send check refuses a workspace that has only a Threads account');

-- 9. Account deletion never hands a Meta token to the X revoke step: a workspace with a connected
--    Threads account (no refresh reference) goes to operator review before any token is read out. The
--    deletion's own SECURITY DEFINER write (publishing off) still reaches the Threads row.
select brand_id as b_del from public.social_accounts where id = 'sa_x_del' \gset
insert into vault.secrets (secret) values ('fake_threads_del_ACCESS') returning id as del_secret \gset
insert into public.social_accounts
  (id, brand_id, platform, handle, platform_user_id, connection_status, verified_at, vault_access_token_secret_id)
values ('sa_x_del_threads', :'b_del', 'threads', 'th_del', 'th_3', 'identity_verified', now(), :'del_secret');
select public.social_mobile_account_deletion_acquire('00000000-0000-4000-8000-000000000306', 'social_and_login', false) as acquired \gset
select pg_temp.check((:'acquired'::jsonb) ->> 'status' = 'acquired', 'deletion started');
select public.social_mobile_account_deletion_credentials('00000000-0000-4000-8000-000000000306', ((:'acquired'::jsonb) ->> 'lease')::uuid) as creds \gset
select pg_temp.check(:'creds'::jsonb = '{"status": "operator_required", "reason": "CREDENTIAL_MATERIAL_MISSING"}'::jsonb,
  'deletion credentials: a Threads account goes to operator review');
select pg_temp.check(position('fake_' in :'creds') = 0, 'no token material handed out');
select pg_temp.check((select state from public.social_mobile_account_deletions where user_id = '00000000-0000-4000-8000-000000000306')
                     = 'operator_required', 'deletion parked for an operator');

-- 10. The new CHECKs and the guard, exact (qualified names, as the candidate's own postcondition sees them).
set search_path = '';
select pg_temp.check(
  (select string_agg(c.conname || '=' || pg_get_constraintdef(c.oid) || ':' || c.convalidated, ' | ' order by c.conname)
   from pg_constraint c
   where c.conrelid = 'public.social_accounts'::regclass
     and c.conname in ('social_accounts_platform_supported', 'social_accounts_provider_credential_profile',
                       'social_accounts_meta_connected_access', 'social_accounts_meta_publish_disabled'))
  = 'social_accounts_meta_connected_access=CHECK (((platform = ''x''::text) OR (vault_access_token_secret_id IS NOT NULL) OR (connection_status = ANY (ARRAY[''unconnected''::text, ''authorization_pending''::text, ''failed''::text])))):true'
    || ' | social_accounts_meta_publish_disabled=CHECK (((platform = ''x''::text) OR (publish_enabled IS FALSE))):true'
    || ' | social_accounts_platform_supported=CHECK ((platform = ANY (ARRAY[''x''::text, ''threads''::text, ''instagram''::text]))):true'
    || ' | social_accounts_provider_credential_profile=CHECK (((platform = ''x''::text) OR (vault_refresh_token_secret_id IS NULL))):true',
  'the four new CHECKs, exact and validated');
select pg_temp.check(
  (select pg_get_triggerdef(t.oid) || ' / ' || t.tgenabled::text || ' / ' || (select p.prosecdef::text || coalesce(p.proconfig::text, '')
                                                                             || coalesce(p.proacl::text, '') from pg_proc p where p.oid = t.tgfoid)
   from pg_trigger t where t.tgrelid = 'public.social_accounts'::regclass and t.tgname = 'social_accounts_provider_guard')
  = 'CREATE TRIGGER social_accounts_provider_guard BEFORE INSERT OR UPDATE ON public.social_accounts FOR EACH ROW EXECUTE FUNCTION public.social_accounts_provider_guard() / O / false{"search_path=\"\""}{'
    || current_user || '=X/' || current_user || '}',
  'the guard trigger and its function, exact (SECURITY INVOKER, empty search_path, EXECUTE for the owner only)');

select 'POSTONA_ACCOUNTS_BEHAVIOR_PASS';
