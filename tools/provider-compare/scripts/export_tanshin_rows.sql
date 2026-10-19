-- READ-ONLY. Phase 5: earnings reports (決算短信 / 四半期決算短信) whose stored text may lack the current-period row.
--   supabase db query --linked -o json -f tools/provider-compare/scripts/export_tanshin_rows.sql > local.jsonl
-- Bodies are returned for local analysis only (src/tanshin_extraction.ts); they must not be committed (see body_policy.ts).
select left(id::text, 8) as id8, title, left(coalesce(body_summary, ''), 2600) as body, importance, status,
       (judgement_reason like '%保存済み情報だけでは安全に確定できないため投稿対象外%') as gate_suppressed
from public.important_news_candidates
where created_at >= timestamptz '2026-09-10 00:00:00+09' and created_at < timestamptz '2026-10-10 00:00:00+09'
  and judgement_model is not null and source_type = 'tdnet'
  and title ~ '決算短信'
  and title !~ '(訂正|補足|説明資料)'
order by created_at;
