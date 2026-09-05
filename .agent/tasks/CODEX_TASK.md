# Codex Task

Codex（こでさん）専用の現在タスクです。`G` を受けたCodexは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルだけを自分の担当タスク正本として扱います。

- task_id: kabumori-important-news-rpc-privilege-fix
- owner: codex
- status: review_required
- purpose: ローカル実装済みのKabumori「重要ニュース」取得RPCについて、レビューで判明したprivate関数の権限境界不一致を修正し、本番適用可能な最小migration案にする。本番適用はまだ行わない。
- scope:
  - `supabase/migrations/20260905042052_get_my_important_stock_news.sql` の権限設計だけを必要最小限で修正
  - authenticatedが`private` schema / private helperを直接実行できない構成にする
  - public RPCだけをauthenticatedへ公開する
  - `auth.uid()`本人限定、`is_active=true`、holding/watch、company_code形式検証、重要度フィルタ、最大50件、返却列最小化は維持
  - SECURITY DEFINERを使う場合は`set search_path = ''`と完全修飾名を維持
  - 修正後のSQLをローカルで静的確認し、可能な範囲のテストを実施
  - 完了報告とレビュー資料を`.agent/CODEX_REPORT.md`へ反映し、実装コードがlocal onlyでも`.agent/`だけはGitHubへ同期
- forbidden:
  - `supabase db push`
  - 本番migration適用
  - 本番GRANT変更
  - Edge Function deploy
  - 本番データ変更
  - `important-news-monitor` / `x-test-post` / Cron / X投稿ロジック変更
  - ニュース画面の仕様変更
  - 新規機能追加
  - 他workstreamの未コミット変更をstage・commit・push
  - secrets・認証情報の表示/記載
- completion_criteria:
  - authenticatedに`private` schemaのUSAGEを付与しない
  - authenticatedに`private.get_my_important_stock_news(integer)`のEXECUTEを付与しない
  - PUBLIC/anonはpublic/private両関数とも実行不可
  - authenticatedは`public.get_my_important_stock_news(integer)`だけ実行可能
  - public入口からの呼び出しは機能しつつ、private helperはDB権限上も直接呼べない
  - `auth.uid()`は呼出ユーザーのJWT subjectを使って本人のtracked_stocksだけに限定される
  - SECURITY DEFINERを採用する関数は`search_path=''`かつ参照先を完全修飾する
  - 返却列にX投稿生成文、判定理由、コスト、投稿ID等を含めない
  - migration全文と変更理由を`.agent/CODEX_REPORT.md`に記載
  - 本番適用はせず`review_required`で終了
- commit: 実装コードはlocal onlyでよい。`.agent/`報告は安全に分離してcommit可能
- push: `.agent/`の完了報告は必ずorigin/mainへ反映。実装コードや他workstream変更を混ぜない
- deploy: 禁止
- next_owner: chatgpt

## C Review decision

前タスク `kabumori-personal-important-news-v1-review-artifacts` のレビュー結果：修正必須。

問題点：

```sql
grant usage on schema private to authenticated;
grant execute on function private.get_my_important_stock_news(integer)
  to authenticated;
```

これにより、PostgRESTでprivate schemaを通常公開していないとしても、DB権限上はauthenticatedがprivate helperを直接EXECUTE可能であり、当初のセキュリティ要件「private関数はauthenticatedから直接呼べない」を満たさない。

推奨方向：

- authenticatedへのprivate schema USAGE / private helper EXECUTEを削除する
- `public.get_my_important_stock_news(integer)`のみauthenticatedへEXECUTE付与
- public入口側を必要に応じてSECURITY DEFINERにし、関数owner権限でprivate helperを呼ぶ。ただし`auth.uid()`による本人限定、`search_path=''`、完全修飾名を必須とする
- あるいはprivate helperを廃止し、public SECURITY DEFINER関数1本に安全なクエリを閉じ込める方法でもよい。より単純かつ安全な方を採用する

修正後も本番適用は禁止。C再レビュー待ちにする。
