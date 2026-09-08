# Codex Report

- task_id: important-news-auto-publish-enable-20260908
- result: review_required
- next_owner: chatgpt

## 結果

`auto_publish=true` は維持されているが、現行の正式repoと本番DB/Cronを調査した結果、important-newsの `publish_ready` を自然に起動する正規経路は確認できなかった。

## 調査結果

- `important-news-monitor` の `mode=publish_ready` 分岐は存在するが、呼び出し元は現行コード内で確認できない。
- Generation完了時は候補を `ready_for_publish` にできるが、publish処理へ自動dispatchする実装はない。
- 本番CronはFetch/Judgement/Generationの3本のみ。`publish_ready` Cronは0本。
- `dispatch-scheduled-posts` はx-test-postを呼ぶscheduled_posts用で、important-newsの `publish_ready` は呼ばない。
- したがって、推測で新規Cronや別dispatcherを追加せず、今回は停止した。

## 安全条件・本番状態

- ACTIVE: `important-news-monitor v30`, `verify_jwt=false`
- settings: `is_active=true`, `interval_minutes=20`, `auto_publish=true`, `luna_enabled=true`, `sol_escalation_enabled=true`
- publish eligibility: `most_important`、`ready_for_publish`、generated textあり、Fact passed、Voice passed、HTTPS source URL、未投稿
- `important` は自動投稿対象外
- ready_for_publish: 29件（important 23件、most_important 6件）
- publish_attempts>0: 0件
- x_post_idあり: 0件
- 過去candidateのstatus変更・再claim・再生成・手動投稿: 0件

## 実施・未実施

- 追加production write: 0
- code変更: 0
- deploy: 0
- Cron変更: 0
- migration/DDL/GRANT: 0
- OpenAI API: 0
- X API/X投稿: 0/0
- secrets表示・変更: 0
- apps/admin・HANDOFF.md・他投稿種別: 変更なし

## 次の判断

自然な重要ニュース自動投稿を実現するには、既存設計に沿った `publish_ready` 起動経路（コード内dispatchまたは明示的Cron等）を別タスクで設計・レビューする必要がある。今回は正規経路が特定できないため実装・設定追加は行わない。
