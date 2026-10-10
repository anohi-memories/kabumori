-- READ-ONLY. Phase 4: the no_post-layer sample used to estimate what production's no_post decisions miss.
--   supabase db query --linked -o json -f tools/provider-compare/scripts/export_eval_nopost_sample.sql
-- Population : AI-judged candidates (judgement_model is not null) with importance = 'no_post', created
--              2026-09-10 00:00 .. 2026-10-10 00:00 JST, minus the 212 evaluation cases already in the set
--              (22 originals + 190 Phase 3 cases; listed below by 8-character id prefix).
-- Layers     : gate_suppressed = the stored reason ends with the pipeline's information-sufficiency gate text, i.e. the
--              final importance was forced to no_post (importance_judgement_logic.ts, judgeCandidateWithEscalation).
--              Two gate layers x source_name cells.
-- Design     : within each gate layer the allocation is proportional to the cell size with a minimum of one row per
--              non-empty cell, so inclusion probabilities inside a layer are nearly equal. Rows inside a cell are taken
--              in seeded md5 order (seed 'kabumori-nopost-v4'). cell_n and cell_sampled are returned so that every row
--              carries its design weight cell_n / cell_sampled.
-- Quotas     : gate_suppressed 75 (tdnet 36, al_jazeera 29, market_macro 7, bbc_world 1, breaking_market 1, jp_official 1)
--              not gated       75 (tdnet 60, market_macro 7, al_jazeera 4, bbc_world 2, breaking_market 1, jp_official 1)
with pop as (
  select c.*, (c.judgement_reason like '%保存済み情報だけでは安全に確定できないため投稿対象外%') as gate_suppressed
  from public.important_news_candidates as c
  where c.created_at >= timestamptz '2026-09-10 00:00:00+09' and c.created_at < timestamptz '2026-10-10 00:00:00+09'
    and c.judgement_model is not null and c.importance = 'no_post'
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
  select *, row_number() over (partition by gate_suppressed, source_name order by md5(id::text || 'kabumori-nopost-v4')) as rn,
         count(*) over (partition by gate_suppressed, source_name) as cell_n
  from pop
),
quota(gate_suppressed, source_name, n) as (
  values
    (true, 'tdnet', 36), (true, 'al_jazeera', 29), (true, 'market_macro', 7), (true, 'bbc_world', 1), (true, 'breaking_market', 1), (true, 'jp_official', 1),
    (false, 'tdnet', 60), (false, 'market_macro', 7), (false, 'al_jazeera', 4), (false, 'bbc_world', 2), (false, 'breaking_market', 1), (false, 'jp_official', 1)
)
select id::text as id, left(id::text, 8) as id8, ranked.source_name, ranked.gate_suppressed, ranked.cell_n, quota.n as cell_sampled, ranked.rn as cell_rank,
       source_type, source_url, title, body_summary, company_name, company_code, entity_key, category, published_at, created_at,
       importance, status, japan_market_relevance, judgement_model, escalated_to_sol, confidence, judgement_reason, fact_check_status,
       affected_entities, coverage_severity, x_post_id is not null as x_posted
from ranked
join quota on quota.gate_suppressed = ranked.gate_suppressed and quota.source_name = ranked.source_name
where ranked.rn <= quota.n
order by ranked.gate_suppressed desc, ranked.source_name, ranked.rn;
