begin;

alter table public.important_news_candidates
  drop constraint important_news_candidates_judgement_model_check,
  add constraint important_news_candidates_judgement_model_check
    check (
      judgement_model is null
      or judgement_model in ('gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-luna', 'gpt-6-sol')
    ),
  drop constraint important_news_candidates_generation_model_check,
  add constraint important_news_candidates_generation_model_check
    check (
      generation_model is null
      or generation_model in ('gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-luna', 'gpt-6-sol')
    );

commit;
