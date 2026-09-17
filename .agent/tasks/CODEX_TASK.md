# Codex Task

- task_id: x-ai-lab-vault-token-refresh-candidate-20260917
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: urgent
- recommended_model: Sol High
- purpose: AI Lab通常`brand_post`で、OAuth再認可後に1回成功した後の次slotで`X_REQUEST_FAILED:401`が再発する問題に対し、Vault-backed refresh tokenを安全に使うrefresh/rotation実装candidateを作る。今回のH1ではsource実装とローカル検証まで。production deploy・token mutation・OAuth再認可は行わない。

## C1 review — 2026-09-17

PASS for the read-only investigation phase.

確認済み:
- slot 6成功とslot 7の401は同じ固定AI Lab route / account / Vault-backed token sourceを使用している。
- wrong account、legacy token fallback、missing ref、dispatcher差分、duplicate/retry起因ではない。
- 現行AI Lab routeは`allowRefresh=false`で、401時に即failし、Vault tokenをrefresh/rotateしない。
- callback後のaccount/Vault refの非秘密stateに、slot 6→7間の意図しないmutationは観測されていない。
- source/deploy/DB/Vault/OAuth/Cron/schedule/manual postの変更は0。

判断:
- read-onlyで特定可能な範囲は完了。
- X側の具体的な401 subtypeは保存されておらず断定できないが、現行設計にrefresh lifecycleが無いことは確認できた。
- 次はproduction変更ではなく、AI Lab専用のrefresh/rotation candidateをコードとtestsで作り、C1で再審査する。

## Goal

AI Labだけに限定した、安全なVault-backed token refresh candidateを作る。

期待する設計:
1. 通常publishは現在のaccess tokenで1回試行。
2. 401/認証失効として扱う条件でのみ、AI Labのrefresh tokenを使ってtoken endpointへrefreshを1回だけ行う。
3. refresh成功時は新access tokenを同じAI Lab Vault destinationへ保存する。
4. Xがrefresh tokenをrotationした場合のみ、新refresh tokenも同じAI Lab Vault destinationへ置換する。
5. refresh後は元の投稿を最大1回だけ再試行する。
6. refresh失敗・再試行401・結果不明時はfail-closed。無限retry禁止。
7. fixed account `ai_salaryman_lab_x` / expected username `kaishain_ai_lab` / brand `ai_salaryman_lab` を維持する。
8. Kabumori/Mio/legacy `oauth_token_store`へfallbackしない。
9. secret/token/Vault値をlog/reportへ出さない。
10. post completion/fingerprint/idempotency/no-duplicate guaranteesを維持する。

## Mandatory startup / safety

開始前に:
1. `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, `.agent/CODEX_REPORT.md` を読む。
2. fresh `origin/main` を確認する。
3. H2/G1/G2に`x-test-post` / `_shared/brand` / OAuth/Vault overlapがないか確認し、競合があればSTOP。
4. production runtimeはread-only確認のみ。
5. token/secret/Vault値は読まない・表示しない。

## Authorized work

このH1で許可:
- source audit
- AI Lab専用refresh/rotation candidate実装
- unit/integration tests
- mocked X token endpoint / mocked publish endpointを使うローカルtest
- fail-closed / retry-count / rotation / duplicate-prevention tests
- implementation commitをbranchへ作成
- `.agent/CODEX_REPORT.md` とTASK metadata更新

## Prohibited

- production Edge Function deploy
- production Vault/token ref更新
- 実token refresh実行
- OAuth再々認可
- manual X post / synthetic `brand_post`
- failed row retry/backfill
- Kabumori/Mio変更
- OAuth scope変更
- legacy `oauth_token_store` fallback追加
- DB schema/migration/RPC/RLS変更
- Cron/posting window変更
- `supabase db push`
- secrets/token値の出力

## Required tests

最低限:
- access token valid -> refresh 0 / publish 1 / success
- first publish 401 -> refresh 1 -> new access -> publish retry 1 -> success
- refresh returns rotated refresh token -> both refs update through mocked persistence path
- refresh returns no new refresh token -> existing refresh ref preserved
- refresh failure -> no publish retry / fail-closed
- second publish still 401 -> stop / no second refresh / no third publish
- uncertain publish completion -> no unsafe duplicate resend
- wrong brand/account -> reject before refresh
- Kabumori/Mio/legacy token store untouched
- secret values never included in thrown/loggable errors
- existing x-test-post + `_shared/brand` regression passes
- `git diff --check`

## Completion

candidateとtestsが完成したら:
- `.agent/CODEX_REPORT.md` 先頭に新しいH1 reportを追加
- changed files / call graph / refresh decision boundary / persistence path / retry upper bound / test results / remaining production risks / exact commitを記載
- this TASKを `status: review_required`, `next_owner: chatgpt` にする
- fresh-check origin/main before push
- origin/main read-back後STOPしてC1待ち

C1前にproductionへdeploy/token mutationしてはいけない。
