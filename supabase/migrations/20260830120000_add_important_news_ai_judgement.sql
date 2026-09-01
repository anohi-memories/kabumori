alter table public.important_news_candidates
  add column if not exists affected_entities jsonb,
  add column if not exists japan_market_relevance text,
  add column if not exists judgement_model text,
  add column if not exists escalated_to_sol boolean not null default false,
  add column if not exists confidence numeric(6, 5),
  add column if not exists judgement_reason text,
  add column if not exists fact_check_status text,
  add column if not exists input_tokens integer,
  add column if not exists output_tokens integer,
  add column if not exists estimated_cost_usd numeric(12, 8),
  add column if not exists judged_at timestamptz;

alter table public.important_news_candidates
  add constraint important_news_candidates_affected_entities_check
    check (affected_entities is null or jsonb_typeof(affected_entities) = 'array'),
  add constraint important_news_candidates_market_relevance_check
    check (japan_market_relevance is null or japan_market_relevance in ('none', 'low', 'medium', 'high')),
  add constraint important_news_candidates_judgement_model_check
    check (judgement_model is null or judgement_model in ('gpt-5.6-luna', 'gpt-5.6-sol')),
  add constraint important_news_candidates_confidence_check
    check (confidence is null or confidence between 0 and 1),
  add constraint important_news_candidates_fact_check_status_check
    check (fact_check_status is null or fact_check_status in ('passed', 'needs_review')),
  add constraint important_news_candidates_token_usage_check
    check (
      (input_tokens is null or input_tokens >= 0)
      and (output_tokens is null or output_tokens >= 0)
      and (estimated_cost_usd is null or estimated_cost_usd >= 0)
    );

create index if not exists important_news_candidates_generation_ready_idx
  on public.important_news_candidates (importance, published_at desc)
  where status = 'ready_for_generation';

-- Ver.1 stage 3 only stores AI judgement. No cron or publication path is enabled.
