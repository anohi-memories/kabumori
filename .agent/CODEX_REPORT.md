# Codex Report

- task_id: important-news-safe-publish-production-activation-20260908
- result: review_required
- next_owner: chatgpt

## 結果

承認済みの`important-news-monitor`コードだけをdeployしました。ACTIVEはv31、`verify_jwt=false`です。

## Production read-back

- settings: `is_active=true`, `interval_minutes=20`, `auto_publish=true`, `luna_enabled=true`, `sol_escalation_enabled=true`
- existing ready backlog: important 23件、most_important 6件
- backlog publish_attempts: 0
- backlog x_post_id: 0
- existing Fetch/Judgement/Generation Cron: 変更なし
- publish_ready Cron: 0本

## Blocker

cutover更新に必要な本番設定SQL（`auto_publish`の一時`true -> false -> true`）は、安全ゲートにより明示的なユーザー承認不足として拒否されました。そのためcutover `updated_at`は更新しておらず、publish_ready Cronも適用していません。

明示承認が得られた場合のみ、次の順序で再開可能です。

1. `auto_publish`を一時的にfalseへ更新
2. trueへ戻し、deploy後の`updated_at`をcutoverとしてread-back
3. `generated_at < cutover` の候補が選択対象外であることを確認
4. `important-news-publish-ready` Cronを1本だけ適用

## Safety

- candidate status変更・claim・backfill・再生成: 0
- manual publish: 0
- X API / X投稿: 0 / 0
- 他Function deploy: 0
- 既存Cron変更: 0
- その他settings変更: 0
