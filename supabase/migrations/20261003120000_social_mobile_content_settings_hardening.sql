-- Hardening for public.social_mobile_content_settings (source candidate; NOT applied to production).
--
-- Applies on top of 20260922045046_social_mobile_content_settings_candidate.sql, which is kept
-- unchanged as history. Corrects the four findings of the 2026-10-03 schema review:
--   F1  JSON boundary: exact, null-safe, type-checked settings/persona contracts (allowlists).
--   F2  ACL: table privileges normalised to SELECT/INSERT/UPDATE for authenticated only.
--   F3  version: updated_at is server-owned and strictly increases on every UPDATE.
--   F4  drift: the existing relation is verified first; unknown drift aborts the migration.
--
-- Run inside one transaction (the migration tool's, or psql --single-transaction): every check
-- below happens before the first change, and the final assertions run after the last one.

-- ---------------------------------------------------------------------------------------------
-- 0. Drift guard. Only two states are accepted:
--    (a) the exact candidate shape, (b) the shape this migration produces (safe re-run).
--    Anything else (missing/retargeted FK, changed column, unknown constraint, index, trigger,
--    policy or grantee, partitioning/inheritance) raises and nothing is changed.
-- ---------------------------------------------------------------------------------------------
do $guard$
declare
  v_rel regclass := to_regclass('public.social_mobile_content_settings');
  v_brands regclass := to_regclass('public.brands');
  v_owner oid;
  v_columns text;
  v_fk record;
  v_unknown text;
begin
  if v_rel is null then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_DRIFT: table is absent (apply the candidate first)';
  end if;
  if v_brands is null then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_DRIFT: public.brands is absent';
  end if;

  select c.relowner into v_owner from pg_class c
  where c.oid = v_rel and c.relkind = 'r' and not c.relispartition
    and c.relnamespace = 'public'::regnamespace;
  if v_owner is null then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_DRIFT: not a plain public table';
  end if;
  if exists (select 1 from pg_inherits where inhrelid = v_rel or inhparent = v_rel) then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_DRIFT: inheritance is not expected';
  end if;

  -- Exact column set: name, type, nullability, no generated/identity columns.
  select string_agg(format('%s:%s:%s:%s:%s', a.attname, format_type(a.atttypid, a.atttypmod),
           a.attnotnull, a.attidentity, a.attgenerated), ',' order by a.attname collate "C")
    into v_columns
  from pg_attribute a
  where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped;
  if v_columns is distinct from
       'brand_id:text:t::,created_at:timestamp with time zone:t::,'
       'persona_confirmed:boolean:t::,persona_last_analyzed_at:timestamp with time zone:f::,'
       'persona_last_analyzed_count:integer:f::,persona_profile:jsonb:t::,'
       'persona_provenance:text:t::,settings:jsonb:t::,updated_at:timestamp with time zone:t::'
  then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_DRIFT: unexpected columns';
  end if;

  -- Primary key: exactly one, on brand_id.
  if (select count(*) from pg_constraint where conrelid = v_rel and contype = 'p') <> 1
     or not exists (
       select 1 from pg_constraint
       where conrelid = v_rel and contype = 'p'
         and conkey = array[(select attnum from pg_attribute where attrelid = v_rel and attname = 'brand_id')]::int2[]
     ) then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_DRIFT: primary key';
  end if;

  -- Foreign key: exactly one, brand_id -> public.brands(id), ON DELETE CASCADE, validated,
  -- not deferrable. Verified by definition, not by name.
  if (select count(*) from pg_constraint where conrelid = v_rel and contype = 'f') <> 1 then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_DRIFT: foreign keys';
  end if;
  select * into v_fk from pg_constraint where conrelid = v_rel and contype = 'f';
  if v_fk.confrelid <> v_brands
     or v_fk.conkey <> array[(select attnum from pg_attribute where attrelid = v_rel and attname = 'brand_id')]::int2[]
     or v_fk.confkey <> array[(select attnum from pg_attribute where attrelid = v_brands and attname = 'id')]::int2[]
     or v_fk.confdeltype <> 'c' or v_fk.confupdtype <> 'a'
     or not v_fk.convalidated or v_fk.condeferrable then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_DRIFT: brand foreign key';
  end if;

  -- Other constraints: only CHECKs with names this migration owns (they are all replaced below).
  select string_agg(conname, ',') into v_unknown
  from pg_constraint
  where conrelid = v_rel and contype not in ('p', 'f')
    and (contype <> 'c' or conname not in (
      'social_mobile_content_settings_shape',
      'social_mobile_content_settings_persona_shape',
      'social_mobile_content_settings_persona_provenance_check',
      -- The candidate's column CHECK; PostgreSQL truncates its generated name to 63 bytes.
      'social_mobile_content_setting_persona_last_analyzed_count_check',
      'social_mobile_content_settings_analyzed_count_check',
      'social_mobile_content_settings_settings_contract',
      'social_mobile_content_settings_persona_contract'));
  if v_unknown is not null then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_DRIFT: unknown constraints';
  end if;

  -- Indexes: only the primary key index.
  if exists (select 1 from pg_index where indrelid = v_rel and not indisprimary) then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_DRIFT: unexpected index';
  end if;

  -- Triggers: only the candidate's or this migration's, each calling its own function.
  if exists (
    select 1 from pg_trigger t
    where t.tgrelid = v_rel and not t.tgisinternal
      and not (
        (t.tgname = 'social_mobile_content_settings_touch_updated_at'
          and t.tgfoid = to_regprocedure('public.social_mobile_content_settings_touch_updated_at()'))
        or (t.tgname = 'social_mobile_content_settings_version'
          and t.tgfoid = to_regprocedure('public.social_mobile_content_settings_version()')))
  ) then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_DRIFT: unexpected trigger';
  end if;

  -- Policies: only the three owner policies (recreated below). An extra policy could widen access.
  if exists (
    select 1 from pg_policy
    where polrelid = v_rel and polname not in (
      'social_mobile_content_settings_owner_select',
      'social_mobile_content_settings_owner_insert',
      'social_mobile_content_settings_owner_update')
  ) then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_DRIFT: unexpected policy';
  end if;

  -- Grantees: only roles whose privileges are normalised below (or the owner).
  if exists (
    select 1
    from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
    where c.oid = v_rel
      and acl.grantee <> c.relowner
      and acl.grantee <> 0
      and acl.grantee not in (
        select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role'))
  ) then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_DRIFT: unexpected grantee';
  end if;
  if exists (
    select 1 from pg_attribute a, aclexplode(a.attacl) acl
    where a.attrelid = v_rel and a.attacl is not null
      and acl.grantee not in (
        select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role'))
  ) then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_DRIFT: unexpected column grantee';
  end if;
end;
$guard$;

-- ---------------------------------------------------------------------------------------------
-- 1. Contract validators (F1). Pure, deterministic, fixed search_path, no dynamic SQL. They return
--    TRUE or FALSE, never NULL, and inspect jsonb types before reading any value as text/number.
--    The DB is a structural boundary: it cannot tell whether free text "contains a secret".
-- ---------------------------------------------------------------------------------------------
create or replace function public.social_mobile_content_settings_text_ok(
  p_value jsonb, p_max_length integer, p_allow_blank boolean)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = pg_catalog
as $$
begin
  if p_value is null or jsonb_typeof(p_value) is distinct from 'string' then
    return false;
  end if;
  if char_length(p_value #>> '{}') > p_max_length then
    return false;
  end if;
  -- Blank = only (ASCII or full-width) whitespace; the app trims both.
  return p_allow_blank or (p_value #>> '{}') !~ '^[[:space:]　]*$';
end;
$$;

create or replace function public.social_mobile_content_settings_text_list_ok(
  p_value jsonb, p_max_items integer, p_max_length integer)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = pg_catalog
as $$
declare
  v_item jsonb;
begin
  if p_value is null or jsonb_typeof(p_value) is distinct from 'array'
     or jsonb_array_length(p_value) > p_max_items then
    return false;
  end if;
  for v_item in select e.value from jsonb_array_elements(p_value) e loop
    if not public.social_mobile_content_settings_text_ok(v_item, p_max_length, false) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- settings: exactly these nine keys, all required, each of its canonical JSON type.
create or replace function public.social_mobile_content_settings_valid_settings(p_settings jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = pg_catalog
as $$
declare
  v_window jsonb;
  v_number numeric;
  v_time constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
begin
  if p_settings is null or jsonb_typeof(p_settings) is distinct from 'object' then
    return false;
  end if;
  if not (p_settings ?& array['locale', 'preferredTone', 'themes', 'objective', 'frequencyTargetPerWeek',
                              'approvalMode', 'generationWindow', 'optionalNgWords', 'notes'])
     or (select count(*) from jsonb_object_keys(p_settings)) <> 9 then
    return false;
  end if;

  -- Only what the app and server can consume today.
  if p_settings -> 'locale' is distinct from '"ja-JP"'::jsonb then return false; end if;
  if not public.social_mobile_content_settings_text_ok(p_settings -> 'preferredTone', 120, false) then return false; end if;
  if not public.social_mobile_content_settings_text_list_ok(p_settings -> 'themes', 8, 100) then return false; end if;
  if not public.social_mobile_content_settings_text_ok(p_settings -> 'objective', 160, false) then return false; end if;
  if not public.social_mobile_content_settings_text_list_ok(p_settings -> 'optionalNgWords', 20, 60) then return false; end if;
  if not public.social_mobile_content_settings_text_ok(p_settings -> 'notes', 1000, true) then return false; end if;

  -- A JSON number that is an integer 0..14 (the string "3" is not accepted).
  if jsonb_typeof(p_settings -> 'frequencyTargetPerWeek') is distinct from 'number' then return false; end if;
  v_number := (p_settings ->> 'frequencyTargetPerWeek')::numeric;
  if v_number <> trunc(v_number) or v_number < 0 or v_number > 14 then return false; end if;

  if p_settings -> 'approvalMode' is distinct from '"manual_review"'::jsonb
     and p_settings -> 'approvalMode' is distinct from '"auto_post_preference"'::jsonb then
    return false;
  end if;

  v_window := p_settings -> 'generationWindow';
  if jsonb_typeof(v_window) is distinct from 'object'
     or not (v_window ?& array['timezone', 'startLocal', 'endLocal', 'defaultGenerationLocal', 'generationDayOffset'])
     or (select count(*) from jsonb_object_keys(v_window)) <> 5 then
    return false;
  end if;
  if v_window -> 'timezone' is distinct from '"Asia/Tokyo"'::jsonb then return false; end if;
  if jsonb_typeof(v_window -> 'startLocal') is distinct from 'string'
     or jsonb_typeof(v_window -> 'endLocal') is distinct from 'string'
     or jsonb_typeof(v_window -> 'defaultGenerationLocal') is distinct from 'string' then
    return false;
  end if;
  -- The window may end at 24:00; it may not start or generate at 24:00.
  if (v_window ->> 'startLocal') !~ v_time
     or ((v_window ->> 'endLocal') !~ v_time and (v_window ->> 'endLocal') <> '24:00')
     or (v_window ->> 'defaultGenerationLocal') !~ v_time then
    return false;
  end if;
  if jsonb_typeof(v_window -> 'generationDayOffset') is distinct from 'number' then return false; end if;
  v_number := (v_window ->> 'generationDayOffset')::numeric;
  if v_number not in (-1, 0) then return false; end if;
  return true;
end;
$$;

-- persona_profile: derived style signals only. Provenance, confirmation and analysis metadata live
-- in their dedicated columns, so they (and anything else) are not accepted as JSON keys here.
create or replace function public.social_mobile_content_settings_valid_persona(p_persona jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = pg_catalog
as $$
declare
  v_key text;
  v_ok boolean;
begin
  if p_persona is null or jsonb_typeof(p_persona) is distinct from 'object' then
    return false;
  end if;
  for v_key in select jsonb_object_keys(p_persona) loop
    v_ok := case v_key
      when 'toneSignals' then public.social_mobile_content_settings_text_list_ok(p_persona -> v_key, 20, 80)
      when 'recurringVocabulary' then public.social_mobile_content_settings_text_list_ok(p_persona -> v_key, 30, 50)
      when 'topicSignals' then public.social_mobile_content_settings_text_list_ok(p_persona -> v_key, 20, 80)
      when 'openingClosingPatterns' then public.social_mobile_content_settings_text_list_ok(p_persona -> v_key, 20, 100)
      when 'punctuationEmoji' then public.social_mobile_content_settings_text_ok(p_persona -> v_key, 200, true)
      when 'hashtagHabits' then public.social_mobile_content_settings_text_ok(p_persona -> v_key, 200, true)
      when 'ctaStyle' then public.social_mobile_content_settings_text_ok(p_persona -> v_key, 200, true)
      when 'sentenceLength' then p_persona -> v_key in ('"short"'::jsonb, '"mixed"'::jsonb, '"long"'::jsonb)
      else false
    end;
    if v_ok is not true then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Constraints (F1): every invariant must be TRUE (a NULL result is a rejection).
--    Existing rows that do not meet the contract make this migration fail; it never rewrites them.
-- ---------------------------------------------------------------------------------------------
do $rows$
begin
  if exists (
    select 1 from public.social_mobile_content_settings s
    where public.social_mobile_content_settings_valid_settings(s.settings) is not true
       or public.social_mobile_content_settings_valid_persona(s.persona_profile) is not true
  ) then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_EXISTING_ROWS_INVALID';
  end if;
end;
$rows$;

alter table public.social_mobile_content_settings
  drop constraint if exists social_mobile_content_settings_shape,
  drop constraint if exists social_mobile_content_settings_persona_shape,
  drop constraint if exists social_mobile_content_settings_persona_provenance_check,
  drop constraint if exists social_mobile_content_setting_persona_last_analyzed_count_check,
  drop constraint if exists social_mobile_content_settings_analyzed_count_check,
  drop constraint if exists social_mobile_content_settings_settings_contract,
  drop constraint if exists social_mobile_content_settings_persona_contract;

alter table public.social_mobile_content_settings
  add constraint social_mobile_content_settings_settings_contract
    check (public.social_mobile_content_settings_valid_settings(settings) is true),
  add constraint social_mobile_content_settings_persona_contract
    check (public.social_mobile_content_settings_valid_persona(persona_profile) is true),
  add constraint social_mobile_content_settings_persona_provenance_check
    check ((persona_provenance in ('conversation', 'past_post_analysis', 'manual')) is true),
  add constraint social_mobile_content_settings_analyzed_count_check
    check (persona_last_analyzed_count is null or (persona_last_analyzed_count between 0 and 1000) is true);

-- Defaults re-stated (an enumerated, deliberate repair): the canonical first-run row.
alter table public.social_mobile_content_settings
  alter column settings set default jsonb_build_object(
    'locale', 'ja-JP',
    'preferredTone', '自然で親しみやすく、押しつけない',
    'themes', jsonb_build_array('日々の生活や仕事に役立つ小さな工夫'),
    'objective', '読者にひとつの実用的な気づきを届ける',
    'frequencyTargetPerWeek', 3,
    'approvalMode', 'manual_review',
    'generationWindow', jsonb_build_object(
      'timezone', 'Asia/Tokyo',
      'startLocal', '09:00',
      'endLocal', '24:00',
      'defaultGenerationLocal', '17:00',
      'generationDayOffset', -1),
    'optionalNgWords', jsonb_build_array(),
    'notes', ''),
  alter column persona_profile set default '{}'::jsonb,
  alter column persona_provenance set default 'conversation',
  alter column persona_confirmed set default false,
  alter column created_at set default clock_timestamp(),
  alter column updated_at set default clock_timestamp();

-- ---------------------------------------------------------------------------------------------
-- 3. Server-owned, strictly increasing version (F3). The app compares updated_at as its CAS token.
--    INSERT: both timestamps come from the server clock (caller values are ignored).
--    UPDATE: created_at is kept; updated_at = max(wall clock, previous + 1 microsecond), so it
--    advances even twice in one transaction, cannot move back behind a later committed version,
--    and cannot be chosen by the caller. timestamptz has microsecond resolution and PostgREST
--    serialises it at full precision, so the token round-trips exactly.
-- ---------------------------------------------------------------------------------------------
create or replace function public.social_mobile_content_settings_version()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := clock_timestamp();
    new.updated_at := new.created_at;
  else
    new.created_at := old.created_at;
    new.updated_at := greatest(clock_timestamp(), old.updated_at + interval '1 microsecond');
  end if;
  return new;
end;
$$;

drop trigger if exists social_mobile_content_settings_touch_updated_at on public.social_mobile_content_settings;
drop trigger if exists social_mobile_content_settings_version on public.social_mobile_content_settings;
create trigger social_mobile_content_settings_version
  before insert or update on public.social_mobile_content_settings
  for each row execute function public.social_mobile_content_settings_version();
drop function if exists public.social_mobile_content_settings_touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- 4. RLS (unchanged meaning): owner of exactly this brand, bound to the verified auth.uid().
--    No DELETE policy: rows go away only with their brand (FK ON DELETE CASCADE).
-- ---------------------------------------------------------------------------------------------
alter table public.social_mobile_content_settings enable row level security;

drop policy if exists social_mobile_content_settings_owner_select on public.social_mobile_content_settings;
create policy social_mobile_content_settings_owner_select
  on public.social_mobile_content_settings
  for select to authenticated
  using (exists (
    select 1 from public.brand_memberships bm
    where bm.brand_id = social_mobile_content_settings.brand_id
      and bm.user_id = (select auth.uid())
      and bm.role = 'owner'
  ));

drop policy if exists social_mobile_content_settings_owner_insert on public.social_mobile_content_settings;
create policy social_mobile_content_settings_owner_insert
  on public.social_mobile_content_settings
  for insert to authenticated
  with check (exists (
    select 1 from public.brand_memberships bm
    where bm.brand_id = social_mobile_content_settings.brand_id
      and bm.user_id = (select auth.uid())
      and bm.role = 'owner'
  ));

drop policy if exists social_mobile_content_settings_owner_update on public.social_mobile_content_settings;
create policy social_mobile_content_settings_owner_update
  on public.social_mobile_content_settings
  for update to authenticated
  using (exists (
    select 1 from public.brand_memberships bm
    where bm.brand_id = social_mobile_content_settings.brand_id
      and bm.user_id = (select auth.uid())
      and bm.role = 'owner'
  ))
  with check (exists (
    select 1 from public.brand_memberships bm
    where bm.brand_id = social_mobile_content_settings.brand_id
      and bm.user_id = (select auth.uid())
      and bm.role = 'owner'
  ));

-- ---------------------------------------------------------------------------------------------
-- 5. Least privilege (F2). Only this table and these functions; default privileges untouched.
--    REVOKE ALL on a table also revokes the matching column privileges.
--    service_role gets nothing: no server path writes or reads this table with it today (the
--    Edge Functions read with the caller's JWT), and FK cascades run as the table owner.
-- ---------------------------------------------------------------------------------------------
revoke all on table public.social_mobile_content_settings from public, anon, authenticated, service_role;
grant select, insert, update on table public.social_mobile_content_settings to authenticated;

revoke all on function public.social_mobile_content_settings_text_ok(jsonb, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_content_settings_text_list_ok(jsonb, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_content_settings_valid_settings(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_content_settings_valid_persona(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_content_settings_version() from public, anon, authenticated, service_role;
-- CHECK expressions run with the writer's privileges, so the writer role needs EXECUTE on the
-- validators (pure functions over the value being written; nothing else is reachable).
grant execute on function public.social_mobile_content_settings_text_ok(jsonb, integer, boolean) to authenticated;
grant execute on function public.social_mobile_content_settings_text_list_ok(jsonb, integer, integer) to authenticated;
grant execute on function public.social_mobile_content_settings_valid_settings(jsonb) to authenticated;
grant execute on function public.social_mobile_content_settings_valid_persona(jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 6. Post-conditions: fail the migration if the result is not exactly what was intended.
-- ---------------------------------------------------------------------------------------------
do $post$
declare
  v_rel constant regclass := 'public.social_mobile_content_settings'::regclass;
  v_privileges text;
begin
  select string_agg(format('%s=%s', coalesce(r.rolname, 'PUBLIC'), acl.privilege_type), ','
           order by coalesce(r.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C")
    into v_privileges
  from pg_class c
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
  left join pg_roles r on r.oid = acl.grantee
  where c.oid = v_rel and acl.grantee <> c.relowner;
  if v_privileges is distinct from 'authenticated=INSERT,authenticated=SELECT,authenticated=UPDATE' then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_POSTCONDITION: table privileges %', v_privileges;
  end if;
  if exists (select 1 from pg_attribute a, aclexplode(a.attacl) acl where a.attrelid = v_rel) then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_POSTCONDITION: column privileges';
  end if;
  if not (select relrowsecurity from pg_class where oid = v_rel) then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_POSTCONDITION: row level security';
  end if;
  if (select count(*) from pg_policy where polrelid = v_rel) <> 3
     or exists (select 1 from pg_policy where polrelid = v_rel and (not polpermissive or polcmd not in ('r', 'a', 'w'))) then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_POSTCONDITION: policies';
  end if;
  if (select count(*) from pg_trigger where tgrelid = v_rel and not tgisinternal) <> 1 then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_POSTCONDITION: triggers';
  end if;
  if exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like 'social\_mobile\_content\_settings\_%'
      and (p.prosecdef or p.proconfig is distinct from array['search_path=pg_catalog'])
  ) then
    raise exception 'SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_POSTCONDITION: function settings';
  end if;
end;
$post$;
