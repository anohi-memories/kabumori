# Codex Task

Codex（こでさん）専用の現在タスクです。`G` を受けたCodexは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルだけを自分の担当タスク正本として扱います。

- task_id: kabumori-personal-important-news-v1
- owner: codex
- status: review_required
- purpose: 現在ログイン中ユーザーの `tracked_stocks` と既存X自動投稿システム側の `important_news_candidates` を安全に結びつけ、「自分が登録している銘柄に関係する重大ニュース」をKabumoriアプリ内で確認できる最小機能を作る。Push通知は今回対象外。
- scope:
  - 本人の `is_active=true` のholding/watchだけを対象に重大ニュースを取得
  - `stocks_master.ticker_code = left(important_news_candidates.company_code, 4)` を基本マッチとする
  - 「重要ニュース」画面/タブを追加
  - 銘柄、会社名、保有/監視、見出し、短い要約、重要度、日時を表示
  - 最大50件、最新順、Pull to Refresh、空状態/失敗UI
  - ExpoからX内部テーブルへ広いSELECT権限を与えず、安全なKabumori専用取得経路を使用
- forbidden:
  - Push通知、メール通知、ニュースAI再生成、重要度再判定
  - `important-news-monitor` / `x-test-post` / X投稿処理 / Cron変更
  - 既存X自動投稿DBロジック変更
  - `important_news_candidates` へのauthenticated広範SELECT GRANT
  - service_role / secret / Vault secretをExpoへ入れる
  - ChatGPT承認前の本番migration、GRANT変更、deploy
  - 他workstreamの未コミット変更を変更・stage・commitすること
- completion_criteria:
  - 実装・TypeScript・iOS bundle確認
  - 本番DB変更なしで停止
  - RPC migration / SECURITY DEFINER / search_path / auth.uid() / EXECUTE権限をレビュー可能な形で提示
  - 本番適用はChatGPTのCレビュー後
- commit: 実装コードはlocal only。安全に分離できるまでcommitしない
- push: 実装コードは未push
- deploy: 禁止
- next_owner: chatgpt

## Current review state

Codexからユーザー経由で、ローカル実装完了・`review_required` の報告を受領済み。

報告概要:
- `src/app/news.tsx`
- `src/lib/important-news.ts`
- `supabase/migrations/20260905042052_get_my_important_stock_news.sql`
- TypeScript PASS
- iOS Expo bundle PASS
- 本番migration / GRANT / deploy未実施

詳細は `.agent/CODEX_REPORT.md` を参照。

## Important

このタスクは `review_required` のため、`G` を受けても新規実装を再開しない。ChatGPTの `C` レビュー待ち。
