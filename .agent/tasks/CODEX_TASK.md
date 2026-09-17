# Codex Task

- task_id: x-ai-lab-vault-token-refresh-integration-candidate-20260917
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol High
- purpose: C1 PASS済みのAI Lab専用Vault-backed refresh/rotation helperを、production deployせずに現行`x-test-post`へ安全に統合するcandidateを作る。実Vault writer/persistence adapter、同時refresh競合、completion/idempotency境界を実装・検証し、production反映前に再度C1へ戻す。

## C1 review — 2026-09-17

**PASS — source candidate / focused fail-closed fix approved.**

承認対象:
- base candidate: `f22e2ca` (`Add AI Lab Vault token refresh candidate`, rebased branch)
- focused fix: `09a199af492510d091d4697cfc10ce13fbf52c97` (`Fail closed on initial AI Lab publish errors`)

確認済み:
- 初回publish 2xxのみsuccess。
- 初回401のみrefreshを1回実行し、persist後に同一publishを最大1回retry。
- 初回400/403/429/500等の401以外non-2xxは`AI_LAB_PUBLISH_FAILED:<status>`で即fail-closed。refresh 0 / retry 0。
- publish throw/結果不明は`AI_LAB_PUBLISH_UNCERTAIN`でfail-closedし、refreshしない。
- retry後も2xxのみsuccess。2回目refresh / 3回目publishなし。
- refresh token rotation時だけ新refresh tokenを保存し、非rotation時は既存refresh tokenを保持。
- persistence失敗・refresh失敗・2回目401もfail-closed。
- fixed AI Lab brand/account/handle境界を維持し、Kabumori/Mio/legacy token storeへfallbackしない。
- focused 13/13、x-test-post + `_shared/brand` regression 469/469、deno check/fmt/diff-check PASS。
- production deploy/token/Vault/OAuth/DB/Cron/post変更0件。

## Goal

production deploy前に、承認済みhelperを現行AI Lab live routeへ統合できるcandidateを完成させる。

必須:
1. 現行`x-test-post` AI Lab branchのcompletion/idempotency guardを最外周に維持したまま、publish内部だけrefresh helperを使用する。
2. AI Lab専用Vault access/refresh refsだけを読み書きするpersistence adapterを実装する。
3. access token更新と、Xがrotationした場合のrefresh token更新を同じ固定AI Lab refsへ安全に保存する。
4. Kabumori/Mio/legacy `oauth_token_store`へ一切fallbackしない。
5. 同一slot/並行実行で複数refreshが競合して古いrefresh tokenを上書きしない設計にする。必要ならcompare-and-set/guarded write candidateを設計するが、production schema/RPC変更はまだ行わない。
6. refresh後のpublish retryでも既存fingerprint/terminal completion/no-duplicate保証を壊さない。
7. token/secret/Vault ID/provider bodyをlogs/errors/reportへ出さない。
8. refresh client authentication方式を現行X OAuth実装と整合させる。

## Mandatory startup / safety

開始前に:
1. `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, `.agent/CODEX_REPORT.md` を読む。
2. fresh `origin/main` を確認。
3. H2/G1/G2に`x-test-post` / `_shared/brand` / OAuth/Vault overlapがあればSTOP。
4. deployed runtimeとVault/RPCはread-only確認のみ。
5. secret/token/Vault値は読まない・表示しない。

## Authorized work

- source audit
- approved refresh helperの`x-test-post`統合candidate
- AI Lab専用Vault persistence adapter candidate
- concurrency/rotation guard candidate
- local/mock tests
- existing regression tests
- implementation branch commit
- `.agent/CODEX_REPORT.md` / this TASK metadata更新

## Prohibited

- production Edge Function deploy
- production Vault/token ref mutation
- 実refresh token call
- OAuth再認可
- manual/synthetic X post
- failed row retry/backfill
- Kabumori/Mio変更
- OAuth scope変更
- legacy `oauth_token_store` fallback追加
- production DB schema/migration/RPC/RLS変更
- Cron/posting window変更
- `supabase db push`
- secrets/token/Vault値出力

## Required tests

最低限:
- valid token -> publish 1 / refresh 0
- 401 -> refresh 1 / guarded persist / publish retry 1 / success
- rotated refresh token -> fixed AI Lab refsだけ更新
- no rotation -> existing refresh ref preserved
- persistence failure -> no retry publish
- concurrent/stale refresh write -> unsafe overwriteを防止
- second publish non-2xx -> stop、no second refresh/no third publish
- uncertain publish completion -> no refresh/no resend
- completion/fingerprint exactly-once behavior remains intact
- wrong brand/account -> refresh/persist前にreject
- Kabumori/Mio/legacy token store untouched
- secret-safe errors/logs
- full `x-test-post` + `_shared/brand` regression
- deno check / fmt / `git diff --check`

## Completion

candidate完成後:
- `.agent/CODEX_REPORT.md` 先頭にintegration candidate reportを追加
- exact commit / changed files / call graph / Vault writer / concurrency strategy / retry upper bound / idempotency evidence / tests / remaining production risks / production changes=0を記録
- this TASKを `status: review_required`, `next_owner: chatgpt`
- fresh origin/main確認後にmetadata同期、origin/main read-backしてC1待ちでSTOP

**C1前にproduction deploy/token mutationを行ってはいけない。**
