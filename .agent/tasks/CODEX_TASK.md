# Codex Task

- task_id: x-ai-lab-vault-token-refresh-candidate-20260917
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol High
- purpose: AI Lab専用Vault-backed refresh/rotation candidate `ed796ba` のC1指摘を修正し、production統合前にfail-closed semanticsを完成させる。今回もsource/testsのみ。production deploy・token/Vault mutation・OAuth再認可は禁止。

## C1 review — 2026-09-17

**NOT PASS / focused fix required.**

良い点:
- AI Lab固定scope/account/Vault ref境界が入っている。
- 初回401時だけrefresh 1回、再publish最大1回という上限がある。
- refresh token rotation時のみrefresh token置換、非rotation時は既存refresh tokenを保持する設計。
- persistence失敗・refresh失敗・2回目401・completion uncertainはfail-closed。
- secret/provider body/Vault IDをerrorへ露出しない。
- focused 9/9、既存x-test-post + `_shared/brand` 465/465、deno check/fmt/diff-check PASS。
- production変更0件。

C1 blocker:
- `publishAiLabWithRefresh()` は初回publish結果が401以外なら、そのstatusが2xxでなくてもそのまま成功戻り値として返す。
- 例: 初回publishが400/403/429/500でも `refreshExecuted:false` の正常returnになり得る。
- helper単体としてはfail-closed契約が不完全で、将来の統合callerが非2xxを成功扱いする余地を残す。

## Required fix

`publishAiLabWithRefresh()` の初回publish判定を次の順序にする:
1. 2xx -> success return
2. 401 -> refresh 1回 -> persist -> 同じpublishを最大1回retry
3. それ以外の非2xx -> `AI_LAB_PUBLISH_FAILED:<status>` で即fail-closed。refreshしない、retryしない
4. publish call自体がthrow/結果不明 -> `AI_LAB_PUBLISH_UNCERTAIN`。refreshしない、retryしない

retry後は現行どおり2xxのみsuccess、それ以外はfail-closed。2回目refresh/3回目publishは禁止。

## Required tests

既存testsに加えて最低限:
- first publish 400 -> refresh 0 / publish 1 / fail
- first publish 403 -> refresh 0 / publish 1 / fail
- first publish 429 -> refresh 0 / publish 1 / fail
- first publish 500 -> refresh 0 / publish 1 / fail
- error messageにresponse body/provider text/token/secretが含まれない
- existing focused + full x-test-post/_shared regression pass
- deno check / deno fmt --check / git diff --check pass

## Production integration review points

今回のfix後もproductionへはまだ入れない。次C1で以下を別途確認する:
- 実Vault writer/persistence adapter
- rotated tokenの同時refresh競合対策
- completion/idempotency guardがrefresh helperより外側で維持されること
- current X OAuth client authentication方式との整合
- Kabumori/Mio/legacy `oauth_token_store` 非影響

## Mandatory safety

開始前に `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, `.agent/CODEX_REPORT.md`, fresh `origin/main` とH2/G1/G2競合を確認。

許可:
- `ed796ba` candidateの上記focused修正
- tests追加/修正
- local verification
- implementation commit/report metadata更新

禁止:
- production Edge Function deploy
- production Vault/token ref更新
- 実refresh token call
- OAuth再認可
- manual/synthetic X post
- failed row retry/backfill
- Kabumori/Mio変更
- scope変更
- DB schema/migration/RPC/RLS変更
- Cron/window変更
- `supabase db push`
- secret/token/Vault値の出力

## Completion

修正とtests完了後:
- `.agent/CODEX_REPORT.md` 先頭にC1 follow-up reportを追加
- exact commit / changed files / first-non401-non2xx behavior / retry upper bound / tests / production changes=0を記録
- this TASKを `status: review_required`, `next_owner: chatgpt` にする
- fresh origin/main確認後にmetadata同期し、read-backしてC1待ちでSTOP。
