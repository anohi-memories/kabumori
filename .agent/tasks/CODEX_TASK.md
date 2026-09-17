# Codex Task

- task_id: x-ai-lab-vault-token-refresh-production-deploy-20260917
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol High
- purpose: C1でsource candidate・integration・read-only preflight・isolated runtime preflightまでPASSしたAI Lab専用Vault-backed refresh実装を、exact candidateから`x-test-post`のみに安全に本番反映し、runtime一致と自然slot結果を確認する。

## C1 review — 2026-09-17

**PASS — production deploy approved for the exact AI Lab refresh candidate only.**

承認根拠:
- source candidateは初回2xxのみsuccess、初回401のみrefresh 1回、persist後にpublish retry最大1回。401以外non-2xx・uncertain・refresh/persist失敗・2回目non-2xxはfail-closed。
- fixed AI Lab boundary `ai_salaryman_lab` / `ai_salaryman_lab_x` / `kaishain_ai_lab` を維持し、Kabumori/Mio/legacy `oauth_token_store`へfallbackしない。
- Vault persistenceはtransaction + advisory lock + expected refresh token比較でstale writerを拒否し、access tokenは固定ref、refresh tokenはrotation時のみ固定refへ更新。
- completion/idempotency guardは外周に維持され、refresh後も無限retry・3回目publish・unsafe resendなし。
- focused 30/30、full x-test-post + `_shared/brand` regression 474/474。candidate由来の新規deno check diagnosticなし、fmt/diff-check PASS。
- production secret metadataで `SUPABASE_DB_URL` / `X_CLIENT_ID` / `X_CLIENT_SECRET` presence確認済み。値は未読。
- deployed `x-oauth-connect` のclient-authは confidential-client HTTP Basic + `grant_type=refresh_token` でcandidateと整合。
- isolated `ai-lab-db-preflight` v1でproduction Edge runtimeから既存`SUPABASE_DB_URL`へのdirect DB connection成功、effective `current_user=postgres`、`vault.update_secret(...)` EXECUTE=trueをread-only確認。probeは削除済み。
- runtime preflightではDB write 0 / Vault write 0 / X write 0 / OAuth action 0 / secret value output 0。他既存Function無変更。

Approved candidate:
- `a7ffba4930a9eff3885ab29254f9858b80e71170`
- candidate branch: `codex/x-ai-lab-vault-token-refresh-integration-candidate-20260917`

## Mandatory startup / conflict gate

開始前に:
1. `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, `.agent/CODEX_REPORT.md` を読む。
2. fresh `origin/main` を確認する。
3. H2/G1/G2を確認し、`x-test-post` / `_shared/brand` / OAuth/Vault/social account stateを同時に変更・deployするworkstreamがあればSTOP。
4. candidate `a7ffba4930a9eff3885ab29254f9858b80e71170` と現在mainの差分を確認し、未レビューのruntime差分を混ぜない。
5. production現行 `x-test-post` version/status/verify_jwt/source hashを記録してrollback基準にする。
6. secret/token/Vault値は読まない・表示しない。

## Authorized production action

このH1で許可するのは以下のみ:
- exact approved candidateのAI Lab refresh integrationを最新mainへ安全に載せるための必要最小限のrebase/cherry-pick/conflict解消
- conflict解消がsemantic変更を伴う場合はdeploy前にSTOPしてC1へ戻す
- local focused/full regression再実行
- `x-test-post` Edge Functionのみdeploy
- 現行 `verify_jwt` 設定を維持
- deploy後のFunction version/status/verify_jwt/updated_at/source read-back/hash確認
- 他Function version/updated_at不変確認
- 既存Cronによる次の自然AI Lab `brand_post` slotをread-only観測
- 自然slotで初回401が発生した場合、承認済みruntime自身がrefresh/persist/retryすることはこのdeployの意図した本番動作として許可

## Prohibited

- `x-oauth-connect` deploy/change
- Kabumori/Mio OAuth/token/handle/publish state変更
- legacy `oauth_token_store`変更/fallback
- OAuth scope変更
- OAuth再認可
- manual/synthetic X post
- failed row retry/backfill
- manual refresh request
- manual Vault/token mutation
- secret/token/Vault値の読取・出力
- DB schema/migration/RPC/RLS/grant変更
- `supabase db push`
- Cron/posting window/time/probability変更
- 他Edge Function deploy
- unrelated source変更

## Required deployment verification

最低限:
- deploy直前 fresh `origin/main`
- exact approved logicがdeploy sourceに存在し、未レビュー差分なし
- focused/full regression PASS
- `x-test-post`のみdeploy成功
- post-deploy ACTIVE / `verify_jwt`維持
- runtime source read-back一致
- 他Function version/updated_at不変
- DB/schema/RPC/grant/Cron/settings変更0
- manual X/OAuth/Vault/token action 0
- secret/token/Vault value output 0

## Natural observation

人工投稿は行わない。

次の自然AI Lab `brand_post` slotについてread-onlyで:
- scheduled row / execution log / attempt_count
- terminal status
- X post id有無
- fingerprint件数
- refresh pathが必要だった場合のstable non-secret outcome codeのみ
を確認する。

成功条件:
- 通常access tokenで成功、または
- 初回401 -> refresh 1回 -> guarded persistence -> publish retry 1回 -> success
のどちらかで、duplicate/retry/backfillなし。

失敗時:
- 2回目publish non-2xx、stale refresh、persist失敗、connection失敗、uncertain completion等はfail-closedしてSTOP。
- 自動で再OAuth、manual retry、backfill、追加deployをしない。

## Rollback

重大なruntime regressionが確認された場合のみ、直前に記録したpre-deploy `x-test-post` runtimeへ戻してよい。
- rollbackは`x-test-post`のみ。
- rollback前後のversion/hash/read-backを記録。
- token/Vaultの手動巻き戻しは行わない。
- refreshがすでにrotation/persist済みの場合、そのtoken pairを手動で旧値に戻してはいけない。

## Completion

完了後:
- `.agent/CODEX_REPORT.md`先頭にproduction deploy reportを追加
- deploy source commit / pre-post version/hash / runtime read-back / other Function unchanged / tests / natural slot observation / refresh実行有無 / token value非露出 / rollback有無を記録
- this TASKを `status: review_required`, `next_owner: chatgpt` に更新
- fresh `origin/main`確認後にcontrol/report metadataをpush
- origin/main read-backしてSTOP、C1待ち

**この承認はAI Lab refresh candidateの`x-test-post` production deployだけに限定する。**

## Deployment completion — 2026-09-17

- Exact approved candidate `a7ffba4930a9eff3885ab29254f9858b80e71170` was deployed to `x-test-post` only with `verify_jwt=false` preserved.
- Post-deploy read-back: ACTIVE v113, source hash `f15bc31519a31181bb739504f9a24be895e7f5a95f01725bca15349db38349c4`; other Functions were unchanged.
- Focused 30/30 and full 474/474 regression suites passed. No manual post, retry/backfill, refresh request, OAuth action, or token/Vault mutation was performed.
- No post-deploy natural AI Lab row was available at read time; the next result must come from the existing Cron path. See `.agent/CODEX_REPORT.md`.
