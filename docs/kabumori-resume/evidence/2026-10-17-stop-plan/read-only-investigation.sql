-- Read-only investigation actually executed. This file contains no stop/update instructions.
BEGIN READ ONLY;
SELECT jsonb_build_object(
'observed_at',now(),'read_only',current_setting('transaction_read_only'),
'planners',(SELECT jsonb_agg(x) FROM (SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args,p.prosrc AS source,md5(p.prosrc) AS fingerprint FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('claim_due_post','plan_daily_posts','plan_morning_report','plan_close_report','plan_weekly_useful_tips','plan_us_premarket_report') ORDER BY p.proname)x),
'table_columns',(SELECT jsonb_agg(x) FROM (SELECT table_name,string_agg(column_name||':'||data_type,', ' ORDER BY ordinal_position) AS columns FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('posting_windows','useful_tip_schedule_settings','us_premarket_report_settings','morning_report_settings','close_report_settings') GROUP BY table_name)x),
'windows',(SELECT jsonb_agg(to_jsonb(w)) FROM posting_windows w WHERE brand_id IN ('kabumori','ai_salaryman_lab')),
'useful_settings',(SELECT jsonb_agg(to_jsonb(t)) FROM useful_tip_schedule_settings t),
'morning_settings',(SELECT jsonb_agg(to_jsonb(t)) FROM morning_report_settings t),
'close_settings',(SELECT jsonb_agg(to_jsonb(t)) FROM close_report_settings t),
'us_settings',(SELECT jsonb_agg(to_jsonb(t)) FROM us_premarket_report_settings t),
'pending',(SELECT jsonb_agg(x) FROM (SELECT brand_id,post_type,status,scheduled_for,created_at FROM scheduled_posts WHERE brand_id IN ('kabumori','ai_salaryman_lab') AND status IN ('pending','running') ORDER BY brand_id,scheduled_for)x),
'cron',(SELECT jsonb_agg(x) FROM (SELECT jobid,jobname,active,md5(command) AS command_fingerprint FROM cron.job ORDER BY jobid)x)
);
COMMIT;

BEGIN READ ONLY; SELECT jsonb_build_object('observed_at',now(),'queue_writers',(SELECT jsonb_agg(x) FROM (SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args,md5(p.prosrc) AS fingerprint,p.prosrc LIKE '%posting_windows%' AS uses_windows,p.prosrc LIKE '%_settings%' AS uses_settings FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND p.prosrc ~* 'insert[[:space:]]+into[[:space:]]+(public\.)?scheduled_posts' ORDER BY p.proname)x),'relevant_table_policies',(SELECT jsonb_agg(x) FROM (SELECT tablename,policyname,cmd,roles FROM pg_policies WHERE schemaname='public' AND tablename IN ('scheduled_posts','posting_windows','useful_tip_schedule_settings','morning_report_settings','close_report_settings') ORDER BY tablename,policyname)x)); COMMIT;
