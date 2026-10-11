-- Behaviour proof for the POSTONA X reservations candidate (fake data, local disposable PostgreSQL only).
-- Runs as the non-superuser owner; the caller identity is the JWT subject set by t.as_user().
-- Guards: the shipped G5/G4 predicates DENY. Sections marked MOCK_ONLY replace them with test doubles in this
-- disposable database only; they are NOT evidence that the real G5/G4 boundary is secure.
\set ON_ERROR_STOP on
set timezone = 'UTC';

create function pg_temp.expect_error(p_sql text, p_expected text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'EXPECTED_ERROR_NOT_RAISED: % :: %', p_expected, p_sql;
exception when others then
  if sqlerrm like 'EXPECTED_ERROR_NOT_RAISED%' then raise; end if;
  if sqlerrm <> p_expected and sqlstate <> p_expected then
    raise exception 'WRONG_ERROR expected % got % (%) :: %', p_expected, sqlerrm, sqlstate, p_sql;
  end if;
end $$;
create function pg_temp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'CHECK_FAILED: %', p_what; end if; end $$;
create function pg_temp.sha(p text) returns text language sql as $$ select encode(sha256(convert_to(btrim(p), 'UTF8')), 'hex') $$;
-- A manual item JSON with its own consent.
create function pg_temp.item(p_draft text, p_at timestamptz, p_body text) returns jsonb language sql as $$
  select jsonb_build_object('draft_id', p_draft, 'scheduled_at', p_at, 'body', p_body,
                            'consent', jsonb_build_object('confirmed', true, 'content_sha256', pg_temp.sha(p_body))) $$;
-- JST day d (relative to today) at hh:mm, as UTC.
create function pg_temp.jst(p_day integer, p_hhmm text) returns timestamptz language sql as $$
  select ((now() at time zone 'Asia/Tokyo')::date + p_day + p_hhmm::time) at time zone 'Asia/Tokyo' $$;
create function pg_temp.band(p_from integer, p_to integer, p_start text, p_end text) returns jsonb language sql as $$
  select jsonb_build_object('date_from', (now() at time zone 'Asia/Tokyo')::date + p_from, 'date_to', (now() at time zone 'Asia/Tokyo')::date + p_to,
                            'window_start', p_start, 'window_end', p_end) $$;
create function pg_temp.count_resv() returns bigint language sql as $$ select count(*) from postona_x_resv.reservations $$;
-- Interval cadence metadata as the planner's request carries it: start = JST date (today + p_day) and time.
create function pg_temp.iband(p_start_date date, p_time text, p_unit text, p_value integer, p_count integer) returns jsonb language sql as $$
  select jsonb_build_object('time_zone', 'Asia/Tokyo', 'start_date', to_char(p_start_date, 'YYYY-MM-DD'), 'start_time', p_time,
                            'every_unit', p_unit, 'every_value', p_value, 'count', p_count) $$;
-- The n slots of a cadence as manual items (slot k at start + k * step), optionally only the listed slots.
create function pg_temp.iitems(p_prefix text, p_start_date date, p_time text, p_step interval, p_slots integer[]) returns jsonb language sql as $$
  select jsonb_agg(pg_temp.item(p_prefix || s, ((p_start_date + p_time::time) at time zone 'Asia/Tokyo') + p_step * s, p_prefix || ' 本文' || s)
                   || jsonb_build_object('slot', s) order by o)
  from unnest(p_slots) with ordinality as u(s, o) $$;
create function pg_temp.jst_date(p_day integer) returns date language sql as $$ select (now() at time zone 'Asia/Tokyo')::date + p_day $$;

\set A '00000000-0000-4000-8000-00000000000a'
\set B '00000000-0000-4000-8000-00000000000b'
\set C '00000000-0000-4000-8000-00000000000c'

-- D0. Shipped predicates deny everything: no create, no list, no claim.
select t.as_user(:'A');
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_exact', null,
  jsonb_build_array(pg_temp.item('d0', pg_temp.jst(3, '10:00'), 'hello')))$q$, 'POSTONA_RESV_SERVICE_NOT_ACTIVE');
select pg_temp.expect_error($q$select * from postona_x_resv.list_reservations('x_a')$q$, 'POSTONA_RESV_SERVICE_NOT_ACTIVE');
select t.as_user(null);
select pg_temp.expect_error($q$select * from postona_x_resv.list_reservations('x_a')$q$, 'POSTONA_RESV_AUTH_REQUIRED');
select pg_temp.check(pg_temp.count_resv() = 0, 'nothing stored under DENY');
select 'D0_DENY_BY_DEFAULT_PASS' as result;

-- MOCK_ONLY: G5 = a fake entitlement table (x_autopost active and account not deleting); G4 = fake allow list.
create table t.mock_entitlement (user_id uuid primary key, status text not null);
create table t.mock_verified (user_id uuid, social_account_id text, primary key (user_id, social_account_id));
insert into t.mock_entitlement values (:'A', 'active'), (:'B', 'active'), (:'C', 'active');
insert into t.mock_verified values (:'A', 'x_a'), (:'A', 'x_a2'), (:'A', 'th_a'), (:'B', 'x_b'), (:'A', 'x_kabu');
create or replace function postona_x_resv.g5_x_autopost_allowed(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from t.mock_entitlement e where e.user_id = p_user_id and e.status = 'active') $$;
create or replace function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from t.mock_verified v where v.user_id = p_user_id and v.social_account_id = p_social_account_id) $$;

-- M1. 10 manual texts spread over days +3..+13, 09:00-21:00 JST (random-batch band), atomic, owner-bound.
select t.as_user(:'A');
select set_config('rt.batch', gen_random_uuid()::text, false);
create temp table m1 as
select * from postona_x_resv.create_batch('x_a', current_setting('rt.batch')::uuid, 1, 'manual_random_batch', pg_temp.band(3, 13, '09:00', '21:00'),
  (select jsonb_agg(pg_temp.item('m1_' || g, pg_temp.jst(3 + g, case when g % 2 = 0 then '09:30' else '20:15' end), '本文' || g) order by g)
   from generate_series(0, 9) g));
select pg_temp.check((select count(*) from m1) = 10, '10 stored');
select pg_temp.check((select bool_and(status = 'planned' and consent_state = 'confirmed' and not fixed) from m1), 'planned, consent, flexible');
select pg_temp.check((select array_agg(body order by position) from m1) = (select array_agg('本文' || g order by g) from generate_series(0, 9) g), 'text order kept');
select pg_temp.check((select bool_and(user_id = :'A' and brand_id = 'brand_a') from postona_x_resv.reservations), 'owner/brand bound server-side');
-- Idempotent replay (same key, same payload) returns the same rows; a changed payload under the same key fails.
select pg_temp.check((select array_agg(reservation_id order by position) from postona_x_resv.create_batch('x_a', current_setting('rt.batch')::uuid, 1, 'manual_random_batch', pg_temp.band(3, 13, '09:00', '21:00'),
  (select jsonb_agg(pg_temp.item('m1_' || g, pg_temp.jst(3 + g, case when g % 2 = 0 then '09:30' else '20:15' end), '本文' || g) order by g) from generate_series(0, 9) g)))
  = (select array_agg(reservation_id order by position) from m1), 'idempotent replay');
select pg_temp.expect_error(format($q$select * from postona_x_resv.create_batch('x_a', %L::uuid, 1, 'manual_random_batch', pg_temp.band(3, 13, '09:00', '21:00'),
  jsonb_build_array(pg_temp.item('m1_0', pg_temp.jst(3, '09:30'), '別の本文')))$q$, current_setting('rt.batch')), 'POSTONA_RESV_IDEMPOTENCY_CONFLICT');
select pg_temp.check(pg_temp.count_resv() = 10, 'no double booking');
select 'M1_BATCH_ATOMIC_IDEMPOTENT_PASS' as result;

-- M2. Multi-tenant: foreign account, Threads account of the same brand, another owned brand, member-not-owner.
select pg_temp.expect_error($q$select * from postona_x_resv.list_reservations('x_b')$q$, 'POSTONA_RESV_ACCOUNT_NOT_FOUND');
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_b', gen_random_uuid(), 1, 'manual_exact', null,
  jsonb_build_array(pg_temp.item('f', pg_temp.jst(4, '11:00'), 'x')))$q$, 'POSTONA_RESV_ACCOUNT_NOT_FOUND');
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('th_a', gen_random_uuid(), 1, 'manual_exact', null,
  jsonb_build_array(pg_temp.item('f', pg_temp.jst(4, '11:00'), 'x')))$q$, 'POSTONA_RESV_ACCOUNT_NOT_FOUND');
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_kabu', gen_random_uuid(), 1, 'manual_exact', null,
  jsonb_build_array(pg_temp.item('f', pg_temp.jst(4, '11:00'), 'x')))$q$, 'POSTONA_RESV_BRAND_NOT_ELIGIBLE');
select pg_temp.check((select count(*) from postona_x_resv.list_reservations('x_a2')) = 0, 'own other brand is separate');
select t.as_user(:'B');
select pg_temp.expect_error($q$select * from postona_x_resv.list_reservations('x_a')$q$, 'POSTONA_RESV_ACCOUNT_NOT_FOUND');
select pg_temp.expect_error(format($q$select * from postona_x_resv.cancel(%L, 1)$q$, (select reservation_id from m1 limit 1)), 'POSTONA_RESV_NOT_FOUND');
select t.as_user(:'C');
select pg_temp.expect_error($q$select * from postona_x_resv.list_reservations('x_a')$q$, 'POSTONA_RESV_ACCOUNT_NOT_FOUND');
select t.as_user(:'A');
select 'M2_TENANT_ISOLATION_PASS' as result;

-- M3. Validation never stores a partial batch.
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_exact', null,
  jsonb_build_array(pg_temp.item('ok', pg_temp.jst(20, '10:00'), 'ok'),
    jsonb_build_object('draft_id', 'bad', 'scheduled_at', pg_temp.jst(21, '10:00'), 'body', 'no consent')))$q$, 'POSTONA_RESV_CONSENT_REQUIRED');
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_exact', null,
  jsonb_build_array(jsonb_build_object('draft_id', 'h', 'scheduled_at', pg_temp.jst(21, '10:00'), 'body', '本文',
    'consent', jsonb_build_object('confirmed', true, 'content_sha256', pg_temp.sha('違う本文')))))$q$, 'POSTONA_RESV_CONSENT_REQUIRED');
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_exact', null,
  jsonb_build_array(pg_temp.item('long', pg_temp.jst(21, '10:00'), repeat('あ', 141))))$q$, 'POSTONA_RESV_TEXT_INVALID');
select pg_temp.check((select count(*) from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_exact', null,
  jsonb_build_array(pg_temp.item('ascii280', pg_temp.jst(22, '10:00'), repeat('a', 280))))) = 1, '280 ascii is within the X limit');
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_exact', null,
  jsonb_build_array(pg_temp.item('past', now() - interval '1 hour', 'x')))$q$, 'POSTONA_RESV_TIME_OUT_OF_RANGE');
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_random_batch', pg_temp.band(30, 31, '09:00', '21:00'),
  jsonb_build_array(pg_temp.item('out', pg_temp.jst(30, '22:30'), 'x')))$q$, 'POSTONA_RESV_OUTSIDE_BAND');
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_random_batch', null,
  jsonb_build_array(pg_temp.item('nob', pg_temp.jst(30, '10:00'), 'x')))$q$, 'POSTONA_RESV_BAND_REQUIRED');
-- Slot conflict with an existing reservation (30 minutes after m1_0), and inside one batch.
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_exact', null,
  jsonb_build_array(pg_temp.item('near', pg_temp.jst(3, '10:00'), 'x')))$q$, 'POSTONA_RESV_SLOT_CONFLICT');
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_exact', null,
  jsonb_build_array(pg_temp.item('p1', pg_temp.jst(40, '10:00'), 'x'), pg_temp.item('p2', pg_temp.jst(40, '10:30'), 'y')))$q$, 'POSTONA_RESV_SLOT_CONFLICT');
-- Daily capacity: 11 posts one hour apart on one JST day.
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_exact', null,
  (select jsonb_agg(pg_temp.item('cap' || g, pg_temp.jst(50, lpad((8 + g)::text, 2, '0') || ':00'), 'c' || g)) from generate_series(0, 10) g))$q$, 'POSTONA_RESV_DAILY_CAPACITY');
select pg_temp.check(pg_temp.count_resv() = 11, 'only m1 + the 280-char post are stored');
-- Another account of the same owner has its own gap/capacity (and the same instant is fine there).
select pg_temp.check((select count(*) from postona_x_resv.create_batch('x_a2', gen_random_uuid(), 1, 'manual_exact', null,
  jsonb_build_array(pg_temp.item('other', pg_temp.jst(3, '09:30'), 'other account')))) = 1, 'per-account slots');
select 'M3_VALIDATION_NO_PARTIAL_PASS' as result;

-- M4. AI slots: owner opt-in read server-side; no text accepted; never claimed in V1.
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'ai_flexible', pg_temp.band(60, 62, '18:00', '22:00'),
  jsonb_build_array(jsonb_build_object('draft_id', 'ai0', 'scheduled_at', pg_temp.jst(60, '19:00'))))$q$, 'POSTONA_RESV_AI_NOT_OPTED_IN');
insert into public.social_mobile_content_settings values ('brand_a', '{"approvalMode":"manual_review"}');
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'ai_flexible', pg_temp.band(60, 62, '18:00', '22:00'),
  jsonb_build_array(jsonb_build_object('draft_id', 'ai0', 'scheduled_at', pg_temp.jst(60, '19:00'))))$q$, 'POSTONA_RESV_AI_NOT_OPTED_IN');
update public.social_mobile_content_settings set settings = '{"approvalMode":"auto_post_preference"}' where brand_id = 'brand_a';
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'ai_flexible', pg_temp.band(60, 62, '18:00', '22:00'),
  jsonb_build_array(jsonb_build_object('draft_id', 'ai0', 'scheduled_at', pg_temp.jst(60, '19:00'), 'body', 'client text')))$q$, 'POSTONA_RESV_AI_TEXT_NOT_ALLOWED');
create temp table ai as select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'ai_flexible', pg_temp.band(60, 62, '18:00', '22:00'),
  jsonb_build_array(jsonb_build_object('draft_id', 'ai0', 'scheduled_at', pg_temp.jst(60, '19:00'))));
select pg_temp.check((select bool_and(origin = 'ai_generated' and body is null and consent_state = 'ai_owner_opt_in') from ai), 'AI slot stored without text');
select 'M4_AI_OPT_IN_SERVER_SIDE_PASS' as result;

-- M5. Reschedule (explicit) invalidates consent; reconfirm needs the current hash; cancel is terminal.
select set_config('rt.r', (select reservation_id::text from m1 where position = 9), false);
select pg_temp.expect_error(format($q$select * from postona_x_resv.reschedule(%L, 7, pg_temp.jst(13, '12:00'))$q$, current_setting('rt.r')), 'POSTONA_RESV_STALE_REVISION');
select pg_temp.check((select consent_state = 'needs_reconfirm' and revision = 2 from postona_x_resv.reschedule(current_setting('rt.r')::uuid, 1, pg_temp.jst(13, '12:00'))), 'reschedule invalidates consent');
select pg_temp.expect_error(format($q$select * from postona_x_resv.reconfirm(%L, 2, pg_temp.sha('別'))$q$, current_setting('rt.r')), 'POSTONA_RESV_CONSENT_REQUIRED');
select pg_temp.check((select consent_state = 'confirmed' from postona_x_resv.reconfirm(current_setting('rt.r')::uuid, 2, pg_temp.sha('本文9'))), 'reconfirmed');
select set_config('rt.c', (select reservation_id::text from m1 where position = 8), false);
select pg_temp.check((select status = 'cancelled' from postona_x_resv.cancel(current_setting('rt.c')::uuid, 1)), 'cancel');
select pg_temp.expect_error(format($q$select * from postona_x_resv.cancel(%L, 2)$q$, current_setting('rt.c')), 'POSTONA_RESV_ALREADY_FINAL');
select pg_temp.expect_error(format($q$select * from postona_x_resv.reschedule(%L, 2, pg_temp.jst(14, '12:00'))$q$, current_setting('rt.c')), 'POSTONA_RESV_NOT_PLANNED');
select 'M5_RESCHEDULE_CONSENT_CANCEL_PASS' as result;

-- M6. manual_interval: the server checks the user's cadence itself (metadata + every instant), atomically.
select set_config('rt.before_m6', pg_temp.count_resv()::text, false);
-- Exact daily (3 posts), every 3 days, every 2 hours: accepted, stored fixed with their exact instants.
create temp table m6 as
select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_interval', pg_temp.iband(pg_temp.jst_date(70), '08:00', 'days', 1, 3),
  pg_temp.iitems('d1_', pg_temp.jst_date(70), '08:00', interval '24 hours', array[0, 1, 2]));
insert into m6 select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_interval', pg_temp.iband(pg_temp.jst_date(74), '12:00', 'days', 3, 3),
  pg_temp.iitems('d3_', pg_temp.jst_date(74), '12:00', interval '72 hours', array[0, 1, 2]));
insert into m6 select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_interval', pg_temp.iband(pg_temp.jst_date(82), '09:00', 'hours', 2, 3),
  pg_temp.iitems('h2_', pg_temp.jst_date(82), '09:00', interval '2 hours', array[0, 1, 2]));
select pg_temp.check((select count(*) from m6) = 9 and (select bool_and(fixed and mode = 'manual_interval' and status = 'planned') from m6), 'interval rows stored fixed');
select pg_temp.check((select array_agg(to_char(scheduled_at at time zone 'Asia/Tokyo', 'HH24:MI') order by scheduled_at) from m6 where draft_id like 'h2_%')
  = array['09:00', '11:00', '13:00'], 'hour cadence in JST');
select pg_temp.check((select max(scheduled_at) - min(scheduled_at) from m6 where draft_id like 'd3_%') = interval '144 hours', 'N-day cadence');
-- Month and day boundary: 22:00 JST on the last day of next month, every 2 hours -> 22:00, 00:00, 02:00 next month.
select set_config('rt.eom', ((date_trunc('month', now() at time zone 'Asia/Tokyo') + interval '2 months')::date - 1)::text, false);
insert into m6 select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_interval', pg_temp.iband(current_setting('rt.eom')::date, '22:00', 'hours', 2, 3),
  pg_temp.iitems('eom_', current_setting('rt.eom')::date, '22:00', interval '2 hours', array[0, 1, 2]));
select pg_temp.check((select array_agg(to_char(scheduled_at at time zone 'Asia/Tokyo', 'MM-DD HH24:MI') order by scheduled_at) from m6 where draft_id like 'eom_%')
  = array[to_char(current_setting('rt.eom')::date, 'MM-DD') || ' 22:00', to_char(current_setting('rt.eom')::date + 1, 'MM-DD') || ' 00:00',
          to_char(current_setting('rt.eom')::date + 1, 'MM-DD') || ' 02:00'], 'month boundary cadence');
-- A slot the user cancelled from the preview is skipped; the remaining posts stay exactly on the cadence.
insert into m6 select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_interval', pg_temp.iband(pg_temp.jst_date(86), '07:00', 'days', 1, 3),
  pg_temp.iitems('skip_', pg_temp.jst_date(86), '07:00', interval '24 hours', array[0, 2]));
select pg_temp.check((select count(*) from m6 where draft_id like 'skip_%') = 2, 'cancelled middle slot skipped');
select set_config('rt.after_ok', pg_temp.count_resv()::text, false);
-- One irregular gap, every timestamp otherwise >= 60 minutes apart: hourly 09:00, 10:00, 11:00 then 12:30.
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_interval', pg_temp.iband(pg_temp.jst_date(64), '09:00', 'hours', 1, 4),
  pg_temp.iitems('irr_', pg_temp.jst_date(64), '09:00', interval '1 hour', array[0, 1, 2]) || jsonb_build_array(
    pg_temp.item('irr_3', ((pg_temp.jst_date(64) + time '12:30') at time zone 'Asia/Tokyo'), 'irr 本文3') || '{"slot": 3}'))$q$, 'POSTONA_RESV_INTERVAL_MISMATCH');
-- Wrong start (times 30 minutes after the stated start), and the start read as UTC instead of JST.
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_interval', pg_temp.iband(pg_temp.jst_date(65), '10:00', 'days', 1, 2),
  pg_temp.iitems('ws_', pg_temp.jst_date(65), '10:30', interval '24 hours', array[0, 1]))$q$, 'POSTONA_RESV_INTERVAL_MISMATCH');
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_interval', pg_temp.iband(pg_temp.jst_date(65), '10:00', 'days', 1, 2),
  (select jsonb_agg(pg_temp.item('utc_' || s, ((pg_temp.jst_date(65) + time '10:00') at time zone 'UTC') + interval '24 hours' * s, 'utc ' || s) || jsonb_build_object('slot', s) order by s)
   from generate_series(0, 1) s))$q$, 'POSTONA_RESV_INTERVAL_MISMATCH');
-- Reordered: slots out of order (times follow the slots), and slots in order with their times swapped.
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_interval', pg_temp.iband(pg_temp.jst_date(66), '10:00', 'days', 1, 3),
  pg_temp.iitems('ro_', pg_temp.jst_date(66), '10:00', interval '24 hours', array[0, 2, 1]))$q$, 'POSTONA_RESV_INTERVAL_MISMATCH');
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_interval', pg_temp.iband(pg_temp.jst_date(66), '10:00', 'days', 1, 2),
  jsonb_build_array(pg_temp.item('sw_0', (pg_temp.jst_date(67) + time '10:00') at time zone 'Asia/Tokyo', 'a') || '{"slot": 0}',
                    pg_temp.item('sw_1', (pg_temp.jst_date(66) + time '10:00') at time zone 'Asia/Tokyo', 'b') || '{"slot": 1}'))$q$, 'POSTONA_RESV_INTERVAL_MISMATCH');
-- Duplicate slot, slot beyond count, more items than count, item without slot.
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_interval', pg_temp.iband(pg_temp.jst_date(66), '10:00', 'days', 1, 3),
  pg_temp.iitems('dup_', pg_temp.jst_date(66), '10:00', interval '24 hours', array[0, 0]))$q$, 'POSTONA_RESV_INTERVAL_MISMATCH');
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_interval', pg_temp.iband(pg_temp.jst_date(66), '10:00', 'days', 1, 2),
  pg_temp.iitems('big_', pg_temp.jst_date(66), '10:00', interval '24 hours', array[0, 2]))$q$, 'POSTONA_RESV_INTERVAL_MISMATCH');
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_interval', pg_temp.iband(pg_temp.jst_date(66), '10:00', 'days', 1, 2),
  pg_temp.iitems('many_', pg_temp.jst_date(66), '10:00', interval '24 hours', array[0, 1, 2]))$q$, 'POSTONA_RESV_INTERVAL_MISMATCH');
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_interval', pg_temp.iband(pg_temp.jst_date(66), '10:00', 'days', 1, 1),
  jsonb_build_array(pg_temp.item('noslot', (pg_temp.jst_date(66) + time '10:00') at time zone 'Asia/Tokyo', 'x')))$q$, 'POSTONA_RESV_INTERVAL_MISMATCH');
-- A flat list of times with no cadence: no metadata, or a random-style band.
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_interval', null,
  pg_temp.iitems('flat_', pg_temp.jst_date(66), '10:00', interval '24 hours', array[0, 1]))$q$, 'POSTONA_RESV_BAND_REQUIRED');
select pg_temp.expect_error($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_interval', pg_temp.band(66, 68, '09:00', '21:00'),
  pg_temp.iitems('flat_', pg_temp.jst_date(66), '10:00', interval '24 hours', array[0, 1]))$q$, 'POSTONA_RESV_INTERVAL_INVALID');
-- Missing / invalid cadence fields: unit, value range, count range, horizon, zone, start time/date, extra key, types.
select pg_temp.expect_error(format($q$select * from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_interval', %L::jsonb,
  pg_temp.iitems('bad_', pg_temp.jst_date(66), '10:00', interval '24 hours', array[0]))$q$, b), 'POSTONA_RESV_INTERVAL_INVALID')
from (values
  (pg_temp.iband(pg_temp.jst_date(66), '10:00', 'days', 1, 1) - 'every_unit'),
  (pg_temp.iband(pg_temp.jst_date(66), '10:00', 'weeks', 1, 1)),
  (pg_temp.iband(pg_temp.jst_date(66), '10:00', 'days', 0, 1)),
  (pg_temp.iband(pg_temp.jst_date(66), '10:00', 'days', 31, 1)),
  (pg_temp.iband(pg_temp.jst_date(66), '10:00', 'hours', 73, 1)),
  (pg_temp.iband(pg_temp.jst_date(66), '10:00', 'days', 1, 0)),
  (pg_temp.iband(pg_temp.jst_date(66), '10:00', 'days', 1, 51)),
  (pg_temp.iband(pg_temp.jst_date(66), '10:00', 'days', 30, 5)),
  (pg_temp.iband(pg_temp.jst_date(66), '10:00', 'days', 1, 1) || '{"time_zone": "UTC"}'),
  (pg_temp.iband(pg_temp.jst_date(66), '24:00', 'days', 1, 1)),
  (pg_temp.iband(pg_temp.jst_date(66), '9:00', 'days', 1, 1)),
  (pg_temp.iband(pg_temp.jst_date(66), '10:00', 'days', 1, 1) || '{"start_date": "2026-02-30"}'),
  (pg_temp.iband(pg_temp.jst_date(66), '10:00', 'days', 1, 1) || '{"seed": 1}'),
  (pg_temp.iband(pg_temp.jst_date(66), '10:00', 'days', 1, 1) || '{"every_value": "1"}'),
  (pg_temp.iband(pg_temp.jst_date(66), '10:00', 'days', 1, 1) || '{"count": 1.5}')
) as v(b);
select pg_temp.check(pg_temp.count_resv() = current_setting('rt.after_ok')::bigint, 'every refused interval batch stored nothing');
select pg_temp.check(current_setting('rt.after_ok')::bigint = current_setting('rt.before_m6')::bigint + 14, 'only the 14 regular posts were stored');
-- Exact and random batches are unaffected by the interval contract (no slot / cadence needed).
select pg_temp.check((select count(*) from postona_x_resv.create_batch('x_a', gen_random_uuid(), 1, 'manual_exact', null,
  jsonb_build_array(pg_temp.item('ex_m6', pg_temp.jst(88, '15:00'), 'exact')))) = 1, 'manual_exact unaffected');
-- Clean up M6 rows so later sections see the same rows as before.
delete from postona_x_resv.batches where id in (select batch_id from m6) or id in (select batch_id from postona_x_resv.reservations where draft_id = 'ex_m6');
select pg_temp.check(pg_temp.count_resv() = current_setting('rt.before_m6')::bigint, 'M6 cleaned up');
select 'M6_INTERVAL_CADENCE_SERVER_CHECK_PASS' as result;

-- W1. Worker: claim only due, consented, publishable manual rows; one lease; finish; replay; lease expiry.
-- Make three rows due (test-only time travel keeps consent bound to the new time).
update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute',
  expires_at = now() + interval '6 hours'
where draft_id in ('m1_0', 'm1_1', 'm1_2', 'm1_9', 'm1_8') or origin = 'ai_generated';
-- m1_9 lost its consent by an unconfirmed change: simulate by flipping it.
update postona_x_resv.reservations set consent_state = 'needs_reconfirm' where draft_id = 'm1_9';
create temp table w1 as select * from postona_x_resv.claim_due('worker-1', 120, 50);
select pg_temp.check((select array_agg(body order by body) from w1) = array['本文0', '本文1', '本文2'], 'only due + consented manual rows (not AI, not cancelled, not unconfirmed)');
select pg_temp.check((select count(*) from postona_x_resv.claim_due('worker-2', 120, 50)) = 0, 'no second claim');
select pg_temp.expect_error(format($q$select * from postona_x_resv.cancel(%L, 1)$q$, (select reservation_id from w1 where body = '本文0')), 'POSTONA_RESV_CANCEL_TOO_LATE');
select pg_temp.check(postona_x_resv.pre_publish_check((select reservation_id from w1 where body = '本文0'), (select lease_token from w1 where body = '本文0')) = 'OK', 'pre-publish ok');
select pg_temp.check(postona_x_resv.finish((select reservation_id from w1 where body = '本文0'), (select lease_token from w1 where body = '本文0'), 'published', '1234567890', null) = 'published', 'published');
select pg_temp.check(postona_x_resv.finish((select reservation_id from w1 where body = '本文0'), (select lease_token from w1 where body = '本文0'), 'published', '1234567890', null) = 'published', 'idempotent replay');
select pg_temp.expect_error(format($q$select postona_x_resv.finish(%L, %L, 'published', '999', null)$q$, (select reservation_id from w1 where body = '本文0'), (select lease_token from w1 where body = '本文0')), 'POSTONA_RESV_LEASE_LOST');
select pg_temp.expect_error(format($q$select postona_x_resv.finish(%L, gen_random_uuid(), 'published', '1', null)$q$, (select reservation_id from w1 where body = '本文1')), 'POSTONA_RESV_LEASE_LOST');
select pg_temp.expect_error(format($q$select postona_x_resv.finish(%L, %L, 'published', null, null)$q$, (select reservation_id from w1 where body = '本文1'), (select lease_token from w1 where body = '本文1')), 'POSTONA_RESV_REQUEST_INVALID');
-- Unknown provider outcome: uncertain, never re-claimed.
select pg_temp.check(postona_x_resv.finish((select reservation_id from w1 where body = '本文1'), (select lease_token from w1 where body = '本文1'), 'uncertain', null, 'PROVIDER_TIMEOUT') = 'uncertain', 'uncertain');
-- Lease expiry: the sweep makes it uncertain; a late finish is refused; nothing is re-claimed.
update postona_x_resv.reservations set lease_expires_at = now() - interval '1 second' where draft_id = 'm1_2';
select pg_temp.check((select count(*) from postona_x_resv.claim_due('worker-3', 120, 50)) = 0, 'expired lease is not re-claimed');
select pg_temp.check((select status = 'uncertain' and outcome_code = 'LEASE_EXPIRED' from postona_x_resv.reservations where draft_id = 'm1_2'), 'swept to uncertain');
select pg_temp.expect_error(format($q$select postona_x_resv.finish(%L, %L, 'published', '42', null)$q$, (select reservation_id from w1 where body = '本文2'), (select lease_token from w1 where body = '本文2')), 'POSTONA_RESV_LEASE_LOST');
select pg_temp.check((select status from postona_x_resv.reservations where origin = 'ai_generated') = 'planned', 'AI never claimed in V1');
select 'W1_CLAIM_LEASE_FINISH_PASS' as result;

-- W2. Withdrawn authority between claim and send stops the post; withdrawn ownership/entitlement stops claims.
update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute' where draft_id = 'm1_3';
create temp table w2 as select * from postona_x_resv.claim_due('worker-1', 120, 50);
select pg_temp.check((select count(*) from w2) = 1, 'm1_3 claimed');
update t.mock_entitlement set status = 'ended' where user_id = :'A';
select pg_temp.check(postona_x_resv.pre_publish_check((select reservation_id from w2), (select lease_token from w2)) = 'NOT_PUBLISHABLE', 'entitlement ended before send');
select pg_temp.check((select status = 'failed' and outcome_code = 'NOT_PUBLISHABLE_AT_SEND' from postona_x_resv.reservations where draft_id = 'm1_3'), 'failed, never sent');
update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute' where draft_id = 'm1_4';
select pg_temp.check((select count(*) from postona_x_resv.claim_due('worker-1', 120, 50)) = 0, 'service ended: nothing claimed');
select pg_temp.expect_error($q$select * from postona_x_resv.list_reservations('x_a')$q$, 'POSTONA_RESV_SERVICE_NOT_ACTIVE');
update t.mock_entitlement set status = 'active' where user_id = :'A';
update public.brand_memberships set role = 'admin' where brand_id = 'brand_a' and user_id = :'A';
select pg_temp.check((select count(*) from postona_x_resv.claim_due('worker-1', 120, 50)) = 0, 'owner role revoked: nothing claimed');
select pg_temp.expect_error($q$select * from postona_x_resv.list_reservations('x_a')$q$, 'POSTONA_RESV_ACCOUNT_NOT_FOUND');
update public.brand_memberships set role = 'owner' where brand_id = 'brand_a' and user_id = :'A';
delete from t.mock_verified where social_account_id = 'x_a';
select pg_temp.check((select count(*) from postona_x_resv.claim_due('worker-1', 120, 50)) = 0, 'X account no longer verified: nothing claimed');
insert into t.mock_verified values (:'A', 'x_a');
-- Expired planned rows are swept, never claimed late.
update postona_x_resv.reservations set expires_at = now() - interval '1 second' where draft_id = 'm1_4';
select pg_temp.check((select count(*) from postona_x_resv.claim_due('worker-1', 120, 50)) = 0, 'expired not claimed');
select pg_temp.check((select status from postona_x_resv.reservations where draft_id = 'm1_4') = 'expired', 'expired');
select 'W2_LIVE_AUTHORITY_RECHECK_PASS' as result;

-- W3. finish() enforces the lease deadline itself: NO claim_due() sweep runs between expiry and finish.
update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute',
  expires_at = now() + interval '6 hours'
where draft_id in ('m1_5', 'm1_6', 'm1_7', 'ascii280');
create temp table w3 as select r.*, x.draft_id from postona_x_resv.claim_due('worker-1', 120, 50) r
  join postona_x_resv.reservations x on x.id = r.reservation_id;
select pg_temp.check((select array_agg(draft_id order by draft_id) from w3) = array['ascii280', 'm1_5', 'm1_6', 'm1_7'], 'four claimed');
create function pg_temp.w3_id(p_draft text) returns uuid language sql as $$ select reservation_id from w3 where draft_id = p_draft $$;
create function pg_temp.w3_tok(p_draft text) returns uuid language sql as $$ select lease_token from w3 where draft_id = p_draft $$;
create function pg_temp.w3_row(p_draft text) returns postona_x_resv.reservations language sql as $$
  select r.* from postona_x_resv.reservations r where r.id = pg_temp.w3_id(p_draft) $$;
-- Expired (1 s ago), unswept: a late 'published' is NOT accepted; the row is fenced to uncertain atomically.
update postona_x_resv.reservations set lease_expires_at = clock_timestamp() - interval '1 second' where id = pg_temp.w3_id('m1_5');
select pg_temp.check((pg_temp.w3_row('m1_5')).status = 'claimed', 'still claimed: no sweep ran');
select pg_temp.check(postona_x_resv.finish(pg_temp.w3_id('m1_5'), pg_temp.w3_tok('m1_5'), 'published', '777000111', null) = 'lease_lost', 'late published refused');
select pg_temp.check((select status = 'uncertain' and outcome_code = 'LEASE_EXPIRED_AT_FINISH' and provider_post_id is null from pg_temp.w3_row('m1_5')),
  'fenced to uncertain, no provider id recorded as success');
select pg_temp.check((select count(*) = 1 and bool_and(detail ->> 'reported_outcome' = 'published' and detail ->> 'reported_provider_post_id' = '777000111')
  from postona_x_resv.audit where reservation_id = pg_temp.w3_id('m1_5') and action = 'finish_after_lease'), 'late report kept for reconciliation only');
select pg_temp.expect_error(format($q$select postona_x_resv.finish(%L, %L, 'published', '777000111', null)$q$, pg_temp.w3_id('m1_5'), pg_temp.w3_tok('m1_5')), 'POSTONA_RESV_LEASE_LOST');
-- Expired, unswept: a late 'failed_before_send' is NOT accepted either (cannot be proven once the lease is gone).
update postona_x_resv.reservations set lease_expires_at = clock_timestamp() - interval '1 second' where id = pg_temp.w3_id('m1_6');
select pg_temp.check(postona_x_resv.finish(pg_temp.w3_id('m1_6'), pg_temp.w3_tok('m1_6'), 'failed_before_send', null, 'RATE_LIMITED') = 'lease_lost', 'late failed refused');
select pg_temp.check((select status = 'uncertain' and outcome_code = 'LEASE_EXPIRED_AT_FINISH' from pg_temp.w3_row('m1_6')), 'fenced, not failed');
-- pre_publish_check uses the real clock too: a lease that runs out inside the transaction is not ours to send on.
do $$
begin
  update postona_x_resv.reservations set lease_expires_at = clock_timestamp() + interval '200 milliseconds' where id = pg_temp.w3_id('m1_7');
  if postona_x_resv.pre_publish_check(pg_temp.w3_id('m1_7'), pg_temp.w3_tok('m1_7')) is distinct from 'OK' then raise exception 'CHECK_FAILED: pre-publish before deadline'; end if;
  perform pg_sleep(0.5);
  if postona_x_resv.pre_publish_check(pg_temp.w3_id('m1_7'), pg_temp.w3_tok('m1_7')) is distinct from 'LEASE_LOST' then
    raise exception 'CHECK_FAILED: pre-publish after an in-transaction deadline must not allow a send';
  end if;
end $$;
-- Near the deadline (30 s left): the current lease is honoured; the published replay stays idempotent even after
-- the deadline passes, and a different id is refused.
update postona_x_resv.reservations set lease_expires_at = clock_timestamp() + interval '30 seconds' where id = pg_temp.w3_id('m1_7');
select pg_temp.check(postona_x_resv.finish(pg_temp.w3_id('m1_7'), pg_temp.w3_tok('m1_7'), 'published', '888000222', null) = 'published', 'valid lease accepted');
update postona_x_resv.reservations set lease_expires_at = clock_timestamp() - interval '1 second' where id = pg_temp.w3_id('m1_7');
select pg_temp.check(postona_x_resv.finish(pg_temp.w3_id('m1_7'), pg_temp.w3_tok('m1_7'), 'published', '888000222', null) = 'published', 'published replay idempotent');
select pg_temp.expect_error(format($q$select postona_x_resv.finish(%L, %L, 'published', '1', null)$q$, pg_temp.w3_id('m1_7'), pg_temp.w3_tok('m1_7')), 'POSTONA_RESV_LEASE_LOST');
select pg_temp.check((select status = 'published' and provider_post_id = '888000222' from pg_temp.w3_row('m1_7')), 'published kept');
select pg_temp.check((select count(*) from postona_x_resv.audit where reservation_id = pg_temp.w3_id('m1_7') and action = 'finish') = 1, 'one finish recorded');
-- The deadline passes INSIDE one transaction (lease valid at transaction start): the real clock decides.
do $$
declare v_result text;
begin
  update postona_x_resv.reservations set lease_expires_at = clock_timestamp() + interval '200 milliseconds' where id = pg_temp.w3_id('ascii280');
  perform pg_sleep(0.5);
  v_result := postona_x_resv.finish(pg_temp.w3_id('ascii280'), pg_temp.w3_tok('ascii280'), 'published', '999000333', null);
  if v_result is distinct from 'lease_lost' then raise exception 'CHECK_FAILED: deadline crossed within the transaction accepted (%)', v_result; end if;
end $$;
select pg_temp.check((select status = 'uncertain' and provider_post_id is null from pg_temp.w3_row('ascii280')), 'in-transaction expiry fenced');
-- Invariants: nothing is re-claimed or sent twice; no claimed row outlives its lease after finish.
select pg_temp.check((select count(*) from postona_x_resv.claim_due('worker-2', 120, 50)) = 0, 'nothing re-claimed');
select pg_temp.check((select array_agg(status order by draft_id) from postona_x_resv.reservations where id in (select reservation_id from w3))
  = array['uncertain', 'uncertain', 'uncertain', 'published'], 'final states');
select pg_temp.check(not exists (select 1 from postona_x_resv.reservations where status = 'published' and outcome_code = 'LEASE_EXPIRED_AT_FINISH'), 'no fenced row is published');
select pg_temp.check(not exists (select 1 from postona_x_resv.reservations where status = 'claimed'), 'no claimed row left');
select 'W3_FINISH_LEASE_DEADLINE_PASS' as result;

-- L1. Lifecycle: deleting a social account / brand cascades its reservations (never blocks G5 deletion);
--     the legacy brand queue is untouched.
select set_config('rt.a2', (select count(*)::text from postona_x_resv.reservations where social_account_id = 'x_a2'), false);
select pg_temp.check(current_setting('rt.a2')::integer = 1, 'x_a2 has one row');
delete from public.social_accounts where id = 'x_a2';
select pg_temp.check((select count(*) from postona_x_resv.reservations where social_account_id = 'x_a2') = 0, 'account delete cascades');
delete from public.social_accounts where brand_id = 'brand_a';
select pg_temp.check(pg_temp.count_resv() = 0 and (select count(*) from postona_x_resv.batches) = 0, 'account delete cascades rows and batches');
delete from public.brands where id = 'brand_a';  -- nothing of the candidate blocks the brand delete
select pg_temp.check((select count(*) from public.scheduled_posts) = 1, 'legacy queue untouched');
select 'L1_LIFECYCLE_CASCADE_PASS' as result;

select 'POSTONA_RESV_BEHAVIOR_PASS' as result;
