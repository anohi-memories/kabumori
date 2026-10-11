-- READ-ONLY. Phase 5: what the information-sufficiency gate did to the no_post decisions of one window.
--   supabase db query --linked -o json -f tools/provider-compare/scripts/export_gate_breakdown.sql
-- The gate is judgeCandidateWithEscalation() in importance_judgement_logic.ts: the final importance is forced to no_post when
-- the final fact_check_status is not 'passed', or when Sol escalation was required but did not run. Only a few things
-- survive in storage, and this query reads exactly those:
--   judgement_reason     ends with the gate sentence when the gate fired
--   escalated_to_sol     whether the Sol call ran
--   judgement_model      the model whose output was stored (gpt-6-sol after a Sol call, otherwise gpt-6-luna)
--   fact_check_status    'needs_review' after the gate
--   ai_usage_events      one 'news_judgement_sol|<reasons>' row per Sol call, carrying the escalation reasons
-- Neither the importance the model returned before the gate nor Luna's own output when Sol ran is stored.
with window_rows as (
  select c.id, c.source_name, c.importance, c.judgement_model, c.escalated_to_sol, c.fact_check_status,
         (c.judgement_reason like '%保存済み情報だけでは安全に確定できないため投稿対象外%') as gate_text
  from public.important_news_candidates as c
  where c.created_at >= timestamptz '2026-09-10 00:00:00+09' and c.created_at < timestamptz '2026-10-10 00:00:00+09'
    and c.judgement_model is not null
),
sol_reasons as (
  select related_id, string_agg(distinct split_part(feature, '|', 2), ',') as reasons
  from public.ai_usage_events
  where feature like 'news_judgement_sol|%' and related_table = 'important_news_candidates'
    and created_at >= timestamptz '2026-09-09 00:00:00+09'
  group by related_id
)
select w.importance = 'no_post' as final_no_post, w.gate_text, w.escalated_to_sol, w.judgement_model, w.fact_check_status,
       coalesce(s.reasons, '') as sol_escalation_reasons, count(*) as n
from window_rows as w
left join sol_reasons as s on s.related_id = w.id::text
group by 1, 2, 3, 4, 5, 6
order by 1 desc, 2 desc, 3 desc, 4, 5, 6;
