# Codex Report

- task_id: kabumori-important-news-rpc-privilege-fix
- result: review_required。ローカルmigrationの権限境界だけを修正。private helperを廃止し、本人限定クエリをpublic SECURITY DEFINER RPC 1本へ統合した。本番適用は未実施。
- changed_files:
  - local only: `supabase/migrations/20260905042052_get_my_important_stock_news.sql`
  - GitHub sync: `.agent/tasks/CODEX_TASK.md`, `.agent/CODEX_REPORT.md`
- tests:
  - migration静的assertion: PASS
  - `git diff --check`: PASS
  - 本番read-only確認: `get_my_important_stock_news`はpublic/privateとも未作成
  - SQL実行テスト: 未実施（ローカルPostgres/Dockerなし、本番DDLは禁止）
- commit_hash: `.agent/`レビュー資料commitで確定予定
- push: `.agent/`のみorigin/mainへ反映予定。migration本体はlocal only
- deploy: 未実施（本番migration、GRANT、データ変更すべてなし）
- remaining_issues:
  - 本番適用前にCレビューが必要
  - public SECURITY DEFINERはauthenticated向けの意図的なper-user APIであり、Supabase Advisor 0029の警告対象になり得る。`auth.uid()`本人限定・最小返却列・EXECUTE制限をレビューした上で意図的例外として判断が必要
  - 本番のprivate schemaには既存用途でauthenticated USAGEがあるが、このmigrationは追加も削除もしない。private helper自体を作成せず、旧ローカルdraftがあればDROPするため、対象helperの直接EXECUTE経路は残らない
- safety_checks:
  - `authenticated`へのprivate schema USAGE追加なし
  - `authenticated`へのprivate helper EXECUTE追加なし
  - private helperはmigration内で作成せず、旧draftを`drop function if exists`で除去
  - public/anon/authenticated/service_roleの既定EXECUTEを一度revokeし、public RPCだけauthenticatedへ再grant
  - SECURITY DEFINERは`search_path = ''`、参照テーブルは完全修飾
  - JWT由来の`auth.uid()`がNULLでないことと`tracked.user_id`一致を必須化
  - holding/watch両方、`is_active=true`、5文字company_code、important/most_important、重複除外、最大50件を維持
  - X投稿生成文、判定理由、コスト、投稿ID等は返却しない
  - Expo画面・Edge Function・Cron・X投稿ロジックは変更していない
  - secrets、認証情報、個人情報を記録していない
- next_recommendation: `C`で下記migration全文を再レビューし、承認後に別工程で本番適用・Advisor・anon/authenticated別のRPC権限E2Eを行う

## 変更理由

旧案はprivate helperへauthenticatedのUSAGE/EXECUTEを付与していた。修正版ではprivate helperを廃止し、public RPC自身がSECURITY DEFINERとして必要最小限のSELECTを行う。これにより、authenticatedが呼べる対象関数はpublic RPCだけになる。

## 権限結果

- `PUBLIC`: public RPC実行不可
- `anon`: public RPC実行不可
- `authenticated`: public RPCのみ実行可
- `service_role`: 明示的な直接EXECUTE付与を除去
- `private.get_my_important_stock_news(integer)`: 作成しない。旧draft適用環境ではDROP

## Artifact hash

```text
c02c5a3c54c279990d681118d5836e16a63a000448f535c56941cf5f34cdf271  supabase/migrations/20260905042052_get_my_important_stock_news.sql
```

## Migration全文

```sql
create or replace function public.get_my_important_stock_news(
  p_limit integer default 50
)
returns table (
  news_id uuid,
  ticker_code text,
  company_name text,
  tracking_type text,
  title text,
  summary text,
  importance text,
  news_time timestamptz,
  source_url text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    news.id as news_id,
    stock.ticker_code,
    stock.company_name,
    tracked.tracking_type,
    news.title,
    news.body_summary as summary,
    news.importance,
    coalesce(news.published_at, news.created_at) as news_time,
    news.source_url
  from public.tracked_stocks as tracked
  inner join public.stocks_master as stock
    on stock.id = tracked.stock_id
  inner join public.important_news_candidates as news
    on news.company_code ~ '^[0-9A-Z]{5}$'
   and left(news.company_code, 4) = stock.ticker_code
  where (select auth.uid()) is not null
    and tracked.user_id = (select auth.uid())
    and tracked.is_active = true
    and news.importance in ('important', 'most_important')
    and news.status in ('ready_for_publish', 'generation_failed')
    and news.duplicate_of is null
  order by coalesce(news.published_at, news.created_at) desc
  limit greatest(1, least(coalesce(p_limit, 50), 50));
$$;

comment on function public.get_my_important_stock_news(integer) is
  'Returns a minimal important-news feed for the authenticated user active tracked stocks.';

-- Remove the helper if an earlier local draft of this migration was applied.
drop function if exists private.get_my_important_stock_news(integer);

revoke all on function public.get_my_important_stock_news(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_important_stock_news(integer)
  to authenticated;
```
