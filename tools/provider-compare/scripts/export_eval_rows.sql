-- READ-ONLY. Stage 2 of the Phase 3 evaluation-set expansion: full candidate rows for the ids picked from stage 1
-- (export_eval_pool.sql) and from the representative sample (export_eval_sample.sql).
--   supabase db query --linked -o json -f tools/provider-compare/scripts/export_eval_rows.sql
-- The id8 list below is the exact selection used on 2026-10-10 (the label file fixtures/eval_labels.json is keyed by the
-- same prefixes). Only candidate columns are read; nothing is written. Bodies are sanitised by build_eval_set.ts.
select id::text as id, left(id::text, 8) as id8, source_type, source_name, source_url, title, body_summary, company_name,
       company_code, entity_key, category, published_at, created_at, importance, status, japan_market_relevance,
       judgement_model, escalated_to_sol, confidence, judgement_reason, fact_check_status, affected_entities,
       generated_text, generation_model, generation_fact_status, generation_voice_status, generation_error,
       generation_fact_issues, generation_voice_issues
from public.important_news_candidates
where left(id::text, 8) in (
  '1cbeaa20', 'bff661cc', 'dc0da342', 'a3fa7f66', '15820dc1', '5007b090', '9d2ddbf7', '6226f20a', 'ba4f9ed0', 'c939a5ec',
  'd1981396', '6b7f1d86', '46e76a76', '2732fd07', '6884e85e', 'baa72e8e', '8793e08f', 'd7a91d90', '1e15749f', 'e569a715',
  '622f46d2', 'faefab96', 'beeb96ea', '8648e274', 'aa37a7d0', 'bb01efce', 'e1d35b56', 'de3598ac', 'adf169b7', '92c695d0',
  'ec1cdccc', 'c5b41d2f', 'ca38bae4', 'f13b8c1f', 'f12437b7', 'ceef3d60', '77c3e7a2', '12e3e5a7', '1d4b6077', '2947fd72',
  '551a2f80', '4c75b45f', 'cc12ca5d', '13417351', 'cf8b5ed1', '500fa0ce', '077310bc', '4963ce08', '9123428d', 'c358bfa3',
  '74c37b63', '566a261d', '505fd42d', 'cface288', '0914c467', 'a17eaba5', '62885535', '33689f20', 'd4cbd9ef', 'b59035ff',
  '4f77500c', 'e7a95fe9', '74008ed6', '8d141d09', '95fad667', 'eff94841', '7845ad9c', '2f96a866', '7983b7e8', 'b1ccd553',
  'dbdf5a17', '64f275df', '58bacb3b', '38449d14', '1eb1c3a3', '855e3cf3', '20dfa7bd', '9193e7a9', 'c0a82fa9', 'fe063010',
  '696f297c', '7bb323e1', '90895fbc', '31548d9c', 'cfbab494', '67498943', '3e977e4d', '4a524e01', '46a47651', 'af5a1ddf',
  '33326e77', 'afbe2902', '5092d954', '91450711', 'e89c58b5', '6a0d5f8a', 'bf5202d3', '8ff7b5c3', 'bfb7b074', '2fad0c37',
  'f57bf1b2', '3dcb7364', 'e18a6918', 'efb55e57', '62b9da1b', '79183f79', '49d11201', '66ac5291', '925e3458', '21c46678',
  '38ae9115', '7af7283f', '765a079d', '46facf07', '0d8afcb3', 'bda4e565', 'd733b257', '299d794a', '5264e055', 'e18fed13',
  'a3a3f0aa', 'd22b7322', 'c6cb76ab', '4b27f740', '17c392a2', '4e13a233', 'c89f77e6', '6215a685', '9fb691a0', '1aaba5c8',
  '777fd842', '34492714', 'ba538b87', 'c2859db6', '60d07123', '91c4d325', 'd39db627', 'ad979900', '8d853aaa', '1b4065c0',
  '0720532f', 'cb8ae243', 'c361378b', 'd84284b8', '4e04766f', 'c6fb3ed6', '89ff5db0', '2ca5075b', 'd830d203', 'f66f2c20',
  '768e3497', 'eaff3af5', '8ba7cbb7', '6392c70d', '56f0e627', 'ec8e2344', 'a0330fac', 'e10be5d7', '4948a74d', '42fd10ef',
  'b0a46c05', '86295c43', 'fb09452c', 'a75d3bb6', '87cc5717', '8933e5db', 'ac2dd4c9', '01cf1e3a', 'cc02aad3', 'c80a3ceb',
  '93ee582a', '092f34d8', '0cfcd65b', '50abdc66', '98470d57', '5177332d', '204e6b7e', '9a650ed9', '434cc413', '97161009',
  '90a0815f', '87f28b51', 'a07434c7', '2097119a', '7a1f8980', '8d35280a', 'de1bf621', 'ae986eb4', 'a5d06b17', 'b726038b'
)
order by published_at;
