# Codex Task 2

- task_id: x-close-report-topix-source-correction-20260911
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol High
- purpose: X版 close_report が Yahoo `^TPX` をTOPIXとして扱っている問題を調査・修正し、誤った指数データを大引けレポートへ混入させない。既存17:00運用・Nikkei取得・Fact/Voice/X品質gateは維持する。

## Context

アプリ専用personalized reportのPhase 1B調査で、Yahoo `^TPX` は日本のTOPIXではなく、古い/別市場データを返している可能性が高いことが判明した。

現行X版 close_report (`x-test-post v96`) はTOPIX取得に `^TPX` を使っているため、誤データをTOPIXとして扱うリスクがある。

ユーザー方針:
- TOPIX問題は今夜のうちに修正着手する
- X版close_reportだけを対象に、安全に直す
- 17:00大引け運用は維持する

## Required startup checks

1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. このTASK
4. `origin/main` fresh-check
5. clean worktree確認
6. 他slot TASKをread-only確認
7. 他slotが `supabase/functions/x-test-post/**` を変更中なら競合報告して開始しない
8. 既存未コミット変更には触れない
9. deploy前に pwd / HEAD / origin/main / worktree-local config / project ref を確認する

## Phase A: root-cause confirmation

まずread-onlyで以下を確認する。

- 現在のTOPIX取得実装箇所
- Yahoo `^TPX` が何を返しているか
- symbol metadata / exchange / timestamps / data freshness
- 2026年のTOPIX値として成立しているか
- 過去のclose_reportでこの値が採用された可能性

`^TPX` が日本TOPIXでない、古い、または信頼できないと判断した場合は、TOPIXとしての利用を停止する。

## Phase B: replacement source investigation

優先順位:
1. 日本TOPIXのsame-day確定値を返す構造化・安定source
2. 既存許可sourceで直接取得できるTOPIX確定値
3. 信頼できる正式TOPIX取得元が確定できない場合は、TOPIXを無理に出さずfail-safeまたは明示的な代替ラベルにする

禁止:
- 1306 ETFを無断で「TOPIX」と表示すること
- HTMLスクレイピングに強く依存する脆い実装
- web記事本文からTOPIX終値を推測すること
- source不明の数値を使うこと

1306等のETFを使う場合は、必ず「TOPIX連動ETF」等の正しいラベルに変更し、TOPIXそのものと誤認させない。ただしX版大引けの仕様上、正式TOPIXが必要なら原則は正式TOPIX取得元を優先する。

## Phase C: implementation

要件:
- Nikkei取得は現行安全実装を維持
- TOPIXはsame JST date / numeric / source-backed / 15:30以降の確定値のみ
- stale / previous-day / unknown timestamp reject
- 取得不能時に偽のTOPIXを出さない
- 17:00 scheduler / posting_windows / Cronは変更しない
- Fact/Voice/X publish gateを緩めない
- morning_reportや他categoryへ影響を広げない

必要なら `close_report_data_logic.ts` と関連testのみ最小変更。

## Required tests

最低限:
- `^TPX` を日本TOPIXとして受理しないnegative test
- 正しいTOPIX sourceのsame-day 15:30以降accept
- 15:29以前reject
- previous-day reject
- source metadata不整合reject
- TOPIX取得不能時fail-safe
- Nikkei regression
- close report Fact/Voice regression
- targeted close-data tests
- full x-test-post regression
- changed pure modules `deno check`
- `git diff --check`

## Production safety

本番deployは、実装・テスト合格後に `x-test-post` のみ許可。

- project ref: `wsmznyzcvmuitkglfeuj`
- `--no-verify-jwt`
- deploy前 root/HEAD/config/ref確認
- deploy後 `supabase functions download x-test-post --use-api`
- runtime files byte compare
- 他Edge Function version / updated_at不変確認

禁止:
- 手動X投稿
- 同日close_report強制実行
- OpenAI/X APIの手動呼び出し
- DB schema/migration/RLS/RPC変更
- Cron/scheduler/posting_windows変更
- secrets/OAuth/Vault/social_accounts変更
- personalized-reports変更
- important-news/Push変更

## Completion

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- `.agent/CODEX_REPORT_2.md` 更新
- origin/main同期

Report必須:
- task_id
- result
- model_used
- root_cause
- old_tpx_source_behavior
- chosen_topix_source_or_fail_safe
- code_changes
- tests
- production_deploy
- deploy_verification
- unchanged_scopes
- changed_files
- commit_hash
- push
- remaining_issues
- safety_checks
- next_recommendation
