# Codex Task

- task_id: broad-news-display-and-notification-presets-phase3-20260913
- owner: codex
- slot: codex-1
- status: done
- next_owner: user
- priority: urgent
- recommended_model: Sol Medium
- purpose: Phase 2で本番接続した広域ニュース収集をユーザー体験へつなげる。アプリのmedium以上表示、カテゴリ/重要度表示、通知プリセット、emergency通知、カテゴリ別設定を安全に実装する。

## Completion summary

実装詳細・変更ファイル・テスト結果・本番未反映事項は `.agent/CODEX_REPORT.md` の task_id `broad-news-display-and-notification-presets-phase3-20260913` を正とする。

- implementation commit: `f7c17b915c551ba81b1dfc62a0731fd3eba6f008`
- production changes: 0
- deploy: none
- exact migration: `supabase/migrations/20260913140000_broad_news_visibility_notification_presets.sql`（未適用）
- dispatcher/claim RPC: unchanged
- `supabase db push`: not used / remains prohibited

## C1 Review — 2026-09-13

- result: PASS
- implementation: PASS。market/companyのmedium以上表示、emergency最上位表示、16カテゴリ日本語ラベル、4段階notification preset、emergency専用設定、行形式カテゴリ設定を実装。
- legacy compatibility: PASS。既存 `alert_settings` 行は新列NULLを維持し、migration適用だけでは通知量を増やさない。既存 `market_critical_news` はdispatcher互換ゲートとして維持。
- emergency safety: PASS。market emergencyはtracked stock/sector一致不要だが、Fact-passed日本語copy、freshness、dedupe、push master/settings gateを要求し、通知行の `tracked_stock_id` はNULL。
- category safety: PASS。カテゴリ設定行なし/候補カテゴリなしは有効扱い。カテゴリ追加時にmigration不要な行形式。
- producer/dispatcher boundary: PASS。producer側のみ変更し、`send-push-notifications` と `claim_pending_push_notifications` は未変更。
- tests: PASS。important-news runtime 395/395、Push/レポート回帰48/48、app presentation 27/27、変更アプリTypeScript、iOS Expo export、`git diff --check` 通過。
- known static issue: repository既存 `_shared/x_oauth2_post.ts` の Uint8Array/BufferSource 型差で全体Deno checkのみ停止。今回変更由来ではない。
- volume estimate: quiet 0 / standard 1 / many 3 / all_useful 3（直近7日read-only試算）。medium表示は現行8件から最大16件へ増える見込み。
- production boundary: PASS。本番migration/RPC/Edge Function/user settings/Push/candidate/Cron/Xへの変更0。
- next recommendation: production rolloutは別スロットへ引き継ぐ。exact migration単体適用 → read-back → `important-news-monitor` のみdeploy → iOS実機/Simulator確認 → 自然Cron/Push観測。migration history修復と `supabase db push` は禁止継続。
