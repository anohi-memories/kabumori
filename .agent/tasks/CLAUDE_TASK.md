# Claude Task 2

Claude Code（くろちゃん）並列スロット2の現在タスクです。`G2` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: kabumori-expo-push-foundation-v1-20260905
- owner: claude
- slot: claude-2
- status: review_required
- purpose: 株アプリPush通知V1のうち、重要ニュース判定ロジックには触れず、Expo Push Token登録と独立したPush配信基盤を実装する。後続タスクで重要ニュース→対象ユーザー→notifications生成を接続できる状態まで整える。
- scope:
  - 現在のExpo/React Native構成と認証フローを確認する
  - `expo-notifications` が未導入なら、既存Expo SDKと整合する方法で導入する
  - iOS中心で通知権限要求、Expo Push Token取得、ログイン中ユーザーの `device_push_tokens` への安全なupsertを実装する
  - Android対応を壊さない設計にするが、V1動作確認はiOS優先でよい
  - `device_push_tokens` の既存列・RLS・unique制約を活用し、不要なDB再設計をしない
  - token更新時・同一端末再登録時に不要な重複を作らない
  - ログアウト時のtoken扱いを既存セキュリティ方針に沿って実装または明示する
  - Push配信側は `notifications` の `push_status` (`pending` / `sent` / `failed` / `skipped`) を将来使える独立した送信モジュール/Edge Function等として最小実装してよい
  - Expo Push APIへ送るpayloadは、将来 `notification_id` / `source_type` / `source_id` 等をdataに載せて通知タップ遷移できる拡張余地を残す
  - 無効なExpo token等、恒久的失敗を無限再試行しない方針を実装または明示する
  - 既存コードと競合する場合は変更を止め、Reportに具体的に記載する
- forbidden:
  - `supabase/functions/important-news-monitor/**` を変更しない
  - `important_news_candidates` の判定・生成・取得・breaking_market・market_macro・TDnetロジックを変更しない
  - `src/app/news.tsx` と `src/lib/important-news.ts` を変更しない
  - Codexの `kabumori-personal-important-news-v1-review-artifacts` の対象ファイルを変更しない
  - ニュース→対象ユーザー抽出→`notifications` 作成ロジックは今回実装しない
  - `tracked_stocks` / stocks sync関連の既存未コミット作業を変更・stage・commitしない
  - 既存X投稿、`x-test-post`、morning greeting、Cronを変更しない
  - 本番DB migration / GRANT / schema変更をしない
  - 本番Edge Function deployをしない
  - productionデータを変更しない
  - secrets・認証情報をcommitしない
- completion_criteria:
  - iOSで通知許可を取得できるコード経路がある
  - Expo Push Tokenを取得し、認証済み本人の `device_push_tokens` にRLSを守ってupsertできる
  - tokenの重複/更新を既存 `expo_push_token` unique制約と整合させる
  - Push送信基盤が重要ニュース監視本体から独立しており、後続で `notifications` のpending行を入力として接続できる
  - 送信成功/失敗を `push_status` に反映する設計または実装があり、恒久的invalid tokenを無限再送しない
  - 通知payloadのdataに後続のアプリ内遷移に必要なIDを載せられる
  - `important-news-monitor`、ニュース画面、重要ニュースRPC/migrationへ差分がない
  - 関連テスト・typecheck/lint等を実行し、既存回帰がない範囲を確認する
  - 実装後は最小差分でcommit/pushしてよい。ただしfresh-checkで他workstreamのdrift/競合があればpushせず停止して報告する
  - 本番deployは禁止。完了時は `review_required` にしてK2レビュー待ちにする
- commit: 今回のslot 2変更として安全に分離できるものだけ最小差分でcommit
- push: fresh-checkで競合がなければorigin/mainへpush可。既存未コミット変更・他workstream変更を混ぜない
- deploy: 禁止。K2承認後に別タスクで判断する
- report_mode: inline
- next_owner: chatgpt

## Design baseline

Push通知V1の基本方針は以下。

- 最終的な通知対象は `important` / `most_important` の重要ニュース
- 対象ユーザーはその銘柄をactiveな `holding` または `watch` として登録している本人
- X投稿生成/投稿成功には依存せず、株アプリ通知を独立させる
- `notifications` の既存dedupe (`user_id`, `tracked_stock_id`, `source_type`, `source_id`) を後続接続で利用する
- `source_type = important_news`、`source_id = important_news_candidates.id` を想定
- Push本文は短く、詳細はアプリ内で読む設計
- `most_important` は強調してよいが煽り表現は避ける
- メール通知・細かな通知時間設定はV1対象外

## Existing production schema facts

- `device_push_tokens`: user_id / expo_push_token / platform / device_id / created_at / updated_at / last_used_at
- `device_push_tokens.expo_push_token` はUNIQUE
- `device_push_tokens` はauthenticated本人のみALL可能なRLSあり
- `notifications`: user_id / tracked_stock_id / source_type / source_id / title / summary / importance / push_status / read_at / created_at
- `notifications.push_status`: pending / sent / failed / skipped
- `notifications` は `(user_id, tracked_stock_id, source_type, source_id)` でUNIQUE dedupeあり
- `notifications` は本人SELECT/UPDATEのみ。今回DB INSERT経路を変更しない

## Completion report

完了時はこのファイル末尾に `## Report` を追加し、task_id / result / changed_files / tests / commit_hash / push / deploy / token_registration / push_sender / conflicts_checked / safety_checks / remaining_issues / next_recommendation を記録する。

## Report

- task_id: kabumori-expo-push-foundation-v1-20260905
- result: 実装完了、ローカル検証済み。**push未実施**（下記conflicts_checked参照）。
- changed_files（すべてローカルの作業ディレクトリ上、未commit）:
  - `src/lib/push-notifications.ts`（新規）— 権限要求・Expo Push Token取得・`device_push_tokens`へのupsert・サインアウト時のbest-effort削除
  - `src/hooks/use-register-push-token.ts`（新規）— セッションごとに1回だけ登録を実行するフック
  - `src/app/_layout.tsx`（既存の未コミットファイルへ2行追加）— `AuthGate`内で`useRegisterPushToken(session)`を呼び出し
  - `src/lib/auth.ts`（既存の未コミットファイルへ追記）— `signOut()`内でトークン削除を追加
  - `app.json` — `expo-notifications` pluginを追加（icon/color設定のみ、他プラグインは無変更）
  - `package.json` / `package-lock.json` — `npx expo install expo-notifications`によりSDK57互換版（`~57.0.17`）を追加
  - `supabase/functions/send-push-notifications/index.ts`（新規、未deploy）— Push送信専用Edge Function。`important-news-monitor`は一切import/参照しない
  - `supabase/functions/send-push-notifications/push_send_logic.ts`（新規）— 純粋ロジック（メッセージ組み立て、Expoチケット判定、通知ごとのpush_status決定、DeviceNotRegistered token収集）
  - `supabase/functions/send-push-notifications/push_send_logic_test.ts`（新規）— 11件
- tests:
  - `node --test`：新規11件全て成功。既存の`stocks-master-sync`/`stocks-new-listing-sync`テスト（計42件）も合わせて再実行し回帰なし（合計53/53成功）。
  - `npx tsc --noEmit`を実行し、今回変更した4ファイル（`push-notifications.ts` / `use-register-push-token.ts` / `_layout.tsx` / `auth.ts`）に該当する新規エラーが無いことを確認（リポジトリ全体では既存の`apps/admin`/Deno Edge Function由来の既知エラーが引き続き存在するが、今回変更分とは無関係）。
  - `npx expo export --platform web`を実施し、exit code 0で成功（`/news`含む全5ルートが正常bundle。`[expo-notifications] Listening to push token changes is not yet fully supported on web`という想定通りの情報ログのみ、エラー無し）。
- commit_hash: none（実装コードは未commit。この`.agent/`更新のみ`origin/main`へ別途commit予定）
- push: **実装コードはpushしていません**。理由はconflicts_checked参照。
- deploy: 未実施（forbidden通り）。
- token_registration: `device_push_tokens`への安全なupsert実装済み（`onConflict: 'expo_push_token'`）。RLS（`auth.uid() = user_id`）を尊重する設計。
- push_sender: `send-push-notifications`として重要ニュース監視本体から完全に独立して実装済み（未deploy）。`stocks-master-sync`/`stocks-new-listing-sync`と同じ認証規約（`verify_jwt=false`＋専用`X-Cron-Secret`＋`SUPABASE_SECRET_KEYS`経由のDBアクセス）を踏襲しているが、今回はsecret登録・config.toml追加・deployのいずれも行っていない。
- conflicts_checked: fresh-checkの結果、**`package.json`/`package-lock.json`が他ワークストリーム（Expo認証/Supabaseクライアント導入、未コミット）の追加分と同一ファイル内で不可分に混在**していることを確認した（`@supabase/supabase-js`・`@react-native-async-storage/async-storage`・`react-native-url-polyfill`が今回追加の`expo-notifications`と同じ`dependencies`ブロック内にアルファベット順で並び、`package-lock.json`側は依存木レベルで完全に絡み合っており、手動での安全な分離は不可能と判断）。このため「他workstream変更を混ぜない」を満たせず、指示通りpushせず停止した。他のファイル（新規ファイル・`app.json`・`_layout.tsx`/`auth.ts`への追記）自体には他ワークストリームとの衝突は無い。
- safety_checks:
  - `important-news-monitor`、`src/app/news.tsx`、`src/lib/important-news.ts`：一切変更していない（差分ゼロを`git diff`で確認）。
  - `tracked_stocks`/stocks sync関連（`src/app/explore.tsx`、`src/app/index.tsx`、`src/components/app-tabs*.tsx`、`supabase/migrations/2026090[3-5]*`等）：一切変更していない。
  - 本番DB migration・GRANT・schema変更：なし。本番Edge Function deploy：なし。production データ変更：なし。secrets/認証情報のcommit：なし。
- remaining_issues:
  1. **push未完了**：上記の通りpackage.json系の絡み合いにより、実装コードは`origin/main`へまだ反映されていません。Expo認証ワークストリームの担当がそちらを先にcommitするか、ユーザーの指示で手動分離する必要があります。
  2. EAS `projectId`が未設定（`app.json`/`eas.json`に無し）。このため実機でも`getExpoPushTokenAsync()`は`skipped`扱いになり、実際のPush Token取得はEAS設定後でないと動作確認できません（コード自体はこの状態を検知して安全にスキップする設計）。
  3. 同一デバイスで別アカウントへ切り替えた場合、既存`device_push_tokens`行が旧ユーザー所有のままだと、新ユーザーでのupsertが`device_push_tokens_owner`RLSの`USING`句（旧行のuser_idで判定）に阻まれ失敗し得る既知の制限。現在の実装は例外を握りつぶさずconsole.warnするのみで、アプリはクラッシュしない。恒久的な解消にはservice_role経由の再割り当てRPCが必要（今回はforbidden対象のためmigration追加はしていない）。
  4. iPhone実機での実際の通知許可ダイアログ・Push Token取得の目視確認は、上記2の理由（EAS未設定）とログイン資格情報が無いことにより未実施。
- next_recommendation: (a) EAS project作成・`projectId`設定、(b) Expo認証ワークストリームのcommit後にこちらの変更を再度fresh-checkしてpush、(c) push後に`send-push-notifications`のsecret登録・`config.toml`追加・cron連携を別タスクとして計画、(d) 同一デバイス複数アカウント切り替えのRLS制限を解消する再割り当てRPCの要否を判断。
