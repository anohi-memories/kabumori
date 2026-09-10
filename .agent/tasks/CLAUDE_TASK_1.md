# Claude Task 1

- task_id: important-news-push-producer-wire-20260910
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus 5
- purpose: 既に完成したPush dispatcher基盤へ、重要ニュースの公開成功時に本人/対象ユーザー向け `notifications` 行を安全に生成するproducerを接続し、自然発生の重要ニュースが自動Pushまで流れる経路を完成させる。

## Context

直前タスク `push-dispatcher-cron-enable-20260910` はChatGPTレビューで承認済み。

確認済み:
- iOS実機Push E2E 1〜9 PASS
- `send-push-notifications` 本番deploy済み
- APNs / Expo Push credentials設定済み
- `device_push_tokens` への本人端末登録済み
- dispatcher Cron `send-push-notifications-dispatch` は毎分active
- Cron自然実行でpending通知を拾い実機着信までPASS
- producer側は未接続で、通常運用では `notifications` 行が自動生成されない
- dispatcherには原子的claimが無いという既知課題があるが、今回はproducer接続を主目的とし、無関係な大改修はしない

## Model

このタスクは `important-news-monitor` の公開確定ロジック、DB通知queue、ユーザー対象判定、本番Edge Function deployをまたぐため **Opus 5を使用する**。Sonnet系へ落とさない。

## Required startup checks

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `origin/main` fresh-check
6. 共有worktreeの未コミット変更確認
7. `.agent/tasks/CODEX_TASK.md` / `.agent/tasks/CODEX_TASK_2.md` / `.agent/tasks/CLAUDE_TASK.md` をread-only確認
8. 他slotが `important-news-monitor/**`, `notifications` producer, 同じmigration/RPC/production設定を変更中なら開始せず競合報告
9. `important-news-monitor` 現行productionのpublish確定経路とDB schemaを先に監査
10. `send-push-notifications` / `notifications` / `alert_settings` の現在仕様をread-only確認

既存未コミット変更は他workstream所有として扱い、変更・stage・commitしない。

## Goal

重要ニュースが**本当にpublish成功した時だけ**、Push対象ユーザー向け `notifications` 行を重複なく生成し、既存dispatcher Cronが自動配送できる状態にする。

今回の対象は **important_news producerのみ**。
朝刊・大引け・useful tip・morning greeting等は触らない。

## Phase 1: Existing design audit

実装前に以下を確認し、最小安全案を決定する。

- `important-news-monitor` で候補生成→判定→公開claim→X投稿成功→published確定までのauthoritative state
- `important` / `most_important` のpublish条件
- 既存のuser/holding関連テーブルと、重要ニュースをどのユーザーへ届けるべきか判断できる情報
- 現在ユーザーが1人でも、将来複数ユーザーになった時に全員一律Pushにならない設計にできるか
- `notifications` schema（title/body/source_type/source_id/push_status等）
- `alert_settings` のimportant_news opt-outとの責務分担
- 同じimportant newsを複数回producer実行しても通知行が重複しない方法
- X投稿失敗/Fact fail/Voice fail/hold/cooldown/rejected候補では通知を作らないこと

### User targeting

優先順位:
1. 既存DBに「保有銘柄/監視対象」とcandidateの銘柄/コードを安全に対応付ける既存方式があるなら再利用
2. 既存の明確な対象判定方式が無い場合、勝手に全ユーザー配信へ広げない
3. 最小安全な対象判定が作れない場合はPhase 1で停止し、具体的な不足schema/情報をReportする

テスト時に本人だけと断定できる場合は本人対象のself-test可。

## Phase 2: Producer implementation

安全案が確立した場合のみ実装する。

必須:
- publish成功のauthoritative point以後でのみ通知enqueue
- `source_type='important_news'`
- `source_id` 等で元ニュースを一意に追跡可能
- title/bodyは既存の公開済みニュース内容を再利用し、別AI生成を追加しない
- enqueue失敗でXの既存publish成功を巻き戻したり二重X投稿を誘発しない
- producer再実行時にduplicate notificationを作らない
- `push_status='pending'` で既存dispatcherへ渡す
- 既存 `alert_settings` の送信時opt-outを壊さない

必要なら最小migration/index/constraint/RPCを追加してよいが、既存schemaで安全に実現できるなら追加しない。

## Phase 3: Tests

最低限以下を固定する。

- published重要ニュース → 1件enqueue
- same source再実行 → duplicate 0
- publish未成功 → enqueue 0
- important/most_importantの対象条件が既存仕様どおり
- 対象外ユーザー → enqueue 0
- enqueue失敗時に既存publish状態を壊さない
- title/body/source metadataがdispatcher互換
- `git diff --check`
- important-news-monitor既存回帰テスト

## Production / deploy

安全確認とテストPASS後に限り、今回のproducer接続に必要な **`important-news-monitor` のみ** 本番deployしてよい。

許可:
- `important-news-monitor` の最小変更/deploy
- producerに不可欠な最小migration/index/constraint/RPC（必要時のみ）
- commit/push/production apply

禁止:
- `send-push-notifications` のコード変更/deploy
- dispatcher Cron変更
- `x-test-post`変更/deploy
- stocks sync変更/deploy
- morning/close producer変更
- Push文面を別AIで生成
- Apple/EAS/APNs変更
- OAuth/secrets変更
- unrelated migration
- 手動X投稿
- 既存backlogの大量Push

## Production proof

本番deploy後:

1. producerがactive codeに入っていること
2. 過去backlogを一括enqueueしないこと
3. 自然発生の新しい重要ニュースで `notifications` が1件生成されることを優先してread-only観測
4. そのnotificationを既存dispatcher Cronが自然に拾うこと
5. 対象が本人端末だけと安全に確認できる場合のみ実機Push着信まで確認
6. duplicate notification / duplicate Pushがないこと

自然発生を待てない場合のself-testは、既存のpublish stateを捏造せず、producer pure logic / isolated DB testを優先する。productionへ偽important-news candidateを注入しない。

## Completion

終了時:
- `status: review_required`
- `next_owner: chatgpt`
- このTASK末尾に `## Report` を追記
- `.agent/ORCHESTRATION.md` 規定どおり同期

Report必須:
- task_id
- result
- model_used
- existing_publish_path
- user_targeting_design
- duplicate_prevention
- changed_files
- migrations/RPC/index（あれば）
- tests
- deploy/version
- production proof
- natural notification enqueue確認
- dispatcher自然配送確認
- 実機着信確認有無
- backlog safety
- commit_hash
- push
- remaining_issues
- safety_checks
- next_recommendation
