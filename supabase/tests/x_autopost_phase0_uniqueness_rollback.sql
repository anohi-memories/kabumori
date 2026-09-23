-- Run only after the behavior script rolled back its fixture writes.
DO $$
DECLARE
  f regprocedure;
  v_definition text;
  v_old text := 'on conflict (schedule_date, post_type, slot_no) do nothing';
  v_new text := 'on conflict (brand_id, schedule_date, post_type, slot_no) do nothing';
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.plan_daily_posts(date)'::regprocedure,
    'public.plan_morning_report(date)'::regprocedure,
    'public.plan_close_report(date)'::regprocedure,
    'public.plan_us_premarket_report(date)'::regprocedure
  ] LOOP
    v_definition := pg_get_functiondef(f);
    IF (length(lower(v_definition)) - length(replace(lower(v_definition), lower(v_new), ''))) / length(v_new) <> 1 THEN
      RAISE EXCEPTION 'rollback expected one scoped planner target in %', f;
    END IF;
    EXECUTE regexp_replace(
      v_definition,
      'on conflict \(brand_id, schedule_date, post_type, slot_no\) do nothing',
      v_old,
      'gi'
    );
  END LOOP;
END
$$;

ALTER TABLE public.posting_windows
  ADD CONSTRAINT posting_windows_post_type_slot_no_key UNIQUE (post_type, slot_no);
ALTER TABLE public.scheduled_posts
  ADD CONSTRAINT scheduled_posts_schedule_date_post_type_slot_no_key UNIQUE (schedule_date, post_type, slot_no);
ALTER TABLE public.publish_claims
  ADD CONSTRAINT publish_claims_post_type_date_jst_key UNIQUE (post_type, date_jst);

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_constraint WHERE conname IN (
    'posting_windows_post_type_slot_no_key',
    'scheduled_posts_schedule_date_post_type_slot_no_key',
    'publish_claims_post_type_date_jst_key'
  ) AND contype='u') <> 3 THEN
    RAISE EXCEPTION 'rollback did not restore all legacy global constraints';
  END IF;
  IF (SELECT count(*) FROM public.posting_windows) <> 1
    OR (SELECT count(*) FROM public.scheduled_posts) <> 1
    OR (SELECT count(*) FROM public.publish_claims) <> 1
  THEN RAISE EXCEPTION 'representative legacy rows changed through apply/rollback'; END IF;
END
$$;

-- Prove the restored global keys reject cross-brand duplicates, without retaining test rows.
DO $$ BEGIN
  BEGIN
    INSERT INTO public.posting_windows (brand_id, post_type, slot_no) VALUES ('brand-b', 'tip', 1);
    RAISE EXCEPTION 'rollback did not restore posting_windows global uniqueness';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.scheduled_posts (brand_id, schedule_date, post_type, slot_no)
    VALUES ('brand-b', '2026-09-22', 'morning_report', 1);
    RAISE EXCEPTION 'rollback did not restore scheduled_posts global uniqueness';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.publish_claims (brand_id, post_type, date_jst)
    VALUES ('brand-b', 'morning_greeting', '2026-09-22');
    RAISE EXCEPTION 'rollback did not restore publish_claims global uniqueness';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
