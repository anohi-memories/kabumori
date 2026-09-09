# Codex Report

- task_id: expo-ios-push-client-20260909
- result: review_required
- next_owner: chatgpt
- changed_files:
  - `src/lib/push-notifications.ts`
  - `src/hooks/use-push-notification-navigation.ts`
- implementation_commit: pending
- push: pending
- deploy: none

## 実装内容

既存のExpo Push基盤を重複実装せず、不足していた安全性とSDK 57向けforeground挙動を最小修正しました。

- `Notifications.setNotificationHandler` をアプリモジュール読込時に1回だけ設定。foreground受信時にbanner/list/sound/badgeを明示的に許可。
- permission確認・permission request・Android channel作成・projectId解決・token取得を1つの安全なtry/catch境界に収め、native API例外でアプリ起動を壊さないように変更。
- simulator/emulator/webは従来どおりtoken取得をskipし、deniedは`{ status: 'denied' }`、その他はtyped errorを返す。
- Expo tokenが空で返る異常ケースをerrorとして扱い、token全文をログ出力しない。
- 通知タップlistenerのcleanupを維持しつつ、cold launch時の`getLastNotificationResponseAsync()`も同じdedupe境界で処理。既存の`important_news -> /news` routing仕様以外は追加していない。

## Expo / Supabase確認

- Expo SDK 57の公式Notifications仕様に合わせ、foreground handlerの`shouldShowBanner` / `shouldShowList`、Android channel先行、`getExpoPushTokenAsync({ projectId })`を使用。
- `app.json`のEAS projectIdは `eb80adf3-861e-4a48-a373-2d9a85b58899` を解決可能。
- iOS `bundleIdentifier` は未設定。勝手なidentifierは追加していない。Apple Developer有効化後、EAS build前に正式Bundle IDを設定する必要がある。
- 既存token保存先 `public.device_push_tokens` は本番に存在。既存RLSは `authenticated` の本人行限定（`auth.uid() = user_id`）で、既存clientのpublishable keyからのみupsertする。service role・secretはExpoコードに存在しない。
- migration/schema/RLS/GRANT/RPC/Edge Function/production secretは変更していない。

## Tests / verification

- targeted TypeScript check（Push関連3ファイル + Supabase client）: PASS
- `git diff --check`: PASS
- `expo config --type public --json`: PASS（projectId / notifications pluginを確認）
- `expo export --platform web` with dummy public Supabase env: PASS（Expo Router 5 routes / web bundle生成）。実値は読み出していない。
- production read-only SQL: `device_push_tokens` table/columns、RLS policy、authenticated grantsを確認
- `npm run lint`: clean worktreeにはESLintが無く実行開始時に自動installを試みたが、ネットワーク/compatibility endpoint到達不可で完了せず。依存ファイルは変更していない。
- Apple Developer有効化前のため、iPhone実機build、permission prompt、APNs/Expo token取得、foreground表示、通知タップ実機確認は未実施。成功扱いにしていない。

## Safety checks

- 既存未コミット変更のある共有worktreeは変更・stage・commitしていない。
- app.json/package.json/eas.json、Supabase migration、Edge Function、server persistence schemaは変更していない。
- Expo token、Supabase key、Apple credentialなどの秘密情報をログ・Reportへ出していない。

## Remaining issues / next recommendation

- 正式なiOS Bundle ID設定とApple/APNs credential有効化後、development buildで実機Push E2Eを行う。
- 実機でpermission denied、foreground表示、cold-launch tap、token保存/RLSをread-only含めて確認する。
- `C1`で変更2ファイルと、lint未完了・実機未確認をレビューしてください。
