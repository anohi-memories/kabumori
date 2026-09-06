# Claude Task 2

- task_id: kabumori-eas-project-and-push-runtime-prep-20260906
- owner: claude
- slot: claude-2
- status: done
- purpose: K2承認済みのPush通知本線を土台に、Expo Push Tokenを実機で取得できるようEAS project設定を整え、`send-push-notifications`を本番deployできる直前まで安全に準備する。重要ニュースmonitor/X/Cron/DB schemaには触れない。

## K2 Review

- decision: approved
- reviewed_by: chatgpt
- result:
  - EAS/Expoの既存ログイン・projectIdが存在しないため、安全ルールどおりユーザー操作待ちで停止した判断を承認
  - `app.json` / `eas.json` を勝手に作成・変更せず、Expoアカウント/projectを新規作成しなかったことを確認
  - iOS export PASS
  - `send-push-notifications` deployに必要なsecret/config/deploy差分をread-onlyで特定
  - 本番DB / Edge Function deploy / Cron / X / important-news-monitor / Codex対象には変更なし
- remaining:
  - ユーザー本人によるExpoログインとEAS project作成
  - `extra.eas.projectId`反映後の実機Push Token E2E
  - `send-push-notifications`のsecret/config/deployは別タスク
  - `supabase/config.toml`はstocks sync側未コミット差分と競合し得るため、次タスクでfresh-check必須
- next_owner: user

このタスクは完了とする。ユーザー側のExpo/EAS操作が終わるまで、slot2で次の実装タスクは開始しない。
