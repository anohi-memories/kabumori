# Social Operations mobile app

独立したExpo Routerアプリです。既存の株価アプリ（repo root）や`apps/admin`とは別に動作します。

```bash
cd apps/social-mobile
npm install
npm run start
```

`w`でWeb、`i`でiOS、`a`でAndroidを起動できます。Phase 1はローカルmock repositoryのみを使用し、Supabase・OAuth・SNS APIには接続しません。

## Phase 2 backend boundary

`.env.example`を`.env`（またはExpoの開発環境）へコピーし、`EXPO_PUBLIC_SUPABASE_URL`と`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`だけを設定できます。service role keyやOAuth secretは絶対に設定しません。`EXPO_PUBLIC_DATA_SOURCE`は既定値`mock`です。`supabase`に変えると、ログイン後に既存`brands` / `social_accounts` / `scheduled_posts`のread-only候補をRLS付きで確認します。RLS・tenant ownershipが確認できない場合はblocked表示にして、mockデータへ黙って切り替えません。

Phase 2のログインは既存Supabase AuthのEmail/Password境界のみです。新規登録、OAuth接続、SNS投稿、Storage/AI APIはまだ行いません。

## Navigation

- ホーム: 運用状況とAI提案
- 投稿予定: 日単位の予定一覧
- AI運用相談: 会話と構造化された変更提案
- 投稿履歴: published/failedの履歴
- 設定: アカウント運用方針とプラン
- アカウント / 素材BOX: stack画面
