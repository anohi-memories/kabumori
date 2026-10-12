-- 20261012100000_market_report_broadcast_push_v1 の取り消し（別承認待ち・未実行）。
-- ゲートが OFF で、送信中の区切りが無いときだけ。手元の検証（market_report_broadcast_run.sh）で、
-- 取り消したあとの定義が適用前と完全に一致することを確かめている。
begin;
drop function public.purge_market_report_broadcasts(integer);
drop function public.finish_market_report_broadcast_chunk(uuid, uuid, bigint, jsonb, text);
drop function public.begin_market_report_broadcast_chunk(uuid, uuid, bigint);
drop function public.claim_market_report_broadcast_chunks(integer);
drop function public.plan_market_report_broadcast(uuid);
drop function public.enqueue_market_report_broadcasts();
drop function public.market_report_broadcast_eligible(uuid, text);
drop function public.market_report_broadcast_send_allowed(uuid);
drop table public.market_report_broadcast_deliveries;
drop table public.market_report_broadcast_chunks;
drop table public.market_report_broadcasts;
drop table public.market_report_broadcast_settings;
commit;
