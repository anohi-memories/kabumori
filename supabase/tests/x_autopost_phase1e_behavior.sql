-- Fake-only Phase1E behavior proof for read_x_publish_credential_for_claim_v2.
-- Run by x_autopost_phase1e_run.sh after: Phase1D fixture -> Phase1E fixture
-- -> Phase1B -> Phase1D -> Phase1E migrations. Every failure raises.
\set ON_ERROR_STOP on
set timezone = 'UTC';

create function pg_temp.expect_error(p_sql text, p_expected text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'EXPECTED_ERROR_NOT_RAISED: % :: %', p_expected, p_sql;
exception when others then
  if sqlerrm like 'EXPECTED_ERROR_NOT_RAISED%' then raise; end if;
  if sqlerrm <> p_expected and sqlstate <> p_expected then
    raise exception 'WRONG_ERROR expected % got % (%) :: %', p_expected, sqlerrm, sqlstate, p_sql;
  end if;
  if sqlerrm like '%fake_%' or sqlerrm like '%00000000-0000%' then
    raise exception 'SECRET_OR_REFERENCE_IN_ERROR: %', sqlerrm;
  end if;
end;
$$;
create function pg_temp.read(p_label text, p_account text, p_brand text, p_require boolean default true)
returns text language plpgsql as $$
declare v_row record;
begin
  select c.* into v_row from claims c where c.label = p_label;
  return (select r.access_token from public.read_x_publish_credential_for_claim_v2(
    v_row.attempt_id, v_row.claim_token, p_account, p_brand, p_require) r);
end;
$$;
create function pg_temp.read_sql(p_label text, p_account text, p_brand text, p_require boolean default true)
returns text language sql as $$
  select format('select pg_temp.read(%L, %L, %L, %L)', p_label, p_account, p_brand, p_require)
$$;

-- 0. Security / ACL.
do $$
declare v_fn regprocedure := 'public.read_x_publish_credential_for_claim_v2(uuid,uuid,text,text,boolean)'::regprocedure;
        v_config text[] := (select proconfig from pg_proc where oid = v_fn);
begin
  if not (select prosecdef from pg_proc where oid = v_fn)
     or not ('search_path=""' = any(v_config)) then
    raise exception 'credential reader security definer/search_path mismatch';
  end if;
  if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE')
     or not has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception 'credential reader ACL mismatch';
  end if;
  if has_table_privilege('service_role', 'vault.secrets', 'SELECT')
     or has_table_privilege('service_role', 'vault.decrypted_secrets', 'SELECT') then
    raise exception 'fixture vault is readable by service_role directly';
  end if;
end $$;

-- Activation step (Phase1D gate) so bound rows can exist.
revoke execute on function public.claim_due_post() from service_role;
set role service_role;

-- 1. Two X accounts in the same brand plus a second brand, all claimed.
select public.schedule_account_bound_post_v2('brand_a','acct_a',current_date,'tip',1::smallint,now()-interval '3 hours');
select public.schedule_account_bound_post_v2('brand_a','acct_a2',current_date,'tip',2::smallint,now()-interval '2 hours');
select public.schedule_account_bound_post_v2('brand_b','acct_b',current_date,'tip',3::smallint,now()-interval '1 hour');
create temporary table claims (label text primary key, attempt_id uuid, claim_token uuid,
  social_account_id text, brand_id text, scheduled_post_id uuid);
insert into claims select 'c' || row_number() over (), q.attempt_id, q.claim_token, q.social_account_id, q.brand_id, q.scheduled_post_id
from (select * from public.claim_due_post_v2() union all select * from public.claim_due_post_v2()
      union all select * from public.claim_due_post_v2()) q;
update claims set label = social_account_id;
do $$ begin
  if (select count(*) from claims) <> 3 then raise exception 'setup: expected three claims'; end if;
end $$;

-- 2. Exact account succeeds; the same-brand sibling and other brand are never returned.
do $$
declare r record;
begin
  if pg_temp.read('acct_a', 'acct_a', 'brand_a') <> 'fake_tok_acct_a' then raise exception 'acct_a token wrong'; end if;
  if pg_temp.read('acct_a2', 'acct_a2', 'brand_a') <> 'fake_tok_acct_a2' then raise exception 'acct_a2 token wrong'; end if;
  if pg_temp.read('acct_b', 'acct_b', 'brand_b') <> 'fake_tok_acct_b' then raise exception 'acct_b token wrong'; end if;
  select x.* into r from claims c, public.read_x_publish_credential_for_claim_v2(
    c.attempt_id, c.claim_token, 'acct_a2', 'brand_a', true) x where c.label = 'acct_a2';
  if r.social_account_id <> 'acct_a2' or r.brand_id <> 'brand_a' or r.platform_user_id <> 'x_a2' then
    raise exception 'returned identity is not the claimed account';
  end if;
end $$;

-- 3. The caller cannot redirect a claim to another account or brand.
do $$ begin
  perform pg_temp.expect_error(pg_temp.read_sql('acct_a2', 'acct_a', 'brand_a'), 'X_CLAIM_ACCOUNT_MISMATCH');
  perform pg_temp.expect_error(pg_temp.read_sql('acct_a2', 'acct_b', 'brand_b'), 'X_CLAIM_ACCOUNT_MISMATCH');
  perform pg_temp.expect_error(pg_temp.read_sql('acct_a2', 'acct_a2', 'brand_b'), 'X_CLAIM_ACCOUNT_MISMATCH');
  perform pg_temp.expect_error(pg_temp.read_sql('acct_a2', 'ai_salaryman_lab_x', 'ai_salaryman_lab'), 'X_CLAIM_ACCOUNT_MISMATCH');
  perform pg_temp.expect_error(format(
    'select * from public.read_x_publish_credential_for_claim_v2(%L, gen_random_uuid(), %L, %L, true)',
    (select attempt_id from claims where label = 'acct_a2'), 'acct_a2', 'brand_a'), 'X_CLAIM_NOT_PRE_X');
  perform pg_temp.expect_error($q$select * from public.read_x_publish_credential_for_claim_v2(
    gen_random_uuid(), gen_random_uuid(), 'acct_a2', 'brand_a', true)$q$, 'X_CLAIM_NOT_PRE_X');
  perform pg_temp.expect_error($q$select * from public.read_x_publish_credential_for_claim_v2(
    null, null, 'acct_a2', 'brand_a', true)$q$, 'X_CREDENTIAL_REQUEST_INVALID');
  perform pg_temp.expect_error(format(
    'select * from public.read_x_publish_credential_for_claim_v2(%L, %L, %L, %L, true)',
    (select attempt_id from claims where label = 'acct_a2'), (select claim_token from claims where label = 'acct_a2'),
    ' ', 'brand_a'), 'X_CREDENTIAL_REQUEST_INVALID');
end $$;

-- 4. Account state is rechecked at read time; no fallback on failure.
reset role;
update public.social_accounts set publish_enabled = false where id = 'acct_a2';
set role service_role;
do $$ begin
  perform pg_temp.expect_error(pg_temp.read_sql('acct_a2', 'acct_a2', 'brand_a'), 'X_ACCOUNT_PUBLISH_DISABLED');
  if pg_temp.read('acct_a2', 'acct_a2', 'brand_a', false) <> 'fake_tok_acct_a2' then
    raise exception 'explicit publish waiver did not return the exact account token';
  end if;
end $$;
reset role;
update public.social_accounts set publish_enabled = true, connection_status = 'pending' where id = 'acct_a2';
set role service_role;
do $$ begin perform pg_temp.expect_error(pg_temp.read_sql('acct_a2', 'acct_a2', 'brand_a'), 'X_ACCOUNT_NOT_VERIFIED'); end $$;
reset role;
update public.social_accounts set connection_status = 'identity_verified', platform_user_id = ' ' where id = 'acct_a2';
set role service_role;
do $$ begin perform pg_temp.expect_error(pg_temp.read_sql('acct_a2', 'acct_a2', 'brand_a'), 'X_ACCOUNT_NOT_VERIFIED'); end $$;
reset role;
update public.social_accounts set platform_user_id = 'x_a2', vault_access_token_secret_id = null where id = 'acct_a2';
set role service_role;
do $$ begin
  -- acct_a (same brand), the legacy store and the AI Lab token all exist; none is used.
  perform pg_temp.expect_error(pg_temp.read_sql('acct_a2', 'acct_a2', 'brand_a'), 'X_CREDENTIAL_NOT_CONFIGURED');
end $$;
reset role;
update public.social_accounts set vault_access_token_secret_id = '00000000-0000-4000-8000-0000000000ee' where id = 'acct_a2';
set role service_role;
do $$ begin perform pg_temp.expect_error(pg_temp.read_sql('acct_a2', 'acct_a2', 'brand_a'), 'X_CREDENTIAL_UNAVAILABLE'); end $$;
reset role;
update public.social_accounts set vault_access_token_secret_id = '00000000-0000-4000-8000-0000000000a2' where id = 'acct_a2';
set role service_role;

-- 5. Only pre-X claims can read: after provider start or settlement it fails closed.
select public.mark_post_provider_started_v2(attempt_id, claim_token) from claims where label = 'acct_a';
select public.settle_post_pre_x_v2(attempt_id, claim_token, true, 'FAKE_PRE_X') from claims where label = 'acct_b';
do $$ begin
  perform pg_temp.expect_error(pg_temp.read_sql('acct_a', 'acct_a', 'brand_a'), 'X_CLAIM_NOT_PRE_X');
  perform pg_temp.expect_error(pg_temp.read_sql('acct_b', 'acct_b', 'brand_b'), 'X_CLAIM_NOT_PRE_X');
  if pg_temp.read('acct_a2', 'acct_a2', 'brand_a') <> 'fake_tok_acct_a2' then raise exception 'acct_a2 lost'; end if;
end $$;

-- 6. The reader never writes and never returns a refresh token.
reset role;
do $$
declare v_now record;
begin
  -- Only the steps above (explicit owner updates, mark, settle) changed state;
  -- re-reading the credential leaves posts/attempts/accounts byte-identical.
  select (select md5(string_agg(t::text, ',' order by t.id)) from public.scheduled_posts t) as posts,
         (select md5(string_agg(t::text, ',' order by t.id)) from public.post_queue_attempts_v2 t) as attempts,
         (select md5(string_agg(t::text, ',' order by t.id)) from public.social_accounts t) as accounts
    into v_now;
  perform set_config('phase1e.posts', v_now.posts, false);
  perform set_config('phase1e.attempts', v_now.attempts, false);
  perform set_config('phase1e.accounts', v_now.accounts, false);
end $$;
set role service_role;
select pg_temp.read('acct_a2', 'acct_a2', 'brand_a');
select pg_temp.read('acct_a2', 'acct_a2', 'brand_a');
reset role;
do $$ begin
  if (select md5(string_agg(t::text, ',' order by t.id)) from public.scheduled_posts t) <> current_setting('phase1e.posts')
     or (select md5(string_agg(t::text, ',' order by t.id)) from public.post_queue_attempts_v2 t) <> current_setting('phase1e.attempts')
     or (select md5(string_agg(t::text, ',' order by t.id)) from public.social_accounts t) <> current_setting('phase1e.accounts') then
    raise exception 'credential reader changed state';
  end if;
  if exists (select 1 from pg_proc p where p.oid = 'public.read_x_publish_credential_for_claim_v2(uuid,uuid,text,text,boolean)'::regprocedure
             and (pg_get_functiondef(p.oid) like '%refresh_token_secret_id%' or pg_get_functiondef(p.oid) like '%oauth_token_store%'
                  or pg_get_functiondef(p.oid) like '%limit 1%' or pg_get_functiondef(p.oid) like '%ai_salaryman_lab%')) then
    raise exception 'credential reader references refresh tokens, the legacy store, limit 1 or a hardcoded account';
  end if;
end $$;

-- 7. API roles cannot call it.
set role authenticated;
do $$ begin
  perform pg_temp.expect_error($q$select * from public.read_x_publish_credential_for_claim_v2(
    gen_random_uuid(), gen_random_uuid(), 'acct_a2', 'brand_a', true)$q$, '42501');
end $$;
reset role;
set role anon;
do $$ begin
  perform pg_temp.expect_error($q$select * from public.read_x_publish_credential_for_claim_v2(
    gen_random_uuid(), gen_random_uuid(), 'acct_a2', 'brand_a', true)$q$, '42501');
end $$;
reset role;

-- 8. A Vault view failure with SQLSTATE P0001 must not leak its own message.
create function vault.raise_fake_error(p_secret text, p_ref uuid) returns text
language plpgsql as $$
begin
  raise exception 'fake_%_%', p_secret, p_ref using errcode = 'P0001';
end;
$$;
create or replace view vault.decrypted_secrets as
  select s.id, vault.raise_fake_error(s.secret, s.id) as decrypted_secret from vault.secrets s;
set role service_role;
do $$ begin
  perform pg_temp.expect_error(pg_temp.read_sql('acct_a2', 'acct_a2', 'brand_a'), 'X_CREDENTIAL_UNAVAILABLE');
end $$;
reset role;

select 'PHASE1E_BEHAVIOR_PASS' as result;
