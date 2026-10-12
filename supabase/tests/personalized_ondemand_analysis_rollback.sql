-- 20261011150000_personalized_ondemand_analysis_v1 の取り消し（別承認待ち・未実行）。
-- ゲートが OFF で、ジョブが0件のときだけ。手元の検証（personalized_ondemand_analysis_run.sh）で、
-- 取り消したあとの定義が適用前と完全に一致することを確かめている。
begin;
drop function public.mark_personalized_analysis_notification_failed(uuid);
drop function public.enqueue_personalized_analysis_notification(uuid);
drop function public.fail_personalized_analysis_job(uuid, uuid, bigint, text, boolean);
drop function public.complete_personalized_analysis_job(uuid, uuid, bigint, jsonb);
drop function public.claim_personalized_analysis_jobs(integer);
drop function public.get_app_market_report(text, date);
drop function public.get_personalized_analysis_status();
drop function public.request_personalized_analysis(text, uuid, text);
drop index public.notifications_personalized_analysis_once;
drop table public.personalized_analysis_results;
drop table public.personalized_analysis_jobs;
drop table public.personalized_ondemand_settings;
commit;
