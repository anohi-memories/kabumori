# Social Operations mobile app

独立したExpo Routerアプリです。既存の株価アプリ（repo root）や`apps/admin`とは別に動作します。

```bash
cd apps/social-mobile
npm install
npm run start
```

`w`でWeb、`i`でiOS、`a`でAndroidを起動できます。Phase 1はローカルmock repositoryのみを使用し、Supabase・OAuth・SNS APIには接続しません。

## Navigation

- ホーム: 運用状況とAI提案
- 投稿予定: 日単位の予定一覧
- AI運用相談: 会話と構造化された変更提案
- 投稿履歴: published/failedの履歴
- 設定: アカウント運用方針とプラン
- アカウント / 素材BOX: stack画面
