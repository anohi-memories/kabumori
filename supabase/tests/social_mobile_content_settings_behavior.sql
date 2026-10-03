-- Behaviour proof for the hardened social_mobile_content_settings (disposable DB only).
-- Runs as the non-superuser table owner; user-facing checks switch to the real API roles.
-- Every assertion raises on failure; the last line prints the PASS marker.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create function t.ok(p_condition boolean, p_label text) returns void language plpgsql as $$
begin
  if p_condition is not true then raise exception 'FAIL %', p_label; end if;
end;
$$;
-- Runs one statement and requires it to fail with exactly p_state.
create function t.rejects(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate <> p_state then
      raise exception 'FAIL % (expected %, got %: %)', p_label, p_state, sqlstate, sqlerrm;
    end if;
    return;
  end;
  raise exception 'FAIL % (accepted)', p_label;
end;
$$;
-- Runs one statement and returns how many rows it changed.
create function t.affected(p_sql text) returns integer language plpgsql as $$
declare v_count integer;
begin
  execute p_sql;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
grant execute on function t.ok(boolean, text), t.rejects(text, text, text), t.affected(text) to anon, authenticated, service_role;

-- ===========================================================================================
-- A. Legitimate writers succeed (as owner A through RLS)
-- ===========================================================================================
begin;
set local role authenticated;
select t.as_user('00000000-0000-4000-8000-00000000000a');
-- The column defaults alone form a valid row (the first-run upsert path).
insert into public.social_mobile_content_settings (brand_id) values ('u_brand_a');
select t.ok((select settings = t.default_settings() and persona_profile = '{}'::jsonb
             from public.social_mobile_content_settings where brand_id = 'u_brand_a'), 'default row is the canonical default');

-- Settings screen payload (validateSocialMobileContentSettings output) through an upsert.
insert into public.social_mobile_content_settings (brand_id, settings)
values ('u_brand_a', jsonb_build_object(
  'locale', 'ja-JP', 'preferredTone', '落ち着いた、ていねい', 'themes', jsonb_build_array('個人開発', 'AI活用'),
  'objective', '学びを共有する', 'frequencyTargetPerWeek', 5, 'approvalMode', 'manual_review',
  'generationWindow', jsonb_build_object('timezone', 'Asia/Tokyo', 'startLocal', '09:00', 'endLocal', '24:00',
    'defaultGenerationLocal', '07:30', 'generationDayOffset', 0),
  'optionalNgWords', jsonb_build_array('絶対', '必ず儲かる'), 'notes', '読者は個人開発者'))
on conflict (brand_id) do update set settings = excluded.settings;

-- Upper and lower bounds that current writers can produce.
select t.ok(t.affected($q$update public.social_mobile_content_settings set settings = jsonb_build_object(
  'locale', 'ja-JP', 'preferredTone', repeat('あ', 120),
  'themes', (select jsonb_agg(repeat('テ', 100)) from generate_series(1, 8)),
  'objective', repeat('目', 160), 'frequencyTargetPerWeek', 14, 'approvalMode', 'auto_post_preference',
  'generationWindow', jsonb_build_object('timezone', 'Asia/Tokyo', 'startLocal', '00:00', 'endLocal', '23:59',
    'defaultGenerationLocal', '23:59', 'generationDayOffset', -1),
  'optionalNgWords', (select jsonb_agg(repeat('語', 60)) from generate_series(1, 20)),
  'notes', repeat('メ', 1000)) where brand_id = 'u_brand_a'$q$) = 1, 'upper bounds accepted');
select t.ok(t.affected($q$update public.social_mobile_content_settings
  set settings = jsonb_set(jsonb_set(t.default_settings(), '{frequencyTargetPerWeek}', '0'), '{themes}', '[]')
  where brand_id = 'u_brand_a'$q$) = 1, 'lower bounds accepted');
select t.ok(t.affected($q$update public.social_mobile_content_settings set settings = t.default_settings()
  where brand_id = 'u_brand_a'$q$) = 1, 'endLocal 24:00 accepted');

-- Persona payloads: empty, the PR #78 confirmed-conversation shape, and every key at its bound.
select t.ok(t.affected($q$update public.social_mobile_content_settings
  set persona_profile = '{"punctuationEmoji": "絵文字は少なめ", "toneSignals": ["淡々", "ていねい"]}',
      persona_provenance = 'conversation', persona_confirmed = true
  where brand_id = 'u_brand_a'$q$) = 1, 'PR78 persona accepted');
select t.ok(t.affected($q$update public.social_mobile_content_settings set persona_profile = jsonb_build_object(
  'toneSignals', (select jsonb_agg(repeat('t', 80)) from generate_series(1, 20)),
  'sentenceLength', 'mixed',
  'punctuationEmoji', repeat('!', 200),
  'recurringVocabulary', (select jsonb_agg(repeat('v', 50)) from generate_series(1, 30)),
  'topicSignals', (select jsonb_agg(repeat('s', 80)) from generate_series(1, 20)),
  'hashtagHabits', repeat('#', 200),
  'ctaStyle', repeat('c', 200),
  'openingClosingPatterns', (select jsonb_agg(repeat('o', 100)) from generate_series(1, 20))),
  persona_provenance = 'past_post_analysis', persona_last_analyzed_count = 1000, persona_last_analyzed_at = now()
  where brand_id = 'u_brand_a'$q$) = 1, 'full past-post-analysis persona accepted');
select t.ok(t.affected($q$update public.social_mobile_content_settings
  set persona_profile = '{}', persona_provenance = 'manual', persona_confirmed = false,
      persona_last_analyzed_count = null, persona_last_analyzed_at = null
  where brand_id = 'u_brand_a'$q$) = 1, 'empty persona accepted');
commit;

-- ===========================================================================================
-- B. The H2 adverse cases are rejected (as owner A; CHECK violation 23514)
-- ===========================================================================================
begin;
set local role authenticated;
select t.as_user('00000000-0000-4000-8000-00000000000a');
create temporary table bad_settings (label text, value jsonb) on commit drop;
insert into bad_settings values
  ('settings not object', '[]'),
  ('settings null', 'null'),
  ('missing locale', t.default_settings() - 'locale'),
  ('missing notes', t.default_settings() - 'notes'),
  ('missing generationWindow', t.default_settings() - 'generationWindow'),
  ('locale null', jsonb_set(t.default_settings(), '{locale}', 'null')),
  ('preferredTone null', jsonb_set(t.default_settings(), '{preferredTone}', 'null')),
  ('objective null', jsonb_set(t.default_settings(), '{objective}', 'null')),
  ('approvalMode null', jsonb_set(t.default_settings(), '{approvalMode}', 'null')),
  ('frequency null', jsonb_set(t.default_settings(), '{frequencyTargetPerWeek}', 'null')),
  ('notes null', jsonb_set(t.default_settings(), '{notes}', 'null')),
  ('themes null', jsonb_set(t.default_settings(), '{themes}', 'null')),
  ('locale en-US', jsonb_set(t.default_settings(), '{locale}', '"en-US"')),
  ('preferredTone number', jsonb_set(t.default_settings(), '{preferredTone}', '5')),
  ('preferredTone bool', jsonb_set(t.default_settings(), '{preferredTone}', 'true')),
  ('preferredTone blank', jsonb_set(t.default_settings(), '{preferredTone}', '"  　 "')),
  ('preferredTone too long', jsonb_set(t.default_settings(), '{preferredTone}', to_jsonb(repeat('あ', 121)))),
  ('objective bool', jsonb_set(t.default_settings(), '{objective}', 'false')),
  ('objective too long', jsonb_set(t.default_settings(), '{objective}', to_jsonb(repeat('目', 161)))),
  ('frequency string', jsonb_set(t.default_settings(), '{frequencyTargetPerWeek}', '"3"')),
  ('frequency fraction', jsonb_set(t.default_settings(), '{frequencyTargetPerWeek}', '2.5')),
  ('frequency negative', jsonb_set(t.default_settings(), '{frequencyTargetPerWeek}', '-1')),
  ('frequency 15', jsonb_set(t.default_settings(), '{frequencyTargetPerWeek}', '15')),
  ('frequency bool', jsonb_set(t.default_settings(), '{frequencyTargetPerWeek}', 'true')),
  ('approvalMode other', jsonb_set(t.default_settings(), '{approvalMode}', '"auto_post"')),
  ('themes not array', jsonb_set(t.default_settings(), '{themes}', '"AI"')),
  ('themes number item', jsonb_set(t.default_settings(), '{themes}', '["ok", 5]')),
  ('themes null item', jsonb_set(t.default_settings(), '{themes}', '["ok", null]')),
  ('themes object item', jsonb_set(t.default_settings(), '{themes}', '["ok", {"token": "x"}]')),
  ('themes blank item', jsonb_set(t.default_settings(), '{themes}', '["ok", " "]')),
  ('themes overlong item', jsonb_set(t.default_settings(), '{themes}', jsonb_build_array(repeat('テ', 101)))),
  ('themes too many', jsonb_set(t.default_settings(), '{themes}', (select jsonb_agg('x'::text) from generate_series(1, 9)))),
  ('ngWords number item', jsonb_set(t.default_settings(), '{optionalNgWords}', '[1]')),
  ('ngWords overlong item', jsonb_set(t.default_settings(), '{optionalNgWords}', jsonb_build_array(repeat('語', 61)))),
  ('ngWords too many', jsonb_set(t.default_settings(), '{optionalNgWords}', (select jsonb_agg('x'::text) from generate_series(1, 21)))),
  ('notes number', jsonb_set(t.default_settings(), '{notes}', '7')),
  ('notes too long', jsonb_set(t.default_settings(), '{notes}', to_jsonb(repeat('メ', 1001)))),
  ('window not object', jsonb_set(t.default_settings(), '{generationWindow}', '"09:00-24:00"')),
  ('window empty', jsonb_set(t.default_settings(), '{generationWindow}', '{}')),
  ('window missing startLocal', jsonb_set(t.default_settings(), '{generationWindow}', (t.default_settings() -> 'generationWindow') - 'startLocal')),
  ('window startLocal null', jsonb_set(t.default_settings(), '{generationWindow,startLocal}', 'null')),
  ('window startLocal 24:00', jsonb_set(t.default_settings(), '{generationWindow,startLocal}', '"24:00"')),
  ('window default 24:00', jsonb_set(t.default_settings(), '{generationWindow,defaultGenerationLocal}', '"24:00"')),
  ('window endLocal 24:01', jsonb_set(t.default_settings(), '{generationWindow,endLocal}', '"24:01"')),
  ('window endLocal prefix', jsonb_set(t.default_settings(), '{generationWindow,endLocal}', '"x24:00"')),
  ('window endLocal suffix', jsonb_set(t.default_settings(), '{generationWindow,endLocal}', '"24:00x"')),
  ('window endLocal number', jsonb_set(t.default_settings(), '{generationWindow,endLocal}', '2400')),
  ('window timezone fake', jsonb_set(t.default_settings(), '{generationWindow,timezone}', '"Fake/Zone"')),
  ('window dayOffset string', jsonb_set(t.default_settings(), '{generationWindow,generationDayOffset}', '"-1"')),
  ('window dayOffset 1', jsonb_set(t.default_settings(), '{generationWindow,generationDayOffset}', '1')),
  ('window dayOffset fraction', jsonb_set(t.default_settings(), '{generationWindow,generationDayOffset}', '-0.5')),
  ('window unknown key', jsonb_set(t.default_settings(), '{generationWindow,publish_enabled}', 'true')),
  ('unknown root key', t.default_settings() || '{"extra": 1}'),
  ('access_token key', t.default_settings() || '{"access_token": "fake"}'),
  ('secret key', t.default_settings() || '{"secret": "fake"}'),
  ('oauth key', t.default_settings() || '{"oauth": {"code": "fake"}}'),
  ('publish_mode key', t.default_settings() || '{"publish_mode": "live"}'),
  ('livePublishingEnabled key', t.default_settings() || '{"livePublishingEnabled": true}'),
  ('publishEnabled key', t.default_settings() || '{"publishEnabled": true}'),
  ('schedule key', t.default_settings() || '{"scheduled_posts": [{"text": "x"}]}'),
  ('account key', t.default_settings() || '{"social_account_id": "sa_1"}');
do $$
declare v record;
begin
  for v in select * from bad_settings loop
    perform t.rejects(format('update public.social_mobile_content_settings set settings = %L::jsonb where brand_id = %L', v.value, 'u_brand_a'), '23514', 'settings: ' || v.label);
  end loop;
end;
$$;
select t.rejects($q$insert into public.social_mobile_content_settings (brand_id, settings) values ('u_brand_c', '{}')$q$, '42501', 'insert for a brand A does not own');

create temporary table bad_personas (label text, value jsonb) on commit drop;
insert into bad_personas values
  ('persona not object', '[]'),
  ('persona null', 'null'),
  ('persona string', '"x"'),
  ('unknown key', '{"favouriteColour": "blue"}'),
  ('secret key', '{"secret": "fake"}'),
  ('access_token key', '{"access_token": "fake"}'),
  ('publishEnabled key', '{"publishEnabled": true}'),
  ('historical posts', '{"historical_posts": ["fake post body"]}'),
  ('posts key', '{"posts": ["fake"]}'),
  ('source in JSON', '{"source": "manual"}'),
  ('confirmed in JSON', '{"confirmed": true}'),
  ('analyzed metadata in JSON', '{"analyzedPostCount": 40}'),
  ('nested token', '{"toneSignals": [{"token": "x"}]}'),
  ('toneSignals string', '{"toneSignals": "淡々"}'),
  ('toneSignals null item', '{"toneSignals": [null]}'),
  ('toneSignals overlong', jsonb_build_object('toneSignals', jsonb_build_array(repeat('t', 81)))),
  ('toneSignals too many', jsonb_build_object('toneSignals', (select jsonb_agg('t'::text) from generate_series(1, 21)))),
  ('vocabulary too many', jsonb_build_object('recurringVocabulary', (select jsonb_agg('v'::text) from generate_series(1, 31)))),
  ('sentenceLength other', '{"sentenceLength": "huge"}'),
  ('sentenceLength null', '{"sentenceLength": null}'),
  ('punctuation number', '{"punctuationEmoji": 1}'),
  ('punctuation overlong', jsonb_build_object('punctuationEmoji', repeat('!', 201))),
  ('hashtag object', '{"hashtagHabits": {"publish": true}}'),
  ('cta null', '{"ctaStyle": null}');
do $$
declare v record;
begin
  for v in select * from bad_personas loop
    perform t.rejects(format('update public.social_mobile_content_settings set persona_profile = %L::jsonb where brand_id = %L', v.value, 'u_brand_a'), '23514', 'persona: ' || v.label);
  end loop;
end;
$$;
select t.rejects($q$update public.social_mobile_content_settings set persona_provenance = 'imported' where brand_id = 'u_brand_a'$q$, '23514', 'unknown provenance');
select t.rejects($q$update public.social_mobile_content_settings set persona_last_analyzed_count = 1001 where brand_id = 'u_brand_a'$q$, '23514', 'analyzed count bound');
select t.rejects($q$update public.social_mobile_content_settings set settings = null where brand_id = 'u_brand_a'$q$, '23502', 'settings NOT NULL');
commit;

-- ===========================================================================================
-- C. Version / compare-and-swap (single connection; the two-connection races are in the runner)
-- ===========================================================================================
-- Insert: the version is the server's, whatever the caller sends.
begin;
set local role authenticated;
select t.as_user('00000000-0000-4000-8000-00000000000b');
insert into public.social_mobile_content_settings (brand_id, created_at, updated_at)
values ('u_brand_b', '2000-01-01', '2999-01-01');
select t.ok((select updated_at > '2020-01-01' and updated_at < '2100-01-01' and created_at = updated_at
             from public.social_mobile_content_settings where brand_id = 'u_brand_b'), 'insert version is server-owned');
commit;

select updated_at as v0, created_at as c0 from public.social_mobile_content_settings where brand_id = 'u_brand_a' \gset
-- Distinct transactions advance.
update public.social_mobile_content_settings set settings = jsonb_set(settings, '{notes}', '"tx1"') where brand_id = 'u_brand_a';
select updated_at as v1 from public.social_mobile_content_settings where brand_id = 'u_brand_a' \gset
select t.ok(:'v1'::timestamptz > :'v0'::timestamptz, 'distinct transactions advance');
select t.ok((select created_at = :'c0'::timestamptz from public.social_mobile_content_settings where brand_id = 'u_brand_a'), 'created_at is kept on update');

-- Two updates in one transaction advance strictly; the first version is stale afterwards.
begin;
set local role authenticated;
select t.as_user('00000000-0000-4000-8000-00000000000a');
update public.social_mobile_content_settings set settings = jsonb_set(settings, '{notes}', '"same-tx-1"') where brand_id = 'u_brand_a';
select updated_at as s1 from public.social_mobile_content_settings where brand_id = 'u_brand_a' \gset
update public.social_mobile_content_settings set settings = jsonb_set(settings, '{notes}', '"same-tx-2"') where brand_id = 'u_brand_a';
select updated_at as s2 from public.social_mobile_content_settings where brand_id = 'u_brand_a' \gset
select t.ok(:'s2'::timestamptz > :'s1'::timestamptz, 'same transaction advances strictly');
select t.ok(t.affected(format($q$update public.social_mobile_content_settings set settings = settings
  where brand_id = 'u_brand_a' and updated_at = %L$q$, :'s1')) = 0, 'same-transaction stale CAS matches 0');
commit;

-- Stale CAS: 0 rows. Current CAS: 1 row. The caller cannot pick the version.
begin;
set local role authenticated;
select t.as_user('00000000-0000-4000-8000-00000000000a');
select t.ok(t.affected(format($q$update public.social_mobile_content_settings set settings = settings
  where brand_id = 'u_brand_a' and updated_at = %L$q$, :'v1')) = 0, 'stale CAS matches 0');
commit;
select updated_at as cur from public.social_mobile_content_settings where brand_id = 'u_brand_a' \gset
begin;
set local role authenticated;
select t.as_user('00000000-0000-4000-8000-00000000000a');
select t.ok(t.affected(format($q$update public.social_mobile_content_settings set updated_at = '2999-01-01', created_at = '2000-01-01'
  where brand_id = 'u_brand_a' and updated_at = %L$q$, :'cur')) = 1, 'current CAS matches 1');
select t.ok((select updated_at < '2100-01-01' and updated_at > :'cur'::timestamptz and created_at = :'c0'::timestamptz
             from public.social_mobile_content_settings where brand_id = 'u_brand_a'), 'caller-supplied future/past version ignored');
commit;
select updated_at as cur2 from public.social_mobile_content_settings where brand_id = 'u_brand_a' \gset
update public.social_mobile_content_settings set updated_at = '2000-01-01' where brand_id = 'u_brand_a';
select t.ok((select updated_at > :'cur2'::timestamptz from public.social_mobile_content_settings where brand_id = 'u_brand_a'), 'version cannot be moved back');
-- Even a far-future stored version (e.g. set by an operator) keeps advancing by at least 1 microsecond.
alter table public.social_mobile_content_settings disable trigger social_mobile_content_settings_version;
update public.social_mobile_content_settings set updated_at = '2999-01-01' where brand_id = 'u_brand_a';
alter table public.social_mobile_content_settings enable trigger social_mobile_content_settings_version;
update public.social_mobile_content_settings set settings = settings where brand_id = 'u_brand_a';
select t.ok((select updated_at = '2999-01-01'::timestamptz + interval '1 microsecond'
             from public.social_mobile_content_settings where brand_id = 'u_brand_a'), 'future version still advances by 1us');
update public.social_mobile_content_settings set settings = settings where brand_id = 'u_brand_a';
select t.ok((select updated_at = '2999-01-01'::timestamptz + interval '2 microseconds'
             from public.social_mobile_content_settings where brand_id = 'u_brand_a'), 'and again');
-- The serialised token round-trips exactly (what PostgREST returns and the app sends back).
select to_json(updated_at)::text as token from public.social_mobile_content_settings where brand_id = 'u_brand_a' \gset
select t.ok((select count(*) = 1 from public.social_mobile_content_settings
             where brand_id = 'u_brand_a' and updated_at = (:'token'::json #>> '{}')::timestamptz), 'version token round-trips');

-- ===========================================================================================
-- D. Privileges and RLS
-- ===========================================================================================
-- Effective table privileges: authenticated SELECT/INSERT/UPDATE only; nothing for anyone else.
do $$
declare
  v_role text;
  v_priv text;
  v_expected boolean;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
      v_expected := v_role = 'authenticated' and v_priv in ('SELECT', 'INSERT', 'UPDATE');
      perform t.ok(has_table_privilege(v_role, 'public.social_mobile_content_settings', v_priv) = v_expected,
        format('effective %s %s = %s', v_role, v_priv, v_expected));
    end loop;
  end loop;
  perform t.ok(not exists (
    select 1 from pg_class c, aclexplode(c.relacl) acl
    where c.oid = 'public.social_mobile_content_settings'::regclass and acl.grantee = 0), 'PUBLIC has nothing');
  perform t.ok(not exists (
    select 1 from pg_attribute a, aclexplode(a.attacl) acl
    where a.attrelid = 'public.social_mobile_content_settings'::regclass), 'no column privileges');
  perform t.ok(has_function_privilege('authenticated', 'public.social_mobile_content_settings_valid_settings(jsonb)', 'EXECUTE'), 'authenticated may run validators');
  perform t.ok(not has_function_privilege('anon', 'public.social_mobile_content_settings_valid_settings(jsonb)', 'EXECUTE'), 'anon may not');
  perform t.ok(not has_function_privilege('service_role', 'public.social_mobile_content_settings_valid_persona(jsonb)', 'EXECUTE'), 'service_role may not');
  perform t.ok(not has_function_privilege('authenticated', 'public.social_mobile_content_settings_version()', 'EXECUTE'), 'nobody calls the version function');
  perform t.ok((select relrowsecurity from pg_class where oid = 'public.social_mobile_content_settings'::regclass), 'RLS enabled');
end;
$$;

-- Attempts by the owner (as authenticated): no destruction, no trigger, no references.
create schema scratch;
grant usage, create on schema scratch to authenticated;
create function scratch.noop() returns trigger language plpgsql as $$ begin return new; end; $$;
grant execute on function scratch.noop() to authenticated;
begin;
set local role authenticated;
select t.as_user('00000000-0000-4000-8000-00000000000a');
select t.rejects($q$delete from public.social_mobile_content_settings where brand_id = 'u_brand_a'$q$, '42501', 'owner DELETE denied');
select t.rejects($q$truncate public.social_mobile_content_settings$q$, '42501', 'owner TRUNCATE denied');
select t.rejects($q$create trigger x before update on public.social_mobile_content_settings for each row execute function scratch.noop()$q$, '42501', 'owner CREATE TRIGGER denied');
select t.rejects($q$create table scratch.refs (brand_id text references public.social_mobile_content_settings (brand_id))$q$, '42501', 'owner REFERENCES denied');
select t.rejects($q$alter table public.social_mobile_content_settings disable row level security$q$, '42501', 'owner cannot alter the table');
select t.ok((select count(*) = 1 from public.social_mobile_content_settings), 'owner sees exactly its own row');
select t.ok(t.affected($q$update public.social_mobile_content_settings set settings = settings where brand_id = 'u_brand_b'$q$) = 0, 'owner A cannot update brand B');
select t.rejects($q$update public.social_mobile_content_settings set brand_id = 'u_brand_c' where brand_id = 'u_brand_a'$q$, '42501', 'owner A cannot move its row to brand C');
select t.rejects($q$insert into public.social_mobile_content_settings (brand_id) values ('u_brand_c')$q$, '42501', 'owner A cannot insert for brand C');
commit;

-- admin / member / viewer of brand A and a non-member: nothing visible, nothing writable.
do $$
declare v_user uuid;
begin
  foreach v_user in array array['00000000-0000-4000-8000-0000000000ad', '00000000-0000-4000-8000-0000000000e0',
                                 '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000ff']::uuid[] loop
    perform t.as_user(v_user);
    set local role authenticated;
    perform t.ok((select count(*) = 0 from public.social_mobile_content_settings), format('%s sees nothing', v_user));
    perform t.ok(t.affected($q$update public.social_mobile_content_settings set settings = settings$q$) = 0, format('%s updates nothing', v_user));
    perform t.rejects($q$insert into public.social_mobile_content_settings (brand_id) values ('u_brand_c')$q$, '42501', format('%s cannot insert', v_user));
    reset role;
  end loop;
end;
$$;

-- anon and service_role: no access at all.
begin;
set local role anon;
select t.rejects($q$select count(*) from public.social_mobile_content_settings$q$, '42501', 'anon SELECT denied');
select t.rejects($q$insert into public.social_mobile_content_settings (brand_id) values ('u_brand_c')$q$, '42501', 'anon INSERT denied');
commit;
begin;
set local role service_role;
select t.rejects($q$select count(*) from public.social_mobile_content_settings$q$, '42501', 'service_role SELECT denied');
select t.rejects($q$truncate public.social_mobile_content_settings$q$, '42501', 'service_role TRUNCATE denied');
commit;

-- The validators' EXECUTE grant is what lets a CHECK run for the writer: without it the write fails.
begin;
revoke execute on function public.social_mobile_content_settings_valid_settings(jsonb) from authenticated;
set local role authenticated;
select t.as_user('00000000-0000-4000-8000-00000000000a');
select t.rejects($q$update public.social_mobile_content_settings set settings = settings where brand_id = 'u_brand_a'$q$, '42501', 'validator EXECUTE is required by the CHECK');
rollback;

-- ===========================================================================================
-- E. Lifecycle: the row goes with its brand; nothing unrelated is touched
-- ===========================================================================================
-- A role with no privilege on this table can still delete a brand: the FK cascade runs as owner.
begin;
grant select, delete on public.brands to service_role;
set local role service_role;
delete from public.brands where id = 'u_brand_b';
reset role;
select t.ok((select count(*) = 0 from public.social_mobile_content_settings where brand_id = 'u_brand_b'), 'brand delete cascades the settings row');
select t.ok((select count(*) = 1 from public.social_mobile_content_settings where brand_id = 'u_brand_a'), 'other brand row kept');
rollback;
select t.ok((select count(*) = 2 from public.unrelated_rows), 'unrelated table untouched');
select t.ok((select count(*) = 2 from public.social_mobile_content_settings), 'rows intact after rollback');

select 'SOCIAL_MOBILE_CONTENT_SETTINGS_BEHAVIOR_PASS';
