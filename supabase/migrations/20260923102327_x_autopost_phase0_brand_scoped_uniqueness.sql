-- Phase 0 candidate: remove only the three Kabumori-era global unique constraints.
-- Intended brand-scoped unique indexes remain the authoritative idempotency keys.
--
-- Rollback: stop writers first, ensure no cross-brand duplicate keys were created, restore
-- the old planner conflict targets, then re-add the three UNIQUE constraints listed below.
-- Re-adding a global key will correctly fail while cross-brand duplicates exist; never
-- delete or merge production rows automatically to force a rollback.

DO $migration$
DECLARE
  v_expected record;
  v_constraint_count integer;
  v_has_scoped_duplicates boolean;
  v_function_oid oid;
  v_function_def text;
  v_old_target text := 'on conflict (schedule_date, post_type, slot_no) do nothing';
  v_new_target text := 'on conflict (brand_id, schedule_date, post_type, slot_no) do nothing';
  v_occurrences integer;
BEGIN
  FOR v_expected IN
    SELECT * FROM (VALUES
      ('posting_windows', 'posting_windows_post_type_slot_no_key', ARRAY['post_type','slot_no']::text[], 'posting_windows_brand_post_type_slot_key', ARRAY['brand_id','post_type','slot_no']::text[]),
      ('scheduled_posts', 'scheduled_posts_schedule_date_post_type_slot_no_key', ARRAY['schedule_date','post_type','slot_no']::text[], 'scheduled_posts_brand_schedule_slot_key', ARRAY['brand_id','schedule_date','post_type','slot_no']::text[]),
      ('publish_claims', 'publish_claims_post_type_date_jst_key', ARRAY['post_type','date_jst']::text[], 'publish_claims_brand_post_type_date_key', ARRAY['brand_id','post_type','date_jst']::text[])
    ) AS expected(table_name, legacy_constraint, legacy_columns, scoped_index, scoped_columns)
  LOOP
    IF to_regclass('public.' || v_expected.table_name) IS NULL THEN
      RAISE EXCEPTION 'PHASE0_UNIQUENESS_PREFLIGHT_TABLE_MISSING:%', v_expected.table_name;
    END IF;

    SELECT count(*) INTO v_constraint_count
    FROM pg_constraint c
    WHERE c.conrelid = to_regclass('public.' || v_expected.table_name)
      AND c.conname = v_expected.legacy_constraint
      AND c.contype = 'u'
      AND ARRAY(
        SELECT a.attname::text
        FROM unnest(c.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key_column.attnum
        ORDER BY key_column.ordinality
      ) = v_expected.legacy_columns;
    IF v_constraint_count <> 1 THEN
      RAISE EXCEPTION 'PHASE0_UNIQUENESS_PREFLIGHT_LEGACY_CONSTRAINT_MISMATCH:%', v_expected.legacy_constraint;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      WHERE i.indrelid = to_regclass('public.' || v_expected.table_name)
        AND idx.relname = v_expected.scoped_index
        AND i.indisunique AND i.indisvalid AND i.indisready
        AND i.indpred IS NULL
        AND ARRAY(
          SELECT a.attname::text
          FROM unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key_column.attnum
          WHERE key_column.ordinality <= i.indnkeyatts
          ORDER BY key_column.ordinality
        ) = v_expected.scoped_columns
    ) THEN
      RAISE EXCEPTION 'PHASE0_UNIQUENESS_PREFLIGHT_SCOPED_INDEX_MISMATCH:%', v_expected.scoped_index;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = to_regclass('public.' || v_expected.table_name)
        AND a.attname = 'brand_id' AND a.attnotnull AND NOT a.attisdropped
    ) THEN
      RAISE EXCEPTION 'PHASE0_UNIQUENESS_PREFLIGHT_BRAND_ID_NOT_NOT_NULL:%', v_expected.table_name;
    END IF;

    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%I GROUP BY %s HAVING count(*) > 1)',
      v_expected.table_name,
      array_to_string(v_expected.scoped_columns, ',')
    ) INTO v_has_scoped_duplicates;
    IF v_has_scoped_duplicates THEN
      RAISE EXCEPTION 'PHASE0_UNIQUENESS_PREFLIGHT_SCOPED_DUPLICATE:%', v_expected.table_name;
    END IF;
  END LOOP;

  ALTER TABLE public.posting_windows DROP CONSTRAINT posting_windows_post_type_slot_no_key;
  ALTER TABLE public.scheduled_posts DROP CONSTRAINT scheduled_posts_schedule_date_post_type_slot_no_key;
  ALTER TABLE public.publish_claims DROP CONSTRAINT publish_claims_post_type_date_jst_key;

  -- Existing production planner bodies contain brand-specific behavior not fully represented
  -- by historical migration files. Preserve those bodies and their ACL/security attributes;
  -- change only the obsolete scheduled_posts conflict target, failing closed unless each exact
  -- current routine has one such target.
  FOR v_function_oid IN
    SELECT unnest(ARRAY[
      to_regprocedure('public.plan_daily_posts(date)'),
      to_regprocedure('public.plan_morning_report(date)'),
      to_regprocedure('public.plan_close_report(date)'),
      to_regprocedure('public.plan_us_premarket_report(date)')
    ])
  LOOP
    IF v_function_oid IS NULL THEN
      RAISE EXCEPTION 'PHASE0_UNIQUENESS_PREFLIGHT_PLANNER_MISSING';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid = v_function_oid
        AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=public']::text[]
    ) THEN
      RAISE EXCEPTION 'PHASE0_UNIQUENESS_PREFLIGHT_PLANNER_SECURITY_MISMATCH:%', v_function_oid::regprocedure;
    END IF;

    v_function_def := pg_get_functiondef(v_function_oid);
    v_occurrences := (length(lower(v_function_def)) - length(replace(lower(v_function_def), lower(v_old_target), ''))) / length(v_old_target);
    IF v_occurrences <> 1 THEN
      RAISE EXCEPTION 'PHASE0_UNIQUENESS_PREFLIGHT_PLANNER_CONFLICT_TARGET_MISMATCH:%', v_function_oid::regprocedure;
    END IF;
    EXECUTE regexp_replace(
      v_function_def,
      'on conflict \(schedule_date, post_type, slot_no\) do nothing',
      v_new_target,
      'gi'
    );
  END LOOP;
END
$migration$;
