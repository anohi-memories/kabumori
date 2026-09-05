# Codex Task

Codex（こでさん）専用の現在タスクです。`G` を受けたCodexは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルだけを自分の担当タスク正本として扱います。

- task_id: kabumori-personal-important-news-v1-review-artifacts
- owner: codex
- status: ready
- purpose: 前タスクでローカル実装した「登録銘柄に関係する重要ニュース」機能について、ChatGPTが本番適用可否をレビューできるよう、実装差分を安全にGitHub共有する。新規実装や本番適用は行わない。
- scope:
  - ローカル実装済みの `supabase/migrations/20260905042052_get_my_important_stock_news.sql` 全文をレビュー可能な形で共有する
  - `src/lib/important-news.ts` の今回差分を共有する
  - `src/app/news.tsx` の今回差分を共有する
  - ニュースタブ追加に伴い変更した他ファイルがあれば、その今回差分も共有する
  - SECURITY DEFINER関数の `search_path` 設定を明示する
  - `auth.uid()` をどこで検証しているか明示する
  - PUBLIC / anon / authenticated の EXECUTE権限SQLを明示する
  - private関数をauthenticatedから直接呼べないことを明示する
  - company_code形式異常を除外する具体条件を明示する
  - 一覧対象が `important` / `most_important` のどちらか、または両方かを明示する
  - 上記レビュー資料を `.agent/CODEX_REPORT.md` に記録し、実装コードをpushできない場合でも `.agent/` 制御ファイルだけは安全にGitHubへ同期する
- forbidden:
  - 新規機能実装
  - 既存ローカル実装の仕様変更
  - `supabase db push`
  - 本番migration適用
  - 本番GRANT変更
  - Edge Function deploy
  - 本番データ変更
  - `important-news-monitor` / `x-test-post` / Cron / X投稿ロジック変更
  - 他workstreamの未コミット変更をstage・commit・pushすること
  - secrets・認証情報の記載
- completion_criteria:
  - ChatGPTがSQL・権限・認証境界・アプリ側呼び出しを実差分ベースでレビューできる
  - 実装コードがlocal onlyのままでも、レビュー資料と完了報告はGitHubからCで取得できる
  - `.agent/CODEX_REPORT.md` に task_id / result / changed_files / tests / commit_hash / push / deploy / remaining_issues / safety_checks / next_recommendation を含める
  - 完了時は status を `review_required` にする
- commit: 実装コードはcommit不要。`.agent/` のレビュー共有だけを安全に分離できる場合は最小commit可
- push: `.agent/` のレビュー共有は必ずGitHubへ反映する。実装コードや他workstream変更を混ぜない
- deploy: 禁止
- next_owner: chatgpt

## Important

今回は本番適用承認ではなく、レビュー資料共有だけが目的です。新しいコード変更は行わず、ローカルに存在する実装の正確な内容を共有してください。
