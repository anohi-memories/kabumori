-- Behavior proof for the POSTONA multi-provider account schema candidate
-- (20261007150000_postona_social_accounts_multi_provider.sql). Run by
-- postona_social_accounts_multi_provider_run.sh as the table owner on a disposable database:
-- publish-permission fixture, the real X migrations (onboarding, reconnect, refresh core, refresh
-- rollout, account deletion, publish permission), production-like access
-- (postona_social_accounts_multi_provider_fixture.sql), seeded X accounts, a snapshot taken right
-- before the candidate (postona_proof.accounts_before / catalog_before / constraints_before), then
-- the candidate. Fake data only; prints POSTONA_ACCOUNTS_BEHAVIOR_PASS.
set timezone = 'UTC';

create function pg_temp.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAIL %', p_label; end if;
end;
$$;

-- Runs one statement and always undoes it: 'accepted', or SQLSTATE:constraint of the refusal.
create function pg_temp.probe(p_sql text) returns text language plpgsql as $$
declare
  v_state text;
  v_constraint text;
begin
  begin
    execute p_sql;
    raise exception using errcode = 'PX001', message = 'probe';
  exception
    when sqlstate 'PX001' then return 'accepted';
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name;
      return v_state || ':' || coalesce(nullif(v_constraint, ''), '-');
  end;
end;
$$;

-- 1. Only the platform CHECK changed: the X-only CHECK gone, every other constraint, column, default,
--    grant, RLS flag, policy, trigger, index and row as before. (The exact text of the three new
--    CHECKs is asserted last, after their behavior.)
select pg_temp.check(
  (select array_agg(c.conname || '=' || pg_get_constraintdef(c.oid) || ':' || c.convalidated order by c.conname)
   from pg_constraint c
   where c.conrelid = 'public.social_accounts'::regclass
     and c.conname not in ('social_accounts_platform_supported', 'social_accounts_provider_credential_profile',
                           'social_accounts_meta_publish_disabled'))
  = (select array_agg(b.def order by b.conname) from postona_proof.constraints_before b
     where b.def <> b.conname || '=CHECK ((platform = ''x''::text)):true'),
  'every other constraint unchanged, the X-only CHECK removed');
select pg_temp.check((select count(*) from postona_proof.constraints_before b
                      where b.def = b.conname || '=CHECK ((platform = ''x''::text)):true') = 1,
  'exactly one X-only CHECK existed before');
select pg_temp.check((postona_proof.catalog() - 'constraints') = (select c.v - 'constraints' from postona_proof.catalog_before c),
  'columns, defaults, grants, RLS, policies, triggers, indexes and rows unchanged');
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
--    unpublished by default, beside the workspace's X account.
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
select pg_temp.check(pg_temp.probe(format(
    $q$insert into public.social_accounts (id, brand_id, platform, connection_status) values ('sa_probe', 'postona_meta_only', %L, 'unconnected')$q$, p)) = 'accepted',
  p || ' row without any credential (not yet connected) accepted')
from unnest(array['threads', 'instagram']) p;

-- 3. The Meta credential profile and publish lock are enforced by the table.
select pg_temp.check(pg_temp.probe(format(
    $q$insert into public.social_accounts (id, brand_id, platform, vault_access_token_secret_id, vault_refresh_token_secret_id)
       values ('sa_probe', 'postona_meta_only', %L, gen_random_uuid(), gen_random_uuid())$q$, p))
  = '23514:social_accounts_provider_credential_profile', p || ' with an X-style refresh reference refused')
from unnest(array['threads', 'instagram']) p;
select pg_temp.check(pg_temp.probe(format(
    $q$insert into public.social_accounts (id, brand_id, platform, vault_refresh_token_secret_id)
       values ('sa_probe', 'postona_meta_only', %L, gen_random_uuid())$q$, p))
  = '23514:social_accounts_provider_credential_profile', p || ' with a refresh reference only refused')
from unnest(array['threads', 'instagram']) p;
select pg_temp.check(pg_temp.probe(format(
    $q$update public.social_accounts set vault_refresh_token_secret_id = gen_random_uuid() where id = %L$q$, a))
  = '23514:social_accounts_provider_credential_profile', a || ': adding a refresh reference refused')
from unnest(array['sa_x_off_threads', 'sa_x_off_instagram']) a;
select pg_temp.check(pg_temp.probe(format(
    $q$insert into public.social_accounts (id, brand_id, platform, publish_enabled) values ('sa_probe', 'postona_meta_only', %L, true)$q$, p))
  = '23514:social_accounts_meta_publish_disabled', p || ' created publish-enabled refused')
from unnest(array['threads', 'instagram']) p;
select pg_temp.check(pg_temp.probe(format(
    $q$update public.social_accounts set publish_enabled = true where id = %L$q$, a))
  = '23514:social_accounts_meta_publish_disabled', a || ': enabling publishing refused')
from unnest(array['sa_x_off_threads', 'sa_x_off_instagram']) a;
-- An X row cannot be relabelled as Meta while it keeps its X refresh reference.
select pg_temp.check(pg_temp.probe(
    $q$update public.social_accounts set platform = 'threads' where id = 'sa_x_off'$q$)
  = '23514:social_accounts_provider_credential_profile', 'a connected X row cannot become Threads with its refresh reference');

-- 4. Unknown providers stay refused; exact spelling only.
select pg_temp.check(pg_temp.probe(format(
    $q$insert into public.social_accounts (id, brand_id, platform) values ('sa_probe', 'postona_meta_only', %L)$q$, p))
  = '23514:social_accounts_platform_supported', 'platform ' || quote_literal(p) || ' refused')
from unnest(array['tiktok', 'facebook', 'bluesky', '', ' ', 'X', 'Threads', 'INSTAGRAM', ' x', 'x ', 'threads ',
                  'instagram' || chr(10), 'meta', 'ig']) p;
select pg_temp.check(pg_temp.probe(
    $q$insert into public.social_accounts (id, brand_id, platform) values ('sa_probe', 'postona_meta_only', null)$q$) = '23502:-',
  'platform null refused');
select pg_temp.check(pg_temp.probe(
    $q$update public.social_accounts set platform = 'tiktok' where id = 'sa_x_off_threads'$q$)
  = '23514:social_accounts_platform_supported', 'an existing row cannot move to an unknown provider');

-- 5. One account per workspace and provider; provider identities unique per provider.
select pg_temp.check(pg_temp.probe(format(
    $q$insert into public.social_accounts (id, brand_id, platform) values ('sa_probe', %L, %L)$q$, :'b_off', p))
  = '23505:social_accounts_brand_id_platform_key', 'a second ' || p || ' account in one workspace refused')
from unnest(array['x', 'threads', 'instagram']) p;
select pg_temp.check(pg_temp.probe(
    $q$insert into public.social_accounts (id, brand_id, platform, platform_user_id) values ('sa_probe', 'postona_meta_only', 'threads', 'th_1')$q$)
  = '23505:social_accounts_platform_user_id_key', 'one Threads identity cannot be connected to two workspaces');
select pg_temp.check(pg_temp.probe(
    $q$insert into public.social_accounts (id, brand_id, platform, platform_user_id) values ('sa_probe', 'postona_meta_only', 'threads', 'x_x_off')$q$)
  = 'accepted', 'identities are unique per provider, not across providers');

-- 6. X is unchanged: the table still accepts every X credential shape it accepted before (the X
--    credential invariants live in the X functions), and those functions still refuse an X account
--    without its refresh reference.
select pg_temp.check(pg_temp.probe(format(
    $q$insert into public.social_accounts (id, brand_id, platform, vault_access_token_secret_id, vault_refresh_token_secret_id)
       values ('sa_probe', 'postona_meta_only', 'x', %s, %s)$q$, s[1], s[2])) = 'accepted',
  'X row with references ' || s[1] || '/' || s[2] || ' accepted as before')
from (values (array['gen_random_uuid()', 'gen_random_uuid()']), (array['gen_random_uuid()', 'null']),
             (array['null', 'gen_random_uuid()']), (array['null', 'null'])) v(s);
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

-- 7. Every X path ignores or refuses a Meta row; the workspace's X account works exactly as before.
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
-- A Meta row that shares the X account's secret reference blocks the X send (the existing
-- cross-account reference check covers every provider).
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
-- A workspace whose only account is Threads has no X account to send with.
insert into vault.secrets (secret) values ('fake_threads_only_ACCESS') returning id as only_secret \gset
insert into public.social_accounts
  (id, brand_id, platform, handle, platform_user_id, connection_status, verified_at, vault_access_token_secret_id)
values ('sa_meta_only_threads', 'postona_meta_only', 'threads', 'th_only', 'th_2', 'identity_verified', now(), :'only_secret');
select public.fixture_running_post('postona_meta_only') as p_meta \gset
select pg_temp.check(public.fixture_permission(:'p_meta', 'sa_meta_only_threads', 'postona_meta_only') = 'X_ACCOUNT_NOT_UNIQUE_FOR_BRAND',
  'pre-send check refuses a workspace that has only a Threads account');

-- 8. Account deletion never hands a Meta token to the X revoke step: a workspace with a connected
--    Threads account (no refresh reference) goes to operator review before any token is read out.
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

-- 9. The three new CHECKs, exact and validated.
select pg_temp.check(
  (select string_agg(c.conname || '=' || pg_get_constraintdef(c.oid) || ':' || c.convalidated, ' | ' order by c.conname)
   from pg_constraint c
   where c.conrelid = 'public.social_accounts'::regclass
     and c.conname in ('social_accounts_platform_supported', 'social_accounts_provider_credential_profile',
                       'social_accounts_meta_publish_disabled'))
  = 'social_accounts_meta_publish_disabled=CHECK (((platform = ''x''::text) OR (publish_enabled IS FALSE))):true'
    || ' | social_accounts_platform_supported=CHECK ((platform = ANY (ARRAY[''x''::text, ''threads''::text, ''instagram''::text]))):true'
    || ' | social_accounts_provider_credential_profile=CHECK (((platform = ''x''::text) OR (vault_refresh_token_secret_id IS NULL))):true',
  'the three new CHECKs, exact and validated');

select 'POSTONA_ACCOUNTS_BEHAVIOR_PASS';
