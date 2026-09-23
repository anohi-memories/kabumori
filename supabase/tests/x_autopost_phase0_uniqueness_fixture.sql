-- Fake-only baseline for a disposable PostgreSQL database. Never point this at production.
CREATE ROLE service_role;

CREATE TABLE public.posting_windows (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_id text NOT NULL DEFAULT 'kabumori',
  post_type text NOT NULL,
  slot_no smallint NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT posting_windows_post_type_slot_no_key UNIQUE (post_type, slot_no)
);
CREATE UNIQUE INDEX posting_windows_brand_post_type_slot_key
  ON public.posting_windows (brand_id, post_type, slot_no);

CREATE TABLE public.scheduled_posts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_id text NOT NULL DEFAULT 'kabumori',
  schedule_date date NOT NULL,
  post_type text NOT NULL,
  slot_no smallint NOT NULL,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending',
  CONSTRAINT scheduled_posts_schedule_date_post_type_slot_no_key
    UNIQUE (schedule_date, post_type, slot_no)
);
CREATE UNIQUE INDEX scheduled_posts_brand_schedule_slot_key
  ON public.scheduled_posts (brand_id, schedule_date, post_type, slot_no);

CREATE TABLE public.publish_claims (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_id text NOT NULL DEFAULT 'kabumori',
  post_type text NOT NULL,
  date_jst date NOT NULL,
  status text NOT NULL DEFAULT 'publishing',
  CONSTRAINT publish_claims_post_type_date_jst_key UNIQUE (post_type, date_jst)
);
CREATE UNIQUE INDEX publish_claims_brand_post_type_date_key
  ON public.publish_claims (brand_id, post_type, date_jst);

INSERT INTO public.posting_windows (post_type, slot_no) VALUES ('tip', 1);
INSERT INTO public.scheduled_posts (schedule_date, post_type, slot_no)
VALUES ('2026-09-22', 'morning_report', 1);
INSERT INTO public.publish_claims (post_type, date_jst)
VALUES ('morning_greeting', '2026-09-22');

CREATE OR REPLACE FUNCTION public.plan_daily_posts(p_date date DEFAULT current_date)
RETURNS SETOF public.scheduled_posts LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_window public.posting_windows%rowtype;
BEGIN
  FOR v_window IN SELECT * FROM public.posting_windows WHERE is_active ORDER BY brand_id, post_type, slot_no LOOP
    INSERT INTO public.scheduled_posts (brand_id, schedule_date, post_type, slot_no)
    VALUES (v_window.brand_id, p_date, v_window.post_type, v_window.slot_no)
    ON CONFLICT (schedule_date, post_type, slot_no) DO NOTHING;
  END LOOP;
  RETURN QUERY SELECT * FROM public.scheduled_posts WHERE schedule_date = p_date ORDER BY brand_id, post_type, slot_no;
END;
$$;

CREATE OR REPLACE FUNCTION public.plan_morning_report(p_date date DEFAULT current_date)
RETURNS SETOF public.scheduled_posts LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.scheduled_posts (schedule_date, post_type, slot_no) VALUES (p_date, 'morning_report', 1)
  ON CONFLICT (schedule_date, post_type, slot_no) DO NOTHING;
  RETURN QUERY SELECT * FROM public.scheduled_posts WHERE schedule_date = p_date AND post_type = 'morning_report';
END;
$$;

CREATE OR REPLACE FUNCTION public.plan_close_report(p_date date DEFAULT current_date)
RETURNS SETOF public.scheduled_posts LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.scheduled_posts (schedule_date, post_type, slot_no) VALUES (p_date, 'close_report', 1)
  ON CONFLICT (schedule_date, post_type, slot_no) DO NOTHING;
  RETURN QUERY SELECT * FROM public.scheduled_posts WHERE schedule_date = p_date AND post_type = 'close_report';
END;
$$;

CREATE OR REPLACE FUNCTION public.plan_us_premarket_report(p_date date DEFAULT current_date)
RETURNS SETOF public.scheduled_posts LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.scheduled_posts (schedule_date, post_type, slot_no) VALUES (p_date, 'us_premarket_report', 1)
  ON CONFLICT (schedule_date, post_type, slot_no) DO NOTHING;
  RETURN QUERY SELECT * FROM public.scheduled_posts WHERE schedule_date = p_date AND post_type = 'us_premarket_report';
END;
$$;

REVOKE ALL ON FUNCTION public.plan_daily_posts(date), public.plan_morning_report(date),
  public.plan_close_report(date), public.plan_us_premarket_report(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plan_daily_posts(date), public.plan_morning_report(date),
  public.plan_close_report(date), public.plan_us_premarket_report(date) TO service_role;
