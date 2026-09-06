# Claude Task 2

- task_id: kabumori-push-settings-enforcement-20260907
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
- priority: high
- purpose: 既存の`alert_settings`を実際のPush送信判定に接続し、将来ユーザーが通知ON/OFFを変更したとき本当に効くバックエンド経路を作る。Codexのimportant-news-monitor作業とは競合させず、`send-push-notifications`側だけで完結できる最小実装を優先する。

## Background

前タスクでは通知設定UIを追加したが、`alert_settings.important_news` / `push_enabled`を通知生成・送信側が読んでおらず実際には効かなかったため、K2レビューでUIを撤回した。

今回は先にバックエンド側で設定を本当に効かせる。UI再導入は、このタスクで安全な送信制御が成立した後の別タスクとする。

## First checks

1. `.agent/ORCHESTRATION.md` と `.agent/CURRENT_STATE.md` を読む。
2. 最新`origin/main`とworktree dirty/stale状態を確認する。
3. Codex task `important-news-freshness-coverage-fix-20260906` の対象 `supabase/functions/important-news-monitor/**` には触れない。
4. `supabase/config.toml` はstocks sync側の未コミット差分と競合し得るため変更しない。
5. 他workstreamの未コミット差分を変更・stage・commitしない。

## Scope

主対象:
- `supabase/functions/send-push-notifications/**`
- その既存unit test / logic test

### A. alert_settings enforcement

`send-push-notifications`がpending通知を送る直前に、通知対象ユーザーの`alert_settings`を確認する。

最低限:
- `push_enabled = false` ならPush送信しない
- `source_type = 'important_news'` の通知は `important_news = false` ならPush送信しない
- `alert_settings`行が存在しないユーザーは既存default（true相当）として扱い、既存ユーザーへのPushを意図せず止めない
- 本人以外の設定を誤って参照しない

### B. skipped扱いの安全設計

設定OFFで送らない通知をどう扱うか、既存schema/状態遷移を確認して最小で安全な方法を採用する。

要件:
- 毎回同じpending通知を拾い続けて無限再試行しない
- 「送信失敗」と誤分類しない
- 既存schemaだけで明確なskipped状態を表現できない場合は、勝手にmigrationせずReportする
- 必要なら既存`push_status`の許容値・更新方式を確認し、互換性を壊さない範囲で扱う

### C. tests

最低限以下を追加/確認:
- settings rowなし → 送信対象
- push_enabled=true / important_news=true → 送信対象
- push_enabled=false → 非送信
- important_news=false + source_type=important_news → 非送信
- important_news=false + 将来の別source_type → push_enabled=trueならsource固有設定が無い限り既存挙動を維持
- 複数ユーザー混在時に設定が交差しない
- DeviceNotRegistered等の既存処理を壊さない

## Explicitly out of scope

- `important-news-monitor/**`
- DB migration / DDL / GRANT
- `supabase/config.toml`
- production deploy
- Supabase secret設定
- Cron変更
- X投稿系
- auto_publish変更
- Apple Developer / EAS build / 実機Push E2E
- 通知設定UIの再導入

## Validation

- relevant push logic tests PASS
- TypeScript/Deno check可能な範囲で確認
- 既存pending→send→success/failure処理のregression確認
- production変更なし

## Completion criteria

- `alert_settings.push_enabled` / `important_news`が実際のPush送信判定に反映されるローカル実装完了
- 非送信時の状態遷移が安全、またはschema制約で安全に完了できない場合はmigrationせず明確にReport
- テスト結果・変更ファイル・残課題をReport
- 安全ならcommitし、`.agent`運用ルールに従ってorigin/mainへ同期
- TASK末尾に`## Report`追加
- status: review_required
- next_owner: chatgpt
- control-plane更新をorigin/mainへ同期してからK2可能と報告
