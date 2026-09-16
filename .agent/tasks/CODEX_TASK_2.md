# Codex Task 2

- task_id: x-close-report-freshness-boundary-fix-20260916
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: urgent
- recommended_model: Luna first
- purpose: X大引けレポートが17:00直後の通常遅延で `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` になる再現性のあるfreshness境界バグを、最小修正で直す。

## Confirmed incident evidence

2026-09-16 production read-only確認:
- X close_report scheduled_for 17:00:00 JST
- started_at 17:00:00.719 JST
- close_report_runs reference/fact note 17:00:01.337 JST
- status failed / `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`
- required indices: 日経平均 / TOPIX連動ETF（1306）
- notes included both `必須指数取得不能` and `鮮度または未来時刻エラー`
- app personalized close report at 17:15 JST completed and had same-day valid Nikkei / 1306 daily data.

Current code in `supabase/functions/x-test-post/close_report_logic.ts`:
- `validateCloseFreshness()` treats `jpx_close` as fresh only when `ageMinutes <= 90`.
- Therefore an observed 15:30:00 JST close is fresh at exactly 17:00:00 but stale at 17:00:01+.
- This same boundary risk was already reproduced on 2026-09-15. Two consecutive days now support treating this as a real production bug, not a theoretical edge case.

## Goal

Keep X close report at 17:00 JST and make same-session official close data valid despite ordinary seconds/minutes of scheduler/function delay.

Do NOT solve by moving the report earlier unless a blocker makes the direct fix unsafe.

## Required behavior

For `jpx_close` in live close-report mode:
- must still require same JST trading date as the report reference
- must still require observed time at or after 15:30 JST
- same-day official close data must remain valid through the normal 17:00 execution window, including 17:00:01+ delay
- previous-day data must remain rejected
- future timestamps must remain rejected
- 15:30-before-session-close/intraday values must remain rejected by existing same-day close gate
- invalid/missing numeric value, source URL, symbol/source identity checks remain unchanged
- no search/morning-data fallback
- Fact/Voice fail-closed behavior remains unchanged

Prefer a semantic same-session-close rule over a magic enlarged 90-minute number. If the existing architecture makes that impractical, use the narrowest safe bounded window and document why.

## Scope

Expected files only as needed:
- `supabase/functions/x-test-post/close_report_logic.ts`
- corresponding close-report tests
- if required for diagnosis/observability, the smallest related close-report data helper/test
- `.agent/CODEX_REPORT_2.md`
- this TASK

Do not touch:
- app personalized report implementation
- morning report
- important-news-monitor
- AI Lab/OAuth/Vault/multibrand paths
- DB/schema/RPC/migration/Cron/settings
- posting schedule time
- unrelated x-test-post behavior

## Required tests

At minimum deterministic tests for:
1. observed 15:30:00 JST, reference 17:00:00 => fresh/accepted
2. observed 15:30:00 JST, reference 17:00:01 and 17:00+ ordinary delay => fresh/accepted
3. same-day post-close value remains accepted within intended close-report live window
4. previous-day 15:30 => stale/rejected
5. same-day pre-15:30 observation => rejected by close-data gate
6. future timestamp => rejected
7. invalid timestamp => rejected
8. existing close report Fact/Voice and X-post suppression tests remain green
9. `git diff --check`
10. changed-file `deno check` or baseline-equivalent diagnostics

Run the relevant full x-test-post regression if practical.

## Production boundary

This task is implementation/review first.

Do NOT deploy unless the user separately and explicitly authorizes the production deploy after C2 review.

Also prohibited:
- production DB writes
- Cron/settings changes
- manual/synthetic X post
- manual OpenAI/X/Push invocation
- schedule time change
- `supabase db push`
- secret/token output

Production read-only checks are allowed.

## Completion

When implementation is complete:
- push the implementation safely after fresh `origin/main` check
- write `.agent/CODEX_REPORT_2.md` with root cause, exact rule change, changed files, tests, commit/push, no-deploy statement, safety checks, remaining issues
- set TASK to `review_required`, `next_owner: chatgpt`
- read back origin/main and stop for C2
