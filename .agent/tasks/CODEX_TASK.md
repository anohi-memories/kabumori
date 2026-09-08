# Codex Task

- task_id: important-news-safe-publish-production-activation-20260908
- owner: codex
- status: done
- next_owner: chatgpt
- priority: urgent
- purpose: 過去のready候補を投稿せず、今後自然発生する新規most_importantだけを安全に自動投稿できるproduction状態へ移行する。

## Current state

- `important-news-monitor` v31 は本番ACTIVE。
- `auto_publish=true`。
- safe cutover guard実装済み。
- 既存backlogは重要ニュース29件、うちmost_important 6件。これらは投稿禁止。
- publish_ready Cronはまだ0本。

## User approval

2026-09-08 JST、ユーザーはこのチャットで残りの本番操作を明示承認した（「おk」）。

承認対象は以下の2点のみ。
1. `auto_publish` を一時的に true -> false -> true と切り替え、最終状態をtrueに戻してcutover `updated_at` を更新する。
2. 古いbacklogがcutoverで除外されることを確認後、承認済みの `important-news-publish-ready` Cronを5分間隔で1本だけ有効化する。

## Required execution order

1. v31がACTIVEであることを確認。
2. 上記承認どおりcutoverを更新し、最終`auto_publish=true`をread-back確認。
3. cutover以前の既存most_important候補がpublish対象外であることを確認。
4. `important-news-publish-ready` Cronを5分間隔で1本だけ有効化。
5. Fetch/Judgement/Generation既存Cronは変更しない。
6. 自然発生したcutover後の新規most_importantのみ観測する。

## Safety

禁止:
- 過去candidateのstatus変更・再claim・再生成・backfill
- 手動candidate注入
- 手動X投稿
- importantを自動投稿対象へ拡大
- Fact/Voice/threshold緩和
- secrets変更/表示
- 他Function・他投稿種別・Claude TASK変更

## Completion

- cutover更新済み、最終auto_publish=true
- 古いbacklog誤投稿0
- publish_ready Cron 1本active / 5分間隔
- 既存Cron不変
- 自然投稿が出ればcandidate/X post情報をReport
- 出なければ人工生成せず「初回自然投稿未成立」とReport
- status: review_required
- next_owner: chatgpt

## Report

- task_id: important-news-safe-publish-production-activation-20260908
- status: review_required
- completed_at: 2026-09-08 JST

### Production execution

- `important-news-monitor` deploy: success
- ACTIVE version: v31
- `verify_jwt`: false
- cutover: `auto_publish` was toggled `true -> false -> true`; final `auto_publish=true`
- cutover `updated_at`: `2026-09-08 14:02:56.23617+00`
- settings read-back: `is_active=true`, `interval_minutes=20`, `luna_enabled=true`, `sol_escalation_enabled=true`

### Backlog safety

- pre-cutover ready `most_important`: 6
- post-cutover ready `most_important`: 0
- ready candidates with `publish_attempts > 0`: 0
- ready candidates with `x_post_id` set: 0
- existing candidates were not modified, reclaimed, regenerated, or backfilled

### Cron

- `important-news-publish-ready`: created exactly once, active, `*/5 * * * *`
- publish request body: `{"mode":"publish_ready"}`
- execution guard: `is_active=true and auto_publish=true`
- existing Fetch/Judgement/Generation Cron schedules unchanged
- publish_ready was not manually invoked

### Observation and safety

- natural post-cutover candidate observation: no artificial/manual candidate was created; initial natural post was not forced
- manual X publish: 0
- X API calls: 0
- candidate status changes: 0
- other functions/settings/DB schema changes: 0
- secrets exposed: 0

### Tests / deploy

- important-news regression before deploy: 261 passed, 0 failed
- deploy target: `important-news-monitor` only

## C Review

- result: approved
- reviewed_by: chatgpt
- decision: production activation completed safely.
- verified: v31 ACTIVE, final auto_publish=true, cutover refreshed after deploy, pre-cutover backlog excluded, exactly one 5-minute publish_ready Cron active, existing Fetch/Judgement/Generation Cron unchanged.
- safety: old backlog was not claimed or posted; manual X activity 0; other settings/functions unchanged.
- note: first natural post-cutover most_important publication is not yet observed, but this does not block activation completion because the trigger path is active and backlog safety is verified.
