-- Stores the AI Fact/Voice check's own returned "issues" array (already computed, previously
-- discarded after generation) so a generation_failed candidate's specific reason can be inspected
-- from the database instead of only its pass/fail status. No new AI judgement is introduced.
alter table public.important_news_candidates
  add column if not exists generation_fact_issues jsonb,
  add column if not exists generation_voice_issues jsonb;
