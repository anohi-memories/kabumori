-- READ-ONLY, NOT EXECUTED YET (Phase 4/5 plan; run only after the product-policy questions are answered).
--   supabase db query --linked -o json -f tools/provider-compare/scripts/export_eval_posted_sample.sql
-- The delivered-side sample: what production decided important or above, to estimate how often that decision was wrong
-- (over-calls) and, for the generation-failed layer, whether the importance was right when the post never went out.
-- Population : AI-judged candidates (judgement_model is not null) with importance <> 'no_post', not duplicates, created
--              2026-09-10 00:00 .. 2026-10-10 00:00 JST, minus the 212 cases already in the evaluation set
--              (22 originals + 190 Phase 3 cases, 8-character id prefixes, same list as export_eval_nopost_sample.sql).
-- Layers     : published = status 'published'; failed = status 'generation_failed'. Cells are layer x source_name.
-- Design     : proportional allocation inside each layer with a minimum of one row per non-empty cell; rows inside a cell
--              in seeded md5 order (seed 'kabumori-posted-v5'). cell_n and cell_sampled give the design weight.
-- Quotas     : published 53 (tdnet 34, al_jazeera 12, bbc_world 4, breaking_market 2, market_macro 1)
--              failed    47 (tdnet 39, al_jazeera 4, bbc_world 2, breaking_market 1, market_macro 1)
-- Frame sizes at the time of the Phase 4 count (excluding the 212): published 174, failed 155.
-- Labels from this sample are AI-provisional or rule-based until a human confirms them; they are never human_confirmed.
with pop as (
  select c.*, case when c.status = 'published' then 'published' else 'failed' end as layer
  from public.important_news_candidates as c
  where c.created_at >= timestamptz '2026-09-10 00:00:00+09' and c.created_at < timestamptz '2026-10-10 00:00:00+09'
    and c.judgement_model is not null and c.importance <> 'no_post' and c.duplicate_of is null
    and c.status in ('published', 'generation_failed')
    and left(c.id::text, 8) not in (
      '01cf1e3a', '0720532f', '077310bc', '090e8d18', '0914c467', '092f34d8', '0b73ef94', '0cfcd65b', '0d8afcb3', '12e3e5a7',
      '13417351', '1533a3fd', '15820dc1', '17c392a2', '1aaba5c8', '1b4065c0', '1cbeaa20', '1d4b6077', '1e15749f', '1eb1c3a3',
      '201cf3c7', '204e6b7e', '2097119a', '20dfa7bd', '21c46678', '25c28b26', '26648baf', '2732fd07', '2947fd72', '299d794a',
      '2ca5075b', '2f881cde', '2f96a866', '2fad0c37', '31548d9c', '33326e77', '33689f20', '34492714', '38449d14', '38ae9115',
      '3a1fe802', '3dcb7364', '3e977e4d', '42fd10ef', '434cc413', '44df218f', '46a47651', '46e76a76', '46facf07', '4887f2b0',
      '4948a74d', '4963ce08', '49d11201', '4a524e01', '4b27f740', '4c75b45f', '4e04766f', '4e13a233', '4f77500c', '5007b090',
      '500fa0ce', '505fd42d', '5092d954', '50abdc66', '5177332d', '5264e055', '551a2f80', '566a261d', '56f0e627', '58bacb3b',
      '60d07123', '60d9954a', '6215a685', '6226f20a', '622f46d2', '62885535', '62b9da1b', '6392c70d', '64f275df', '66ac5291',
      '67498943', '6884e85e', '696f297c', '6a0d5f8a', '6b7f1d86', '7207a56d', '74008ed6', '74c37b63', '765a079d', '768e3497',
      '777fd842', '77c3e7a2', '7845ad9c', '79183f79', '7983b7e8', '7a1f8980', '7af7283f', '7bb323e1', '84832da2', '855e3cf3',
      '86295c43', '8648e274', '8792253b', '8793e08f', '87cc5717', '87f28b51', '8933e5db', '89ff5db0', '8ba7cbb7', '8d141d09',
      '8d35280a', '8d853aaa', '8ff7b5c3', '90895fbc', '90a0815f', '9123428d', '91450711', '91569af5', '9193e7a9', '91c4d325',
      '925e3458', '92c695d0', '93ee582a', '95fad667', '97161009', '98470d57', '9a650ed9', '9d2ddbf7', '9fb691a0', 'a0330fac',
      'a07434c7', 'a17eaba5', 'a3a3f0aa', 'a3dac612', 'a3fa7f66', 'a5d06b17', 'a75d3bb6', 'a989d1f3', 'aa37a7d0', 'ac2dd4c9',
      'ad979900', 'adf169b7', 'ae986eb4', 'af5a1ddf', 'afbe2902', 'b0a46c05', 'b1ccd553', 'b59035ff', 'b5a10bac', 'b726038b',
      'ba4f9ed0', 'ba538b87', 'baa72e8e', 'bb01efce', 'bda4e565', 'beeb96ea', 'bf5202d3', 'bfb7b074', 'bff661cc', 'c0a82fa9',
      'c2859db6', 'c358bfa3', 'c361378b', 'c5b41d2f', 'c6cb76ab', 'c6fb3ed6', 'c80a3ceb', 'c89f77e6', 'c939a5ec', 'ca38bae4',
      'cafc0f82', 'cb8ae243', 'cc02aad3', 'cc12ca5d', 'ceef3d60', 'cf8b5ed1', 'cface288', 'cfbab494', 'd09c88ce', 'd1981396',
      'd22b7322', 'd39db627', 'd4cbd9ef', 'd733b257', 'd7a91d90', 'd830d203', 'd84284b8', 'dbdf5a17', 'dc0da342', 'de1bf621',
      'de3598ac', 'e10be5d7', 'e18a6918', 'e18fed13', 'e1d35b56', 'e569a715', 'e7a95fe9', 'e89c58b5', 'e956ae92', 'eaff3af5',
      'ec1cdccc', 'ec8e2344', 'efb55e57', 'eff94841', 'f12437b7', 'f13b8c1f', 'f4a8a7cc', 'f57bf1b2', 'f66f2c20', 'faefab96',
      'fb09452c', 'fe063010'
    )
),
ranked as (
  select *, row_number() over (partition by layer, source_name order by md5(id::text || 'kabumori-posted-v5')) as rn,
         count(*) over (partition by layer, source_name) as cell_n
  from pop
),
quota(layer, source_name, n) as (
  values
    ('published', 'tdnet', 34), ('published', 'al_jazeera', 12), ('published', 'bbc_world', 4), ('published', 'breaking_market', 2), ('published', 'market_macro', 1),
    ('failed', 'tdnet', 39), ('failed', 'al_jazeera', 4), ('failed', 'bbc_world', 2), ('failed', 'breaking_market', 1), ('failed', 'market_macro', 1)
)
select id::text as id, left(id::text, 8) as id8, ranked.source_name, ranked.layer, ranked.cell_n, quota.n as cell_sampled, ranked.rn as cell_rank,
       source_type, source_url, title, body_summary, company_name, company_code, category, published_at, created_at,
       importance, status, japan_market_relevance, judgement_model, escalated_to_sol, confidence, judgement_reason, fact_check_status,
       generation_error, generation_fact_issues, generation_voice_issues, coverage_severity, x_post_id is not null as x_posted
from ranked
join quota on quota.layer = ranked.layer and quota.source_name = ranked.source_name
where ranked.rn <= quota.n
order by ranked.layer, ranked.source_name, ranked.rn;
