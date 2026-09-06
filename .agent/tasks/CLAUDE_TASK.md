# Claude Task 2

- task_id: kabumori-mvp-completion-nonapple-20260907
- owner: claude
- slot: claude-2
- status: done
- next_owner: chatgpt
- priority: high
- purpose: Kabumori MVPのApple加入不要部分を完成に近づける。前回実装 `24ee8bb` のK2レビューで1点修正必須となったため、そこだけ安全に是正する。

## K2 Review

- decision: approved
- reviewed_by: chatgpt
- reviewed_commit: `b6814fa`
- result:
  - 前回blocking issueだった「保存できるが実際の通知停止には効かない通知設定UI」は撤回され、誤解を招く非機能トグル問題を解消
  - `b6814fa` の差分は `src/app/explore.tsx` の通知設定導線撤回、`src/components/notification-settings.tsx` 削除、`src/lib/alert-settings.ts` 削除のみで、修正範囲は最小
  - 前回承認済みの Push tap → `/news`、重要ニュース閲覧時の既読化は維持
  - iOS/web export PASS、新規TypeScriptエラーなし
  - `important-news-monitor/**`、DB migration/schema/GRANT、Cron、X投稿系、Apple有料領域、本番Edge deployには触れていない
- remaining:
  - 通知設定ON/OFFを実際に効かせるには、将来 `important-news-monitor` または `send-push-notifications` 側で `alert_settings` を読むロジックを追加してからUIを再導入する
  - 実機Push E2E / EAS development buildはユーザー方針どおり保留
  - ログイン後の新規導線の目視確認は認証資格情報がないため未実施
- next_owner: chatgpt
