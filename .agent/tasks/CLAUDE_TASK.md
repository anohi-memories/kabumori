# Claude Task 2

Claude Code（くろちゃん）並列スロット2の現在タスクです。`G2` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: kabumori-expo-push-foundation-v1-20260905
- owner: claude
- slot: claude-2
- status: ready
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
