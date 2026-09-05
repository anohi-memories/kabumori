# Codex Task

Codex（こでさん）専用の現在タスクです。`G` を受けたCodexは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルだけを自分の担当タスク正本として扱います。

- task_id: kabumori-important-news-rpc-production-apply
- owner: codex
- status: review_required
- purpose: Cレビューで承認したKabumori「重要ニュース」RPC migrationを本番へ安全に適用し、権限境界と取得経路を検証する。既存X自動投稿系や他workstreamを変更しない。
- scope:
  - 作業開始前にorigin/mainをfetchし、`.agent/ORCHESTRATION.md` / `.agent/CURRENT_STATE.md` / 本TASKをfresh-check
  - ローカルの `supabase/migrations/20260905042052_get_my_important_stock_news.sql` が前回Cレビュー済み内容・SHA-256 `c02c5a3c54c279990d681118d5836e16a63a000448f535c56941cf5f34cdf271` と一致することを確認
  - migration一覧を確認し、今回対象以外のLocal-only migrationや並行作業のmigrationがある場合は誤適用防止を最優先する
  - 本番へ今回のKabumori RPC migrationだけを安全に適用
  - 適用後、関数定義・SECURITY DEFINER・`search_path=''`・EXECUTE権限をread-onlyで確認
  - `PUBLIC` / `anon` が `public.get_my_important_stock_news(integer)` を実行できず、`authenticated` のみ実行可能であることを確認
  - `private.get_my_important_stock_news(integer)` が存在しないことを確認
  - 返却列が news_id / ticker_code / company_name / tracking_type / title / summary / importance / news_time / source_url のみに限定されていることを確認
  - `auth.uid()`本人限定、`is_active=true`、holding/watch、5文字company_code、important/most_important、duplicate除外、最大50件の条件が本番定義に維持されていることを確認
  - Supabase Advisor等で今回の関数に関連する警告が出る場合は内容を確認し、意図的なSECURITY DEFINER警告か、それ以外の実問題かを区別して報告
  - 認証ユーザーでのRPC E2Eを安全に実施できる既存手段がある場合は実施。ユーザー資格情報が必要なら勝手に作成・変更せず、アプリ実画面テストを次工程として残す
  - 完了報告を `.agent/CODEX_REPORT.md` に記録し、TASKを `review_required` にする
  - 実装コードを安全に分離してcommit/pushできる場合のみ対象ファイルだけcommit/push。既存dirty worktreeや他workstreamを混ぜない
- forbidden:
  - `--include-all` 等で今回と無関係なmigrationをまとめて適用すること
  - 今回対象外のmigration / RPC / DB schema / GRANT変更
  - `important-news-monitor` / `x-test-post` / Cron / X投稿ロジック変更
  - Edge Function deploy
  - ニュース画面の仕様変更・新規機能追加
  - 他workstreamの未コミット変更を変更・stage・commit・push
  - テスト目的で本番ユーザーのパスワードや認証情報を変更すること
  - secrets・認証情報の表示/記載
- completion_criteria:
  - Cレビュー済みmigrationとローカル実物のhash一致を適用前に確認
  - 今回migrationだけが本番適用され、無関係migrationは未適用
  - `public.get_my_important_stock_news(integer)` が本番に存在
  - public RPCはSECURITY DEFINERかつ`search_path=''`
  - `PUBLIC` / `anon` EXECUTEなし、`authenticated` EXECUTEあり
  - private helper関数なし
  - authenticatedへprivate helper用の新規USAGE/EXECUTE付与なし
  - 本人のactiveなholding/watchだけに限定するSQL条件が維持
  - X投稿内部情報を返さない
  - 本番適用後のDB定義・権限確認結果を報告
  - 認証ユーザーRPC E2Eが可能なら結果を報告。不可能なら理由を明示し、iOS実画面確認を未完了として残す
  - 本番適用後も既存X自動投稿系に変更なし
  - `.agent/CODEX_REPORT.md` をGitHubへ必ず同期
  - 完了時status=`review_required`
- commit: 実装コードを安全に分離できる場合のみ最小差分。無理ならlocal onlyのままでよい
- push: `.agent/`完了報告は必ずorigin/mainへ反映。実装コードは安全に分離できる場合のみ
- deploy: Edge Function deployは禁止。DB migrationの今回対象のみ本番適用を許可
- next_owner: chatgpt

## C Review decision

前タスク `kabumori-important-news-rpc-privilege-fix` は承認。

承認理由：
- private helperを廃止し、authenticatedからprivate helperを直接呼べる経路を削除
- public SECURITY DEFINER RPC 1本へ統合
- `auth.uid()`で本人のtracked_stocksだけに限定
- `search_path=''` と完全修飾名を維持
- PUBLIC/anon/authenticated/service_roleの既定EXECUTEをrevoke後、authenticatedにpublic RPCだけ再grant
- 返却列をKabumori表示に必要な最小列へ限定
- 本番未適用のため、次工程で本番定義・権限を実確認する

SECURITY DEFINERがpublic schemaにあること自体は、今回の用途では意図的なper-user APIとして許容する。ただし本番適用後に権限・auth.uid()条件・Advisor警告を再確認すること。

## Migration safety

過去にKabumoriとは別workstreamのLocal-only migrationが存在した経緯があるため、`supabase db push --include-all` は禁止。

適用前に必ずmigration一覧/dry-run相当を確認し、今回の `20260905042052_get_my_important_stock_news.sql` 以外が同時適用対象になる場合は停止して報告する。
