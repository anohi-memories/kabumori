-- Fake-only proof for the narrow publish-time settings reader
-- (20261006160100_social_mobile_publish_settings_reader.sql). Run by
-- x_account_refresh_pilot_run.sh after the publish-authority behavior (the PR81
-- settings store holds rows for u_pilot and u_other by then). Never production.
\set ON_ERROR_STOP on
set timezone = 'Asia/Tokyo';

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
end;
$$;
create function pg_temp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'CHECK_FAILED: %', p_what; end if; end; $$;
create function pg_temp.run_post(p_brand text, p_status text default 'running', p_type text default 'brand_post') returns uuid
language sql as $$
  insert into public.scheduled_posts (brand_id, post_type, status, attempt_count, started_at)
  values (p_brand, p_type, p_status, 1, now()) returning id $$;
create function pg_temp.rd(p_post uuid, p_brand text) returns text language sql as $$
  select format('select * from public.read_social_mobile_publish_settings(%L, %L)', p_post, p_brand) $$;
grant execute on function pg_temp.expect_error(text, text), pg_temp.check(boolean, text), pg_temp.run_post(text, text, text),
  pg_temp.rd(uuid, text) to service_role, authenticated, anon;

-- 0. Catalog: one definer function, pinned path, owned by the settings table owner, service_role only;
--    the table itself grants service_role nothing.
do $$
declare v_fn oid := 'public.read_social_mobile_publish_settings(uuid,text)'::regprocedure;
        r record;
begin
  perform pg_temp.check((select count(*) from pg_proc where proname = 'read_social_mobile_publish_settings') = 1, 'no overload');
  select p.prosecdef, p.proconfig, p.provolatile, p.proowner, p.proacl into r from pg_proc p where p.oid = v_fn;
  perform pg_temp.check(r.prosecdef and r.proconfig = array['search_path=""'] and r.provolatile = 's', 'definer / search_path / stable');
  perform pg_temp.check(r.proowner = (select relowner from pg_class where oid = 'public.social_mobile_content_settings'::regclass), 'owner = table owner');
  perform pg_temp.check(not exists (select 1 from aclexplode(r.proacl) a where a.grantee = 0), 'no PUBLIC execute');
  perform pg_temp.check(has_function_privilege('service_role', v_fn, 'EXECUTE')
    and not has_function_privilege('anon', v_fn, 'EXECUTE')
    and not has_function_privilege('authenticated', v_fn, 'EXECUTE'), 'execute: service_role only');
  perform pg_temp.check(not has_table_privilege('service_role', 'public.social_mobile_content_settings',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'service_role has no table privilege');
  perform pg_temp.check(not exists (select 1 from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'social_mobile_content_settings' and grantee = 'service_role'), 'no column grant');
end $$;

-- Fixture: running posts for each case; persona on u_pilot is confirmed and distinctive.
update public.social_mobile_content_settings
set settings = jsonb_set(settings, '{preferredTone}', '"pilot tone"'),
    persona_profile = '{"toneSignals": ["淡々"], "hashtagHabits": "1つだけ"}', persona_provenance = 'conversation', persona_confirmed = true
where brand_id = 'u_pilot';
update public.social_mobile_content_settings set settings = jsonb_set(settings, '{preferredTone}', '"other tone"') where brand_id = 'u_other';
select set_config('rd.pilot', pg_temp.run_post('u_pilot')::text, false),
       set_config('rd.other', pg_temp.run_post('u_other')::text, false),
       set_config('rd.norefs', pg_temp.run_post('u_norefs')::text, false),
       set_config('rd.pending', pg_temp.run_post('u_pilot', 'pending')::text, false),
       set_config('rd.done', pg_temp.run_post('u_pilot', 'succeeded')::text, false),
       set_config('rd.tip', pg_temp.run_post('u_pilot', 'running', 'tip')::text, false),
       set_config('rd.ai', pg_temp.run_post('ai_salaryman_lab')::text, false),
       set_config('rd.kb', pg_temp.run_post('kabumori')::text, false),
       set_config('rd.internal', pg_temp.run_post('u_internal')::text, false);

set role service_role;
do $$
declare v record;
        n integer;
begin
  -- 1. The exact brand's own row: settings + persona columns only.
  select * into v from public.read_social_mobile_publish_settings(current_setting('rd.pilot')::uuid, 'u_pilot');
  perform pg_temp.check(v.settings ->> 'preferredTone' = 'pilot tone' and v.persona_confirmed and v.persona_provenance = 'conversation'
                        and v.persona_profile ->> 'hashtagHabits' = '1つだけ', 'own row');
  select count(*) into n from public.read_social_mobile_publish_settings(current_setting('rd.pilot')::uuid, 'u_pilot');
  perform pg_temp.check(n = 1, 'one row');
  -- 2. Another user's brand is answered only for its own running post and returns only its own row.
  select * into v from public.read_social_mobile_publish_settings(current_setting('rd.other')::uuid, 'u_other');
  perform pg_temp.check(v.settings ->> 'preferredTone' = 'other tone', 'other row is its own');
  -- A user brand with nothing saved: zero rows (= no consent), not an error.
  select count(*) into n from public.read_social_mobile_publish_settings(current_setting('rd.norefs')::uuid, 'u_norefs');
  perform pg_temp.check(n = 0, 'nothing saved -> zero rows');
  -- 3. A post of one brand can never read another brand's settings.
  perform pg_temp.expect_error(pg_temp.rd(current_setting('rd.pilot')::uuid, 'u_other'), 'SOCIAL_MOBILE_PUBLISH_SETTINGS_POST_NOT_RUNNING');
  perform pg_temp.expect_error(pg_temp.rd(current_setting('rd.other')::uuid, 'u_pilot'), 'SOCIAL_MOBILE_PUBLISH_SETTINGS_POST_NOT_RUNNING');
  -- 4. Only the post being published right now: pending / finished / other post type / unknown are refused.
  perform pg_temp.expect_error(pg_temp.rd(current_setting('rd.pending')::uuid, 'u_pilot'), 'SOCIAL_MOBILE_PUBLISH_SETTINGS_POST_NOT_RUNNING');
  perform pg_temp.expect_error(pg_temp.rd(current_setting('rd.done')::uuid, 'u_pilot'), 'SOCIAL_MOBILE_PUBLISH_SETTINGS_POST_NOT_RUNNING');
  perform pg_temp.expect_error(pg_temp.rd(current_setting('rd.tip')::uuid, 'u_pilot'), 'SOCIAL_MOBILE_PUBLISH_SETTINGS_POST_NOT_RUNNING');
  perform pg_temp.expect_error(pg_temp.rd(gen_random_uuid(), 'u_pilot'), 'SOCIAL_MOBILE_PUBLISH_SETTINGS_POST_NOT_RUNNING');
  -- 5. Internal profiles (AI Lab, Kabumori, any non-user profile) can never be read through here.
  perform pg_temp.expect_error(pg_temp.rd(current_setting('rd.ai')::uuid, 'ai_salaryman_lab'), 'SOCIAL_MOBILE_PUBLISH_SETTINGS_BRAND_NOT_ELIGIBLE');
  perform pg_temp.expect_error(pg_temp.rd(current_setting('rd.kb')::uuid, 'kabumori'), 'SOCIAL_MOBILE_PUBLISH_SETTINGS_BRAND_NOT_ELIGIBLE');
  perform pg_temp.expect_error(pg_temp.rd(current_setting('rd.internal')::uuid, 'u_internal'), 'SOCIAL_MOBILE_PUBLISH_SETTINGS_BRAND_NOT_ELIGIBLE');
  -- 6. Malformed requests.
  perform pg_temp.expect_error($q$select * from public.read_social_mobile_publish_settings(null, 'u_pilot')$q$, 'SOCIAL_MOBILE_PUBLISH_SETTINGS_REQUEST_INVALID');
  perform pg_temp.expect_error(pg_temp.rd(current_setting('rd.pilot')::uuid, null), 'SOCIAL_MOBILE_PUBLISH_SETTINGS_REQUEST_INVALID');
  perform pg_temp.expect_error(pg_temp.rd(current_setting('rd.pilot')::uuid, 'u_pilot''; --'), 'SOCIAL_MOBILE_PUBLISH_SETTINGS_REQUEST_INVALID');
  -- 7. The table itself stays closed to service_role, and the reader writes nothing.
  perform pg_temp.expect_error('select count(*) from public.social_mobile_content_settings', '42501');
  perform pg_temp.expect_error($q$update public.social_mobile_content_settings set persona_confirmed = false$q$, '42501');
end $$;
reset role;

-- 8. A brand moved off the user profile is refused from then on.
update public.brands set code_profile_key = 'internal_ops_v1' where id = 'u_other';
set role service_role;
do $$ begin
  perform pg_temp.expect_error(pg_temp.rd(current_setting('rd.other')::uuid, 'u_other'), 'SOCIAL_MOBILE_PUBLISH_SETTINGS_BRAND_NOT_ELIGIBLE');
end $$;
reset role;
update public.brands set code_profile_key = 'social_mobile_user_v1' where id = 'u_other';

-- 9. App users and anonymous callers cannot execute it at all.
set role authenticated;
do $$ begin
  perform pg_temp.expect_error(pg_temp.rd(current_setting('rd.pilot')::uuid, 'u_pilot'), '42501');
end $$;
reset role;
set role anon;
do $$ begin
  perform pg_temp.expect_error(pg_temp.rd(current_setting('rd.pilot')::uuid, 'u_pilot'), '42501');
end $$;
reset role;

select 'PUBLISH_SETTINGS_READER_BEHAVIOR_PASS' as result;
