# Claude Task 1

- task_id: push-dispatcher-cron-enable-20260910
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus 5
- purpose: 実機E2Eまで完了した `send-push-notifications` を、安全な定期実行Cronへ接続し、`notifications.push_status=pending` が本番で自動配送される基盤を完成させる。

## Context

直前タスク `expo-ios-push-e2e-resume-20260910` は完了済み。

確認済み:
- iOS development build / 実機インストール成功
- Expo Push Token取得・`public.device_push_tokens`保存成功
- APNs Key設定済み
- `send-push-notifications` 本番deploy済み（v1）
- `SEND_PUSH_NOTIFICATIONS_CRON_SECRET` 本番secret設定済み
- background / foreground / tap-to-`/news` / cold launch を含むPush E2E 1〜9すべてPASS
- テスト用notifications行はクリーンアップ済み
- 現在 `send-push-notifications` はCron未接続で、手動invokeのみ動作確認済み

前タスク完了commit/report: `0bfbe37c459f36ee524d54849f7db6264e99bfb8`。

## Model

このタスクはproduction Cron、認証secret、DB queue、Push配送の安全性をまたぐため **Opus 5を使用する**。Sonnet系へ落とさない。

## Required startup checks

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `origin/main` fresh-check
6. 共有worktreeの未コミット変更確認
7. `.agent/tasks/CODEX_TASK.md` / `.agent/tasks/CODEX_TASK_2.md` / `.agent/tasks/CLAUDE_TASK.md` をread-only確認し、同じCron / migration / `send-push-notifications` / production設定を他slotが変更中でないことを確認
8. `send-push-notifications` 現行本番実装と認証方式を再確認
9. 既存のSupabase Cron / pg_cron / pg_net / Vault等の運用パターンをrepo内とproduction metadataで確認

既存未コミット変更は他workstream所有として扱い、変更・stage・commitしない。
競合があれば開始せず、具体的な競合箇所をReportする。

## Goal

`notifications.push_status='pending'` の通知が、人手でFunctionを叩かなくても安全に `send-push-notifications` へ流れ、自動配送される状態を作る。

今回は **dispatcherの自動実行だけ** が対象。
重要ニュース・朝刊・大引け等が `notifications` 行を新規生成するproducer側の変更は今回行わない。producer wiringは別タスクに分離する。

## Phase 1: Existing design audit

まず実装せず、以下を確認して最小安全案を決める。

- `send-push-notifications` の認証方式（`X-Cron-Secret` / `SEND_PUSH_NOTIFICATIONS_CRON_SECRET`）
- pending選択条件
- `alert_settings` opt-out
- sent / failed状態遷移
- retryable / permanent failure分類
- 同時実行時の二重送信耐性
- 1回の最大batch / timeout / rate limit
- pending=0のとき安全にno-opになること
- 既存Cronの命名・頻度・HTTP invokeパターン
- secretをmigration SQLやGitへ平文保存せずに呼び出せる方法

### Security requirement

`SEND_PUSH_NOTIFICATIONS_CRON_SECRET` の値を:
- Git
- migration SQL本文
- Report
- shell historyを意図的に残す形
- DBの一般テーブル
へ平文保存してはいけない。

既存の安全なVault/secret参照パターンがあるなら再利用する。
安全にsecretを参照できる既存パターンがない場合は、勝手に弱い方式でCronを作らず停止して設計案をReportする。

## Phase 2: Cron implementation

安全案が確立できた場合のみ実装する。

推奨要件:
- 1分間隔を第一候補とする（重要ニュースPushの遅延を小さくするため）
- 毎回 `send-push-notifications` を1回invoke
- pending=0ならno-op
- Cronの重複jobを作らない
- 既存jobがあれば安全に再利用/置換し、同一Functionを二重スケジュールしない
- auth secretを安全に付与
- Cron失敗が他のX投稿/重要ニュース監視Cronへ波及しない

頻度を1分以外にする合理的理由がある場合は、その理由をReportする。

## Phase 3: Verification

### Before production enable

- `send-push-notifications` targeted testsを再実行
- Cron SQL / helper logicがある場合は可能な範囲でテスト
- `git diff --check`
- secret漏洩がdiff/logにないことを確認
- productionの既存Cron一覧を確認し、同名/同目的jobがないことを確認

### Production enable

このTASKでは、上記安全確認がPASSした場合に限り、**`send-push-notifications`のdispatcher Cronだけ本番有効化してよい**。

許可:
- このdispatcher Cronに必要な最小migration / Cron設定
- 必要なら既存の安全なVault参照設定
- このタスク専用の最小helper RPC/function（どうしても必要な場合のみ。既存方式で不要なら作らない）
- commit / push / production apply

禁止:
- `send-push-notifications`以外のEdge Function変更/deploy
- `x-test-post`変更/deploy
- `important-news-monitor`変更/deploy
- stocks sync系変更/deploy
- morning/close producer変更
- alert_settings仕様変更
- Push文面仕様変更
- OAuth変更
- Apple/EAS/APNs credential変更
- 既存secretのrotate/revoke
- App Store submit
- unrelated migration

## Phase 4: End-to-end Cron proof

Cron有効化後、以下を確認する。

1. Cron jobがactive
2. 予定間隔で実行される
3. pending=0時に安全にno-op
4. Function側で401にならず認証成功
5. Function runtime errorなし
6. 二重Cron / 二重配送なし

### Safe self-test

自然なpending通知がまだ無い場合に限り、次の条件をすべて満たす場合は本人端末だけへのテスト通知を1件作成してよい。

- `device_push_tokens` の対象端末/ownerを特定できる
- 他ユーザーのpendingが0件であることを実行直前に確認
- タイトル/本文に明確な `【自動Pushテスト】` 表記
- 手動でFunctionをinvokeせず、**Cronが自然に拾って送ること**を証明する
- 実機着信まで確認
- テスト行は確認後削除
- 他人の端末へ送らない

他ユーザーのpendingが存在する、または安全に本人だけと断定できない場合はテスト行を作らずread-only検証で止める。

## Important non-goal

今回Cronをつないでも、重要ニュース/朝刊/大引け等が自動で`notifications`を生成していない場合、それらのPushはまだ自動化完了ではない。

TASK終了時に必ず:
- dispatcher Cronだけ完成したのか
- producer側も既に自然にnotificationsを作っているのか
をread-onlyで調査し、明確に区別してReportする。

producer側が未接続なら、次タスク候補として具体的に提示するが、今回勝手に変更しない。

## Completion

終了時:
- `status: review_required`
- `next_owner: chatgpt`
- このTASK末尾に `## Report` を追記
- `.agent/ORCHESTRATION.md`規定どおり同期

Report必須:
- task_id
- result
- model_used
- existing_design_audit
- chosen_cron_design
- cron_frequency
- changed_files
- migrations / production changes
- secret_handling（値は絶対に書かない）
- tests
- production Cron job name / active state
- Cron自然実行確認
- self-test実施有無と結果
- duplicate prevention確認
- producer側の現状（read-only）
- commit_hash
- push
- remaining_issues
- safety_checks
- next_recommendation
