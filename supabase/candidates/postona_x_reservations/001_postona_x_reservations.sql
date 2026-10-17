-- POSTONA X reservations — G3 SOURCE CANDIDATE ONLY (2026-10-11). NOT in supabase/migrations/.
-- Never apply to production without a separately reviewed rollout: G5 x_autopost / lifecycle guard,
-- G4 verified X account predicate (Issue #131), one Sol（高） integrated security review and user approval.
--
-- What this file creates (schema postona_x_resv, NOT exposed through PostgREST):
--   batches / reservations / audit tables, RLS on and NO policies, NO privilege for anon / authenticated /
--   service_role / PUBLIC: the endpoint stays disabled. Every row is bound to one owner (auth user), one brand
--   and one X social account. Owner actions (create / list / reschedule / reconfirm / cancel) and worker actions
--   (claim / pre-publish check / finish) are SECURITY DEFINER functions with search_path = '' and NO EXECUTE
--   grant to any API role.
--
-- Trust boundary (fail closed):
--   * the caller is auth.uid() (a verified JWT subject); a client brand / account / approvalMode is a selector,
--     never proof. Ownership = an 'owner' brand_memberships row for the account's brand, read live.
--   * g5_x_autopost_allowed(user) and g4_x_account_verified(user, account) are the G5- and G4-owned
--     predicates. Until their reviewed implementations replace them they return FALSE: every owner action and
--     every claim is denied. Nothing here infers success from a missing table or function.
--   * AI slots additionally need the owner's approvalMode = 'auto_post_preference', read server-side from the
--     brand's own social_mobile_content_settings row ("これで覚えて" is settings confirmation only).
--   * a manual post needs a per-post consent bound to content hash + scheduled time + account + owner +
--     revision; any change of time invalidates it until reconfirmed.
--
-- Concurrency: one transaction-scoped advisory lock per social account serialises every create / reschedule
-- for that account (gap and capacity checks see each other); claims use FOR UPDATE SKIP LOCKED.
-- Delivery state machine: planned -> claimed -> published | failed | uncertain; planned -> cancelled | expired.
-- A claimed row whose lease expires becomes 'uncertain' and is never re-claimed (no blind X retry): swept by
-- claim_due(), and fenced by finish() itself when the holder reports after its deadline.
-- Deleting a brand or a social account cascades its reservations (never blocks G5 deletion).
begin;

do $$
begin
  if to_regclass('public.brands') is null or to_regclass('public.social_accounts') is null
     or to_regclass('public.brand_memberships') is null or to_regprocedure('auth.uid()') is null then
    raise exception 'POSTONA_RESV_PRECONDITION_MISSING';
  end if;
  if to_regnamespace('postona_x_resv') is not null then
    raise exception 'POSTONA_RESV_ALREADY_APPLIED';
  end if;
  if to_regrole('anon') is null or to_regrole('authenticated') is null or to_regrole('service_role') is null then
    raise exception 'POSTONA_RESV_PRECONDITION_ROLES';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass)
          is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'POSTONA_RESV_PRECONDITION_OWNER';
  end if;
  if pg_catalog.pg_has_role('anon', current_user, 'usage') or pg_catalog.pg_has_role('authenticated', current_user, 'usage')
     or pg_catalog.pg_has_role('anon', 'service_role', 'usage') or pg_catalog.pg_has_role('authenticated', 'service_role', 'usage') then
    raise exception 'POSTONA_RESV_PRECONDITION_ROLE_GRAPH';
  end if;
end $$;

create schema postona_x_resv;
revoke all on schema postona_x_resv from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------
create table postona_x_resv.batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  brand_id text not null references public.brands (id) on delete cascade,
  social_account_id text not null references public.social_accounts (id) on delete cascade,
  client_batch_id uuid not null,
  revision integer not null check (revision between 1 and 1000),
  mode text not null check (mode in ('manual_exact', 'manual_random_batch', 'manual_interval', 'ai_flexible')),
  origin text not null check (origin in ('user_authored', 'ai_generated')),
  time_zone text not null check (time_zone = 'Asia/Tokyo'),
  band jsonb,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (user_id, social_account_id, client_batch_id, revision),
  check ((mode = 'ai_flexible') = (origin = 'ai_generated'))
);

create table postona_x_resv.reservations (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references postona_x_resv.batches (id) on delete cascade,
  user_id uuid not null,
  brand_id text not null references public.brands (id) on delete cascade,
  social_account_id text not null references public.social_accounts (id) on delete cascade,
  draft_id text not null check (draft_id ~ '^[A-Za-z0-9:_-]{1,80}$'),
  position integer not null check (position between 0 and 49),
  origin text not null check (origin in ('user_authored', 'ai_generated')),
  mode text not null,
  body text,
  content_sha256 text check (content_sha256 ~ '^[0-9a-f]{64}$'),
  scheduled_at timestamptz not null check (isfinite(scheduled_at)),
  fixed boolean not null,
  status text not null default 'planned'
    check (status in ('planned', 'claimed', 'published', 'failed', 'uncertain', 'cancelled', 'expired')),
  revision integer not null default 1 check (revision >= 1),
  consent_state text not null check (consent_state in ('confirmed', 'needs_reconfirm', 'ai_owner_opt_in')),
  consent_sha256 text,
  consent_scheduled_at timestamptz,
  consent_revision integer,
  consent_at timestamptz,
  expires_at timestamptz not null,
  lease_token uuid,
  lease_expires_at timestamptz,
  claimed_by text,
  provider_post_id text check (provider_post_id ~ '^[0-9]{1,30}$'),
  outcome_code text check (outcome_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, position),
  unique (batch_id, draft_id),
  -- Manual: plain text with its hash. AI: no text until a future reviewed generation step.
  check ((origin = 'user_authored') = (body is not null and content_sha256 is not null)),
  check (origin = 'user_authored' or consent_state = 'ai_owner_opt_in'),
  check (origin = 'ai_generated' or consent_state in ('confirmed', 'needs_reconfirm')),
  check (status <> 'claimed' or (lease_token is not null and lease_expires_at is not null)),
  check (status <> 'published' or provider_post_id is not null)
);
create index reservations_due on postona_x_resv.reservations (scheduled_at) where status = 'planned';
create index reservations_account on postona_x_resv.reservations (social_account_id, scheduled_at);

create table postona_x_resv.audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  batch_id uuid,
  reservation_id uuid,
  action text not null check (action ~ '^[a-z_]{1,40}$'),
  detail jsonb not null default '{}'::jsonb  -- codes, revisions and times only; never post text
);

alter table postona_x_resv.batches enable row level security;
alter table postona_x_resv.reservations enable row level security;
alter table postona_x_resv.audit enable row level security;
revoke all on all tables in schema postona_x_resv from public, anon, authenticated, service_role;
revoke all on all sequences in schema postona_x_resv from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------
-- G5- / G4-owned predicates: DENY until their reviewed implementations replace these bodies.
-- ---------------------------------------------------------------------------------------------------
create function postona_x_resv.g5_x_autopost_allowed(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  -- G5 contract: true only while the user's common account is active (not deleting / locked) AND the
  -- x_autopost service entitlement is 'active', evaluated in the caller's transaction with G5's T13 writer
  -- fence. Not implemented in G3: always false.
  select false
$$;

create function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  -- G4 contract (Issue #131): true only for an X account whose platform identity was proven by the reviewed
  -- OAuth flow for exactly this user and whose publish permission is on. Not implemented in G3: always false.
  select false
$$;

-- ---------------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------------
create function postona_x_resv.caller() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v uuid := auth.uid();
begin
  if v is null then raise exception 'POSTONA_RESV_AUTH_REQUIRED' using errcode = 'P0001'; end if;
  return v;
end $$;

-- X-style weighted length (wide characters and emoji 2, URL 23); same rule as the app planner.
create function postona_x_resv.x_weighted_length(p_text text) returns integer
language sql immutable set search_path = '' as $$
  with parts as (
    select pg_catalog.regexp_replace(p_text, 'https?://\S+', '', 'g') as rest,
           (select pg_catalog.count(*) from pg_catalog.regexp_matches(p_text, 'https?://\S+', 'g')) as urls
  )
  select (urls * 23
          + (select pg_catalog.count(*) from pg_catalog.regexp_split_to_table(rest, '') c)
          + (select pg_catalog.count(*) from pg_catalog.regexp_split_to_table(rest, '') c
             where c ~ '[ᄀ-ᇿ⺀-鿿가-힯豈-﫿︰-﹏＀-￯\U0001F000-\U0010FFFF]'))::integer
  from parts
$$;

create function postona_x_resv.sha256_hex(p_text text) returns text
language sql immutable set search_path = '' as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_text, 'UTF8')), 'hex')
$$;

/** Live access check for (user, account): returns the account's brand or raises a fixed code. */
create function postona_x_resv.assert_account_access(p_user_id uuid, p_social_account_id text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_brand text; v_platform text; v_profile text;
begin
  select sa.brand_id, sa.platform into v_brand, v_platform from public.social_accounts sa where sa.id = p_social_account_id;
  if v_brand is null or v_platform is distinct from 'x' then
    raise exception 'POSTONA_RESV_ACCOUNT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.brand_memberships bm
                 where bm.brand_id = v_brand and bm.user_id = p_user_id and bm.role = 'owner') then
    raise exception 'POSTONA_RESV_ACCOUNT_NOT_FOUND' using errcode = 'P0001';  -- same answer: no oracle
  end if;
  select b.code_profile_key into v_profile from public.brands b where b.id = v_brand;
  if v_profile is distinct from 'social_mobile_user_v1' then
    raise exception 'POSTONA_RESV_BRAND_NOT_ELIGIBLE' using errcode = 'P0001';
  end if;
  if postona_x_resv.g5_x_autopost_allowed(p_user_id) is not true then
    raise exception 'POSTONA_RESV_SERVICE_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if postona_x_resv.g4_x_account_verified(p_user_id, p_social_account_id) is not true then
    raise exception 'POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED' using errcode = 'P0001';
  end if;
  return v_brand;
end $$;

/** Is `p_at` (UTC) inside the JST band { date_from, date_to, window_start, window_end ('24:00' allowed) }? */
create function postona_x_resv.in_band(p_at timestamptz, p_band jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare v_local timestamp := p_at at time zone 'Asia/Tokyo';
        v_minute integer := extract(hour from v_local)::integer * 60 + extract(minute from v_local)::integer;
        v_start integer; v_end integer;
begin
  if p_band is null or jsonb_typeof(p_band) <> 'object' then return false; end if;
  v_start := split_part(p_band ->> 'window_start', ':', 1)::integer * 60 + split_part(p_band ->> 'window_start', ':', 2)::integer;
  v_end := split_part(p_band ->> 'window_end', ':', 1)::integer * 60 + split_part(p_band ->> 'window_end', ':', 2)::integer;
  return v_local::date between (p_band ->> 'date_from')::date and (p_band ->> 'date_to')::date
     and v_minute >= v_start and v_minute < v_end;
exception when others then
  return false;
end $$;

/**
 * manual_interval contract. p_band is the cadence the user confirmed in the planner, exactly:
 *   { time_zone: 'Asia/Tokyo', start_date: 'YYYY-MM-DD', start_time: 'HH:MM' (JST),
 *     every_unit: 'days' (1-30) | 'hours' (1-72), every_value, count: planned series length 1-50 }
 * and every item carries its series position `slot` (0 .. count-1). Slots must strictly increase in item order
 * and each scheduled_at must equal start + slot * every exactly (absolute hours: Asia/Tokyo has no DST). A
 * skipped slot is a post the user cancelled from the preview; no post is ever moved onto or off the cadence.
 * A flat list of times without this metadata, or any irregular / reordered / inconsistent instant, raises.
 */
create function postona_x_resv.assert_interval(p_band jsonb, p_items jsonb) returns void
language plpgsql stable set search_path = '' as $$
declare v_unit text; v_value integer; v_count integer; v_step_hours integer; v_first timestamptz;
        v_item jsonb; v_slot integer; v_prev integer := -1;
begin
  if p_band is null or jsonb_typeof(p_band) <> 'object'
     or (select array_agg(k order by k) from jsonb_object_keys(p_band) k)
        is distinct from array['count', 'every_unit', 'every_value', 'start_date', 'start_time', 'time_zone']
     or jsonb_typeof(p_band -> 'time_zone') <> 'string' or (p_band ->> 'time_zone') <> 'Asia/Tokyo'
     or jsonb_typeof(p_band -> 'start_date') <> 'string' or (p_band ->> 'start_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or jsonb_typeof(p_band -> 'start_time') <> 'string' or (p_band ->> 'start_time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or jsonb_typeof(p_band -> 'every_unit') <> 'string' or (p_band ->> 'every_unit') not in ('days', 'hours')
     or jsonb_typeof(p_band -> 'every_value') <> 'number' or (p_band ->> 'every_value') !~ '^[0-9]{1,3}$'
     or jsonb_typeof(p_band -> 'count') <> 'number' or (p_band ->> 'count') !~ '^[0-9]{1,3}$' then
    raise exception 'POSTONA_RESV_INTERVAL_INVALID' using errcode = 'P0001';
  end if;
  v_unit := p_band ->> 'every_unit';
  v_value := (p_band ->> 'every_value')::integer;
  v_count := (p_band ->> 'count')::integer;
  if not ((v_unit = 'days' and v_value between 1 and 30) or (v_unit = 'hours' and v_value between 1 and 72))
     or v_count not between 1 and 50 then
    raise exception 'POSTONA_RESV_INTERVAL_INVALID' using errcode = 'P0001';
  end if;
  v_step_hours := case v_unit when 'days' then v_value * 24 else v_value end;
  if (v_count - 1) * v_step_hours > 90 * 24 then  -- the planner's horizon: last post within 90 days of the first
    raise exception 'POSTONA_RESV_INTERVAL_INVALID' using errcode = 'P0001';
  end if;
  begin
    v_first := ((p_band ->> 'start_date')::date + (p_band ->> 'start_time')::time) at time zone 'Asia/Tokyo';
  exception when others then
    raise exception 'POSTONA_RESV_INTERVAL_INVALID' using errcode = 'P0001';  -- e.g. 2026-02-30
  end;
  if (p_band ->> 'start_date') <> pg_catalog.to_char((p_band ->> 'start_date')::date, 'YYYY-MM-DD') then
    raise exception 'POSTONA_RESV_INTERVAL_INVALID' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) > v_count then
    raise exception 'POSTONA_RESV_INTERVAL_MISMATCH' using errcode = 'P0001';
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item -> 'slot') is distinct from 'number' or (v_item ->> 'slot') !~ '^[0-9]{1,3}$' then
      raise exception 'POSTONA_RESV_INTERVAL_MISMATCH' using errcode = 'P0001';
    end if;
    v_slot := (v_item ->> 'slot')::integer;
    if v_slot <= v_prev or v_slot >= v_count
       or (v_item ->> 'scheduled_at')::timestamptz is distinct from v_first + pg_catalog.make_interval(hours => v_slot * v_step_hours) then
      raise exception 'POSTONA_RESV_INTERVAL_MISMATCH' using errcode = 'P0001';
    end if;
    v_prev := v_slot;
  end loop;
end $$;

/**
 * Gap / capacity check for one account against every active reservation (planned, claimed, published,
 * uncertain), excluding `p_exclude`. Raises a fixed code naming the problem; never moves anything.
 */
create function postona_x_resv.assert_slots_free(p_social_account_id text, p_times timestamptz[], p_exclude uuid[])
returns void language plpgsql stable security definer set search_path = '' as $$
declare v_all timestamptz[]; v_t timestamptz; v_prev timestamptz; v_day date; v_month date;
        min_gap constant interval := interval '60 minutes';
        max_per_day constant integer := 10;
        max_per_month constant integer := 300;
begin
  select coalesce(array_agg(r.scheduled_at), '{}') into v_all
  from postona_x_resv.reservations r
  where r.social_account_id = p_social_account_id
    and r.status in ('planned', 'claimed', 'published', 'uncertain')
    and not (r.id = any (coalesce(p_exclude, '{}')));
  v_all := v_all || p_times;
  v_prev := null;
  foreach v_t in array (select coalesce(array_agg(t order by t), '{}') from unnest(v_all) t) loop
    if v_prev is not null and v_t - v_prev < min_gap then
      raise exception 'POSTONA_RESV_SLOT_CONFLICT' using errcode = 'P0001';
    end if;
    v_prev := v_t;
  end loop;
  foreach v_t in array p_times loop
    v_day := (v_t at time zone 'Asia/Tokyo')::date;
    v_month := date_trunc('month', v_t at time zone 'Asia/Tokyo')::date;
    if (select count(*) from unnest(v_all) t where (t at time zone 'Asia/Tokyo')::date = v_day) > max_per_day then
      raise exception 'POSTONA_RESV_DAILY_CAPACITY' using errcode = 'P0001';
    end if;
    if (select count(*) from unnest(v_all) t where date_trunc('month', t at time zone 'Asia/Tokyo')::date = v_month) > max_per_month then
      raise exception 'POSTONA_RESV_MONTHLY_CAPACITY' using errcode = 'P0001';
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Owner actions
-- ---------------------------------------------------------------------------------------------------
create type postona_x_resv.reservation_view as (
  reservation_id uuid, batch_id uuid, draft_id text, position integer, origin text, mode text, body text,
  scheduled_at timestamptz, fixed boolean, status text, revision integer, consent_state text
);

/**
 * Atomic batch create. p_items: [{ draft_id, scheduled_at, body?, consent?: { confirmed: true, content_sha256 }, slot? }].
 * p_band: null (manual_exact), the JST date/time band (random, AI), or the cadence (manual_interval, see
 * assert_interval).
 * Idempotent per (owner, account, client_batch_id, revision): the same payload returns the stored rows; a
 * different payload under the same key fails. Either every item is stored or none is.
 */
create function postona_x_resv.create_batch(
  p_social_account_id text, p_client_batch_id uuid, p_revision integer, p_mode text, p_band jsonb, p_items jsonb
) returns setof postona_x_resv.reservation_view
language plpgsql volatile security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller();
        v_brand text;
        v_origin text := case when p_mode = 'ai_flexible' then 'ai_generated' else 'user_authored' end;
        v_hash text;
        v_batch postona_x_resv.batches%rowtype;
        v_item jsonb; v_idx integer := 0; v_at timestamptz; v_body text; v_sha text;
        v_times timestamptz[] := '{}';
        v_approval text;
begin
  if p_mode is null or p_mode not in ('manual_exact', 'manual_random_batch', 'manual_interval', 'ai_flexible')
     or p_client_batch_id is null or p_revision is null or p_revision < 1
     or p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception 'POSTONA_RESV_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  v_brand := postona_x_resv.assert_account_access(v_user, p_social_account_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('postona_x_resv:' || p_social_account_id, 0));

  v_hash := postona_x_resv.sha256_hex(pg_catalog.jsonb_build_object('mode', p_mode, 'band', p_band, 'items', p_items)::text);
  select * into v_batch from postona_x_resv.batches b
  where b.user_id = v_user and b.social_account_id = p_social_account_id
    and b.client_batch_id = p_client_batch_id and b.revision = p_revision;
  if found then
    if v_batch.payload_sha256 <> v_hash then
      raise exception 'POSTONA_RESV_IDEMPOTENCY_CONFLICT' using errcode = 'P0001';
    end if;
    return query select r.id, r.batch_id, r.draft_id, r.position, r.origin, r.mode, r.body, r.scheduled_at, r.fixed,
                        r.status, r.revision, r.consent_state
                 from postona_x_resv.reservations r where r.batch_id = v_batch.id order by r.position;
    return;
  end if;

  if p_mode <> 'manual_exact' and (p_band is null or jsonb_typeof(p_band) <> 'object') then
    raise exception 'POSTONA_RESV_BAND_REQUIRED' using errcode = 'P0001';
  end if;
  if v_origin = 'ai_generated' then
    -- The owner's own opt-in, read here; never the client's claim.
    select s.settings ->> 'approvalMode' into v_approval from public.social_mobile_content_settings s where s.brand_id = v_brand;
    if v_approval is distinct from 'auto_post_preference' then
      raise exception 'POSTONA_RESV_AI_NOT_OPTED_IN' using errcode = 'P0001';
    end if;
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object' or (v_item ->> 'draft_id') is null or (v_item ->> 'scheduled_at') is null then
      raise exception 'POSTONA_RESV_ITEM_INVALID' using errcode = 'P0001';
    end if;
    v_at := (v_item ->> 'scheduled_at')::timestamptz;
    if v_at < pg_catalog.now() + interval '5 minutes' or v_at > pg_catalog.now() + interval '90 days' then
      raise exception 'POSTONA_RESV_TIME_OUT_OF_RANGE' using errcode = 'P0001';
    end if;
    if p_mode in ('manual_random_batch', 'ai_flexible') and not postona_x_resv.in_band(v_at, p_band) then
      raise exception 'POSTONA_RESV_OUTSIDE_BAND' using errcode = 'P0001';
    end if;
    if v_origin = 'user_authored' then
      v_body := pg_catalog.btrim(v_item ->> 'body');
      if v_body is null or v_body = '' or postona_x_resv.x_weighted_length(v_body) > 280 then
        raise exception 'POSTONA_RESV_TEXT_INVALID' using errcode = 'P0001';
      end if;
      v_sha := postona_x_resv.sha256_hex(v_body);
      if (v_item -> 'consent' ->> 'confirmed') is distinct from 'true' or (v_item -> 'consent' ->> 'content_sha256') is distinct from v_sha then
        raise exception 'POSTONA_RESV_CONSENT_REQUIRED' using errcode = 'P0001';
      end if;
    elsif v_item ? 'body' and v_item ->> 'body' is not null then
      raise exception 'POSTONA_RESV_AI_TEXT_NOT_ALLOWED' using errcode = 'P0001';
    end if;
    v_times := v_times || v_at;
  end loop;
  if p_mode = 'manual_interval' then
    perform postona_x_resv.assert_interval(p_band, p_items);  -- the user's cadence, never only UI validation
  end if;
  perform postona_x_resv.assert_slots_free(p_social_account_id, v_times, '{}');

  insert into postona_x_resv.batches (user_id, brand_id, social_account_id, client_batch_id, revision, mode, origin, time_zone, band, payload_sha256)
  values (v_user, v_brand, p_social_account_id, p_client_batch_id, p_revision, p_mode, v_origin, 'Asia/Tokyo', p_band, v_hash)
  returning * into v_batch;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_at := (v_item ->> 'scheduled_at')::timestamptz;
    v_body := case when v_origin = 'user_authored' then pg_catalog.btrim(v_item ->> 'body') end;
    insert into postona_x_resv.reservations
      (batch_id, user_id, brand_id, social_account_id, draft_id, position, origin, mode, body, content_sha256, scheduled_at,
       fixed, consent_state, consent_sha256, consent_scheduled_at, consent_revision, consent_at, expires_at)
    values (v_batch.id, v_user, v_brand, p_social_account_id, v_item ->> 'draft_id', v_idx, v_origin, p_mode, v_body,
            case when v_body is not null then postona_x_resv.sha256_hex(v_body) end, v_at,
            p_mode in ('manual_exact', 'manual_interval'),
            case when v_origin = 'user_authored' then 'confirmed' else 'ai_owner_opt_in' end,
            case when v_body is not null then postona_x_resv.sha256_hex(v_body) end,
            case when v_origin = 'user_authored' then v_at end,
            case when v_origin = 'user_authored' then 1 end,
            case when v_origin = 'user_authored' then pg_catalog.now() end,
            v_at + interval '6 hours');
    v_idx := v_idx + 1;
  end loop;
  insert into postona_x_resv.audit (user_id, batch_id, action, detail)
  values (v_user, v_batch.id, 'create_batch', pg_catalog.jsonb_build_object('mode', p_mode, 'items', v_idx, 'revision', p_revision));
  return query select r.id, r.batch_id, r.draft_id, r.position, r.origin, r.mode, r.body, r.scheduled_at, r.fixed,
                      r.status, r.revision, r.consent_state
               from postona_x_resv.reservations r where r.batch_id = v_batch.id order by r.position;
end $$;

create function postona_x_resv.list_reservations(p_social_account_id text)
returns setof postona_x_resv.reservation_view
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller();
begin
  perform postona_x_resv.assert_account_access(v_user, p_social_account_id);
  return query select r.id, r.batch_id, r.draft_id, r.position, r.origin, r.mode, r.body, r.scheduled_at, r.fixed,
                      r.status, r.revision, r.consent_state
               from postona_x_resv.reservations r
               where r.social_account_id = p_social_account_id and r.user_id = v_user
               order by r.scheduled_at, r.id;
end $$;

/** Locks the owner's own row for an owner action and re-checks live access. */
create function postona_x_resv.lock_own(p_reservation_id uuid, p_expected_revision integer)
returns postona_x_resv.reservations
language plpgsql volatile security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller(); v_row postona_x_resv.reservations%rowtype;
begin
  select r.* into v_row from postona_x_resv.reservations r where r.id = p_reservation_id for update;
  if not found or v_row.user_id <> v_user then
    raise exception 'POSTONA_RESV_NOT_FOUND' using errcode = 'P0001';
  end if;
  perform postona_x_resv.assert_account_access(v_user, v_row.social_account_id);
  if v_row.revision <> p_expected_revision then
    raise exception 'POSTONA_RESV_STALE_REVISION' using errcode = 'P0001';
  end if;
  return v_row;
end $$;

/** Explicit owner reschedule. A manual post's consent is invalidated until reconfirmed. */
create function postona_x_resv.reschedule(p_reservation_id uuid, p_expected_revision integer, p_new_at timestamptz)
returns setof postona_x_resv.reservation_view
language plpgsql volatile security definer set search_path = '' as $$
declare v_row postona_x_resv.reservations%rowtype; v_band jsonb;
begin
  v_row := postona_x_resv.lock_own(p_reservation_id, p_expected_revision);
  if v_row.status <> 'planned' then raise exception 'POSTONA_RESV_NOT_PLANNED' using errcode = 'P0001'; end if;
  if p_new_at is null or p_new_at < pg_catalog.now() + interval '5 minutes' or p_new_at > pg_catalog.now() + interval '90 days' then
    raise exception 'POSTONA_RESV_TIME_OUT_OF_RANGE' using errcode = 'P0001';
  end if;
  select b.band into v_band from postona_x_resv.batches b where b.id = v_row.batch_id;
  if v_row.mode in ('manual_random_batch', 'ai_flexible') and not postona_x_resv.in_band(p_new_at, v_band) then
    raise exception 'POSTONA_RESV_OUTSIDE_BAND' using errcode = 'P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('postona_x_resv:' || v_row.social_account_id, 0));
  perform postona_x_resv.assert_slots_free(v_row.social_account_id, array[p_new_at], array[v_row.id]);
  update postona_x_resv.reservations r
  set scheduled_at = p_new_at, revision = r.revision + 1, expires_at = p_new_at + interval '6 hours',
      consent_state = case when r.origin = 'user_authored' then 'needs_reconfirm' else r.consent_state end,
      updated_at = pg_catalog.now()
  where r.id = v_row.id;
  insert into postona_x_resv.audit (user_id, reservation_id, action, detail)
  values (v_row.user_id, v_row.id, 'reschedule', pg_catalog.jsonb_build_object('from_revision', v_row.revision));
  return query select r.id, r.batch_id, r.draft_id, r.position, r.origin, r.mode, r.body, r.scheduled_at, r.fixed,
                      r.status, r.revision, r.consent_state from postona_x_resv.reservations r where r.id = v_row.id;
end $$;

/** Explicit owner reconfirmation of a manual post at its CURRENT text and time. */
create function postona_x_resv.reconfirm(p_reservation_id uuid, p_expected_revision integer, p_content_sha256 text)
returns setof postona_x_resv.reservation_view
language plpgsql volatile security definer set search_path = '' as $$
declare v_row postona_x_resv.reservations%rowtype;
begin
  v_row := postona_x_resv.lock_own(p_reservation_id, p_expected_revision);
  if v_row.status <> 'planned' or v_row.origin <> 'user_authored' then
    raise exception 'POSTONA_RESV_NOT_PLANNED' using errcode = 'P0001';
  end if;
  if p_content_sha256 is distinct from v_row.content_sha256 then
    raise exception 'POSTONA_RESV_CONSENT_REQUIRED' using errcode = 'P0001';
  end if;
  update postona_x_resv.reservations r
  set consent_state = 'confirmed', consent_sha256 = r.content_sha256, consent_scheduled_at = r.scheduled_at,
      consent_revision = r.revision, consent_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where r.id = v_row.id;
  insert into postona_x_resv.audit (user_id, reservation_id, action, detail)
  values (v_row.user_id, v_row.id, 'reconfirm', pg_catalog.jsonb_build_object('revision', v_row.revision));
  return query select r.id, r.batch_id, r.draft_id, r.position, r.origin, r.mode, r.body, r.scheduled_at, r.fixed,
                      r.status, r.revision, r.consent_state from postona_x_resv.reservations r where r.id = v_row.id;
end $$;

/** Owner cancel: only a planned row; cancelled is terminal. A claimed row is too late (delivery in progress). */
create function postona_x_resv.cancel(p_reservation_id uuid, p_expected_revision integer)
returns setof postona_x_resv.reservation_view
language plpgsql volatile security definer set search_path = '' as $$
declare v_row postona_x_resv.reservations%rowtype;
begin
  v_row := postona_x_resv.lock_own(p_reservation_id, p_expected_revision);
  if v_row.status = 'claimed' then raise exception 'POSTONA_RESV_CANCEL_TOO_LATE' using errcode = 'P0001'; end if;
  if v_row.status <> 'planned' then raise exception 'POSTONA_RESV_ALREADY_FINAL' using errcode = 'P0001'; end if;
  update postona_x_resv.reservations r set status = 'cancelled', revision = r.revision + 1, updated_at = pg_catalog.now()
  where r.id = v_row.id;
  insert into postona_x_resv.audit (user_id, reservation_id, action, detail)
  values (v_row.user_id, v_row.id, 'cancel', pg_catalog.jsonb_build_object('from_revision', v_row.revision));
  return query select r.id, r.batch_id, r.draft_id, r.position, r.origin, r.mode, r.body, r.scheduled_at, r.fixed,
                      r.status, r.revision, r.consent_state from postona_x_resv.reservations r where r.id = v_row.id;
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Worker actions (future service worker; no EXECUTE for any role in this candidate)
-- ---------------------------------------------------------------------------------------------------

/** Is this planned/claimed row still publishable right now (consent intact, owner + G5 + G4 live)? */
create function postona_x_resv.row_publishable(p_row postona_x_resv.reservations) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_approval text;
begin
  if p_row.origin <> 'user_authored' then
    return false;  -- AI text generation is not available in V1: AI slots are never claimed
  end if;
  if p_row.consent_state <> 'confirmed' or p_row.consent_sha256 is distinct from p_row.content_sha256
     or p_row.consent_scheduled_at is distinct from p_row.scheduled_at or p_row.consent_revision is distinct from p_row.revision then
    return false;
  end if;
  if not exists (select 1 from public.brand_memberships bm
                 where bm.brand_id = p_row.brand_id and bm.user_id = p_row.user_id and bm.role = 'owner') then
    return false;
  end if;
  if not exists (select 1 from public.social_accounts sa where sa.id = p_row.social_account_id and sa.brand_id = p_row.brand_id and sa.platform = 'x') then
    return false;
  end if;
  return postona_x_resv.g5_x_autopost_allowed(p_row.user_id) is true
     and postona_x_resv.g4_x_account_verified(p_row.user_id, p_row.social_account_id) is true;
end $$;

/**
 * Sweeps, then claims up to p_limit due, publishable rows with an exclusive lease.
 *   planned past expires_at                 -> expired
 *   claimed with an expired lease           -> uncertain (never re-claimed: the X outcome is unknown)
 */
create function postona_x_resv.claim_due(p_worker text, p_lease_seconds integer, p_limit integer)
returns table (reservation_id uuid, lease_token uuid, social_account_id text, body text, scheduled_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare v_row postona_x_resv.reservations%rowtype; v_token uuid; v_count integer := 0;
begin
  if p_worker is null or p_worker !~ '^[a-z0-9_-]{1,40}$' or p_lease_seconds not between 30 and 900 or p_limit not between 1 and 50 then
    raise exception 'POSTONA_RESV_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  update postona_x_resv.reservations r set status = 'expired', updated_at = pg_catalog.now()
  where r.status = 'planned' and r.expires_at <= pg_catalog.now();
  update postona_x_resv.reservations r set status = 'uncertain', outcome_code = 'LEASE_EXPIRED', updated_at = pg_catalog.now()
  where r.status = 'claimed' and r.lease_expires_at <= pg_catalog.now();
  for v_row in
    select r.* from postona_x_resv.reservations r
    where r.status = 'planned' and r.scheduled_at <= pg_catalog.now() and r.expires_at > pg_catalog.now()
    order by r.scheduled_at, r.id
    for update skip locked
  loop
    exit when v_count >= p_limit;
    continue when not postona_x_resv.row_publishable(v_row);
    v_token := gen_random_uuid();
    update postona_x_resv.reservations r
    set status = 'claimed', lease_token = v_token, claimed_by = p_worker,
        lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds), updated_at = pg_catalog.now()
    where r.id = v_row.id;
    insert into postona_x_resv.audit (user_id, reservation_id, action, detail)
    values (v_row.user_id, v_row.id, 'claim', pg_catalog.jsonb_build_object('worker', p_worker));
    reservation_id := v_row.id; lease_token := v_token; social_account_id := v_row.social_account_id;
    body := v_row.body; scheduled_at := v_row.scheduled_at;
    v_count := v_count + 1;
    return next;
  end loop;
end $$;

/** Immediately before provider IO: the lease must still be ours and the row still publishable. */
create function postona_x_resv.pre_publish_check(p_reservation_id uuid, p_lease_token uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v_row postona_x_resv.reservations%rowtype;
begin
  select r.* into v_row from postona_x_resv.reservations r where r.id = p_reservation_id for update;
  if not found or v_row.status <> 'claimed' or v_row.lease_token is distinct from p_lease_token
     or v_row.lease_expires_at <= pg_catalog.clock_timestamp() then
    return 'LEASE_LOST';
  end if;
  if not postona_x_resv.row_publishable(v_row) then
    update postona_x_resv.reservations r set status = 'failed', outcome_code = 'NOT_PUBLISHABLE_AT_SEND', updated_at = pg_catalog.now()
    where r.id = v_row.id;
    return 'NOT_PUBLISHABLE';
  end if;
  return 'OK';
end $$;

/**
 * Lease holder reports the outcome:
 *   published (with the provider post id), failed_before_send (provably never sent), uncertain (unknown).
 * Returns the recorded outcome, or 'lease_lost' when the lease had already expired (row fenced to uncertain).
 * A repeated identical 'published' report is idempotent; anything else on a finished row is refused.
 */
create function postona_x_resv.finish(p_reservation_id uuid, p_lease_token uuid, p_outcome text, p_provider_post_id text, p_code text)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v_row postona_x_resv.reservations%rowtype;
begin
  if p_outcome not in ('published', 'failed_before_send', 'uncertain')
     or (p_outcome = 'published') <> (p_provider_post_id is not null)
     or (p_provider_post_id is not null and p_provider_post_id !~ '^[0-9]{1,30}$')
     or (p_code is not null and p_code !~ '^[A-Z][A-Z0-9_]{1,63}$') then
    raise exception 'POSTONA_RESV_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  select r.* into v_row from postona_x_resv.reservations r where r.id = p_reservation_id for update;
  if not found or v_row.lease_token is distinct from p_lease_token then
    raise exception 'POSTONA_RESV_LEASE_LOST' using errcode = 'P0001';
  end if;
  if v_row.status = 'published' and p_outcome = 'published' and v_row.provider_post_id = p_provider_post_id then
    return 'published';  -- idempotent replay
  end if;
  if v_row.status <> 'claimed' then
    -- Includes a lease swept to 'uncertain': a late success is recorded only by a reviewed reconciliation.
    raise exception 'POSTONA_RESV_LEASE_LOST' using errcode = 'P0001';
  end if;
  -- The lease deadline is enforced here, at the decision point, on the real clock (not the transaction start)
  -- and independently of any claim_due() sweep. An expired lease is fenced atomically under the row lock:
  -- the row becomes 'uncertain' (never re-claimed, never re-sent, never shown as success) and the late report
  -- is kept in the audit trail only, so a future reviewed reconciliation can verify it with X before any
  -- 'published'. Nothing is raised, so the fence commits; the caller gets 'lease_lost', not its outcome.
  if v_row.lease_expires_at <= pg_catalog.clock_timestamp() then
    update postona_x_resv.reservations r
    set status = 'uncertain', outcome_code = 'LEASE_EXPIRED_AT_FINISH', updated_at = pg_catalog.now()
    where r.id = v_row.id;
    insert into postona_x_resv.audit (user_id, reservation_id, action, detail)
    values (v_row.user_id, v_row.id, 'finish_after_lease', pg_catalog.jsonb_build_object(
      'reported_outcome', p_outcome, 'reported_provider_post_id', p_provider_post_id, 'reported_code', p_code));
    return 'lease_lost';
  end if;
  update postona_x_resv.reservations r
  set status = case p_outcome when 'published' then 'published' when 'failed_before_send' then 'failed' else 'uncertain' end,
      provider_post_id = p_provider_post_id, outcome_code = coalesce(p_code, upper(p_outcome)), updated_at = pg_catalog.now()
  where r.id = v_row.id;
  insert into postona_x_resv.audit (user_id, reservation_id, action, detail)
  values (v_row.user_id, v_row.id, 'finish', pg_catalog.jsonb_build_object('outcome', p_outcome));
  return p_outcome;
end $$;

-- ---------------------------------------------------------------------------------------------------
-- ACL: nothing is reachable from the API. Postconditions fail the whole file otherwise.
-- ---------------------------------------------------------------------------------------------------
revoke all on all functions in schema postona_x_resv from public, anon, authenticated, service_role;
revoke all on type postona_x_resv.reservation_view from public;

do $$
declare v_role text; v_bad text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if pg_catalog.has_schema_privilege(v_role, 'postona_x_resv', 'USAGE') then
      raise exception 'POSTONA_RESV_POSTCONDITION: % has schema usage', v_role;
    end if;
    select string_agg(c.relname, ',') into v_bad from pg_catalog.pg_class c
    where c.relnamespace = 'postona_x_resv'::regnamespace and c.relkind in ('r', 'S')
      and (pg_catalog.has_table_privilege(v_role, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
           or (c.relkind = 'S' and pg_catalog.has_sequence_privilege(v_role, c.oid, 'USAGE,SELECT,UPDATE')));
    if v_bad is not null then raise exception 'POSTONA_RESV_POSTCONDITION: % reaches %', v_role, v_bad; end if;
    select string_agg(p.proname, ',') into v_bad from pg_catalog.pg_proc p
    where p.pronamespace = 'postona_x_resv'::regnamespace and pg_catalog.has_function_privilege(v_role, p.oid, 'EXECUTE');
    if v_bad is not null then raise exception 'POSTONA_RESV_POSTCONDITION: % executes %', v_role, v_bad; end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_class c where c.relnamespace = 'postona_x_resv'::regnamespace and c.relkind = 'r' and not c.relrowsecurity)
     or exists (select 1 from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid where c.relnamespace = 'postona_x_resv'::regnamespace) then
    raise exception 'POSTONA_RESV_POSTCONDITION: RLS';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p where p.pronamespace = 'postona_x_resv'::regnamespace
             and p.prosecdef and p.proconfig is distinct from array['search_path=""']) then
    raise exception 'POSTONA_RESV_POSTCONDITION: definer search_path';
  end if;
end $$;

commit;
