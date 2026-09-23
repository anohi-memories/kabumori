-- Run only after the fake fixture and candidate migration in the disposable phase0_proof DB.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname IN (
      'posting_windows_post_type_slot_no_key',
      'scheduled_posts_schedule_date_post_type_slot_no_key',
      'publish_claims_post_type_date_jst_key'
    )
  ) THEN RAISE EXCEPTION 'legacy global uniqueness still exists'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='posting_windows_brand_post_type_slot_key')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='scheduled_posts_brand_schedule_slot_key')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='publish_claims_brand_post_type_date_key')
  THEN RAISE EXCEPTION 'brand-scoped replacement missing'; END IF;
  IF (SELECT count(*) FROM public.posting_windows) <> 1
    OR (SELECT count(*) FROM public.scheduled_posts) <> 1
    OR (SELECT count(*) FROM public.publish_claims) <> 1
  THEN RAISE EXCEPTION 'representative pre-migration rows were not preserved'; END IF;
END
$$;

INSERT INTO public.posting_windows (brand_id, post_type, slot_no) VALUES ('brand-a', 'tip', 1);
INSERT INTO public.posting_windows (brand_id, post_type, slot_no) VALUES ('brand-b', 'tip', 1);
DO $$ BEGIN
  BEGIN
    INSERT INTO public.posting_windows (brand_id, post_type, slot_no) VALUES ('brand-a', 'tip', 1);
    RAISE EXCEPTION 'same-brand posting_windows duplicate was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

INSERT INTO public.scheduled_posts (brand_id, schedule_date, post_type, slot_no)
VALUES ('brand-a', '2099-01-01', 'tip', 1), ('brand-b', '2099-01-01', 'tip', 1);
DO $$ BEGIN
  BEGIN
    INSERT INTO public.scheduled_posts (brand_id, schedule_date, post_type, slot_no)
    VALUES ('brand-a', '2099-01-01', 'tip', 1);
    RAISE EXCEPTION 'same-brand scheduled_posts duplicate was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

INSERT INTO public.publish_claims (brand_id, post_type, date_jst)
VALUES ('brand-a', 'morning_greeting', '2099-01-01'), ('brand-b', 'morning_greeting', '2099-01-01');
DO $$ BEGIN
  BEGIN
    INSERT INTO public.publish_claims (brand_id, post_type, date_jst)
    VALUES ('brand-a', 'morning_greeting', '2099-01-01');
    RAISE EXCEPTION 'same-brand publish_claims duplicate was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- The real planner conflict key must accept the same type/slot for a second brand and remain idempotent.
SELECT count(*) FROM public.plan_daily_posts('2099-01-02');
SELECT count(*) FROM public.plan_daily_posts('2099-01-02');
SELECT * FROM public.plan_morning_report('2099-01-02');
SELECT * FROM public.plan_morning_report('2099-01-02');
SELECT * FROM public.plan_close_report('2099-01-02');
SELECT * FROM public.plan_us_premarket_report('2099-01-02');

DO $$
DECLARE f regprocedure;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.plan_daily_posts(date)'::regprocedure,
    'public.plan_morning_report(date)'::regprocedure,
    'public.plan_close_report(date)'::regprocedure,
    'public.plan_us_premarket_report(date)'::regprocedure
  ] LOOP
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role execute grant changed for %', f;
    END IF;
    IF NOT (SELECT prosecdef AND proconfig @> ARRAY['search_path=public']::text[] FROM pg_proc WHERE oid=f) THEN
      RAISE EXCEPTION 'planner security properties changed for %', f;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.scheduled_posts WHERE brand_id IN ('brand-a','brand-b') AND schedule_date='2099-01-02' AND post_type='tip' AND slot_no=1) <> 2 THEN
    RAISE EXCEPTION 'planner did not schedule both brands';
  END IF;
END
$$;

ROLLBACK;
