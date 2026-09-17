# Codex Task 2

- task_id: kabumori-news-url-removal-production-deploy-20260917
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol Medium
- purpose: C2 PASS済みの「かぶモリ通常ニュースX本文から外部URLを除去する」変更を、`important-news-monitor` のみに安全に本番反映し、runtime source一致と影響範囲を確認する。

## C2 review — 2026-09-17

PASS.

承認対象:
- implementation commit: `bd97a56c8f4f9321070bcdef7970062090308a49`
- metadata/report commit: `8757416`
- merge/read-back commit: `940cea6518e3b816f3c4f4b9be0e9457eeb203f8`

確認済み:
- 変更対象は `supabase/functions/important-news-monitor/publish_logic.ts` とそのtestのみ。
- `stripExternalUrlsFromNewsPost()` は important-news のX publisher直前だけで適用される。
- `http://` / `https://` と末尾の `出典: <URL>` をX送信本文から除去する。
- candidate側 `generated_text`、`sourceUrl`、Fact/Voice、dedupe/fingerprint、claim/publish stateは変更しない。
- AI Lab / Mio / `x-test-post` / 朝刊 / 大引け / tips / media / Admin / DB schema / Cronは変更しない。
- focused 19/19、important-news全体 407/407、`deno check --no-config`、`git diff --check` PASS。
- C2時点でproduction deploy 0、DB/Cron/settings変更0、OpenAI/X/API/Push手動実行0、X投稿0。

## Mandatory fresh checks

開始前に:
1. `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, `.agent/CODEX_REPORT_2.md` を読む。
2. fresh `origin/main` を確認し、上記approved implementationが最新mainに含まれることを確認する。
3. H1/G1/G2の現行TASKを確認し、`important-news-monitor` を同時変更/deployするworkstreamがあればSTOP。
4. production `important-news-monitor` の現在version/status/verify_jwt/updated_atを記録する。
5. deploy sourceに未レビューの `important-news-monitor` runtime差分が混入していないことを確認する。混入があればSTOPしてC2へ戻す。

## Authorized production action

許可するのは以下のみ:
- clean checkout/worktreeのfresh `origin/main` をdeploy sourceとして使用
- `important-news-monitor` Edge Functionのみdeploy
- 現行 `verify_jwt` 設定を事前確認し、その設定を維持
- deploy後にversion/status/verify_jwt/updated_atをread-back
- production function sourceをdownload/read-backし、deploy sourceのruntime filesと一致確認
- 他Edge Functionのversion/updated_atが意図せず変化していないことを確認

## Prohibited

- 新しいsource修正（deploy blockerがあれば修正せずSTOP）
- `x-test-post` / OAuth / Vault / AI Lab / Mio変更
- DB/schema/migration/RPC/RLS変更
- Cron / posting_windows / settings変更
- `supabase db push`
- migration history repair/reconcile
- manual/synthetic important-news生成
- manual OpenAI/X/Push/API invocation
- manual X投稿
- source URL metadata削除
- 他Edge Function deploy
- secret/token表示

自然Cronによる通常処理は止めない。

## Verification

最低限:
- deploy前 fresh `origin/main`
- approved URL-removal sourceがdeploy sourceに存在
- `important-news-monitor` deploy success
- post-deploy ACTIVE/status/JWT設定確認
- runtime source read-back一致
- 他Function無変更確認
- production DB/Cron/settings変更0
- manual OpenAI/X/Push/API/X投稿0

本番動作確認は次の自然な重要ニュース投稿で行う。人工的に投稿を発生させない。

## Completion

完了時:
- `.agent/CODEX_REPORT_2.md` 先頭にdeploy reportを追加
- deploy前後version、deploy source commit、runtime read-back一致、他Function無変更、安全確認、自然投稿観測待ちを記録
- `.agent/tasks/CODEX_TASK_2.md` を `status: review_required`, `next_owner: chatgpt` に更新
- push前に再度fresh `origin/main`確認
- `.agent/` control/report metadataのみ安全にpush
- origin/main read-back後STOPしてC2待ち

## Deploy report — 2026-09-17

- result: `important-news-monitor` only deployed successfully from clean latest `origin/main`; C2 review required
- deploy_source: `origin/main` `e8db510458351d919c13eb2ee7e58944ac8aee2f`, containing approved URL-removal implementation `bd97a56c8f4f9321070bcdef7970062090308a49`; no runtime diff after the implementation commit
- pre_deploy: v54 ACTIVE, `verify_jwt=false`
- post_deploy: v55 ACTIVE, `verify_jwt=false`, updated_at advanced
- runtime_readback: downloaded source matched deploy source byte-for-byte for all 23 runtime TypeScript files (21 important-news-monitor files plus 2 `_shared` dependencies)
- other_functions: stocks-master-sync v16, stocks-new-listing-sync v15, send-push-notifications v15, x-oauth-connect v18, personalized-reports v13, market-intelligence-ingest v11, market-intelligence-state-evaluator v7, and brand-post-dry-run v5 retained their pre-deploy versions/updated_at. `x-test-post` advanced separately from v109 to v110 during the deploy window under the concurrent H1 workstream; this H2 deploy did not target or modify it.
- safety: no DB/schema/RPC/migration/RLS/Cron/settings/secrets/OAuth changes; no manual OpenAI/X/Push/API invocation or X post; no source URL metadata deletion; no other Function deploy
- next_step: observe the next natural important-news post only; no manual candidate or publish. Keep `status: review_required` / `next_owner: chatgpt`.
