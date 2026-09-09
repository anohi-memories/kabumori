# Codex Task 2

- task_id: morning-greeting-soft-copy-production-deploy-20260909
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: high
- purpose: commit `7fc7f9c` の morning_greeting 文体緩和 + 固定5タグ実装を production の `x-test-post` へ安全にdeployし、自然投稿で確認できる状態にする。

## User authorization

2026-09-09、ユーザーが明示的に「デプロイしじだして」と承認。

## Preconditions

1. `.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、このTASKを確認。
2. `origin/main` をfresh-check。
3. commit `7fc7f9c` が `origin/main` に含まれることを確認。
4. 他slotが同じ `x-test-post` Edge Functionをproduction deploy中、または同じproduction設定を変更中なら競合として停止・報告する。
5. deploy前に現在のproduction `x-test-post` version/statusを確認し、推測で旧versionを上書きしない。

## Authorized production action

- deploy対象は **`supabase/functions/x-test-post` のみ**。
- `origin/main` の最新安全状態をproductionへdeployする。
- deploy後に `x-test-post` がACTIVEであることと新versionをread-back確認する。

## Verification

最低限:
- deploy成功 / ACTIVE確認。
- morning_greetingのsoft-copy実装がproduction bundleに含まれることを確認。
- 本文validator 60〜140文字、generation target 80〜120文字、length retry最大1回を維持。
- 固定タグ `#おはよう #日本株 #日経平均 #かぶモリ #ブルバ100` の決定論的付与がproductionに入ったことを確認。
- 画像関連ロジックが今回変更されていないことを再確認。
- 既存morning_greetingスケジュールは変更しない。

## Natural observation policy

- 手動X投稿は禁止。
- 手動でmorning_greeting候補を注入しない。
- Cronやposting_windowsを変更しない。
- 次の自然morning_greetingが発生した場合のみread-onlyで、本文が柔らかい日常挨拶になっているか、固定5タグが1回ずつ付いているか、画像が従来どおりかを確認する。
- このTASK中に自然投稿がまだ発生しなくても、deployが正しく完了していれば「自然投稿未観測」と明記してreview_requiredへ進めてよい。

## Explicitly forbidden

- X実投稿 / manual publish
- 本番DB write
- Cron / scheduler / posting_windows変更
- secrets変更・表示
- OAuth変更
- 画像prompt / canonical reference / image model / quality / size変更
- `important-news-monitor`変更
- morning_report / close_reportのロジック変更
- Storage receipt 400問題の修正（別タスク）
- 他Edge Function deploy

## Completion

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- `.agent/CODEX_REPORT_2.md` 更新
- deploy前version/status
- deploy後version/status
- deploy対象
- production read-back
- natural投稿観測の有無
- X手動投稿0 / Cron変更0 / DB write0を明記
- remaining issues

## Report

- task_id: `morning-greeting-soft-copy-production-deploy-20260909`
- result: `review_required`
- deploy_target: `x-test-post` only
- source_commit: `7fc7f9c` included in `origin/main` (`c9ec4b3`)
- pre_deploy: `x-test-post` v89 ACTIVE, `verify_jwt=false`
- deploy: success with `--no-verify-jwt`
- post_deploy: `x-test-post` v90 ACTIVE, `verify_jwt=false`
- production_readback: deployed bundle contains morning greeting 60-140 validator, 80-120 target, single retry, and deterministic five-tag helper; no image-logic diff after `7fc7f9c`
- natural_observation: not performed yet
- manual_x_post: 0
- cron_change: 0
- database_write: 0
- other_function_deploy: 0
- remaining_issues: natural morning greeting observation is pending
