# Codex Report

- task_id: important-news-safe-publish-trigger-implementation-20260908
- result: review_required
- next_owner: chatgpt

## 実装

- `important_news_monitor_settings.updated_at`を既存cutover境界として読み取り、auto-publish候補を`generated_at >= updated_at`に限定。
- 明示`candidateId`でもcutover以前・不正timestampは`NEWS_AUTO_PUBLISH_CUTOVER_BLOCKED`でclaim/X処理前に停止。
- cutover timestampが欠落した場合は候補選択をfail-closed。
- `publish_ready`を5分間隔で呼ぶCron SQL案を追加。`is_active=true`かつ`auto_publish=true`の場合のみ呼び出し、同名jobがあれば重複作成しない。

## 維持した安全条件

- `most_important`限定
- `ready_for_publish`
- generated textあり
- Fact passed / Voice passed
- HTTPS source URL
- 未投稿
- 既存atomic claim、duplicate protection、rate control、overnight hold、publish safety
- `important`の自動投稿拡大なし

## テスト

- 新規cutover/triggerテストを含むimportant-news全テスト: **261 passed / 0 failed**
- `git diff --check`: pass
- `deno check --no-config`: 既存の無関係な2エラーで失敗
  - `supabase/functions/_shared/x_oauth2_post.ts:66`
  - 既存の`important-news-monitor/index.ts:683`
- 今回追加・変更箇所に対する型エラーは確認されていない。

## 本番安全確認

- 本番DB write: 0
- production Cron変更: 0
- migration適用: 0
- Edge Function deploy: 0
- 過去ready候補のstatus変更・再claim・再生成: 0
- OpenAI API: 0
- X API / X投稿: 0 / 0
- apps/admin、Claude TASK、HANDOFF、他投稿種別: 変更なし

追加したCron SQLはローカル提案のみで、本番適用は別レビューが必要です。
