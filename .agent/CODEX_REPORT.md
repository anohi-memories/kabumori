# Codex Report

- task_id: kabumori-production-scheduler-restore-20260911
- result: review_required — implementation and required local SQL runtime tests pass
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
- 静的検証: 5 plannerが各1回・正しい順序で呼ばれること、`posting_windows`への書込みが無いこと、RPC権限境界を確認してpass。
- 隔離ローカルSupabase/Postgresで候補migrationを一時適用し、SQLテストを `BEGIN` / `ROLLBACK` 内で実行してpass。Podman machineの現在のAPI socketは実行時に `podman machine inspect` から取得し、固定path・本番link・`--linked` は使用していない。
  - 2026-09-11（金・JPX営業日）に morning_report / close_report が各1件だけ計画されること。
  - report用 `posting_windows` が両方inactiveでも、専用plannerが計画できること。
  - 同じplanner呼出しと `claim_due_post()` を複数回実行しても各1件のままになること。
  - 土日と `market_holidays` のJPX休日で両reportが計画されないこと。
  - 既存の `morning_greeting` / `tip` / `interaction` と `useful_tip` plannerが計画行を作ること。
- テスト後、対象日・対象post_typeの検証用 `scheduled_posts` は0行であることを確認。ローカルDBにもテスト行を残していない。
- 候補関数の定義で5 planner呼出しを確認。実行権限は anon=false / authenticated=false / service_role=true を確認。

## Safety checks

- X投稿、手動publish、Cron、Edge Function、OAuth/Vault/secrets、brands/social_accounts、H2 close-reportコードは変更ゼロ。
- production DB migration/function適用はゼロ。
- G2のOAuth作業と同一worktreeを使わず、独立worktreeで実装・ローカル検証した。

## Remaining issues / next recommendation

1. C1では最小diffとローカルSQLテスト結果を確認する。
2. 本番適用は未承認・未実施。C1後にユーザーが明示承認した場合のみ、このmigration単体を本番へ適用する。
3. 適用後は関数定義・EXECUTE権限・翌営業日の自然dispatchによる朝刊/大引け予定補完をread-onlyで確認する。手動投稿・手動予定INSERTは行わない。
