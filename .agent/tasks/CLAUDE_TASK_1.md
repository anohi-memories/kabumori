# Claude Task 1

- task_id: x-test-post-deploy-verify-20260907
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
- priority: high
- purpose: K1承認済みcommit `a1d2735` の `x-test-post` 改修を本番へ反映し、安全なdry-run/read-only確認で動作確認する。

## Approved baseline

前タスク `morning-content-resilience-20260907` はK1承認済み。

- approved commit: `a1d2735`
- origin/mainへpush済み
- morning_greeting: validator 100〜300文字、generation target 120〜200文字
- morning_report: 「気になるところです」等の通常の相場コメントを許容
- morning_report: Voiceのみfail時、同一実行内で最大1回だけ限定rewrite→再検証
- morning_report: 末尾へ `#日本株 #日経平均 #株式投資 #かぶモリ` をコード側で1回付与
- 前タスク: 316 passed / 0 failed、今回起因の新規type/lint error 0

## Start checks

1. `origin/main` をfresh-checkし、`a1d2735` が含まれることを確認する。
2. `.agent/ORCHESTRATION.md` / `.agent/CURRENT_STATE.md` / このTASKを確認する。
3. 他workstreamの未コミット変更には触れない。
4. Codex担当 `important-news-monitor`、Claude slot 2担当領域には触れない。
5. deploy前に現在のSupabase CLI helpを確認し、現行構文に従う。

競合やmain driftがあればdeployせず報告する。

## Required work

### 1. `x-test-post` のみ本番deploy

承認済みorigin/mainの `supabase/functions/x-test-post/**` を本番 `x-test-post` Edge Functionへdeployする。

今回許可するproduction変更は **`x-test-post` のdeployだけ**。

禁止:
- DB migration / schema / GRANT変更
- Cron変更
- secrets変更・表示
- production settings変更
- Xへの実投稿
- 2026-09-07のfailed morning_report / morning_greetingの再実行・再claim・削除・status変更

### 2. deploy確認

read-onlyで以下を確認する。

- `x-test-post` がACTIVE
- versionが旧v87より新しい
- deployed sourceに承認済み3点が含まれる
  - morning_greeting 100〜300 / target 120〜200
  - morning_report Voice誤判定修正＋最大1回rewrite
  - 固定4タグ共有・朝刊への付与

### 3. morning_report dry-run

**X投稿しない既存dry-runモードであることをコード上で確認してから**実行する。

確認:
- generation / format / fact / Voice pipelineの結果
- 「気になるところです」等を単独でfabricated personal state扱いしないこと
- Voice first passならrewriteしないこと
- 最終dry-run本文の末尾に固定4タグがちょうど1回あること
- Voice fail時は可能な範囲でrewrite diagnosticsを確認する

X投稿される可能性があるモードは使わない。

### 4. morning_greeting dry-run

X投稿しないpayload dry-run等を使う。

確認:
- validator 100〜300
- generation target 120〜200
- 生成文字数
- 「おはよう」必須・theme整合・架空実体験/未確認天気/投資助言/架空記念日/URL・hashtag禁止の既存安全策を維持

### 5. 副作用確認

作業後read-onlyで確認:
- 新規X post idなし
- 今日のfailed postを再投稿・再claimしていない
- DB/Cron/secrets/settings変更なし

## Failure policy

- 同じ失敗操作を3回以上繰り返さない。
- 追加コード修正が必要と判明した場合、本番hotfixせず `review_required` で報告する。
- dry-runを通すために設定やDBを変更しない。

## Completion

完了時、このファイル末尾に `## Report` を追記する。

必須項目:
- task_id
- result
- deployed_from_commit
- deployed_function_version
- deploy_result
- morning_report_dry_run_result
- morning_report_hashtags_check
- morning_report_voice/rewrite diagnostics（取得できる範囲）
- morning_greeting_dry_run_result
- morning_greeting_character_count
- x_post_created: yes/no
- production_side_effects
- tests/checks
- remaining_issues
- safety_checks
- next_recommendation

完了後:
- status: `review_required`
- next_owner: `chatgpt`
- `.agent/` Report/statusをGitHubへ同期
- deploy: 今回は `x-test-post` のみ許可
- X actual post: 禁止
