# Codex Task 2

- task_id: close-report-live-data-and-voice-retry-hardening-20260910
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Luna
- purpose: 2026-09-10 16:00 JSTのclose_report失敗を受け、Voice評価の限定retry、当日終値の安全取得、15:30大引け境界を本番へ安全に反映する。

## C2 Review — 2026-09-11 final implementation review

- review_result: implementation_approved_deploy_pending
- reviewed_by: chatgpt
- follow_up_d_commit: `491eb46f4294324d3736419e57a3e510f319d0ca`
- commit_push_review: pass
- code_review: pass
- test_review: pass
- production_completion: pending deploy

### Approved implementation

- Yahoo Finance chart `^N225` / `^TPX` のdirect close取得方針を承認。
- same JST date、numeric、source-backedを要求。
- 15:30 JST以降だけcloseとして採用。
- 15:00〜15:29は明示reject。
- latest pointが15:30未満ならnull。
- `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` fail-closedを維持。
- material/news検索を終値の代替にしない。
- Fact/Voice/X publish基準は不変。
- Voice evaluator transport/output failureのsingle retryも既承認のまま。

### Verified tests

- targeted close-report/data: 55 passed / 0 failed
- full x-test-post: 379 passed / 0 failed
- changed pure module deno check: pass
- git diff --check: pass
- explicit boundary tests:
  - 15:30 Nikkei accept
  - 15:30 TOPIX accept
  - 15:29 reject
  - 15:15 reject
  - 15:00 reject
  - front-session / previous-day / unknown / failed response reject

### Follow-up E — production deploy only

Implementation is approved. Production still runs the pre-Follow-up-D x-test-post deployment, so deploy only the approved source containing commit `491eb46f4294324d3736419e57a3e510f319d0ca`.

Required:
1. fresh-check `origin/main` and confirm `491eb46f4294324d3736419e57a3e510f319d0ca` is an ancestor.
2. confirm no active slot is modifying `supabase/functions/x-test-post/**` or the same production configuration.
3. use a clean worktree from current `origin/main` only if current origin/main includes the approved commit and contains no unreviewed x-test-post changes after it. If x-test-post changed after `491eb46`, stop and report instead of deploying blindly.
4. verify `pwd`, worktree-local `supabase/config.toml`, linked project ref, and `[functions.x-test-post] verify_jwt=false`.
5. deploy **x-test-post only** with `--no-verify-jwt`.
6. after deploy, `supabase functions download x-test-post --use-api` and byte-compare every downloaded function file against the exact deployed source worktree.
7. confirm x-test-post ACTIVE / verify_jwt=false and other Edge Function updated_at/version unchanged.
8. no manual Function execution, no manual close_report, no OpenAI/X API call, no X post.
9. no DB/migration/RLS/RPC, Cron/scheduler/posting_windows/settings, secrets/OAuth changes.
10. update `.agent/CODEX_REPORT_2.md`, then set:
   - status: review_required
   - next_owner: chatgpt

### Completion condition

Do not mark this task done until production deploy verification is complete. Natural close_report observation can remain a post-deploy monitoring item; do not force a same-day run.

## Follow-up E completion — 2026-09-11

- `x-test-post` only deployed from current `origin/main` with `--no-verify-jwt`.
- Post-deploy: `x-test-post` v95 ACTIVE, `verify_jwt=false`.
- `supabase functions download x-test-post --use-api` completed; every downloaded function file byte-compared equal to the pre-deploy source snapshot.
- Other Edge Function versions and `updated_at` values were unchanged.
- No manual Function execution, close_report run, OpenAI/X API call, X post, DB/migration/RLS/RPC, Cron/scheduler/settings, secrets, or OAuth change.
- status: `review_required`
- next_owner: `chatgpt`
