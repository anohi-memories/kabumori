# Claude Task 2

- task_id: kabumori-eas-project-and-push-runtime-prep-20260906
- owner: claude
- slot: claude-2
- status: ready
- purpose: K2承認済みのPush通知本線を土台に、Expo Push Tokenを実機で取得できるようEAS project設定を整え、`send-push-notifications`を本番deployできる直前まで安全に準備する。重要ニュースmonitor/X/Cron/DB schemaには触れない。

## Previous K2 Review

前タスク `kabumori-expo-push-foundation-mainline-20260906` は承認。

承認理由:
- commit `43a2628` がorigin/mainへ反映済み
- `expo-notifications ~57.0.17`、通知plugin、token登録hook、logout時token削除、独立Push senderが安全に本線反映
- Push関連テスト 11/11 PASS
- web/iOS export PASS
- 重要ニュース画面/RPC/monitor/X系/DB/Cronに差分なし
- 本番Edge Function deployなし
- secrets/認証情報のcommitなし

残課題:
- EAS projectId未設定で実機Expo Push Token取得未確認
- `send-push-notifications`のsecret/config/deploy未実施
- 重要ニュース→対象ユーザー→`notifications`生成接続は未実装

## Scope

- origin/main、ORCHESTRATION、CURRENT_STATE、本TASKをfresh-check
- 現在のExpo/EAS設定を確認し、既存Expo projectがあればそのprojectIdを安全に利用する
- projectIdが未作成でExpo/EASログインやユーザー操作が必要なら、勝手に別アカウント/別projectを作らず停止して必要手順をReport
- 安全に解決できる場合のみ `app.json` の `extra.eas.projectId` 等、Expo SDK57/EAS標準の最小設定を反映
- `eas.json` が必要なら最小構成のみ追加し、既存設定がある場合は壊さない
- `npx expo config --type public` / prebuild相当でprojectId・notifications設定を確認
- iOS bundle/exportを再確認
- 実機E2Eは既存安全な端末/セッションが利用できる場合のみ。資格情報新規作成・変更は禁止
- `send-push-notifications`について、既存のsecret運用と `supabase/config.toml` をread-only確認し、本番deployに必要な最小差分を特定
- secret値は表示・記録しない
- 安全に設定ファイルだけ先行commit/pushできる場合は最小差分で反映可
- 本番Edge Function deployはこのタスクでは実施しない

## Forbidden

- `supabase/functions/important-news-monitor/**`変更
- Codex現在task対象の変更
- 重要ニュース画面/RPC/migration変更
- DB migration/schema/GRANT変更
- Cron/X投稿系変更
- 本番Edge Function deploy
- secret新規値の表示/commit
- ユーザー/Expoアカウント/認証情報の勝手な作成・変更
- 他workstream差分の混入

## Completion criteria

- EAS projectIdの有無と安全な設定可否を確定
- 設定可能ならorigin/mainへ最小反映
- Expo config / iOS export結果を報告
- 実機Push Token E2Eの実施可否を報告
- `send-push-notifications`本番deployに必要なsecret/config差分を明示
- 本番deploy・DB変更・Cron/X変更なし
- 完了時status=`review_required`
- TASK末尾に `## Report` を追記
- next_owner: chatgpt

- commit: 安全に分離できるExpo/EAS設定のみ可
- push: fresh-checkで競合なければ可
- deploy: 禁止
- report_mode: inline
- next_owner: chatgpt
