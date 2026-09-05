# Codex Task

Codex（こでさん）専用の現在タスクです。`G` を受けたCodexは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルだけを自分の担当タスク正本として扱います。

- task_id: kabumori-important-news-history-align-and-e2e-prep
- owner: codex
- status: review_required
- purpose: 本番適用済みのKabumori「重要ニュース」RPCについて、ローカルmigration履歴とのversion差を安全に解消し、アプリ側実装を既存workstreamと混ぜずに整理して、認証ユーザー/iOS実画面E2Eへ進められる状態にする。本番DB定義は変更しない。
- scope:
  - 作業開始前にorigin/mainをfresh-checkし、ORCHESTRATION / CURRENT_STATE / 本TASKを確認
  - 本番migration `20260905140638_get_my_important_stock_news` と、ローカル `20260905042052_get_my_important_stock_news.sql` が同一SQLであることを再確認
  - 同じSQLを将来の通常db pushで再適用しないよう、Supabase migration履歴の整合方法を安全に決める
  - 可能ならローカルmigrationファイル名/versionを本番履歴 `20260905140638` に合わせる。ただし他workstreamのmigrationや未コミット変更と競合する場合は変更せず停止・報告
  - `src/app/news.tsx`、`src/lib/important-news.ts`、ニュースタブ追加hunkを既存未コミット変更と分離して確認
  - 安全に分離できる場合のみ、今回のKabumori重要ニュース実装ファイルを最小commit/pushする
  - Expo対象TypeScriptとiOS bundleを再確認
  - 本番RPCはread-only確認のみ。DDL/GRANT変更はしない
  - 認証済みユーザーRPC E2Eを既存資格情報を変更せず安全に実施できる場合のみ実施
  - 資格情報が必要なら作成・変更せず、ユーザーがiOS Simulator/実機で確認できる具体的な最短手順を報告
  - 完了報告を `.agent/CODEX_REPORT.md` に記録し、TASKを `review_required` にする
- forbidden:
  - 本番DB migration / DDL / GRANT変更
  - `supabase db push` / `--include-all`
  - 対象外migrationのrename/repair/apply
  - `important-news-monitor` / `x-test-post` / Cron / X投稿系の変更
  - Edge Function deploy
  - 他workstreamの未コミット変更を変更・stage・commit・push
  - 本番ユーザー作成、パスワード変更、資格情報取得
  - secrets・認証情報の表示/記載
- completion_criteria:
  - 本番RPC適用結果は承認済みとして維持し、追加の本番変更をしない
  - migration version差 `20260905042052` vs `20260905140638` の安全な解消方針を確定し、可能ならローカル履歴を整合
  - 将来の通常migration運用で同SQLが二重適用されない状態にする
  - ニュース画面/取得コード/タブ変更を今回workstreamとして安全に分離できたか明示
  - 分離可能ならcommit/pushし、commit hashを報告。不可なら理由を明示
  - Expo対象TypeScript PASS、iOS bundle PASSを再確認
  - 認証RPC E2E実施可否と結果を明示
  - iOS実画面で確認すべき項目を簡潔に列挙
  - `.agent/CODEX_REPORT.md` をGitHubへ必ず同期
  - 完了時status=`review_required`
- commit: 今回workstreamとして安全に分離できるファイルのみ
- push: 安全に分離できる場合のみ実装commitをpush。`.agent/`報告は必ずpush
- deploy: 禁止
- next_owner: chatgpt

## C Review decision

前タスク `kabumori-important-news-rpc-production-apply` は承認。

確認済み:
- 本番migration `20260905140638_get_my_important_stock_news` のみ追加
- public RPC 1件、STABLE SECURITY DEFINER、`search_path=''`
- EXECUTE: PUBLIC=false / anon=false / authenticated=true / service_role=false
- private helperなし
- `auth.uid()`本人限定、active holding/watch、5文字company_code、important/most_important、duplicate除外、最大50件を維持
- 匿名RPC拒否を確認
- Advisor 0029は今回の意図的per-user SECURITY DEFINER APIとして許容
- X自動投稿系・Cron・Edge Function等への変更なし

残課題は、ローカルmigration version差の整合と、認証ユーザー/iOS E2Eのみ。
