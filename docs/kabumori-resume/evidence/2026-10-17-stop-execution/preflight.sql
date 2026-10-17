BEGIN READ ONLY;
SELECT jsonb_build_object(
'observed_at',now(),'read_only',current_setting('transaction_read_only'),'database',current_database(),'server_version',current_setting('server_version'),
'planners',(SELECT jsonb_agg(x ORDER BY proname) FROM (SELECT p.proname,pg_get_function_identity_arguments(p.oid) args,md5(p.prosrc) fingerprint FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('claim_due_post','plan_daily_posts','plan_morning_report','plan_close_report','plan_weekly_useful_tips','plan_us_premarket_report'))x),
'queue_writers',(SELECT jsonb_agg(x ORDER BY proname) FROM (SELECT p.proname,pg_get_function_identity_arguments(p.oid) args,md5(p.prosrc) fingerprint FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND p.prosrc ~* 'insert[[:space:]]+into[[:space:]]+(public\.)?scheduled_posts')x),
'table_columns',(SELECT jsonb_agg(x ORDER BY table_name) FROM (SELECT table_name,string_agg(column_name||':'||data_type,', ' ORDER BY ordinal_position) columns FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('posting_windows','useful_tip_schedule_settings','us_premarket_report_settings','morning_report_settings','close_report_settings') GROUP BY table_name)x),
'windows',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM public.posting_windows w),
'brands',(SELECT jsonb_agg(x ORDER BY id) FROM (SELECT id,is_active,publish_mode,to_jsonb(brands)->'enabled_post_types' AS enabled_post_types FROM public.brands)x),
'useful_settings',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.useful_tip_schedule_settings t),
'morning_settings',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.morning_report_settings t),
'close_settings',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.close_report_settings t),
'us_settings',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.us_premarket_report_settings t),
'pending',(SELECT jsonb_agg(x ORDER BY scheduled_for,id) FROM (SELECT id,brand_id,post_type,status,scheduled_for,created_at FROM public.scheduled_posts WHERE brand_id='kabumori' AND status IN ('pending','running'))x),
'queue_summary',(SELECT jsonb_agg(x ORDER BY brand_id,status) FROM (SELECT brand_id,status,count(*) count,max(created_at) latest_created_at FROM public.scheduled_posts GROUP BY brand_id,status)x),
'cron',(SELECT jsonb_agg(x ORDER BY jobid) FROM (SELECT jobid,jobname,active,schedule,md5(command) command_fingerprint FROM cron.job)x),
'triggers',(SELECT jsonb_agg(x ORDER BY table_name,tgname) FROM (SELECT c.relname table_name,t.tgname,pg_get_triggerdef(t.oid) definition,p.proname,md5(p.prosrc) source_fingerprint FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname='public' AND c.relname IN ('posting_windows','useful_tip_schedule_settings','morning_report_settings','close_report_settings','us_premarket_report_settings') AND NOT t.tgisinternal)x),
'scheduled_brand_default',(SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='scheduled_posts' AND column_name='brand_id'),
'settings_consumers',(SELECT jsonb_agg(x ORDER BY proname) FROM (SELECT p.proname,md5(p.prosrc) fingerprint FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND p.prosrc ~ '(useful_tip_schedule_settings|morning_report_settings|close_report_settings|us_premarket_report_settings)')x),
'inflight',(SELECT jsonb_agg(x) FROM (SELECT pid,state,xact_start,query_start,wait_event_type,wait_event,md5(query) query_fingerprint,left(query,180) query_prefix FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state<>'idle' AND query ~* '(plan_daily_posts|plan_weekly_useful_tips|plan_morning_report|plan_close_report|plan_us_premarket_report|claim_due_post|posting_windows|report_settings|useful_tip_schedule_settings|ALTER |CREATE |DROP )')x),
'storage',(SELECT jsonb_agg(x ORDER BY bucket_id) FROM (SELECT bucket_id,count(*) count,max(created_at) latest_created_at,max(updated_at) latest_updated_at FROM storage.objects WHERE bucket_id ILIKE '%greet%' OR name ILIKE '%morning%' GROUP BY bucket_id)x)
) AS snapshot;
COMMIT;
