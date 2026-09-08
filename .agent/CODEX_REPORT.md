# Codex Report

- task_id: important-news-safe-publish-production-activation-20260908
- result: review_required
- next_owner: chatgpt
- completed_at: 2026-09-08 JST

## Result

明示承認された順序で、safe cutoverとpublish_ready Cronを本番反映しました。

### Deploy

- `important-news-monitor`のみdeploy成功
- ACTIVE version: v31
- `verify_jwt=false`
- deploy前のimportant-news regression: 261 passed / 0 failed

### Cutover settings

- `auto_publish`: `true -> false -> true`を実施
- 最終 `auto_publish=true`
- `updated_at` cutover: `2026-09-08 14:02:56.23617+00`
- `is_active=true`
- `interval_minutes=20`
- `luna_enabled=true`
- `sol_escalation_enabled=true`

### Backlog exclusion

cutover前の既存ready候補は投稿対象から除外されることを確認しました。

- pre-cutover ready `most_important`: 6
- post-cutover ready `most_important`: 0
- ready candidates with `publish_attempts > 0`: 0
- ready candidates with `x_post_id`: 0
- 既存候補のstatus変更・再claim・再生成・backfill: 0

### Cron

`important-news-publish-ready`を1本だけ作成しました。

- schedule: `*/5 * * * *`
- active: true
- body: `{"mode":"publish_ready"}`
- SQL側guard: `is_active=true and auto_publish=true`

既存の以下3本は変更していません。

- Fetch: `0,20,40 * * * *`
- Judgement: `7,27,47 * * * *`
- Generation: `14,34,54 * * * *`

### Safety / observation

- publish_ready手動実行: 0
- 人工candidate作成: 0
- 手動X投稿: 0
- X API呼び出し: 0
- X投稿: 0
- 自然発生のpost-cutover候補は今回の確認時点で未成立（人工生成・再処理はしていません）
- 他Function・他settings・DB schema・既存candidateへの変更: 0
- secret露出: 0
