# Codex Report

- task_id: kabumori-production-scheduler-restore-20260911
- result: review_required
- next_owner: chatgpt
- implementation_branch: `codex/scheduler-restore-20260911`
- commit_hash: `246f080`
- push: `origin/codex/scheduler-restore-20260911`へpush済み
- deploy: なし
- production_changes: なし

## Result

- root cause: 複垢化Phase 2の `20260910170000_add_multibrand_brand_context_foundation.sql` が `claim_due_post()` を再定義した際、既存の専用planner呼出しを `plan_daily_posts()` だけへ縮小していた。
- 最小復旧migration: `20260911130000_restore_claim_due_post_planners.sql`。`claim_due_post()` だけを再定義し、`plan_morning_report()`、`plan_close_report()`、既存の `plan_daily_posts()`、`plan_weekly_useful_tips()`、`plan_us_premarket_report()` を順に呼び戻す。
- report用 `posting_windows` は変更しない。専用planner自身のJPX営業日・祝日・center time・既存unique制約/`ON CONFLICT`による重複防止を維持する。
- `claim_due_post()` の実行権限はpublic/anon/authenticatedからrevokeし、service_roleだけへgrantする。

## Production read-only confirmation

- 現在の本番 `claim_due_post()` は `plan_daily_posts()` だけを呼ぶ定義だった。
- `morning_report_settings`: active、center `08:20`、Asia/Tokyo。`close_report_settings`: active、center `16:00`、Asia/Tokyo。
- 両reportの `posting_windows` は重複防止のためinactive。本日分 `scheduled_posts` は両reportとも0件。
- 専用planner 4種は本番に存在し、現行 `claim_due_post()` はanon/authenticated不可・service_roleのみ実行可。

## Verification

- `git diff --check`: pass。
- Deno静的検証: 5 plannerが各1回・正しい順序で呼ばれること、`posting_windows`への書込みが無いこと、RPC権限境界を確認してpass。
- ローカルSQL実行テスト: **未実施**。既存Podman VMは `podman machine start` 後に停止し、socket接続が拒否されるため、local Supabaseを起動できなかった。再試行は2回で打ち切った。本番へはSQLを実行していない。

## Safety checks

- X投稿、手動publish、Cron、Edge Function、OAuth/Vault/secrets、brands/social_accounts、H2 close-reportコードは変更ゼロ。
- production DB migration/function適用はゼロ。
- G2のOAuth作業と同一worktreeを使わず、`origin/main`起点の独立worktreeで実装した。

## Remaining issues / next recommendation

1. C1では最小diffと本番read-only事実を確認する。
2. 本番適用前に、Podmanまたは同等の隔離Postgresを復旧し、平日・週末・JPX休日・二重dispatch・generic planner回帰のSQL実行テストを完了する。
3. その後、ユーザーの明示承認を受けた場合のみ、このmigration単体を本番へ適用し、自然dispatchで当日予定が補完されることをread-only確認する。
