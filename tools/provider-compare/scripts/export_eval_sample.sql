-- READ-ONLY. Representative sample for the Phase 3 evaluation set (kept apart from the hand-picked hard cases).
--   supabase db query --linked -o json -f tools/provider-compare/scripts/export_eval_sample.sql
-- Population : every AI-judged candidate (judgement_model is not null) created 2026-09-10 00:00 .. 2026-10-10 00:00 JST,
--              minus the 22 fixtures of cases.json. Duplicates dropped by production (status = 'duplicate') are not AI-judged
--              and are therefore not in the population.
-- Design     : stratified by source_name; within a stratum a seeded md5 order picks the first n_h rows (reproducible).
--              The stratum size N_h is returned with every row so estimates can be weighted by N_h / n_h.
-- Quotas     : tdnet 16, market_macro 8, jp_official 4, bbc_world 4, al_jazeera 6, breaking_market 3.
with pop as (
  select * from public.important_news_candidates
  where created_at >= timestamptz '2026-09-10 00:00:00+09' and created_at < timestamptz '2026-10-10 00:00:00+09'
    and judgement_model is not null
    and left(id::text, 8) not in ('25c28b26','a989d1f3','cafc0f82','090e8d18','84832da2','26648baf','e956ae92','f4a8a7cc',
      'a3dac612','1533a3fd','4887f2b0','0b73ef94','3a1fe802','d09c88ce','60d9954a','7207a56d','91569af5','8792253b',
      '44df218f','2f881cde','201cf3c7','b5a10bac')
),
ranked as (
  select *, row_number() over (partition by source_name order by md5(id::text || 'kabumori-eval-sample-v3')) as rn,
         count(*) over (partition by source_name) as stratum_n
  from pop
)
select left(id::text, 8) as id8, id::text as id, source_name, stratum_n, rn as stratum_rank, importance, title
from ranked
where rn <= case source_name when 'tdnet' then 16 when 'market_macro' then 8 when 'jp_official' then 4 when 'bbc_world' then 4
                             when 'al_jazeera' then 6 when 'breaking_market' then 3 else 0 end
order by source_name, rn;
