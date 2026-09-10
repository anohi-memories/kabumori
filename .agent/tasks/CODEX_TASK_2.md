# Codex Task 2

- task_id: morning-report-fact-diagnostics-and-greeting-status-fix-20260910
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: urgent
- recommended_model: Sol High
- purpose: `x-test-post` の朝系2件を最小変更で修正する。① morning_report のFact失敗時に実際の失敗理由・retrieval diagnosticsが消えて原因不明になる問題、② morning_greeting がX投稿成功後のlegacy Storage receipt保存400で scheduled_posts / 管理画面上だけfailedになる問題。

## C2 Review continuation

- review_result: follow_up_required
- reviewed_by: chatgpt
- implementation_review: pass
- implementation_commit: `41de66bd4b4eb69bbdf0b6718274c519912f8a24`
- push: `origin/main` 済み
- blocker: production `x-test-post` deploy and post-deploy natural-path verification are not completed.

## Verified implementation

### A. Morning report Fact failure observability

- plain `MORNING_REPORT_FACT_CHECK_FAILED` で draft が存在する場合、以下を `morning_report_runs` に保持する実装を確認。
  - `fact_check_notes = draft.factCheckNotes`
  - `source_urls`
  - `market_data_timestamp`
  - input/output tokens
  - web search calls
  - API cost
  - `morningRunMarketData(...)` の retrieval diagnostics
  - draft textが存在する場合のみ generated_text / character_count
- Fact gate自体は緩和していない。
- retry classification、Voice/Lane failure loggingは変更していない。

### B. Morning greeting X-success / admin-failed split brain

- `completePublishSlot(...)` 成功後のlegacy Storage receipt writeをbest-effort化。
- Storage receipt HTTP 400でも、既に成功したX投稿とauthoritative `publish_claims=published`を失敗へ覆さない。
- atomic `publish_claims` claimによる同日二重X投稿防止を維持。
- legacy receipt read互換性は維持。

## Tests verified

- targeted morning report + morning greeting publish/claim/scheduled tests: 69 passed / 0 failed
- full `x-test-post` regression: 367 passed / 0 failed
- `git diff --check`: pass
- `deno check morning_greeting_publish_logic.ts` は unchanged dependency の既存2エラーのみ:
  - `_shared/x_oauth2_post.ts` BufferSource typing
  - `morning_greeting_logic.ts` retry_count return-type mismatch
- 今回変更由来の新規type errorはReport上確認されていない。

## Required continuation after explicit deploy approval

1. `.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、このTASK、`.agent/CODEX_REPORT_2.md` を再確認。
2. `origin/main` fresh-check。
3. 他slotが `supabase/functions/x-test-post/**` / 同じproduction設定を変更中でないことを確認。競合時は停止して報告。
4. 既存ローカル未コミット変更には一切触れない。必要なら既に許可済みのclean worktree方式を使う。
5. production deployは `x-test-post` のみ。
6. deploy後ACTIVE version / `verify_jwt` をread-back確認。
7. 手動X投稿・手動morning_greeting publish・手動candidate注入は行わない。
8. 自然経路で次回対象が発生した場合、read-onlyで確認:
   - morning_report Fact failureなら具体的 `fact_check_notes` / diagnosticsが保存されること
   - morning_greeting X成功時にlegacy receipt 400が起きても scheduled_posts / 管理画面がfailedへ落ちないこと
   - `publish_claims` がauthoritative publishedを維持し、二重投稿がないこと
9. 自然対象がすぐ発生しない場合は人工生成せず、その旨をReportする。
10. `.agent/CODEX_REPORT_2.md` にdeploy version / verification / safety / remaining issueを記録。
11. 完了時 `status: review_required`, `next_owner: chatgpt`。

## Production / safety

現時点では本番deploy未実施。

禁止:
- 手動X投稿
- 手動morning_greeting publish
- 手動candidate注入
- Fact gateの緩和
- Cron / scheduler / posting_windows変更
- DB schema / migration / RLS / GRANT / RPC変更
- secrets / OAuth変更
- 他Edge Function deploy
- important-news / close_report / Pushアプリ変更
- legacy backlog再実行

Production DB確認はread-onlyのみ。

## Completion

- implementation review: pass
- production `x-test-post` deploy成功
- ACTIVE version確認
- post-deploy natural-path observation結果をReport
- unrelated production変更なし
- status: `review_required`
- next_owner: `chatgpt`
